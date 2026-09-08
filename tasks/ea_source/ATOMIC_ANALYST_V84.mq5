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
input bool   InpDrawLevels       = true;  // draw SL and TP1..TP5 on the chart

// THE TP LADDER IS FIBONACCI ON THE RISK DISTANCE, NOT ROUND R MULTIPLES.
//
// Derived from his own MT4 screenshots rather than guessed. Panel: entry 4393.79,
// SL 4462.82, so risk = 69.03. Chart: TP1 4377.50, TP2 4351.13, TP3 4324.76,
// TP4 4298.38, TP5 4255.72. Each distance divided by the risk gives
// 0.236 / 0.618 / 1.000 / 1.382 / 2.000 - exact to three decimals, and picture 2
// prints those same five numbers as fib labels down the left of the chart.
// The first build of this file used 1R and 2R, which matched nothing he had.
double FIB_TP[5] = { 0.236, 0.618, 1.000, 1.382, 2.000 };

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
   // "Overlap" is a real value in his panel (13:36 shot) and was missing here. The
   // London/New York overlap is the highest-liquidity window of the day and it is its own
   // label, not a slice of either session.
   if(h >= 0  && h < 7)  return("Asian");
   if(h >= 7  && h < 12) return("Europe");
   if(h >= 12 && h < 16) return("Overlap");
   if(h >= 16 && h < 21) return("US");
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
   double macdHist = macdMain - macdSig;

   // Volume pulse and Bollinger width. His Evidence Matrix carries both ("Volume Pulse"
   // NORMAL, "Volatility" NORMAL) and neither existed in the first build of this file.
   //
   // The volume ratio compares the LAST CLOSED bar against the 20 before it, not the
   // still-forming bar against completed ones - a part-formed bar is not a bar's volume,
   // and comparing them makes the ratio structurally small for most of every session.
   // That exact bug is recorded in the engine's own volume block.
   double volRatio = 1.0;
   if(rates_total > 22)
     {
      double vSum = 0;
      for(int i = 2; i <= 21; i++) vSum += (double)tick_volume[rates_total - i];
      double vAvg = vSum / 20.0;
      if(vAvg > 0) volRatio = (double)tick_volume[rates_total - 2] / vAvg;
     }
   double bbWidth = (bbMid > 0) ? ((bbUp - bbLo) / bbMid * 100.0) : 0.0;

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
   // THE AI DECISION IS NOT THE INDICATOR CONSENSUS. They are two separate readings and
   // his 13:36 screenshot shows them DISAGREEING: Final Consensus reads SELL while the
   // Atomic AI Decision reads WAIT, because Dominance was Bullish 6 / Wait 56 / Bearish 38
   // and WAIT was the largest share. The first build of this file conflated them, so it
   // could never reproduce that state.
   //
   //   Final Consensus = majority of the seven indicators        (vFinal)
   //   AI Decision     = the largest slice of Market Dominance   (vDecision)
   int vDecision;
   if(waitPct >= bullPct && waitPct >= bearPct)      vDecision = V_WAIT;
   else if(bullPct >= bearPct)                       vDecision = V_BUY;
   else                                              vDecision = V_SELL;

   bool   mtfAgrees = (vDecision == V_BUY && tfSell == 0) || (vDecision == V_SELL && tfBuy == 0);
   string headline  = (vDecision == V_WAIT) ? "WAIT"
                    : (VerdictText(vDecision) + (mtfAgrees ? " ONLY" : " (MTF MIXED)"));

   if(vDecision != g_lastVerdict && vDecision != V_WAIT)
     {
      if(vDecision == V_BUY) g_buySignals++; else g_sellSignals++;
      g_lastVerdict = vDecision;
     }

   //--- ticket -----------------------------------------------------
   double entry = px;
   double slDist = atr * InpSlAtrMult;
   double sl = 0;
   double tp[5];
   ArrayInitialize(tp, 0.0);
   if(vDecision != V_WAIT)
     {
      int dir = (vDecision == V_BUY) ? 1 : -1;
      sl = entry - dir * slDist;
      for(int i = 0; i < 5; i++) tp[i] = entry + dir * slDist * FIB_TP[i];
     }

   //--- spread -----------------------------------------------------
   long   spreadPts = (long)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   int    dg = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   string spreadTxt = "Spread " + IntegerToString(spreadPts) + "pt";

   if(InpShowPanel) DrawPanel(headline, confidence, tfV, cons, vFinal, vDecision,
                              bullPct, waitPct, bearPct, sentiment,
                              rsi, adx, atr, entry, sl, tp, dg, spreadTxt, mtfAgrees,
                              volRatio, bbWidth, macdHist, tfBuy, tfSell, px, maS);
   if(InpDrawLevels) DrawLevels(vDecision, entry, sl, tp, dg);

   if(InpWriteFeedFile && (TimeCurrent() - g_lastFeedWrite) >= InpFeedSeconds)
     {
      WriteFeed(headline, confidence, tfV, cons, vFinal, vDecision, bullPct, waitPct, bearPct,
                sentiment, rsi, macdMain, macdSig, adx, atr, entry, sl, tp,
                dg, spreadPts, mtfAgrees, volRatio, bbWidth, tfBuy, tfSell);
      g_lastFeedWrite = TimeCurrent();
     }

   return(rates_total);
}

//+------------------------------------------------------------------+
void DrawPanel(const string headline, const double confidence, const int &tfV[],
               const int &cons[], const int vFinal, const int vDecision, const double bullPct,
               const double waitPct, const double bearPct, const string sentiment,
               const double rsi, const double adx, const double atr,
               const double entry, const double sl, const double &tp[],
               const int dg, const string spreadTxt, const bool mtfAgrees,
               const double volRatio, const double bbWidth, const double macdHist,
               const int tfBuy, const int tfSell, const double px, const double maS)
{
   color bgDark = C'12,20,38', bgPanel = C'18,28,50';
   Box("bg", PANEL_X, PANEL_Y, PANEL_W, 352, bgDark);

   Txt("title", PANEL_X + 12, PANEL_Y + 6, "ATOMIC ANALYST V84", clrWhite, 12, "Segoe UI Bold");
   Txt("sub",   PANEL_X + 12, PANEL_Y + 24, "AI Market Verdict Engine  -  " + _Symbol, C'120,160,220', 7);
   Txt("verd",  PANEL_X + 540, PANEL_Y + 6, headline,
       vDecision == V_BUY ? clrLime : (vDecision == V_SELL ? C'255,80,90' : clrGoldenrod), 13, "Segoe UI Bold");
   Txt("conf",  PANEL_X + 540, PANEL_Y + 26, "Confidence " + DoubleToString(confidence, 0) + "%", C'120,180,255', 8);
   Txt("sess",  PANEL_X + 1100, PANEL_Y + 6, SessionName() + " Session", clrWhite, 8);
   Txt("spr",   PANEL_X + 1100, PANEL_Y + 24, spreadTxt, C'90,220,140', 8);

   Box("mtfbg", PANEL_X + 10, PANEL_Y + 46, PANEL_W - 20, 40, bgPanel);
   Txt("mtflbl", PANEL_X + 18, PANEL_Y + 60, "MTF", C'120,180,255', 8, "Segoe UI Bold");
   for(int i = 0; i < 9; i++)
     {
      int cx = PANEL_X + 60 + i * 135;
      Txt("tfn" + IntegerToString(i), cx + 40, PANEL_Y + 50, g_tfNames[i], C'150,175,210', 7);
      Box("tfb" + IntegerToString(i), cx, PANEL_Y + 64, 128, 16, VerdictColor(tfV[i]));
      Txt("tft" + IntegerToString(i), cx + 48, PANEL_Y + 64, VerdictText(tfV[i]), clrWhite, 7);
     }

   // Consensus, WITH the Final Consensus row his panel carries as an eighth line.
   string names[7] = { "RSI","MACD","Moving Average","Stochastic","Bollinger","Fibonacci","Pivot Points" };
   Box("cbg", PANEL_X + 10, PANEL_Y + 92, 420, 145, bgPanel);
   Txt("chdr", PANEL_X + 150, PANEL_Y + 96, "Indicator Consensus", C'120,180,255', 8, "Segoe UI Bold");
   for(int i = 0; i < 7; i++)
     {
      Txt("cn" + IntegerToString(i), PANEL_X + 100, PANEL_Y + 114 + i * ROW_H, names[i], C'190,205,225', 7);
      Box("cb" + IntegerToString(i), PANEL_X + 300, PANEL_Y + 114 + i * ROW_H, 110, 13, VerdictColor(cons[i]));
      Txt("ct" + IntegerToString(i), PANEL_X + 340, PANEL_Y + 113 + i * ROW_H, VerdictText(cons[i]), clrWhite, 7);
     }
   Txt("cnF", PANEL_X + 92, PANEL_Y + 114 + 7 * ROW_H, "Final Consensus", clrWhite, 7, "Segoe UI Bold");
   Box("cbF", PANEL_X + 300, PANEL_Y + 114 + 7 * ROW_H, 110, 13, VerdictColor(vFinal));
   Txt("ctF", PANEL_X + 340, PANEL_Y + 113 + 7 * ROW_H, VerdictText(vFinal), clrWhite, 7);

   Box("dbg", PANEL_X + 440, PANEL_Y + 92, 420, 145, bgPanel);
   Txt("dhdr", PANEL_X + 590, PANEL_Y + 96, "Atomic AI Decision", C'120,180,255', 8, "Segoe UI Bold");
   Txt("dver", PANEL_X + 560, PANEL_Y + 145, headline,
       vDecision == V_BUY ? clrLime : (vDecision == V_SELL ? C'255,80,90' : clrGoldenrod), 16, "Segoe UI Bold");
   Txt("dcnf", PANEL_X + 600, PANEL_Y + 180, "Confidence " + DoubleToString(confidence, 0) + "%", C'150,190,240', 8);
   Txt("dmtf", PANEL_X + 545, PANEL_Y + 206,
       "Timeframes  " + IntegerToString(tfBuy) + " buy / " + IntegerToString(tfSell) + " sell / " +
       IntegerToString(9 - tfBuy - tfSell) + " wait", C'150,175,210', 7);

   Box("mbg", PANEL_X + 870, PANEL_Y + 92, 420, 145, bgPanel);
   Txt("mhdr", PANEL_X + 1010, PANEL_Y + 96, "Market Dominance", C'120,180,255', 8, "Segoe UI Bold");
   Txt("mbul", PANEL_X + 910,  PANEL_Y + 128, "Bullish " + DoubleToString(bullPct, 0) + "%", clrLime, 8);
   Txt("mwai", PANEL_X + 1050, PANEL_Y + 128, "Wait " + DoubleToString(waitPct, 0) + "%",   clrGoldenrod, 8);
   Txt("mbea", PANEL_X + 1170, PANEL_Y + 128, "Bearish " + DoubleToString(bearPct, 0) + "%", C'255,80,90', 8);
   // The proportional gradient bar under Dominance. Three segments sized by their own
   // share, so the picture and the numbers can never disagree.
   int barX = PANEL_X + 890, barY = PANEL_Y + 176, barW = 380;
   int wBull = (int)MathRound(barW * bullPct / 100.0);
   int wWait = (int)MathRound(barW * waitPct / 100.0);
   int wBear = barW - wBull - wWait;
   if(wBull > 0) Box("domB", barX,                 barY, wBull, 10, C'0,150,75');
   else          Box("domB", barX,                 barY, 1,     10, C'18,28,50');
   if(wWait > 0) Box("domW", barX + wBull,         barY, wWait, 10, C'170,120,25');
   else          Box("domW", barX + wBull,         barY, 1,     10, C'18,28,50');
   if(wBear > 0) Box("domR", barX + wBull + wWait, barY, wBear, 10, C'165,35,50');
   else          Box("domR", barX + wBull + wWait, barY, 1,     10, C'18,28,50');
   Txt("msen", PANEL_X + 950,  PANEL_Y + 200, "Market sentiment is " + sentiment, C'200,215,235', 8);

   // ATOMIC EVIDENCE MATRIX - all EIGHT rows his panel carries, in his order and with his
   // labels. The first build of this file had five and invented its own names, which is
   // why he said to check the pictures properly.
   string eLbl[8] = { "Atomic Bias", "Trend Pressure", "Momentum Force", "Volume Pulse",
                      "Volatility", "Currency / Pair", "MTF Alignment", "RSI Pressure" };
   string eVal[8]; color eCol[8];
   eVal[0] = VerdictText(vFinal);
   eCol[0] = VerdictColor(vFinal);
   eVal[1] = adx >= 25 ? "STRONG" : (adx >= 20 ? "TRENDING" : "MIXED");
   eCol[1] = adx >= 20 ? C'0,140,70' : C'120,95,20';
   // His 13:36 panel reads "WEAK BUY" where the 11:42 one read "STRONG SELL", so this
   // carries a WEAK / plain / STRONG modifier in BOTH directions, not a one-sided scale.
   eVal[2] = (MathAbs(macdHist) > atr * 0.05)  ? (macdHist > 0 ? "STRONG BUY" : "STRONG SELL")
           : (MathAbs(macdHist) < atr * 0.015) ? (macdHist > 0 ? "WEAK BUY"   : "WEAK SELL")
           :                                     (macdHist > 0 ? "BUY"        : "SELL");
   eCol[2] = macdHist > 0 ? C'0,140,70' : C'150,30,45';
   eVal[3] = volRatio >= 1.5 ? "HIGH" : (volRatio <= 0.6 ? "THIN" : "NORMAL");
   eCol[3] = (volRatio >= 1.5 || volRatio <= 0.6) ? C'20,90,140' : C'25,70,110';
   eVal[4] = bbWidth >= 8.0 ? "EXPANDED" : (bbWidth <= 3.0 ? "SQUEEZE" : "NORMAL");
   eCol[4] = bbWidth <= 3.0 ? C'120,95,20' : C'25,70,110';
   // Currency / Pair reads BULLISH in green in his 13:36 shot, so it is a pair-strength
   // read of its own - price against the slow EMA - not a restatement of the verdict.
   eVal[5] = (maS <= 0) ? "NEUTRAL" : (px > maS ? "BULLISH" : "BEARISH");
   eCol[5] = (maS <= 0) ? C'120,95,20' : (px > maS ? C'0,140,70' : C'150,30,45');
   eVal[6] = mtfAgrees ? "ALIGNED" : "MIXED";
   eCol[6] = mtfAgrees ? C'0,140,70' : C'120,95,20';
   eVal[7] = rsi >= 60 ? "BULLISH" : (rsi <= 40 ? "BEARISH" : "NEUTRAL");
   eCol[7] = rsi >= 60 ? C'0,140,70' : (rsi <= 40 ? C'150,30,45' : C'120,95,20');

   Box("ebg", PANEL_X + 10, PANEL_Y + 244, 420, 80, bgPanel);
   Txt("ehdr", PANEL_X + 140, PANEL_Y + 246, "Atomic Evidence Matrix", C'120,180,255', 8, "Segoe UI Bold");
   for(int i = 0; i < 8; i++)
     {
      int col = (i < 4) ? 0 : 1;
      int row = i % 4;
      int ex  = PANEL_X + 18 + col * 204;
      int ey  = PANEL_Y + 264 + row * 14;
      Txt("en" + IntegerToString(i), ex, ey, eLbl[i], C'190,205,225', 6);
      Box("eb" + IntegerToString(i), ex + 104, ey + 1, 92, 11, eCol[i]);
      Txt("ev" + IntegerToString(i), ex + 110, ey, eVal[i], clrWhite, 6);
     }

   // Ticket, now the FULL FIVE-STEP LADDER with the fib ratio beside each level.
   Box("tbg", PANEL_X + 440, PANEL_Y + 244, 420, 80, bgPanel);
   Txt("thdr", PANEL_X + 560, PANEL_Y + 246, "Active Signal Ticket", C'120,180,255', 8, "Segoe UI Bold");
   Txt("tage", PANEL_X + 730, PANEL_Y + 247, TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES), C'140,165,200', 6);
   for(int i = 0; i < 5; i++) Txt("tkp" + IntegerToString(i), PANEL_X + 450 + (i % 3) * 138,
                                  PANEL_Y + 284 + (i / 3) * 14, "", C'190,205,225', 6);
   if(vFinal == V_WAIT)
     {
      Txt("tk1", PANEL_X + 470, PANEL_Y + 280, "no ticket - consensus is WAIT", clrGoldenrod, 7);
     }
   else
     {
      Txt("tk1", PANEL_X + 450, PANEL_Y + 264,
          VerdictText(vFinal) + "   entry " + DoubleToString(entry, dg) +
          "    SL " + DoubleToString(sl, dg), clrWhite, 7);
      for(int i = 0; i < 5; i++)
        {
         Txt("tkp" + IntegerToString(i), PANEL_X + 450 + (i % 3) * 138, PANEL_Y + 284 + (i / 3) * 14,
             "TP" + IntegerToString(i + 1) + " " + DoubleToString(tp[i], dg) +
             " (" + DoubleToString(FIB_TP[i], 3) + ")", C'190,205,225', 6);
        }
     }

   Box("sbg", PANEL_X + 870, PANEL_Y + 244, 420, 80, bgPanel);
   Txt("shdr", PANEL_X + 995, PANEL_Y + 246, "Statistics / Performance", C'120,180,255', 8, "Segoe UI Bold");
   Txt("s1", PANEL_X + 890, PANEL_Y + 266, "Buy flips " + IntegerToString(g_buySignals) +
       "      Sell flips " + IntegerToString(g_sellSignals), C'190,205,225', 6);
   Txt("s2", PANEL_X + 890, PANEL_Y + 282, "Balance " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
       "    Equity " + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2), C'190,205,225', 6);
   // NO "Total Pip Profit" row. His MT4 panel showed +99037 pips beside Total Profit 0.00 -
   // a pip count with no money behind it, the same illusion as +0.37R against -173.16.
   Txt("s3", PANEL_X + 890, PANEL_Y + 298, "Open P/L " +
       DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + " " + AccountInfoString(ACCOUNT_CURRENCY),
       AccountInfoDouble(ACCOUNT_PROFIT) >= 0 ? C'90,220,140' : C'255,110,120', 6);

   // SEVEN cells, as his panel carries them: SESSION, SPREAD, CONNECTED, AI FILTER,
   // ATOMIC, GRADIENT, ALERTS. The last cell replaces his "ALERTS ON" with the constraint
   // that actually matters here - this thing decides nothing - so it is stated on the
   // chart and not only in a source comment nobody reading the panel will ever open.
   string sb[7]; color sbc[7];
   color on = C'0,110,60', off = C'70,70,70', info = C'25,70,110';
   sb[0] = "SESSION " + SessionName();                       sbc[0] = info;
   sb[1] = spreadTxt;                                        sbc[1] = info;
   sb[2] = TerminalInfoInteger(TERMINAL_CONNECTED) ? "CONNECTED" : "DISCONNECTED";
   sbc[2] = TerminalInfoInteger(TERMINAL_CONNECTED) ? on : C'150,30,45';
   sb[3] = mtfAgrees ? "MTF FILTER PASS" : "MTF FILTER MIXED";
   sbc[3] = mtfAgrees ? on : C'120,95,20';
   sb[4] = "ATOMIC ON";                                      sbc[4] = on;
   sb[5] = InpDrawLevels ? "LEVELS ON" : "LEVELS OFF";       sbc[5] = InpDrawLevels ? C'20,90,140' : off;
   sb[6] = InpWriteFeedFile ? "FEED ON - GATES NOTHING" : "FEED OFF";
   sbc[6] = InpWriteFeedFile ? C'120,80,20' : off;
   for(int i = 0; i < 7; i++)
     {
      int bx = PANEL_X + 10 + i * 184;
      Box("sb" + IntegerToString(i), bx, PANEL_Y + 330, 178, 18, sbc[i]);
      Txt("sbt" + IntegerToString(i), bx + 8, PANEL_Y + 331, sb[i], clrWhite, 6);
     }
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| SL and the five TPs drawn on the chart, as picture 2 shows them.  |
//| Deleted and redrawn every update so a level from a previous       |
//| verdict can never sit on the chart looking current.               |
//+------------------------------------------------------------------+
void DrawLevels(const int vFinal, const double entry, const double sl,
                const double &tp[], const int dg)
{
   for(int i = 0; i < 7; i++)
     {
      ObjectDelete(0, PFX + "L" + IntegerToString(i));
      ObjectDelete(0, PFX + "LT" + IntegerToString(i));
     }
   if(vFinal == V_WAIT) { ChartRedraw(0); return; }

   double lv[7]; string lb[7]; color lc[7];
   lv[0] = entry; lb[0] = "ENTRY " + DoubleToString(entry, dg); lc[0] = clrWhite;
   lv[1] = sl;    lb[1] = "SL - " + DoubleToString(sl, dg);     lc[1] = C'255,80,90';
   for(int i = 0; i < 5; i++)
     {
      lv[i + 2] = tp[i];
      lb[i + 2] = "TP" + IntegerToString(i + 1) + " - " + DoubleToString(tp[i], dg) +
                  "  (" + DoubleToString(FIB_TP[i], 3) + ")";
      lc[i + 2] = C'120,200,255';
     }
   for(int i = 0; i < 7; i++)
     {
      string n = PFX + "L" + IntegerToString(i);
      if(ObjectFind(0, n) < 0) ObjectCreate(0, n, OBJ_HLINE, 0, 0, lv[i]);
      ObjectSetDouble (0, n, OBJPROP_PRICE, lv[i]);
      ObjectSetInteger(0, n, OBJPROP_COLOR, lc[i]);
      ObjectSetInteger(0, n, OBJPROP_STYLE, i == 0 ? STYLE_SOLID : STYLE_DOT);
      ObjectSetInteger(0, n, OBJPROP_WIDTH, i <= 1 ? 2 : 1);
      ObjectSetInteger(0, n, OBJPROP_BACK, true);
      ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);

      string t = PFX + "LT" + IntegerToString(i);
      if(ObjectFind(0, t) < 0) ObjectCreate(0, t, OBJ_TEXT, 0, TimeCurrent(), lv[i]);
      ObjectSetInteger(0, t, OBJPROP_TIME, TimeCurrent());
      ObjectSetDouble (0, t, OBJPROP_PRICE, lv[i]);
      ObjectSetString (0, t, OBJPROP_TEXT, lb[i]);
      ObjectSetInteger(0, t, OBJPROP_COLOR, lc[i]);
      ObjectSetInteger(0, t, OBJPROP_FONTSIZE, 7);
      ObjectSetInteger(0, t, OBJPROP_ANCHOR, ANCHOR_LEFT_LOWER);
      ObjectSetInteger(0, t, OBJPROP_SELECTABLE, false);
     }
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
               const int &cons[], const int vFinal, const int vDecision, const double bullPct,
               const double waitPct, const double bearPct, const string sentiment,
               const double rsi, const double macdMain, const double macdSig,
               const double adx, const double atr, const double entry,
               const double sl, const double &tp[],
               const int dg, const long spreadPts, const bool mtfAgrees,
               const double volRatio, const double bbWidth,
               const int tfBuy, const int tfSell)
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
   // BOTH readings, because they can disagree and that disagreement is information.
   // 13:36 shot: Final Consensus SELL, AI Decision WAIT.
   j += "\"direction\":\"" + VerdictText(vDecision) + "\",";
   j += "\"finalConsensus\":\"" + VerdictText(vFinal) + "\",";
   j += "\"decisionAgreesWithConsensus\":" + ((vDecision == vFinal) ? "true" : "false") + ",";
   j += "\"confidence\":" + JNum(confidence, 1) + ",";
   j += "\"mtfAligned\":" + (mtfAgrees ? "true" : "false") + ",";
   j += "\"dominance\":{\"bullish\":" + JNum(bullPct,1) + ",\"wait\":" + JNum(waitPct,1) +
        ",\"bearish\":" + JNum(bearPct,1) + ",\"sentiment\":\"" + JStr(sentiment) + "\"},";
   j += "\"mtf\":{" + tfJson + "},";
   j += "\"consensus\":{" + consJson + "},";
   j += "\"indicators\":{\"rsi\":" + JNum(rsi,2) + ",\"macd\":" + JNum(macdMain,dg) +
        ",\"macdSignal\":" + JNum(macdSig,dg) + ",\"adx\":" + JNum(adx,2) +
        ",\"atr\":" + JNum(atr,dg) + ",\"spreadPoints\":" + IntegerToString(spreadPts) + "},";
   // THE FULL LADDER, with the ratio each level was built from, so a consumer can
   // check the geometry instead of trusting five bare numbers.
   string tpJson = "";
   for(int i = 0; i < 5; i++)
      tpJson += (i ? "," : "") + StringFormat("{\"level\":%d,\"fib\":%.3f,\"price\":%s}",
                                              i + 1, FIB_TP[i], JNum(tp[i], dg));
   double riskDist = MathAbs(entry - sl);
   j += "\"ticket\":" + (vFinal == V_WAIT ? "null" :
        ("{\"direction\":\"" + VerdictText(vFinal) + "\",\"entry\":" + JNum(entry,dg) +
         ",\"sl\":" + JNum(sl,dg) +
         ",\"riskDistance\":" + JNum(riskDist,dg) +
         ",\"tpBasis\":\"fibonacci extension of the entry-to-stop distance\"" +
         ",\"tp\":[" + tpJson + "]" +
         ",\"tp1\":" + JNum(tp[0],dg) + ",\"tp2\":" + JNum(tp[1],dg) +
         ",\"tp3\":" + JNum(tp[2],dg) + ",\"tp4\":" + JNum(tp[3],dg) +
         ",\"tp5\":" + JNum(tp[4],dg) + "}")) + ",";
   j += "\"evidence\":{\"volumeRatio\":" + JNum(volRatio,2) +
        ",\"bbWidthPct\":" + JNum(bbWidth,2) +
        ",\"tfBuy\":" + IntegerToString(tfBuy) +
        ",\"tfSell\":" + IntegerToString(tfSell) +
        ",\"tfWait\":" + IntegerToString(9 - tfBuy - tfSell) + "},";
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
