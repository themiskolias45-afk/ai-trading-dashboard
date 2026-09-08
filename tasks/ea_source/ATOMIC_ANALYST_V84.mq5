//+------------------------------------------------------------------+
//|  ATOMIC ANALYST V84 — MT5 port of the MT4 panel, plus a data feed |
//|                                                                  |
//|  THIS IS AN INDICATOR, NOT AN EXPERT ADVISOR. Deliberately.       |
//|                                                                  |
//|  It touches NO existing EA. It does not use the chart's expert    |
//|  slot, so it sits alongside EA_CRT_AMD_Dashboard, V10_EA_MASTER,  |
//|  TK_SMART_ENTRY or anything else already attached, and it can     |
//|  never place, modify or close an order — an indicator has no      |
//|  trade functions available to it at all. That is the point.       |
//|                                                                  |
//|  WHY IT WRITES A FILE INSTEAD OF POSTING                          |
//|  MQL5 forbids WebRequest() inside an indicator: the call returns  |
//|  -1 with error 4014 (function not allowed for call). Only EAs and |
//|  scripts may use it. FileWrite IS permitted, so the verdict is    |
//|  written to MQL5\Files\atomic_analyst\<SYMBOL>.json and a small   |
//|  reader on the Node side ships it. That keeps this file free of   |
//|  any network dependency and free of the WebRequest URL whitelist, |
//|  which is a GUI setting nobody can apply headlessly on the VPS.   |
//|                                                                  |
//|  WHAT IT FEEDS, AND WHAT IT MUST NEVER FEED                       |
//|  The JSON it emits is EVIDENCE, not a gate. It rides alongside    |
//|  the engine the way `shadow` does in /api/learning. Nothing in    |
//|  this file may be wired into confidence, the 70 gate, position    |
//|  size or a stop. Mixing an unproven third-party read into the     |
//|  live decision path is how a paper result becomes indistinguish-  |
//|  able from a measured one.                                        |
//+------------------------------------------------------------------+
#property copyright "SmartEntry Pro"
#property version   "1.00"
#property indicator_chart_window
#property indicator_plots 0

//--- inputs ---------------------------------------------------------
input int    InpRsiPeriod        = 14;
input int    InpMacdFast         = 12;
input int    InpMacdSlow         = 26;
input int    InpMacdSignal       = 9;
input int    InpMaFast           = 50;
input int    InpMaSlow           = 200;
input int    InpStochK           = 5;
input int    InpStochD           = 3;
input int    InpStochSlow        = 3;
input int    InpBandsPeriod      = 20;
input double InpBandsDev         = 2.0;
input int    InpAtrPeriod        = 14;
input int    InpFibLookback      = 100;   // bars used for the Fibonacci swing
input double InpSlAtrMult        = 1.5;   // ticket SL distance, in ATR
input bool   InpWriteFeedFile    = true;  // write MQL5\Files\atomic_analyst\<SYM>.json
input int    InpFeedSeconds      = 60;    // minimum seconds between file writes
input bool   InpShowPanel        = true;

//--- verdict codes --------------------------------------------------
#define V_BUY   1
#define V_WAIT  0
#define V_SELL -1

//--- panel geometry -------------------------------------------------
#define PFX      "AA84_"
#define PANEL_X  8
#define PANEL_Y  18
#define PANEL_W  1300
#define ROW_H    15

//--- indicator handles, created once in OnInit ----------------------
// A handle per timeframe per indicator. Creating them inside OnCalculate
// would leak a handle on every tick — the single most common way an MQL5
// indicator degrades a terminal until it is restarted.
ENUM_TIMEFRAMES g_tfs[9] = { PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30,
                             PERIOD_H1, PERIOD_H4, PERIOD_D1, PERIOD_W1, PERIOD_MN1 };
string          g_tfNames[9] = { "M1","M5","M15","M30","H1","H4","D1","W1","MN1" };
int             g_hRsiTf[9];
int             g_hMaFastTf[9];
int             g_hMaSlowTf[9];

int g_hRsi = INVALID_HANDLE, g_hMacd = INVALID_HANDLE, g_hMaF = INVALID_HANDLE;
int g_hMaS = INVALID_HANDLE, g_hStoch = INVALID_HANDLE, g_hBands = INVALID_HANDLE;
int g_hAtr = INVALID_HANDLE, g_hAdx = INVALID_HANDLE;

datetime g_lastFeedWrite = 0;
int      g_buySignals = 0, g_sellSignals = 0;
int      g_lastVerdict = V_WAIT;

//+------------------------------------------------------------------+
int OnInit()
{
   for(int i = 0; i < 9; i++)
     {
      g_hRsiTf[i]    = iRSI(_Symbol, g_tfs[i], InpRsiPeriod, PRICE_CLOSE);
      g_hMaFastTf[i] = iMA(_Symbol, g_tfs[i], InpMaFast, 0, MODE_EMA, PRICE_CLOSE);
      g_hMaSlowTf[i] = iMA(_Symbol, g_tfs[i], InpMaSlow, 0, MODE_EMA, PRICE_CLOSE);
     }
   g_hRsi   = iRSI(_Symbol, _Period, InpRsiPeriod, PRICE_CLOSE);
   g_hMacd  = iMACD(_Symbol, _Period, InpMacdFast, InpMacdSlow, InpMacdSignal, PRICE_CLOSE);
   g_hMaF   = iMA(_Symbol, _Period, InpMaFast, 0, MODE_EMA, PRICE_CLOSE);
   g_hMaS   = iMA(_Symbol, _Period, InpMaSlow, 0, MODE_EMA, PRICE_CLOSE);
   g_hStoch = iStochastic(_Symbol, _Period, InpStochK, InpStochD, InpStochSlow, MODE_SMA, STO_LOWHIGH);
   g_hBands = iBands(_Symbol, _Period, InpBandsPeriod, 0, InpBandsDev, PRICE_CLOSE);
   g_hAtr   = iATR(_Symbol, _Period, InpAtrPeriod);
   g_hAdx   = iADX(_Symbol, _Period, InpAtrPeriod);

   if(g_hRsi == INVALID_HANDLE || g_hMacd == INVALID_HANDLE || g_hBands == INVALID_HANDLE ||
      g_hAtr == INVALID_HANDLE || g_hAdx == INVALID_HANDLE || g_hStoch == INVALID_HANDLE)
     {
      Print("ATOMIC V84: an indicator handle failed to create — refusing to run half-blind");
      return(INIT_FAILED);
     }
   IndicatorSetString(INDICATOR_SHORTNAME, "ATOMIC ANALYST V84");
   // SAY THAT IT STARTED. Without this, "attached and returning early" and "never
   // attached at all" produce byte-identical evidence: an empty log and no file. That
   // ambiguity cost a diagnostic round on 2026-09-08.
   PrintFormat("ATOMIC V84: attached to %s %s, feed=%s, writing every %ds",
               _Symbol, EnumToString((ENUM_TIMEFRAMES)_Period),
               (InpWriteFeedFile ? "ON" : "OFF"), InpFeedSeconds);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   for(int i = 0; i < 9; i++)
     {
      if(g_hRsiTf[i]    != INVALID_HANDLE) IndicatorRelease(g_hRsiTf[i]);
      if(g_hMaFastTf[i] != INVALID_HANDLE) IndicatorRelease(g_hMaFastTf[i]);
      if(g_hMaSlowTf[i] != INVALID_HANDLE) IndicatorRelease(g_hMaSlowTf[i]);
     }
   if(g_hRsi   != INVALID_HANDLE) IndicatorRelease(g_hRsi);
   if(g_hMacd  != INVALID_HANDLE) IndicatorRelease(g_hMacd);
   if(g_hMaF   != INVALID_HANDLE) IndicatorRelease(g_hMaF);
   if(g_hMaS   != INVALID_HANDLE) IndicatorRelease(g_hMaS);
   if(g_hStoch != INVALID_HANDLE) IndicatorRelease(g_hStoch);
   if(g_hBands != INVALID_HANDLE) IndicatorRelease(g_hBands);
   if(g_hAtr   != INVALID_HANDLE) IndicatorRelease(g_hAtr);
   if(g_hAdx   != INVALID_HANDLE) IndicatorRelease(g_hAdx);
   ObjectsDeleteAll(0, PFX);
}

//+------------------------------------------------------------------+
//| Read one value from an indicator buffer. Returns false rather     |
//| than a silent 0 when the buffer is not ready — a zero RSI would   |
//| read as "extremely oversold" and flip a verdict.                  |
//+------------------------------------------------------------------+
bool Val(const int handle, const int buffer, const int shift, double &out)
{
   double tmp[];
   if(handle == INVALID_HANDLE) return(false);
   if(CopyBuffer(handle, buffer, shift, 1, tmp) != 1) return(false);
   if(!MathIsValidNumber(tmp[0])) return(false);
   out = tmp[0];
   return(true);
}

string VerdictText(const int v) { return(v == V_BUY ? "BUY" : (v == V_SELL ? "SELL" : "WAIT")); }
color  VerdictColor(const int v){ return(v == V_BUY ? C'0,140,70' : (v == V_SELL ? C'150,30,45' : C'120,95,20')); }

//+------------------------------------------------------------------+
//| Per-timeframe verdict: price against its fast and slow EMA, with  |
//| RSI as the tiebreak. Deliberately simple and stated rather than   |
//| tuned — this panel is a second opinion, not the engine.           |
//+------------------------------------------------------------------+
int TfVerdict(const int i)
{
   double maF, maS, rsi;
   if(!Val(g_hMaFastTf[i], 0, 0, maF)) return(V_WAIT);
   if(!Val(g_hMaSlowTf[i], 0, 0, maS)) return(V_WAIT);
   if(!Val(g_hRsiTf[i],    0, 0, rsi)) return(V_WAIT);
   double px = iClose(_Symbol, g_tfs[i], 0);
   if(px <= 0) return(V_WAIT);
   if(px > maF && maF > maS && rsi >= 50) return(V_BUY);
   if(px < maF && maF < maS && rsi <= 50) return(V_SELL);
   return(V_WAIT);
}

//+------------------------------------------------------------------+
//| Session, from the terminal's own clock.                           |
//+------------------------------------------------------------------+
string SessionName()
{
   MqlDateTime t; TimeToStruct(TimeCurrent(), t);
   int h = t.hour;
   if(h >= 0  && h < 7)  return("Asian");
   if(h >= 7  && h < 13) return("Europe");
   if(h >= 13 && h < 21) return("US");
   return("Pacific");
}

//+------------------------------------------------------------------+
//| Panel drawing helpers                                             |
//+------------------------------------------------------------------+
void Box(const string name, const int x, const int y, const int w, const int h, const color bg)
{
   string n = PFX + name;
   if(ObjectFind(0, n) < 0) ObjectCreate(0, n, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, n, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, n, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, n, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, n, OBJPROP_XSIZE, w);
   ObjectSetInteger(0, n, OBJPROP_YSIZE, h);
   ObjectSetInteger(0, n, OBJPROP_BGCOLOR, bg);
   ObjectSetInteger(0, n, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, n, OBJPROP_COLOR, C'40,60,95');
   ObjectSetInteger(0, n, OBJPROP_BACK, false);
   ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);
}

void Txt(const string name, const int x, const int y, const string s, const color c,
         const int size = 8, const string font = "Segoe UI")
{
   string n = PFX + name;
   if(ObjectFind(0, n) < 0) ObjectCreate(0, n, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, n, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, n, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, n, OBJPROP_YDISTANCE, y);
   ObjectSetString (0, n, OBJPROP_TEXT, s);
   ObjectSetString (0, n, OBJPROP_FONT, font);
   ObjectSetInteger(0, n, OBJPROP_FONTSIZE, size);
   ObjectSetInteger(0, n, OBJPROP_COLOR, c);
   ObjectSetInteger(0, n, OBJPROP_BACK, false);
   ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);
}

//+------------------------------------------------------------------+
//| Escape a string for JSON. Without this a broker symbol or comment |
//| containing a quote or a backslash silently produces a file the    |
//| Node reader cannot parse, and the feed goes quiet with no error.  |
//+------------------------------------------------------------------+
string JStr(const string s)
{
   string o = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort ch = StringGetCharacter(s, i);
      if(ch == '"')       o += "\\\"";
      else if(ch == '\\') o += "\\\\";
      else if(ch == '\n') o += "\\n";
      else if(ch == '\r') o += "\\r";
      else if(ch == '\t') o += "\\t";
      else if(ch < 32)    o += " ";
      else                o += ShortToString(ch);
     }
   return(o);
}

string JNum(const double v, const int digits)
{
   if(!MathIsValidNumber(v)) return("null");
   return(DoubleToString(v, digits));
}

//+------------------------------------------------------------------+
int OnCalculate(const int rates_total, const int prev_calculated,
                const datetime &time[], const double &open[], const double &high[],
                const double &low[], const double &close[], const long &tick_volume[],
                const long &volume[], const int &spread[])
{
   if(rates_total < InpMaSlow + 10) return(rates_total);

   //--- core reads -------------------------------------------------
   double rsi, macdMain, macdSig, maF, maS, stochM, stochS;
   double bbUp, bbMid, bbLo, atr, adx;
   bool ok = true;
   ok &= Val(g_hRsi,   0, 0, rsi);
   ok &= Val(g_hMacd,  0, 0, macdMain);
   ok &= Val(g_hMacd,  1, 0, macdSig);
   ok &= Val(g_hMaF,   0, 0, maF);
   ok &= Val(g_hMaS,   0, 0, maS);
   ok &= Val(g_hStoch, 0, 0, stochM);
   ok &= Val(g_hStoch, 1, 0, stochS);
   ok &= Val(g_hBands, 1, 0, bbUp);
   ok &= Val(g_hBands, 0, 0, bbMid);
   ok &= Val(g_hBands, 2, 0, bbLo);
   ok &= Val(g_hAtr,   0, 0, atr);
   ok &= Val(g_hAdx,   0, 0, adx);
   if(!ok)
     {
      // NAME THE BUFFER THAT IS NOT READY. "Something was not ready" is not a
      // diagnosis, and on a fresh attach several of these warm up at different rates.
      // Throttled to once a minute so a genuinely cold chart cannot flood the log.
      static datetime lastWarn = 0;
      if(TimeCurrent() - lastWarn >= 60)
        {
         lastWarn = TimeCurrent();
         string miss = "";
         double t;
         if(!Val(g_hRsi,0,0,t))   miss += "RSI ";
         if(!Val(g_hMacd,0,0,t))  miss += "MACD ";
         if(!Val(g_hMaF,0,0,t))   miss += "EMA" + IntegerToString(InpMaFast) + " ";
         if(!Val(g_hMaS,0,0,t))   miss += "EMA" + IntegerToString(InpMaSlow) + " ";
         if(!Val(g_hStoch,0,0,t)) miss += "Stoch ";
         if(!Val(g_hBands,0,0,t)) miss += "Bands ";
         if(!Val(g_hAtr,0,0,t))   miss += "ATR ";
         if(!Val(g_hAdx,0,0,t))   miss += "ADX ";
         PrintFormat("ATOMIC V84: waiting on %s(bars=%d) — no panel, no feed until ready",
                     (miss == "" ? "(none - a higher-TF buffer)" : miss), rates_total);
        }
      return(rates_total);   // buffers not ready — draw nothing rather than guess
     }

   double px = close[rates_total - 1];

   //--- indicator consensus ---------------------------------------
   int vRsi   = (rsi > 55 ? V_BUY : (rsi < 45 ? V_SELL : V_WAIT));
   int vMacd  = (macdMain > macdSig ? V_BUY : (macdMain < macdSig ? V_SELL : V_WAIT));
   int vMa    = (px > maF && maF > maS ? V_BUY : (px < maF && maF < maS ? V_SELL : V_WAIT));
   int vStoch = (stochM > stochS && stochM < 80 ? V_BUY : (stochM < stochS && stochM > 20 ? V_SELL : V_WAIT));
   int vBb    = (px > bbMid ? V_BUY : (px < bbMid ? V_SELL : V_WAIT));

   // Fibonacci: where price sits inside the recent swing. Above the 61.8%
   // retracement of an up-swing is constructive, below the 38.2% is not.
   int    look = (int)MathMin(InpFibLookback, rates_total - 1);
   int    hi   = ArrayMaximum(high, rates_total - look, look);
   int    lo   = ArrayMinimum(low,  rates_total - look, look);
   double swingH = (hi >= 0 ? high[hi] : px);
   double swingL = (lo >= 0 ? low[lo]  : px);
   double span   = swingH - swingL;
   int vFib = V_WAIT;
   if(span > 0)
     {
      double pos = (px - swingL) / span;
      if(pos >= 0.618)      vFib = V_BUY;
      else if(pos <= 0.382) vFib = V_SELL;
     }

   // Classic floor-trader pivot off the previous daily bar.
   double pdH = iHigh(_Symbol, PERIOD_D1, 1);
   double pdL = iLow(_Symbol, PERIOD_D1, 1);
   double pdC = iClose(_Symbol, PERIOD_D1, 1);
   int vPivot = V_WAIT;
   if(pdH > 0 && pdL > 0 && pdC > 0)
     {
      double pivot = (pdH + pdL + pdC) / 3.0;
      vPivot = (px > pivot ? V_BUY : (px < pivot ? V_SELL : V_WAIT));
     }

   int cons[7] = { vRsi, vMacd, vMa, vStoch, vBb, vFib, vPivot };
   int buys = 0, sells = 0, waits = 0;
   for(int i = 0; i < 7; i++)
     {
      if(cons[i] == V_BUY) buys++; else if(cons[i] == V_SELL) sells++; else waits++;
     }
   int vFinal = (buys > sells ? V_BUY : (sells > buys ? V_SELL : V_WAIT));

   //--- MTF row ----------------------------------------------------
   int tfV[9]; int tfBuy = 0, tfSell = 0;
   for(int i = 0; i < 9; i++)
     {
      tfV[i] = TfVerdict(i);
      if(tfV[i] == V_BUY) tfBuy++; else if(tfV[i] == V_SELL) tfSell++;
     }

   //--- dominance and confidence ----------------------------------
   double bullPct = (buys  * 100.0) / 7.0;
   double bearPct = (sells * 100.0) / 7.0;
   double waitPct = (waits * 100.0) / 7.0;
   double confidence = MathMax(bullPct, bearPct);
   string sentiment = (vFinal == V_BUY ? "BULLISH" : (vFinal == V_SELL ? "BEARISH" : "UNDECIDED"));

   // The header verdict is "ONLY" when the timeframes do not contradict the
   // consensus. The MT4 panel printed SELL ONLY at 63% while its own MTF row
   // showed M1, M5, W1 and MN1 on BUY and its Evidence Matrix said MIXED — the
   // headline claimed more than the rows under it supported. This will not.
   bool   mtfAgrees = (vFinal == V_BUY && tfSell == 0) || (vFinal == V_SELL && tfBuy == 0);
   string headline  = (vFinal == V_WAIT) ? "WAIT"
                    : (VerdictText(vFinal) + (mtfAgrees ? " ONLY" : " (MTF MIXED)"));

   if(vFinal != g_lastVerdict && vFinal != V_WAIT)
     {
      if(vFinal == V_BUY) g_buySignals++; else g_sellSignals++;
      g_lastVerdict = vFinal;
     }

   //--- ticket -----------------------------------------------------
   double entry = px;
   double slDist = atr * InpSlAtrMult;
   double sl = 0, tp1 = 0, tp2 = 0;
   if(vFinal == V_BUY)  { sl = entry - slDist; tp1 = entry + slDist; tp2 = entry + slDist * 2.0; }
   if(vFinal == V_SELL) { sl = entry + slDist; tp1 = entry - slDist; tp2 = entry - slDist * 2.0; }

   //--- spread -----------------------------------------------------
   long   spreadPts = (long)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   int    dg = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   string spreadTxt = "Spread " + IntegerToString(spreadPts) + "pt";

   if(InpShowPanel) DrawPanel(headline, confidence, tfV, cons, vFinal,
                              bullPct, waitPct, bearPct, sentiment,
                              rsi, adx, atr, entry, sl, tp1, tp2, dg, spreadTxt, mtfAgrees);

   if(InpWriteFeedFile && (TimeCurrent() - g_lastFeedWrite) >= InpFeedSeconds)
     {
      WriteFeed(headline, confidence, tfV, cons, vFinal, bullPct, waitPct, bearPct,
                sentiment, rsi, macdMain, macdSig, adx, atr, entry, sl, tp1, tp2,
                dg, spreadPts, mtfAgrees);
      g_lastFeedWrite = TimeCurrent();
     }

   return(rates_total);
}

//+------------------------------------------------------------------+
void DrawPanel(const string headline, const double confidence, const int &tfV[],
               const int &cons[], const int vFinal, const double bullPct,
               const double waitPct, const double bearPct, const string sentiment,
               const double rsi, const double adx, const double atr,
               const double entry, const double sl, const double tp1, const double tp2,
               const int dg, const string spreadTxt, const bool mtfAgrees)
{
   color bgDark = C'12,20,38', bgPanel = C'18,28,50';
   Box("bg", PANEL_X, PANEL_Y, PANEL_W, 300, bgDark);

   Txt("title", PANEL_X + 12, PANEL_Y + 6, "ATOMIC ANALYST V84", clrWhite, 12, "Segoe UI Bold");
   Txt("sub",   PANEL_X + 12, PANEL_Y + 24, "AI Market Verdict Engine  ·  " + _Symbol, C'120,160,220', 7);
   Txt("verd",  PANEL_X + 540, PANEL_Y + 6, headline,
       vFinal == V_BUY ? clrLime : (vFinal == V_SELL ? C'255,80,90' : clrGoldenrod), 13, "Segoe UI Bold");
   Txt("conf",  PANEL_X + 540, PANEL_Y + 26, "Confidence " + DoubleToString(confidence, 0) + "%", C'120,180,255', 8);
   Txt("sess",  PANEL_X + 1100, PANEL_Y + 6, SessionName() + " Session", clrWhite, 8);
   Txt("spr",   PANEL_X + 1100, PANEL_Y + 24, spreadTxt, C'90,220,140', 8);

   //--- MTF row
   Box("mtfbg", PANEL_X + 10, PANEL_Y + 46, PANEL_W - 20, 40, bgPanel);
   Txt("mtflbl", PANEL_X + 18, PANEL_Y + 60, "MTF", C'120,180,255', 8, "Segoe UI Bold");
   for(int i = 0; i < 9; i++)
     {
      int cx = PANEL_X + 60 + i * 135;
      Txt("tfn" + IntegerToString(i), cx + 40, PANEL_Y + 50, g_tfNames[i], C'150,175,210', 7);
      Box("tfb" + IntegerToString(i), cx, PANEL_Y + 64, 128, 16, VerdictColor(tfV[i]));
      Txt("tft" + IntegerToString(i), cx + 48, PANEL_Y + 64, VerdictText(tfV[i]), clrWhite, 7);
     }

   //--- consensus
   string names[7] = { "RSI","MACD","Moving Average","Stochastic","Bollinger","Fibonacci","Pivot Points" };
   Box("cbg", PANEL_X + 10, PANEL_Y + 92, 420, 130, bgPanel);
   Txt("chdr", PANEL_X + 150, PANEL_Y + 96, "Indicator Consensus", C'120,180,255', 8, "Segoe UI Bold");
   for(int i = 0; i < 7; i++)
     {
      Txt("cn" + IntegerToString(i), PANEL_X + 100, PANEL_Y + 114 + i * ROW_H, names[i], C'190,205,225', 7);
      Box("cb" + IntegerToString(i), PANEL_X + 300, PANEL_Y + 114 + i * ROW_H, 110, 13, VerdictColor(cons[i]));
      Txt("ct" + IntegerToString(i), PANEL_X + 340, PANEL_Y + 113 + i * ROW_H, VerdictText(cons[i]), clrWhite, 7);
     }

   //--- decision
   Box("dbg", PANEL_X + 440, PANEL_Y + 92, 420, 130, bgPanel);
   Txt("dhdr", PANEL_X + 590, PANEL_Y + 96, "Atomic AI Decision", C'120,180,255', 8, "Segoe UI Bold");
   Txt("dver", PANEL_X + 560, PANEL_Y + 140, headline,
       vFinal == V_BUY ? clrLime : (vFinal == V_SELL ? C'255,80,90' : clrGoldenrod), 16, "Segoe UI Bold");
   Txt("dcnf", PANEL_X + 600, PANEL_Y + 172, "Confidence " + DoubleToString(confidence, 0) + "%", C'150,190,240', 8);

   //--- dominance
   Box("mbg", PANEL_X + 870, PANEL_Y + 92, 420, 130, bgPanel);
   Txt("mhdr", PANEL_X + 1010, PANEL_Y + 96, "Market Dominance", C'120,180,255', 8, "Segoe UI Bold");
   Txt("mbul", PANEL_X + 910,  PANEL_Y + 128, "Bullish " + DoubleToString(bullPct, 0) + "%", clrLime, 8);
   Txt("mwai", PANEL_X + 1050, PANEL_Y + 128, "Wait " + DoubleToString(waitPct, 0) + "%",   clrGoldenrod, 8);
   Txt("mbea", PANEL_X + 1170, PANEL_Y + 128, "Bearish " + DoubleToString(bearPct, 0) + "%", C'255,80,90', 8);
   Txt("msen", PANEL_X + 960,  PANEL_Y + 190, "Market sentiment is " + sentiment, C'200,215,235', 8);

   //--- evidence matrix
   Box("ebg", PANEL_X + 10, PANEL_Y + 230, 420, 62, bgPanel);
   Txt("ehdr", PANEL_X + 140, PANEL_Y + 232, "Atomic Evidence Matrix", C'120,180,255', 8, "Segoe UI Bold");
   Txt("e1", PANEL_X + 30,  PANEL_Y + 250, "Bias " + VerdictText(vFinal), C'190,205,225', 7);
   Txt("e2", PANEL_X + 150, PANEL_Y + 250, "ADX " + DoubleToString(adx, 1) +
       (adx >= 20 ? " TREND" : " NO TREND"), adx >= 20 ? clrLime : clrGoldenrod, 7);
   Txt("e3", PANEL_X + 30,  PANEL_Y + 268, "RSI " + DoubleToString(rsi, 1), C'190,205,225', 7);
   Txt("e4", PANEL_X + 150, PANEL_Y + 268, "MTF " + (mtfAgrees ? "ALIGNED" : "MIXED"),
       mtfAgrees ? clrLime : clrGoldenrod, 7);
   Txt("e5", PANEL_X + 290, PANEL_Y + 268, "ATR " + DoubleToString(atr, dg), C'190,205,225', 7);

   //--- ticket
   Box("tbg", PANEL_X + 440, PANEL_Y + 230, 420, 62, bgPanel);
   Txt("thdr", PANEL_X + 580, PANEL_Y + 232, "Active Signal Ticket", C'120,180,255', 8, "Segoe UI Bold");
   if(vFinal == V_WAIT)
      Txt("tk1", PANEL_X + 470, PANEL_Y + 258, "no ticket — consensus is WAIT", clrGoldenrod, 7);
   else
     {
      Txt("tk1", PANEL_X + 460, PANEL_Y + 250, VerdictText(vFinal) + "  entry " + DoubleToString(entry, dg), clrWhite, 7);
      Txt("tk2", PANEL_X + 460, PANEL_Y + 268, "SL " + DoubleToString(sl, dg) +
          "   TP1 " + DoubleToString(tp1, dg) + "   TP2 " + DoubleToString(tp2, dg), C'190,205,225', 7);
     }
   // The MT4 panel showed a ticket stamped four days earlier under a live
   // headline. This one always states its own age.
   Txt("tage", PANEL_X + 700, PANEL_Y + 232, TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES), C'140,165,200', 7);

   //--- stats
   Box("sbg", PANEL_X + 870, PANEL_Y + 230, 420, 62, bgPanel);
   Txt("shdr", PANEL_X + 1010, PANEL_Y + 232, "Session Statistics", C'120,180,255', 8, "Segoe UI Bold");
   Txt("s1", PANEL_X + 890, PANEL_Y + 250, "Buy flips " + IntegerToString(g_buySignals) +
       "    Sell flips " + IntegerToString(g_sellSignals), C'190,205,225', 7);
   Txt("s2", PANEL_X + 890, PANEL_Y + 268, "Balance " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
       "   Equity " + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2), C'190,205,225', 7);
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| Write the verdict as JSON for the Node reader to ship.            |
//|                                                                   |
//| FILE_COMMON is NOT used on purpose: the file belongs to this       |
//| terminal, and the reader is told which data folder to look in. Two |
//| terminals writing the same common file would silently interleave   |
//| two accounts' verdicts into one record.                            |
//+------------------------------------------------------------------+
void WriteFeed(const string headline, const double confidence, const int &tfV[],
               const int &cons[], const int vFinal, const double bullPct,
               const double waitPct, const double bearPct, const string sentiment,
               const double rsi, const double macdMain, const double macdSig,
               const double adx, const double atr, const double entry,
               const double sl, const double tp1, const double tp2,
               const int dg, const long spreadPts, const bool mtfAgrees)
{
   string dir  = "atomic_analyst";
   string path = dir + "\\" + _Symbol + ".json";
   int h = FileOpen(path, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      // Reported, not swallowed. A feed that stops writing must not look
      // identical to a feed that is simply quiet.
      Print("ATOMIC V84: cannot write ", path, " err=", GetLastError());
      return;
     }

   string tfJson = "";
   for(int i = 0; i < 9; i++)
      tfJson += (i ? "," : "") + StringFormat("\"%s\":\"%s\"", g_tfNames[i], VerdictText(tfV[i]));

   string consNames[7] = { "rsi","macd","movingAverage","stochastic","bollinger","fibonacci","pivot" };
   string consJson = "";
   for(int i = 0; i < 7; i++)
      consJson += (i ? "," : "") + StringFormat("\"%s\":\"%s\"", consNames[i], VerdictText(cons[i]));

   string j = "{";
   j += "\"source\":\"ATOMIC_ANALYST_V84\",";
   j += "\"schema\":1,";
   j += "\"feedsTheGate\":false,";
   j += "\"symbol\":\"" + JStr(_Symbol) + "\",";
   j += "\"timeframe\":\"" + JStr(EnumToString((ENUM_TIMEFRAMES)_Period)) + "\",";
   j += "\"account\":\"" + JStr(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))) + "\",";
   j += "\"generatedAt\":\"" + TimeToString(TimeGMT(), TIME_DATE | TIME_SECONDS) + "\",";
   j += "\"generatedAtEpoch\":" + IntegerToString((long)TimeGMT()) + ",";
   j += "\"verdict\":\"" + JStr(headline) + "\",";
   j += "\"direction\":\"" + VerdictText(vFinal) + "\",";
   j += "\"confidence\":" + JNum(confidence, 1) + ",";
   j += "\"mtfAligned\":" + (mtfAgrees ? "true" : "false") + ",";
   j += "\"dominance\":{\"bullish\":" + JNum(bullPct,1) + ",\"wait\":" + JNum(waitPct,1) +
        ",\"bearish\":" + JNum(bearPct,1) + ",\"sentiment\":\"" + JStr(sentiment) + "\"},";
   j += "\"mtf\":{" + tfJson + "},";
   j += "\"consensus\":{" + consJson + "},";
   j += "\"indicators\":{\"rsi\":" + JNum(rsi,2) + ",\"macd\":" + JNum(macdMain,dg) +
        ",\"macdSignal\":" + JNum(macdSig,dg) + ",\"adx\":" + JNum(adx,2) +
        ",\"atr\":" + JNum(atr,dg) + ",\"spreadPoints\":" + IntegerToString(spreadPts) + "},";
   j += "\"ticket\":" + (vFinal == V_WAIT ? "null" :
        ("{\"direction\":\"" + VerdictText(vFinal) + "\",\"entry\":" + JNum(entry,dg) +
         ",\"sl\":" + JNum(sl,dg) + ",\"tp1\":" + JNum(tp1,dg) + ",\"tp2\":" + JNum(tp2,dg) + "}")) + ",";
   j += "\"note\":\"Evidence only. This is a second opinion from an indicator and must never be wired into confidence, the gate, position size or a stop.\"";
   j += "}";

   FileWriteString(h, j);
   FileClose(h);
   // Confirm the first write out loud, then stay quiet. A feed that started is worth
   // one line; a feed that repeats itself every minute buries the EAs' own output.
   static bool announced = false;
   if(!announced)
     {
      announced = true;
      // `path` already carries the subfolder, and the MQL5\Files prefix is implied by
      // FileOpen's sandbox — spelling it out here only invited the escape-sequence
      // warnings this line shipped with on its first compile.
      PrintFormat("ATOMIC V84: feed written -> %s  (%s %.0f pct)",
                  path, headline, confidence);
     }
}
//+------------------------------------------------------------------+
