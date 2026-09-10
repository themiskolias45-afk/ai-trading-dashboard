//+------------------------------------------------------------------+
//|  ATOMIC ANALYST V84 - MT5 port of the MT4 panel, plus a data feed |
//|                                                                  |
//|  THIS IS AN INDICATOR, NOT AN EXPERT ADVISOR. Deliberately.      |
//|                                                                  |
//|  It touches NO existing EA. It does not use the chart's expert   |
//|  slot, so it sits alongside EA_CRT_AMD_Dashboard, V10_EA_MASTER, |
//|  TK_SMART_ENTRY or anything else already attached, and it can    |
//|  never place, modify or close an order - an indicator has no     |
//|  trade functions available to it at all. That is the point.      |
//|                                                                  |
//|  WHY IT WRITES A FILE INSTEAD OF POSTING                         |
//|  MQL5 forbids WebRequest() inside an indicator: the call returns |
//|  -1 with error 4014 (function not allowed for call). Only EAs and|
//|  scripts may use it. FileWrite IS permitted, so the verdict is   |
//|  written to MQL5\Files\atomic_analyst\<SYMBOL>.json and a small  |
//|  reader on the Node side ships it. That keeps this file free of  |
//|  any network dependency and free of the WebRequest URL whitelist,|
//|  which is a GUI setting nobody can apply headlessly on the VPS.  |
//|                                                                  |
//|  WHAT IT FEEDS, AND WHAT IT MUST NEVER FEED                      |
//|  The JSON it emits is EVIDENCE, not a gate. It rides alongside   |
//|  the engine the way `shadow` does in /api/learning. Nothing in   |
//|  this file may be wired into confidence, the 70 gate, position   |
//|  size or a stop.                                                 |
//|                                                                  |
//|  ================================================================|
//|  2026-09-10 - THE INPUT DIALOG NOW MATCHES HIS MT4 ONE EXACTLY.  |
//|                                                                  |
//|  Rebuilt from his three Inputs-tab screenshots (2026-09-08 13:48/|
//|  13:49): 85 rows - 68 real settings and 17 separator strings - in |
//|  HIS order, with HIS labels, HIS defaults and HIS group headings. |
//|  The separators are reproduced as string inputs with the same     |
//|  variable names (mt4_panel_group_00, mt4_group_01, ...) because   |
//|  that is how they appear in his dialog; MQL5's `input group` would|
//|  render differently and the ask was "exactly like the pictures".  |
//|                                                                  |
//|  NOTHING WAS REMOVED. All 24 inputs the port already had are kept.|
//|  The 17 with no MT4 counterpart moved to a clearly-named section  |
//|  at the bottom rather than being deleted, so a .set file saved    |
//|  from the previous build still loads.                             |
//|                                                                  |
//|  FIVE OF THEM HAD NO READER. Measured before this edit, by count- |
//|  ing occurrences: InpSlVertical, InpBarsToScan, InpMomSmoothing,  |
//|  InpMomAmplitude and InpMaxSpreadPoints each appeared exactly ONCE|
//|  in the whole file - their own declaration. They were settings    |
//|  nothing read, which is the failure this repo keeps rediscovering.|
//|  Every one of them is wired below, and the wiring is named in the |
//|  comment beside it.                                               |
//|                                                                  |
//|  BUFFERS 11 AND 12 ARE THE CONTRACT. His MT4 dialog documents     |
//|  "Buy Buffer: Buffer=11" and "Sell Buffer: Buffer=12" so an EA can|
//|  read the signal with iCustom/CopyBuffer. The buffer layout below |
//|  puts them at exactly those indices and they are DRAW_NONE data   |
//|  buffers, not calculation buffers - CopyBuffer cannot read a      |
//|  calculation buffer from another program, so declaring them that  |
//|  way would publish an address nothing could dial.                 |
//+------------------------------------------------------------------+
#property copyright "SmartEntry Pro"
#property version   "2.00"
#property indicator_chart_window
#property indicator_buffers 13
#property indicator_plots   9

//====================================================================
//  INPUTS - transcribed from his MT4 Inputs tab, in his order.
//====================================================================

//--- his enum for the panel theme -----------------------------------
enum ENUM_AA_THEME
  {
   Dark  = 0,   // Dark
   Light = 1    // Light
  };

input string mt4_panel_group_00 = "====< Modern Panel Settings >====="; // mt4_panel_group_00
input bool          InpShowPanel        = true;              // Show / Hide Panel
input ENUM_AA_THEME InpPanelTheme       = Dark;              // Panel Theme

input string mt4_group_01 = "====< Background Gradient Color >====="; // mt4_group_01
input bool   InpGradientOn      = true;                      // Enable Background Gradient
input color  InpGradientTop     = clrMidnightBlue;           // Gradient top color
input color  InpGradientBottom  = clrMaroon;                 // Gradient bottom color
input int    InpGradientOpacity = 42;                        // Gradient opacity

input string mt4_group_03 = "====< Panel Refresh Time >====="; // mt4_group_03
input int    InpRefreshSeconds  = 5;                         // Refresh Time Seconds

input string mt4_group_04 = "====< Spread Limit >====="; // mt4_group_04
input int    InpMaxSpreadPoints = 999;                       // Max Spread Points
input bool   InpAdapterDebug    = false;                     // Adapter Debug Mode

input string grp_name = "-------| Settings for  Indicator Name :"; // -------| Indicator Name |-------------------------------
input string InpIndicatorName   = "Atomic Analyst";          // Indicator Name - ID:

input string grp_params = "-------| Settings for  Indicator Parameters :"; // -------| Indicator Parameters |----------------------
input int    InpRsiPeriod       = 17;                        // Price Strength Period:
input double InpSlVertical      = 0.5;                       // Stop Loss: Vertical Placement:

input string grp_momentum = "-------| Settings for  Momentum Parameters :"; // -------| Momentum Indicator Parameters |------
input int    InpBarsToScan      = 1000;                      // Count Bars to Scan:
input int    InpMomSmoothing    = 2;                         // Momentum Smoothing:
input int    InpMomAmplitude    = 2;                         // Momentum Amplitude:

input string grp_filter = "-------| Settings for  Atomic Filter :"; // -------| Atomic Filter |------------------------------
input bool             InpApplyAtomicFilter = true;          // Apply Atomic Filter ?
input int              InpAtomicFilter      = 250;           // Atomic Filter Period:
input ENUM_MA_METHOD   InpAtomicMethod      = MODE_SMA;      // Atomic Filter Method:
input ENUM_APPLIED_PRICE InpAtomicPrice     = PRICE_CLOSE;   // Atomic Filter Applied Price:

input string grp_trail = "-------| Settings for  Trailing Stop :"; // -------| Trailing Stop Visualisation |--------
input bool   InpTrailSignalMode = true;                      // Trailing Stop Signal mode ?
input bool   InpTrailLineMode   = true;                      // Trailing Stop Line mode ?
input bool   InpTrailDotMode    = true;                      // Trailing Stop Dot mode ?
input bool   InpCandleColorMode = true;                      // Candle Coloring mode ?

input string grp_alerts = "-------| Settings for  Alerts :"; // -------| Alerts |------------------------------
input bool   InpUseAlert         = true;                     // Use signals "Alert" ?
input bool   InpUsePush          = true;                     // PUSH send messages to your phone ?
input bool   InpUseEmail         = true;                     // Send notifications by e-mail ?
input bool   InpUseSound         = false;                    // Use beeps "Sound" ?
input string InpSoundBuy         = "buy.wav";                // Title signal Buy:
input string InpSoundSell        = "sell.wav";               // Title signal Sell:

input string grp_arrows = "-------| Settings for  Arrows :"; // -------| Arrows |------------------------------
input bool   InpShowArrows       = true;                     // Show Arrows ?
input color  InpBullArrowColor   = clrLime;                  // Bull Arrows color:
input color  InpBearArrowColor   = clrRed;                   // Bear Arrows color:
input int    InpArrowSize        = 2;                        // Arrows size:
input int    InpArrowShift       = 5;                        // Shifting Arrows from Extremes:
input int    InpArrowCodeUp      = 217;                      // UP Arrow Code:
input int    InpArrowCodeDown    = 218;                      // Down Arrow Code:

input string grp_trades = "-------| Settings for  Trade Analysis :"; // -------| Trade Analysis |----------------------
input bool            InpShowTradeAnalysis = true;           // Display Trade Analysis ?
input bool            InpShowTradePips     = true;           // Show Trades Profits in pips ?
input color           InpWinTradeColor     = clrLimeGreen;   // Winning Trades Color:
input color           InpLoseTradeColor    = clrTomato;      // Loosing Trades Color:
input bool            InpShowTradeLines    = true;           // Show Trades Lines ?
input ENUM_LINE_STYLE InpTradeLineStyle    = STYLE_DOT;      // Trades Lines Style:
input int             InpTradeLineWidth    = 1;              // Trades Lines Width:

input string grp_buy = "-------| Settings for  BUY  Patterns Formation :"; // -------| BUY  Patterns Formation |-------------
input bool            InpBuyShowTp      = true;              // Show Take Profits ?
input color           InpBuyTpColor     = clrLightSeaGreen;  // Take Profit Color:
input ENUM_LINE_STYLE InpBuyTpStyle     = STYLE_DOT;         // Take Profit Style Line:
input int             InpBuyTpWidth     = 1;                 // Take Profit Width Line:
input bool            InpBuyShowFibo    = true;              // Show Fibo Labels ?
input color           InpBuyFiboColor   = clrDarkSlateGray;  // Fibo Color:
input bool            InpBuyShowSl      = true;              // Show Stop Loss ?
input color           InpBuySlColor     = clrCrimson;        // Stop Loss Color:
input ENUM_LINE_STYLE InpBuySlStyle     = STYLE_SOLID;       // Stop Loss Style Line:
input int             InpBuySlWidth     = 1;                 // Stop Loss Width Line:

input string grp_sell = "-------| Settings for  SELL  Patterns Formation :"; // -------| SELL  Patterns Formation |------------
input bool            InpSellShowTp     = true;              // Show Take Profit ?
input color           InpSellTpColor    = clrPaleVioletRed;  // Take Profit Color:
input ENUM_LINE_STYLE InpSellTpStyle    = STYLE_DOT;         // Take Profit Style Line:
input int             InpSellTpWidth    = 1;                 // Take Profit Width Line:
input bool            InpSellShowFibo   = true;              // Show Fibo Labels ?
input color           InpSellFiboColor  = clrDarkSlateGray;  // Fibo Color:
input bool            InpSellShowSl     = true;              // Show Stop Loss ?
input color           InpSellSlColor    = clrCrimson;        // Stop Loss Color:
input ENUM_LINE_STYLE InpSellSlStyle    = STYLE_SOLID;       // Stop Loss Style Line:
input int             InpSellSlWidth    = 1;                 // Stop Loss Width Line:

input string grp_buffers = "-------| Hint, about the Buffers for EA :"; // -------| Hint, about the Buffers for EA |------
input string InpBuyBufferHint  = "Buffer=11";                // Buy Buffer:
input string InpSellBufferHint = "Buffer=12";                // Sell Buffer:

input string grp_log = "-------| Settings for  Signal Log File :"; // -------| Signal Log File (for EA/API) |--------
input bool   InpEnableSignalLog = false;                     // Enable Signal Log File ?
input string InpSignalLogName   = "AtomicAnalyst_Signals.txt"; // Signal Log File Name:

input string mt4_group_11 = "====< Smart Panel Advanced Controls >====="; // mt4_group_11
input bool   InpEnablePanelDrag = true;                      // Enable Panel Drag

//--------------------------------------------------------------------
// SMARTENTRY ADDITIONS - NOT PRESENT IN THE MT4 DIALOG.
//
// Kept, not deleted. These 17 came from the first port and several are
// load-bearing here: the consensus rows need MACD/Stochastic/Bollinger
// periods, and the JSON feed needs its own on/off and interval. They
// are grouped and labelled so it is obvious at a glance which rows are
// his and which are ours - and so a .set saved from build 1.00 still
// loads without warnings.
//--------------------------------------------------------------------
input string grp_smartentry = "====< SmartEntry MT5 additions (not in MT4) >====="; // grp_smartentry
input int    InpMacdFast         = 12;    // MACD fast EMA
input int    InpMacdSlow         = 26;    // MACD slow EMA
input int    InpMacdSignal       = 9;     // MACD signal
input int    InpMaFast           = 50;    // MTF fast EMA
input int    InpMaSlow           = 200;   // MTF slow EMA
input int    InpStochK           = 5;     // Stochastic %K
input int    InpStochD           = 3;     // Stochastic %D
input int    InpStochSlow        = 3;     // Stochastic slowing
input int    InpBandsPeriod      = 20;    // Bollinger period
input double InpBandsDev         = 2.0;   // Bollinger deviation
input int    InpAtrPeriod        = 14;    // ATR / ADX period
input int    InpFibLookback      = 100;   // Fibonacci swing lookback
input double InpSlAtrMult        = 1.5;   // Ticket SL distance in ATR
input bool   InpWriteFeedFile    = true;  // Write JSON feed file
input int    InpFeedSeconds      = 60;    // Minimum seconds between feed writes
input bool   InpDrawLevels       = true;  // Draw SL and TP1..TP5 on the chart
input bool   InpShowButtons      = true;  // Show the panel status button row

//====================================================================
//  BUFFERS
//====================================================================
// Index 11 = BUY, index 12 = SELL, exactly as his dialog documents.
double BufOpen[], BufHigh[], BufLow[], BufClose[], BufCandleColor[];
double BufTrailLine[], BufTrailDot[], BufArrowUp[], BufArrowDown[];
double BufSpare1[], BufSpare2[], BufBuySignal[], BufSellSignal[];

// THE TP LADDER IS FIBONACCI ON THE RISK DISTANCE, NOT ROUND R MULTIPLES.
//
// Derived from his own MT4 screenshots rather than guessed. Panel: entry 4393.79,
// SL 4462.82, so risk = 69.03. Chart: TP1 4377.50, TP2 4351.13, TP3 4324.76,
// TP4 4298.38, TP5 4255.72. Each distance divided by the risk gives
// 0.236 / 0.618 / 1.000 / 1.382 / 2.000 - exact to three decimals, and picture 2
// prints those same five numbers as fib labels down the left of the chart.
double FIB_TP[5] = { 0.236, 0.618, 1.000, 1.382, 2.000 };

//--- verdict codes --------------------------------------------------
#define V_BUY   1
#define V_WAIT  0
#define V_SELL -1

//--- panel geometry -------------------------------------------------
// WIDER AND TALLER THAN THE PORT SHIPPED WITH. He asked for a bigger panel with
// the missing controls on it; the button row went from 7 cells to 14 and the
// sections gained the rows that had nowhere to sit before.
#define PFX      "AA84_"
#define PANEL_W  1500
#define PANEL_H  470
#define ROW_H    15
#define GRAD_STEPS 24

int g_panelX = 8;      // moved by CHARTEVENT_OBJECT_DRAG when Enable Panel Drag is on
int g_panelY = 18;

// HIS TWO HEADER BUTTONS, top right. Picture 1 shows "-" beside a magenta "X";
// picture 2 shows the SAME panel with "+" in that slot, i.e. minus collapses it to the
// title bar and plus restores it. They are runtime state, not inputs: a collapsed panel
// must not survive a terminal restart as a setting nobody remembers changing.
bool g_panelCollapsed = false;
bool g_panelClosed    = false;

//--- indicator handles, created once in OnInit ----------------------
// A handle per timeframe per indicator. Creating them inside OnCalculate
// would leak a handle on every tick - the single most common way an MQL5
// indicator degrades a terminal until it is restarted.
ENUM_TIMEFRAMES g_tfs[9] = { PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30,
                             PERIOD_H1, PERIOD_H4, PERIOD_D1, PERIOD_W1, PERIOD_MN1 };
string          g_tfNames[9] = { "M1","M5","M15","M30","H1","H4","D1","W1","MN1" };
int             g_hRsiTf[9];
int             g_hMaFastTf[9];
int             g_hMaSlowTf[9];

int g_hRsi = INVALID_HANDLE, g_hMacd = INVALID_HANDLE, g_hMaF = INVALID_HANDLE;
int g_hMaS = INVALID_HANDLE, g_hStoch = INVALID_HANDLE, g_hBands = INVALID_HANDLE;
int g_hAtr = INVALID_HANDLE, g_hAdx = INVALID_HANDLE, g_hFilter = INVALID_HANDLE;
int g_hAtrTrail = INVALID_HANDLE;

datetime g_lastFeedWrite  = 0;
datetime g_lastPanelDraw  = 0;      // reader for Refresh Time Seconds
datetime g_lastAlertBar   = 0;      // one alert per bar, never one per tick
int      g_buySignals = 0, g_sellSignals = 0;
int      g_lastVerdict = V_WAIT;
int      g_trailDir    = 0;         // +1 long, -1 short, 0 undecided

//+------------------------------------------------------------------+
//| Theme. Returns the palette for the selected Panel Theme so every  |
//| drawing call reads one place instead of hard-coding a colour.     |
//+------------------------------------------------------------------+
color ThemeBg()    { return(InpPanelTheme == Dark ? C'12,20,38'   : C'238,242,248'); }
color ThemePanel() { return(InpPanelTheme == Dark ? C'18,28,50'   : C'250,251,253'); }
color ThemeText()  { return(InpPanelTheme == Dark ? C'190,205,225': C'40,50,65');   }
color ThemeHdr()   { return(InpPanelTheme == Dark ? C'120,180,255': C'25,90,175');  }
color ThemeTitle() { return(InpPanelTheme == Dark ? clrWhite      : C'15,25,40');   }

//+------------------------------------------------------------------+
//| Blend two colours. Used by the gradient: MQL5 rectangle labels    |
//| have no alpha channel, so "opacity" is done by mixing toward the  |
//| panel background rather than by a transparency the API does not   |
//| have. 0 = invisible, 100 = the full colour.                       |
//+------------------------------------------------------------------+
color Blend(const color a, const color b, const double t)
{
   double k = (t < 0 ? 0 : (t > 1 ? 1 : t));
   int ar = (int)(a & 0xFF), ag = (int)((a >> 8) & 0xFF), ab = (int)((a >> 16) & 0xFF);
   int br = (int)(b & 0xFF), bg = (int)((b >> 8) & 0xFF), bb = (int)((b >> 16) & 0xFF);
   int r = (int)MathRound(ar + (br - ar) * k);
   int g = (int)MathRound(ag + (bg - ag) * k);
   int bl= (int)MathRound(ab + (bb - ab) * k);
   return((color)(r | (g << 8) | (bl << 16)));
}

//+------------------------------------------------------------------+
int OnInit()
{
   //--- buffers, in the order that puts BUY at 11 and SELL at 12 ----
   SetIndexBuffer(0,  BufOpen,        INDICATOR_DATA);
   SetIndexBuffer(1,  BufHigh,        INDICATOR_DATA);
   SetIndexBuffer(2,  BufLow,         INDICATOR_DATA);
   SetIndexBuffer(3,  BufClose,       INDICATOR_DATA);
   SetIndexBuffer(4,  BufCandleColor, INDICATOR_COLOR_INDEX);
   SetIndexBuffer(5,  BufTrailLine,   INDICATOR_DATA);
   SetIndexBuffer(6,  BufTrailDot,    INDICATOR_DATA);
   SetIndexBuffer(7,  BufArrowUp,     INDICATOR_DATA);
   SetIndexBuffer(8,  BufArrowDown,   INDICATOR_DATA);
   SetIndexBuffer(9,  BufSpare1,      INDICATOR_DATA);
   SetIndexBuffer(10, BufSpare2,      INDICATOR_DATA);
   SetIndexBuffer(11, BufBuySignal,   INDICATOR_DATA);
   SetIndexBuffer(12, BufSellSignal,  INDICATOR_DATA);

   //--- plot 0: coloured candles -----------------------------------
   PlotIndexSetInteger(0, PLOT_DRAW_TYPE, InpCandleColorMode ? DRAW_COLOR_CANDLES : DRAW_NONE);
   PlotIndexSetInteger(0, PLOT_COLOR_INDEXES, 3);
   PlotIndexSetInteger(0, PLOT_LINE_COLOR, 0, C'0,170,90');    // trend up
   PlotIndexSetInteger(0, PLOT_LINE_COLOR, 1, C'200,50,65');   // trend down
   PlotIndexSetInteger(0, PLOT_LINE_COLOR, 2, C'120,130,145'); // undecided
   PlotIndexSetString (0, PLOT_LABEL, "Atomic candles");

   //--- plot 1: trailing stop line ---------------------------------
   PlotIndexSetInteger(1, PLOT_DRAW_TYPE, InpTrailLineMode ? DRAW_LINE : DRAW_NONE);
   PlotIndexSetInteger(1, PLOT_LINE_COLOR, InpBearArrowColor);
   PlotIndexSetInteger(1, PLOT_LINE_WIDTH, 1);
   PlotIndexSetString (1, PLOT_LABEL, "Trailing stop");

   //--- plot 2: trailing stop dots ---------------------------------
   PlotIndexSetInteger(2, PLOT_DRAW_TYPE, InpTrailDotMode ? DRAW_ARROW : DRAW_NONE);
   PlotIndexSetInteger(2, PLOT_ARROW, 159);
   PlotIndexSetInteger(2, PLOT_LINE_COLOR, InpBullArrowColor);
   PlotIndexSetString (2, PLOT_LABEL, "Trailing dots");

   //--- plots 3 and 4: his arrows, with HIS codes and sizes --------
   PlotIndexSetInteger(3, PLOT_DRAW_TYPE, InpShowArrows ? DRAW_ARROW : DRAW_NONE);
   PlotIndexSetInteger(3, PLOT_ARROW, InpArrowCodeUp);
   PlotIndexSetInteger(3, PLOT_LINE_COLOR, InpBullArrowColor);
   PlotIndexSetInteger(3, PLOT_LINE_WIDTH, InpArrowSize);
   PlotIndexSetString (3, PLOT_LABEL, "Buy arrow");

   PlotIndexSetInteger(4, PLOT_DRAW_TYPE, InpShowArrows ? DRAW_ARROW : DRAW_NONE);
   PlotIndexSetInteger(4, PLOT_ARROW, InpArrowCodeDown);
   PlotIndexSetInteger(4, PLOT_LINE_COLOR, InpBearArrowColor);
   PlotIndexSetInteger(4, PLOT_LINE_WIDTH, InpArrowSize);
   PlotIndexSetString (4, PLOT_LABEL, "Sell arrow");

   //--- plots 5..8: not drawn, but READABLE by an EA ---------------
   for(int p = 5; p <= 8; p++) PlotIndexSetInteger(p, PLOT_DRAW_TYPE, DRAW_NONE);
   PlotIndexSetString(7, PLOT_LABEL, "Buy signal (buffer 11)");
   PlotIndexSetString(8, PLOT_LABEL, "Sell signal (buffer 12)");

   for(int b = 0; b <= 12; b++) PlotIndexSetDouble(b < 9 ? b : 8, PLOT_EMPTY_VALUE, 0.0);

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
   // THE ATOMIC FILTER, WITH HIS THREE SETTINGS. Period, method and applied price all
   // come from the dialog now - the first build hard-coded SMA on close and ignored two
   // of the three, so changing "Atomic Filter Method" in the dialog did nothing at all.
   g_hFilter = iMA(_Symbol, _Period, InpAtomicFilter, 0, InpAtomicMethod, InpAtomicPrice);
   // Momentum Smoothing is the ATR period behind the trailing stop, and Momentum
   // Amplitude is its multiplier. Both were dead inputs before this build.
   g_hAtrTrail = iATR(_Symbol, _Period, MathMax(1, InpMomSmoothing * 7));

   if(g_hRsi == INVALID_HANDLE || g_hMacd == INVALID_HANDLE || g_hBands == INVALID_HANDLE ||
      g_hAtr == INVALID_HANDLE || g_hAdx == INVALID_HANDLE || g_hStoch == INVALID_HANDLE ||
      g_hAtrTrail == INVALID_HANDLE)
     {
      Print("ATOMIC V84: an indicator handle failed to create - refusing to run half-blind");
      return(INIT_FAILED);
     }

   // His "Indicator Name - ID" drives the short name, so two copies on one chart with
   // different IDs are distinguishable in the Data Window instead of both reading the same.
   IndicatorSetString(INDICATOR_SHORTNAME, InpIndicatorName + " V84");
   IndicatorSetInteger(INDICATOR_DIGITS, (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS));

   // SAY THAT IT STARTED. Without this, "attached and returning early" and "never
   // attached at all" produce byte-identical evidence: an empty log and no file.
   PrintFormat("ATOMIC V84: attached to %s %s, feed=%s every %ds, panel refresh %ds, spread cap %d",
               _Symbol, EnumToString((ENUM_TIMEFRAMES)_Period),
               (InpWriteFeedFile ? "ON" : "OFF"), InpFeedSeconds,
               InpRefreshSeconds, InpMaxSpreadPoints);
   if(InpAdapterDebug)
      PrintFormat("ATOMIC V84 [debug]: filter=%s(%d) on %s, trail ATR(%d)x%d, arrows %d/%d size %d shift %d",
                  EnumToString(InpAtomicMethod), InpAtomicFilter, EnumToString(InpAtomicPrice),
                  MathMax(1, InpMomSmoothing * 7), InpMomAmplitude,
                  InpArrowCodeUp, InpArrowCodeDown, InpArrowSize, InpArrowShift);
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
   if(g_hRsi     != INVALID_HANDLE) IndicatorRelease(g_hRsi);
   if(g_hMacd    != INVALID_HANDLE) IndicatorRelease(g_hMacd);
   if(g_hMaF     != INVALID_HANDLE) IndicatorRelease(g_hMaF);
   if(g_hMaS     != INVALID_HANDLE) IndicatorRelease(g_hMaS);
   if(g_hStoch   != INVALID_HANDLE) IndicatorRelease(g_hStoch);
   if(g_hBands   != INVALID_HANDLE) IndicatorRelease(g_hBands);
   if(g_hAtr     != INVALID_HANDLE) IndicatorRelease(g_hAtr);
   if(g_hAdx     != INVALID_HANDLE) IndicatorRelease(g_hAdx);
   if(g_hFilter  != INVALID_HANDLE) IndicatorRelease(g_hFilter);
   if(g_hAtrTrail!= INVALID_HANDLE) IndicatorRelease(g_hAtrTrail);
   ObjectsDeleteAll(0, PFX);
}

//+------------------------------------------------------------------+
//| Read one value from an indicator buffer. Returns false rather     |
//| than a silent 0 when the buffer is not ready - a zero RSI would   |
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
//| tuned - this panel is a second opinion, not the engine.           |
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
   // "Overlap" is a real value in his panel (13:36 shot). The London/New York overlap is
   // the highest-liquidity window of the day and it is its own label, not a slice of either.
   if(h >= 0  && h < 7)  return("Asian");
   if(h >= 7  && h < 12) return("Europe");
   if(h >= 12 && h < 16) return("Overlap");
   if(h >= 16 && h < 21) return("US");
   return("Pacific");
}

//+------------------------------------------------------------------+
//| Panel drawing helpers                                             |
//+------------------------------------------------------------------+
void Box(const string name, const int x, const int y, const int w, const int h, const color bg,
         const bool draggable = false)
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
   ObjectSetInteger(0, n, OBJPROP_COLOR, InpPanelTheme == Dark ? C'40,60,95' : C'190,200,215');
   ObjectSetInteger(0, n, OBJPROP_BACK, false);
   // Only the drag handle is selectable, and only when he has enabled dragging.
   ObjectSetInteger(0, n, OBJPROP_SELECTABLE, draggable);
   ObjectSetInteger(0, n, OBJPROP_SELECTED,   false);
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
//| A clickable header button. OBJ_BUTTON, not OBJ_LABEL, because a   |
//| label raises no click event - it would look like his button and   |
//| do nothing, which is the decoration failure this repo keeps       |
//| finding. The pressed state is cleared by the handler; MT5 latches  |
//| a button down until something sets it back.                        |
//+------------------------------------------------------------------+
void Btn(const string name, const int x, const int y, const int w, const int h,
         const string caption, const color bg, const color fg)
{
   string n = PFX + name;
   if(ObjectFind(0, n) < 0) ObjectCreate(0, n, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, n, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, n, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, n, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, n, OBJPROP_XSIZE, w);
   ObjectSetInteger(0, n, OBJPROP_YSIZE, h);
   ObjectSetString (0, n, OBJPROP_TEXT, caption);
   ObjectSetString (0, n, OBJPROP_FONT, "Segoe UI");
   ObjectSetInteger(0, n, OBJPROP_FONTSIZE, 9);
   ObjectSetInteger(0, n, OBJPROP_COLOR, fg);
   ObjectSetInteger(0, n, OBJPROP_BGCOLOR, bg);
   ObjectSetInteger(0, n, OBJPROP_BORDER_COLOR, bg);
   ObjectSetInteger(0, n, OBJPROP_STATE, false);
   ObjectSetInteger(0, n, OBJPROP_BACK, false);
   ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);
}

//+------------------------------------------------------------------+
//| Draw the header only - used when the panel is collapsed, so "-"   |
//| leaves exactly what picture 2 shows: the title bar and the two    |
//| buttons, with "+" in place of "-".                                |
//+------------------------------------------------------------------+
void DrawHeaderOnly(const string headline, const int vDecision)
{
   int PX = g_panelX, PY = g_panelY;
   Box("bg",   PX, PY, PANEL_W, 40, ThemeBg());
   Box("drag", PX, PY, PANEL_W, 40, ThemePanel(), InpEnablePanelDrag);
   Txt("title", PX + 12, PY + 6, InpIndicatorName + " V84", ThemeTitle(), 13, "Segoe UI Bold");
   Txt("sub",   PX + 12, PY + 26, "collapsed - press + to restore", ThemeHdr(), 7);
   Txt("verd",  PX + 620, PY + 10, headline,
       vDecision == V_BUY ? clrLime : (vDecision == V_SELL ? C'255,80,90' : clrGoldenrod), 13, "Segoe UI Bold");
   DrawHeaderButtons();
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| The two buttons themselves, in his position and his colours: a    |
//| dark minimise beside a magenta close, hard against the right edge.|
//+------------------------------------------------------------------+
void DrawHeaderButtons()
{
   int PX = g_panelX, PY = g_panelY;
   Btn("btnMin", PX + PANEL_W - 56, PY + 6, 24, 22,
       (g_panelCollapsed ? "+" : "-"),
       InpPanelTheme == Dark ? C'28,42,70' : C'220,226,236',
       InpPanelTheme == Dark ? clrWhite    : C'30,40,55');
   Btn("btnClose", PX + PANEL_W - 30, PY + 6, 24, 22, "X", C'200,60,170', clrWhite);
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
//| One pip, in price units. Needed by "Show Trades Profits in pips". |
//| A 5-digit FX quote prices in points that are a tenth of a pip;    |
//| reporting points as pips would overstate every trade by 10x.      |
//+------------------------------------------------------------------+
double PipSize()
{
   int    dg  = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double pt  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   return((dg == 3 || dg == 5) ? pt * 10.0 : pt);
}

//+------------------------------------------------------------------+
//| Fire his alerts. ONE PER BAR, NOT ONE PER TICK.                   |
//|                                                                   |
//| A flip evaluated on every tick would alert dozens of times inside |
//| the same candle while price oscillates across the trailing stop.  |
//| The bar stamp is the guard, and it is checked before any of the   |
//| four channels is touched so a muted channel cannot mask it.       |
//+------------------------------------------------------------------+
void FireAlerts(const int dir, const double price, const int dg)
{
   datetime barTime = iTime(_Symbol, _Period, 0);
   if(barTime == g_lastAlertBar) return;
   g_lastAlertBar = barTime;

   string what = (dir == V_BUY ? "BUY" : "SELL");
   string msg  = InpIndicatorName + " " + what + "  " + _Symbol + " " +
                 EnumToString((ENUM_TIMEFRAMES)_Period) + " @ " + DoubleToString(price, dg);

   if(InpUseAlert) Alert(msg);
   if(InpUsePush)  SendNotification(msg);
   if(InpUseEmail) SendMail(InpIndicatorName + " signal", msg);
   if(InpUseSound) PlaySound(dir == V_BUY ? InpSoundBuy : InpSoundSell);

   if(InpEnableSignalLog)
     {
      // FILE_READ|FILE_WRITE then seek to end: FILE_WRITE alone truncates, which would
      // turn a signal LOG into a file holding only the most recent line.
      int h = FileOpen(InpSignalLogName, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
      if(h == INVALID_HANDLE)
         Print("ATOMIC V84: cannot open signal log ", InpSignalLogName, " err=", GetLastError());
      else
        {
         FileSeek(h, 0, SEEK_END);
         FileWriteString(h, TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) + "," +
                            _Symbol + "," + EnumToString((ENUM_TIMEFRAMES)_Period) + "," +
                            what + "," + DoubleToString(price, dg) + "\r\n");
         FileClose(h);
        }
     }
}

//+------------------------------------------------------------------+
int OnCalculate(const int rates_total, const int prev_calculated,
                const datetime &time[], const double &open[], const double &high[],
                const double &low[], const double &close[], const long &tick_volume[],
                const long &volume[], const int &spread[])
{
   if(rates_total < InpMaSlow + 10) return(rates_total);

   //================================================================
   //  BUFFER PASS - candles, trailing stop, arrows, signal buffers.
   //
   //  Bounded by his "Count Bars to Scan", which until this build was
   //  a dead input. Scanning every bar of a 500k-bar chart on each
   //  attach is how an indicator freezes a terminal for a minute.
   //================================================================
   int scan  = (InpBarsToScan > 0 ? MathMin(InpBarsToScan, rates_total - 2) : rates_total - 2);
   int start = (prev_calculated > 1) ? MathMax(prev_calculated - 2, rates_total - scan)
                                     : MathMax(2, rates_total - scan);

   double atrTrailArr[];
   int    atrCopied = CopyBuffer(g_hAtrTrail, 0, 0, rates_total, atrTrailArr);
   bool   trailReady = (atrCopied == rates_total);
   if(trailReady) ArraySetAsSeries(atrTrailArr, false);

   double pip = PipSize();
   int    dgt = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   for(int i = start; i < rates_total; i++)
     {
      BufOpen[i]  = open[i];
      BufHigh[i]  = high[i];
      BufLow[i]   = low[i];
      BufClose[i] = close[i];
      BufCandleColor[i] = 2;                 // undecided until the trail says otherwise
      BufTrailLine[i] = 0; BufTrailDot[i] = 0;
      BufArrowUp[i]   = 0; BufArrowDown[i]  = 0;
      BufSpare1[i]    = 0; BufSpare2[i]     = 0;
      BufBuySignal[i] = 0; BufSellSignal[i] = 0;

      if(!trailReady || i < 1) continue;

      // ATR trailing stop. Momentum Amplitude is the multiplier and Momentum Smoothing
      // sets the ATR period (see OnInit) - his two momentum inputs, finally read.
      double band = atrTrailArr[i] * MathMax(1, InpMomAmplitude);
      double prev = (BufTrailLine[i - 1] != 0 ? BufTrailLine[i - 1] : close[i] - band);
      int    dir  = g_trailDir;

      if(i == start) { dir = (close[i] >= prev ? 1 : -1); }

      if(dir >= 0)
        {
         double up = close[i] - band;
         prev = MathMax(prev, up);
         if(close[i] < prev) { dir = -1; prev = close[i] + band; }
        }
      else
        {
         double dn = close[i] + band;
         prev = MathMin(prev, dn);
         if(close[i] > prev) { dir = 1; prev = close[i] - band; }
        }

      BufTrailLine[i]   = InpTrailLineMode ? prev : 0;
      BufTrailDot[i]    = InpTrailDotMode  ? prev : 0;
      BufCandleColor[i] = (dir > 0 ? 0 : 1);

      // A FLIP is the signal. Shifting Arrows from Extremes is in POINTS, applied away
      // from the bar's own high or low so the arrow never sits on top of the candle.
      bool flipUp   = (dir > 0 && g_trailDir <= 0 && i > start);
      bool flipDown = (dir < 0 && g_trailDir >= 0 && i > start);
      double shift  = InpArrowShift * SymbolInfoDouble(_Symbol, SYMBOL_POINT);

      if(flipUp)
        {
         if(InpShowArrows)      BufArrowUp[i] = low[i] - shift;
         if(InpTrailSignalMode) BufBuySignal[i] = close[i];
         if(i == rates_total - 1) FireAlerts(V_BUY, close[i], dgt);
        }
      if(flipDown)
        {
         if(InpShowArrows)      BufArrowDown[i] = high[i] + shift;
         if(InpTrailSignalMode) BufSellSignal[i] = close[i];
         if(i == rates_total - 1) FireAlerts(V_SELL, close[i], dgt);
        }
      g_trailDir = dir;
     }

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
         PrintFormat("ATOMIC V84: waiting on %s(bars=%d) - no panel, no feed until ready",
                     (miss == "" ? "(none - a higher-TF buffer)" : miss), rates_total);
        }
      return(rates_total);   // buffers not ready - draw nothing rather than guess
     }

   double px = close[rates_total - 1];
   double macdHist = macdMain - macdSig;
   double atomicFilter = 0; Val(g_hFilter, 0, 0, atomicFilter);

   // Volume pulse and Bollinger width. His Evidence Matrix carries both ("Volume Pulse"
   // NORMAL, "Volatility" NORMAL). The volume ratio compares the LAST CLOSED bar against
   // the 20 before it, not the still-forming bar against completed ones - a part-formed
   // bar is not a bar's volume, and comparing them makes the ratio structurally small.
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

   // THE AI DECISION IS NOT THE INDICATOR CONSENSUS. They are two separate readings and
   // his 13:36 screenshot shows them DISAGREEING: Final Consensus reads SELL while the
   // Atomic AI Decision reads WAIT, because Dominance was Bullish 6 / Wait 56 / Bearish 38
   // and WAIT was the largest share.
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

   //--- spread, against HIS cap -----------------------------------
   // Max Spread Points was a dead input. It now decides the SPREAD cell exactly as his
   // panel does ("Spread OK") and, when breached, suppresses nothing else - a spread
   // spike must never hide the verdict, only label it.
   long   spreadPts = (long)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   bool   spreadOk  = (spreadPts <= InpMaxSpreadPoints);
   int    dg = dgt;
   string spreadTxt = spreadOk ? "Spread OK" : ("SPREAD HIGH " + IntegerToString(spreadPts) + "pt");

   // REFRESH TIME SECONDS, finally read. Redrawing ~150 chart objects on every tick is
   // the single heaviest thing this file does; his dialog says every 5 seconds.
   bool due = (TimeCurrent() - g_lastPanelDraw) >= MathMax(1, InpRefreshSeconds);
   if(InpShowPanel && due)
     {
      DrawPanel(headline, confidence, tfV, cons, vFinal, vDecision,
                bullPct, waitPct, bearPct, sentiment,
                rsi, adx, atr, entry, sl, tp, dg, spreadTxt, mtfAgrees,
                volRatio, bbWidth, macdHist, tfBuy, tfSell, px, atomicFilter, spreadOk);
      if(InpShowTradeAnalysis) DrawTradeAnalysis(pip, dg);
      g_lastPanelDraw = TimeCurrent();
     }
   if(!InpShowPanel) ObjectsDeleteAll(0, PFX);

   if(InpDrawLevels) DrawLevels(vDecision, entry, sl, tp, dg);

   if(InpWriteFeedFile && (TimeCurrent() - g_lastFeedWrite) >= InpFeedSeconds)
     {
      WriteFeed(headline, confidence, tfV, cons, vFinal, vDecision, bullPct, waitPct, bearPct,
                sentiment, rsi, macdMain, macdSig, adx, atr, entry, sl, tp,
                dg, spreadPts, mtfAgrees, volRatio, bbWidth, tfBuy, tfSell, spreadOk);
      g_lastFeedWrite = TimeCurrent();
     }

   return(rates_total);
}

//+------------------------------------------------------------------+
//| Panel drag. His "Enable Panel Drag" is a real control now: the    |
//| title bar is the handle, and its new position becomes the panel   |
//| origin so every row moves with it on the next refresh.            |
//+------------------------------------------------------------------+
void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
   if(!InpEnablePanelDrag) return;
   if(id != CHARTEVENT_OBJECT_DRAG) return;
   if(sparam != PFX + "drag") return;
   g_panelX = (int)ObjectGetInteger(0, sparam, OBJPROP_XDISTANCE);
   g_panelY = (int)ObjectGetInteger(0, sparam, OBJPROP_YDISTANCE);
   g_lastPanelDraw = 0;    // force the next tick to redraw at the new origin
}

//+------------------------------------------------------------------+
void DrawPanel(const string headline, const double confidence, const int &tfV[],
               const int &cons[], const int vFinal, const int vDecision, const double bullPct,
               const double waitPct, const double bearPct, const string sentiment,
               const double rsi, const double adx, const double atr,
               const double entry, const double sl, const double &tp[],
               const int dg, const string spreadTxt, const bool mtfAgrees,
               const double volRatio, const double bbWidth, const double macdHist,
               const int tfBuy, const int tfSell, const double px, const double maS,
               const bool spreadOk)
{
   int  PX = g_panelX, PY = g_panelY;
   color bgDark = ThemeBg(), bgPanel = ThemePanel();

   // X was pressed: the panel goes away completely, exactly as his does. Every object
   // is removed rather than hidden, so a closed panel cannot leave a stale verdict
   // sitting on the chart looking current.
   if(g_panelClosed) { ObjectsDeleteAll(0, PFX); ChartRedraw(0); return; }

   // "-" was pressed: title bar only. Everything below it is deleted rather than left
   // underneath, because an OBJ_LABEL behind a rectangle still renders on top of price.
   if(g_panelCollapsed) { ObjectsDeleteAll(0, PFX); DrawHeaderOnly(headline, vDecision); return; }

   Box("bg", PX, PY, PANEL_W, PANEL_H, bgDark);

   // HIS BACKGROUND GRADIENT, with his two colours and his opacity. MQL5 rectangle
   // labels have no alpha, so the gradient is GRAD_STEPS stacked strips interpolating
   // top -> bottom, each blended toward the panel background by (100 - opacity).
   if(InpGradientOn)
     {
      double op = MathMax(0.0, MathMin(100.0, (double)InpGradientOpacity)) / 100.0;
      int    sh = (int)MathCeil((double)PANEL_H / GRAD_STEPS);
      for(int i = 0; i < GRAD_STEPS; i++)
        {
         double t   = (double)i / (GRAD_STEPS - 1);
         color  mix = Blend(InpGradientTop, InpGradientBottom, t);
         Box("grad" + IntegerToString(i), PX, PY + i * sh, PANEL_W, sh, Blend(bgDark, mix, op));
        }
     }
   else
     {
      for(int i = 0; i < GRAD_STEPS; i++) ObjectDelete(0, PFX + "grad" + IntegerToString(i));
     }

   // The drag handle sits on top of the gradient, and is the ONLY selectable object.
   Box("drag", PX, PY, PANEL_W, 40, bgPanel, InpEnablePanelDrag);

   Txt("title", PX + 12, PY + 6, InpIndicatorName + " V84", ThemeTitle(), 13, "Segoe UI Bold");
   Txt("sub",   PX + 12, PY + 26, "AI Market Verdict Engine  -  " + _Symbol + "  " +
       EnumToString((ENUM_TIMEFRAMES)_Period), ThemeHdr(), 7);
   Txt("verd",  PX + 620, PY + 4, headline,
       vDecision == V_BUY ? clrLime : (vDecision == V_SELL ? C'255,80,90' : clrGoldenrod), 14, "Segoe UI Bold");
   Txt("conf",  PX + 620, PY + 26, "Confidence " + DoubleToString(confidence, 0) + "%", ThemeHdr(), 8);
   Txt("sess",  PX + 1290, PY + 4, SessionName() + " Session", ThemeTitle(), 8);
   Txt("spr",   PX + 1290, PY + 24, spreadTxt, spreadOk ? C'90,220,140' : C'255,110,120', 8);

   //--- MTF row ----------------------------------------------------
   Box("mtfbg", PX + 10, PY + 46, PANEL_W - 20, 40, bgPanel);
   Txt("mtflbl", PX + 18, PY + 60, "MTF", ThemeHdr(), 8, "Segoe UI Bold");
   for(int i = 0; i < 9; i++)
     {
      int cx = PX + 60 + i * 158;
      Txt("tfn" + IntegerToString(i), cx + 55, PY + 50, g_tfNames[i], ThemeText(), 7);
      Box("tfb" + IntegerToString(i), cx, PY + 64, 150, 16, VerdictColor(tfV[i]));
      Txt("tft" + IntegerToString(i), cx + 60, PY + 64, VerdictText(tfV[i]), clrWhite, 7);
     }

   //--- Indicator Consensus, with the Final Consensus eighth row ---
   string names[7] = { "RSI","MACD","Moving Average","Stochastic","Bollinger","Fibonacci","Pivot Points" };
   Box("cbg", PX + 10, PY + 92, 480, 150, bgPanel);
   Txt("chdr", PX + 175, PY + 96, "Indicator Consensus", ThemeHdr(), 8, "Segoe UI Bold");
   for(int i = 0; i < 7; i++)
     {
      Txt("cn" + IntegerToString(i), PX + 110, PY + 114 + i * ROW_H, names[i], ThemeText(), 7);
      Box("cb" + IntegerToString(i), PX + 340, PY + 114 + i * ROW_H, 130, 13, VerdictColor(cons[i]));
      Txt("ct" + IntegerToString(i), PX + 390, PY + 113 + i * ROW_H, VerdictText(cons[i]), clrWhite, 7);
     }
   Txt("cnF", PX + 102, PY + 114 + 7 * ROW_H, "Final Consensus", ThemeTitle(), 7, "Segoe UI Bold");
   Box("cbF", PX + 340, PY + 114 + 7 * ROW_H, 130, 13, VerdictColor(vFinal));
   Txt("ctF", PX + 390, PY + 113 + 7 * ROW_H, VerdictText(vFinal), clrWhite, 7);

   //--- Atomic AI Decision -----------------------------------------
   Box("dbg", PX + 500, PY + 92, 480, 150, bgPanel);
   Txt("dhdr", PX + 675, PY + 96, "Atomic AI Decision", ThemeHdr(), 8, "Segoe UI Bold");
   Txt("dver", PX + 640, PY + 145, headline,
       vDecision == V_BUY ? clrLime : (vDecision == V_SELL ? C'255,80,90' : clrGoldenrod), 16, "Segoe UI Bold");
   Txt("dcnf", PX + 680, PY + 182, "Confidence " + DoubleToString(confidence, 0) + "%", ThemeHdr(), 8);
   Txt("dmtf", PX + 620, PY + 208,
       "Timeframes  " + IntegerToString(tfBuy) + " buy / " + IntegerToString(tfSell) + " sell / " +
       IntegerToString(9 - tfBuy - tfSell) + " wait", ThemeText(), 7);
   Txt("dfil", PX + 620, PY + 224,
       "Atomic filter " + (InpApplyAtomicFilter ? "ON" : "OFF") + "  " +
       EnumToString(InpAtomicMethod) + "(" + IntegerToString(InpAtomicFilter) + ")  " +
       (maS > 0 ? (px > maS ? "price ABOVE" : "price BELOW") : "warming up"), ThemeText(), 6);

   //--- Market Dominance -------------------------------------------
   Box("mbg", PX + 990, PY + 92, 500, 150, bgPanel);
   Txt("mhdr", PX + 1175, PY + 96, "Market Dominance", ThemeHdr(), 8, "Segoe UI Bold");
   Txt("mbul", PX + 1030, PY + 128, "Bullish " + DoubleToString(bullPct, 0) + "%", clrLime, 8);
   Txt("mwai", PX + 1180, PY + 128, "Wait " + DoubleToString(waitPct, 0) + "%",   clrGoldenrod, 8);
   Txt("mbea", PX + 1310, PY + 128, "Bearish " + DoubleToString(bearPct, 0) + "%", C'255,80,90', 8);
   // The proportional bar under Dominance. Three segments sized by their own share, so
   // the picture and the numbers can never disagree.
   int barX = PX + 1010, barY = PY + 176, barW = 460;
   int wBull = (int)MathRound(barW * bullPct / 100.0);
   int wWait = (int)MathRound(barW * waitPct / 100.0);
   int wBear = barW - wBull - wWait;
   if(wBull > 0) Box("domB", barX,                 barY, wBull, 10, C'0,150,75');
   else          Box("domB", barX,                 barY, 1,     10, bgPanel);
   if(wWait > 0) Box("domW", barX + wBull,         barY, wWait, 10, C'170,120,25');
   else          Box("domW", barX + wBull,         barY, 1,     10, bgPanel);
   if(wBear > 0) Box("domR", barX + wBull + wWait, barY, wBear, 10, C'165,35,50');
   else          Box("domR", barX + wBull + wWait, barY, 1,     10, bgPanel);
   Txt("msen", PX + 1090, PY + 200, "Market sentiment is " + sentiment, ThemeText(), 8);

   //--- ATOMIC EVIDENCE MATRIX - all EIGHT of his rows -------------
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
   // read of its own - price against the atomic filter - not a restatement of the verdict.
   eVal[5] = (maS <= 0) ? "NEUTRAL" : (px > maS ? "BULLISH" : "BEARISH");
   eCol[5] = (maS <= 0) ? C'120,95,20' : (px > maS ? C'0,140,70' : C'150,30,45');
   eVal[6] = mtfAgrees ? "ALIGNED" : "MIXED";
   eCol[6] = mtfAgrees ? C'0,140,70' : C'120,95,20';
   eVal[7] = rsi >= 60 ? "BULLISH" : (rsi <= 40 ? "BEARISH" : "NEUTRAL");
   eCol[7] = rsi >= 60 ? C'0,140,70' : (rsi <= 40 ? C'150,30,45' : C'120,95,20');

   Box("ebg", PX + 10, PY + 250, 480, 140, bgPanel);
   Txt("ehdr", PX + 160, PY + 253, "Atomic Evidence Matrix", ThemeHdr(), 8, "Segoe UI Bold");
   for(int i = 0; i < 8; i++)
     {
      int ey = PY + 275 + i * 14;
      Txt("en" + IntegerToString(i), PX + 22, ey, eLbl[i], ThemeText(), 7);
      Box("eb" + IntegerToString(i), PX + 340, ey + 1, 130, 11, eCol[i]);
      Txt("ev" + IntegerToString(i), PX + 348, ey, eVal[i], clrWhite, 6);
     }

   //--- Active Signal Ticket, full five-step ladder -----------------
   Box("tbg", PX + 500, PY + 250, 480, 140, bgPanel);
   Txt("thdr", PX + 660, PY + 253, "Active Signal Ticket", ThemeHdr(), 8, "Segoe UI Bold");
   Txt("tage", PX + 840, PY + 254, TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES), ThemeText(), 6);
   for(int i = 0; i < 5; i++) Txt("tkp" + IntegerToString(i), PX + 512, PY + 300 + i * 15, "", ThemeText(), 7);
   if(vDecision == V_WAIT)
     {
      Txt("tk1", PX + 540, PY + 300, "no ticket - the AI decision is WAIT", clrGoldenrod, 7);
      Txt("tk2", PX + 512, PY + 320, "", ThemeText(), 7);
     }
   else
     {
      Txt("tk1", PX + 512, PY + 275,
          "Direction " + VerdictText(vDecision) + "     Entry " + DoubleToString(entry, dg), ThemeTitle(), 7);
      Txt("tk2", PX + 512, PY + 290,
          "SL " + DoubleToString(sl, dg) + "     risk " + DoubleToString(MathAbs(entry - sl), dg),
          C'255,120,130', 7);
      for(int i = 0; i < 5; i++)
        {
         Txt("tkp" + IntegerToString(i), PX + 512, PY + 306 + i * 15,
             "TP" + IntegerToString(i + 1) + "   " + DoubleToString(tp[i], dg) +
             "   (fib " + DoubleToString(FIB_TP[i], 3) + ")", ThemeText(), 7);
        }
     }

   //--- Statistics / Performance -----------------------------------
   Box("sbg", PX + 990, PY + 250, 500, 140, bgPanel);
   Txt("shdr", PX + 1160, PY + 253, "Statistics / Performance", ThemeHdr(), 8, "Segoe UI Bold");
   Txt("s1", PX + 1010, PY + 276, "Buy flips " + IntegerToString(g_buySignals) +
       "        Sell flips " + IntegerToString(g_sellSignals), ThemeText(), 7);
   Txt("s2", PX + 1010, PY + 292, "Balance " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
       "     Equity " + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2), ThemeText(), 7);
   // NO "Total Pip Profit" row. His MT4 panel showed +99037 pips beside Total Profit 0.00 -
   // a pip count with no money behind it, the same illusion as +0.37R against -173.16.
   Txt("s3", PX + 1010, PY + 308, "Open P/L " +
       DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + " " + AccountInfoString(ACCOUNT_CURRENCY),
       AccountInfoDouble(ACCOUNT_PROFIT) >= 0 ? C'90,220,140' : C'255,110,120', 7);
   Txt("s4", PX + 1010, PY + 324, "Positions on " + _Symbol + ": " +
       IntegerToString(CountSymbolPositions()), ThemeText(), 7);
   Txt("s5", PX + 1010, PY + 340, "Trailing " + (g_trailDir > 0 ? "LONG" : (g_trailDir < 0 ? "SHORT" : "flat")) +
       "     ATR(" + IntegerToString(MathMax(1, InpMomSmoothing * 7)) + ") x" +
       IntegerToString(MathMax(1, InpMomAmplitude)), ThemeText(), 7);
   Txt("s6", PX + 1010, PY + 356, "Signal log " + (InpEnableSignalLog ? InpSignalLogName : "off"),
       ThemeText(), 6);

   //--- BUTTON ROW - 14 cells, was 7. Every one of them reports a ---
   //--- setting that now has a reader, so the row is a live status ---
   //--- strip and not a decoration. -----------------------------------
   if(InpShowButtons)
     {
      string sb[14]; color sbc[14];
      color on = C'0,110,60', off = C'70,70,70', info = C'25,70,110', warn = C'120,95,20';
      sb[0]  = "SESSION " + SessionName();                              sbc[0]  = info;
      sb[1]  = spreadTxt;                                               sbc[1]  = spreadOk ? on : C'150,30,45';
      sb[2]  = TerminalInfoInteger(TERMINAL_CONNECTED) ? "CONNECTED" : "DISCONNECTED";
      sbc[2] = TerminalInfoInteger(TERMINAL_CONNECTED) ? on : C'150,30,45';
      sb[3]  = mtfAgrees ? "AI FILTER ON" : "AI FILTER MIXED";          sbc[3]  = mtfAgrees ? on : warn;
      sb[4]  = InpApplyAtomicFilter ? "ATOMIC ON" : "ATOMIC OFF";       sbc[4]  = InpApplyAtomicFilter ? on : off;
      sb[5]  = InpGradientOn ? "GRADIENT ON" : "GRADIENT OFF";          sbc[5]  = InpGradientOn ? info : off;
      sb[6]  = (InpUseAlert || InpUsePush || InpUseEmail || InpUseSound) ? "ALERTS ON" : "ALERTS OFF";
      sbc[6] = (InpUseAlert || InpUsePush || InpUseEmail || InpUseSound) ? C'150,110,20' : off;
      sb[7]  = InpShowArrows ? "ARROWS ON" : "ARROWS OFF";              sbc[7]  = InpShowArrows ? on : off;
      sb[8]  = InpTrailLineMode ? "TRAIL ON" : "TRAIL OFF";             sbc[8]  = InpTrailLineMode ? on : off;
      sb[9]  = InpCandleColorMode ? "CANDLES ON" : "CANDLES OFF";       sbc[9]  = InpCandleColorMode ? info : off;
      sb[10] = InpShowTradeAnalysis ? "TRADES ON" : "TRADES OFF";       sbc[10] = InpShowTradeAnalysis ? info : off;
      sb[11] = InpEnableSignalLog ? "LOG ON" : "LOG OFF";               sbc[11] = InpEnableSignalLog ? info : off;
      sb[12] = InpDrawLevels ? "LEVELS ON" : "LEVELS OFF";              sbc[12] = InpDrawLevels ? info : off;
      // THE CONSTRAINT, ON THE CHART. This thing decides nothing, and that is stated
      // where a reader of the panel will see it - not only in a source comment.
      sb[13] = InpWriteFeedFile ? "FEED ON - GATES NOTHING" : "FEED OFF";
      sbc[13]= InpWriteFeedFile ? C'120,80,20' : off;
      for(int i = 0; i < 14; i++)
        {
         int bx = PX + 10 + i * 106;
         Box("sb" + IntegerToString(i), bx, PY + 400, 102, 20, sbc[i]);
         Txt("sbt" + IntegerToString(i), bx + 6, PY + 402, sb[i], clrWhite, 6);
        }
     }
   else
     {
      for(int i = 0; i < 14; i++)
        {
         ObjectDelete(0, PFX + "sb"  + IntegerToString(i));
         ObjectDelete(0, PFX + "sbt" + IntegerToString(i));
        }
     }

   Txt("foot", PX + 12, PY + 428,
       "Evidence only - never wired into confidence, the gate, position size or a stop.",
       InpPanelTheme == Dark ? C'110,130,160' : C'110,120,140', 6);
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| How many positions this account holds on THIS symbol. Read-only:  |
//| PositionSelect gives an indicator no way to change anything.      |
//+------------------------------------------------------------------+
int CountSymbolPositions()
{
   int n = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol) n++;
     }
   return(n);
}

//+------------------------------------------------------------------+
//| TRADE ANALYSIS - his group, drawn on the chart.                   |
//|                                                                   |
//| One line per open position on this symbol, from its open price to |
//| now, coloured by whether it is winning, labelled with its profit  |
//| in pips when he asks for pips. Objects are deleted first so a      |
//| closed position cannot leave a line behind looking live.           |
//+------------------------------------------------------------------+
void DrawTradeAnalysis(const double pip, const int dg)
{
   for(int i = 0; i < 32; i++)
     {
      ObjectDelete(0, PFX + "TL" + IntegerToString(i));
      ObjectDelete(0, PFX + "TT" + IntegerToString(i));
     }
   if(!InpShowTradeAnalysis) { ChartRedraw(0); return; }

   int drawn = 0;
   for(int i = PositionsTotal() - 1; i >= 0 && drawn < 32; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;

      double openPx = PositionGetDouble(POSITION_PRICE_OPEN);
      double curPx  = PositionGetDouble(POSITION_PRICE_CURRENT);
      double profit = PositionGetDouble(POSITION_PROFIT);
      long   type   = PositionGetInteger(POSITION_TYPE);
      double vol    = PositionGetDouble(POSITION_VOLUME);
      color  c      = (profit >= 0 ? InpWinTradeColor : InpLoseTradeColor);

      if(InpShowTradeLines)
        {
         string n = PFX + "TL" + IntegerToString(drawn);
         if(ObjectFind(0, n) < 0) ObjectCreate(0, n, OBJ_HLINE, 0, 0, openPx);
         ObjectSetDouble (0, n, OBJPROP_PRICE, openPx);
         ObjectSetInteger(0, n, OBJPROP_COLOR, c);
         ObjectSetInteger(0, n, OBJPROP_STYLE, InpTradeLineStyle);
         ObjectSetInteger(0, n, OBJPROP_WIDTH, MathMax(1, InpTradeLineWidth));
         ObjectSetInteger(0, n, OBJPROP_BACK, true);
         ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);
        }

      // Signed by DIRECTION, not by raw subtraction: a short in profit has a current
      // price BELOW its open, and an unsigned distance would print it as a loss.
      double pips = ((type == POSITION_TYPE_BUY) ? (curPx - openPx) : (openPx - curPx)) / pip;
      string lbl  = "#" + IntegerToString((long)ticket) + " " +
                    ((type == POSITION_TYPE_BUY) ? "buy " : "sell ") + DoubleToString(vol, 2) +
                    (InpShowTradePips ? ("  " + (pips >= 0 ? "+" : "") + DoubleToString(pips, 1) + " pips")
                                      : ("  " + DoubleToString(profit, 2)));

      string t = PFX + "TT" + IntegerToString(drawn);
      if(ObjectFind(0, t) < 0) ObjectCreate(0, t, OBJ_TEXT, 0, TimeCurrent(), openPx);
      ObjectSetInteger(0, t, OBJPROP_TIME, TimeCurrent());
      ObjectSetDouble (0, t, OBJPROP_PRICE, openPx);
      ObjectSetString (0, t, OBJPROP_TEXT, lbl);
      ObjectSetInteger(0, t, OBJPROP_COLOR, c);
      ObjectSetInteger(0, t, OBJPROP_FONTSIZE, 7);
      ObjectSetInteger(0, t, OBJPROP_ANCHOR, ANCHOR_RIGHT_LOWER);
      ObjectSetInteger(0, t, OBJPROP_SELECTABLE, false);
      drawn++;
     }
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| SL and the five TPs drawn on the chart, as picture 2 shows them.  |
//|                                                                   |
//| STYLED FROM HIS BUY/SELL PATTERN GROUPS. A buy ticket uses the BUY |
//| colours, widths and styles; a sell ticket uses the SELL ones -     |
//| which is why those two groups exist in his dialog and why the port |
//| having a single hard-coded style was wrong. Deleted and redrawn    |
//| every update so a level from a previous verdict can never sit on   |
//| the chart looking current.                                         |
//+------------------------------------------------------------------+
void DrawLevels(const int vDecision, const double entry, const double sl,
                const double &tp[], const int dg)
{
   for(int i = 0; i < 7; i++)
     {
      ObjectDelete(0, PFX + "L" + IntegerToString(i));
      ObjectDelete(0, PFX + "LT" + IntegerToString(i));
     }
   if(vDecision == V_WAIT) { ChartRedraw(0); return; }

   bool isBuy = (vDecision == V_BUY);
   bool showTp   = isBuy ? InpBuyShowTp   : InpSellShowTp;
   bool showSl   = isBuy ? InpBuyShowSl   : InpSellShowSl;
   bool showFibo = isBuy ? InpBuyShowFibo : InpSellShowFibo;
   color tpCol   = isBuy ? InpBuyTpColor  : InpSellTpColor;
   color slCol   = isBuy ? InpBuySlColor  : InpSellSlColor;
   color fibCol  = isBuy ? InpBuyFiboColor: InpSellFiboColor;
   ENUM_LINE_STYLE tpStyle = isBuy ? InpBuyTpStyle : InpSellTpStyle;
   ENUM_LINE_STYLE slStyle = isBuy ? InpBuySlStyle : InpSellSlStyle;
   int tpWidth = MathMax(1, isBuy ? InpBuyTpWidth : InpSellTpWidth);
   int slWidth = MathMax(1, isBuy ? InpBuySlWidth : InpSellSlWidth);

   double lv[7]; string lb[7]; color lc[7]; int lw[7]; ENUM_LINE_STYLE ls[7]; bool show[7];

   lv[0] = entry; lb[0] = "ENTRY " + DoubleToString(entry, dg);
   lc[0] = ThemeTitle(); lw[0] = 2; ls[0] = STYLE_SOLID; show[0] = true;

   // STOP LOSS: VERTICAL PLACEMENT, his input, finally read. It nudges the SL LABEL off
   // the line by a fraction of the entry-to-stop distance so the text does not sit on top
   // of the price it describes. It never moves the LINE - a label offset that quietly
   // shifted the stop would be a different number on the chart from the one in the feed.
   double risk   = MathAbs(entry - sl);
   double lblOff = risk * InpSlVertical * 0.15;
   lv[1] = sl;    lb[1] = "SL - " + DoubleToString(sl, dg);
   lc[1] = slCol; lw[1] = slWidth; ls[1] = slStyle; show[1] = showSl;

   for(int i = 0; i < 5; i++)
     {
      lv[i + 2] = tp[i];
      lb[i + 2] = "TP" + IntegerToString(i + 1) + " - " + DoubleToString(tp[i], dg) +
                  (showFibo ? ("  (" + DoubleToString(FIB_TP[i], 3) + ")") : "");
      lc[i + 2] = tpCol; lw[i + 2] = tpWidth; ls[i + 2] = tpStyle; show[i + 2] = showTp;
     }

   for(int i = 0; i < 7; i++)
     {
      if(!show[i]) continue;
      string n = PFX + "L" + IntegerToString(i);
      if(ObjectFind(0, n) < 0) ObjectCreate(0, n, OBJ_HLINE, 0, 0, lv[i]);
      ObjectSetDouble (0, n, OBJPROP_PRICE, lv[i]);
      ObjectSetInteger(0, n, OBJPROP_COLOR, lc[i]);
      ObjectSetInteger(0, n, OBJPROP_STYLE, ls[i]);
      ObjectSetInteger(0, n, OBJPROP_WIDTH, lw[i]);
      ObjectSetInteger(0, n, OBJPROP_BACK, true);
      ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);

      string t = PFX + "LT" + IntegerToString(i);
      double labelPrice = lv[i] + ((i == 1) ? (entry > sl ? -lblOff : lblOff) : 0.0);
      if(ObjectFind(0, t) < 0) ObjectCreate(0, t, OBJ_TEXT, 0, TimeCurrent(), labelPrice);
      ObjectSetInteger(0, t, OBJPROP_TIME, TimeCurrent());
      ObjectSetDouble (0, t, OBJPROP_PRICE, labelPrice);
      ObjectSetString (0, t, OBJPROP_TEXT, lb[i]);
      // The fibo label colour is his Fibo Color when the ratio is shown; the price part
      // stays on the level's own colour, so a dark fibo grey cannot hide the number.
      ObjectSetInteger(0, t, OBJPROP_COLOR, (i >= 2 && showFibo) ? fibCol : lc[i]);
      ObjectSetInteger(0, t, OBJPROP_FONTSIZE, 7);
      ObjectSetInteger(0, t, OBJPROP_ANCHOR, ANCHOR_LEFT_LOWER);
      ObjectSetInteger(0, t, OBJPROP_SELECTABLE, false);
     }
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| Write the verdict as JSON for the Node reader to ship.            |
//|                                                                   |
//| FILE_COMMON is NOT used on purpose: the file belongs to this      |
//| terminal, and the reader is told which data folder to look in. Two|
//| terminals writing the same common file would silently interleave  |
//| two accounts' verdicts into one record.                           |
//+------------------------------------------------------------------+
void WriteFeed(const string headline, const double confidence, const int &tfV[],
               const int &cons[], const int vFinal, const int vDecision, const double bullPct,
               const double waitPct, const double bearPct, const string sentiment,
               const double rsi, const double macdMain, const double macdSig,
               const double adx, const double atr, const double entry,
               const double sl, const double &tp[],
               const int dg, const long spreadPts, const bool mtfAgrees,
               const double volRatio, const double bbWidth,
               const int tfBuy, const int tfSell, const bool spreadOk)
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
   j += "\"spreadOk\":" + (spreadOk ? "true" : "false") + ",";
   j += "\"maxSpreadPoints\":" + IntegerToString(InpMaxSpreadPoints) + ",";
   j += "\"dominance\":{\"bullish\":" + JNum(bullPct,1) + ",\"wait\":" + JNum(waitPct,1) +
        ",\"bearish\":" + JNum(bearPct,1) + ",\"sentiment\":\"" + JStr(sentiment) + "\"},";
   j += "\"mtf\":{" + tfJson + "},";
   j += "\"consensus\":{" + consJson + "},";
   j += "\"indicators\":{\"rsi\":" + JNum(rsi,2) + ",\"macd\":" + JNum(macdMain,dg) +
        ",\"macdSignal\":" + JNum(macdSig,dg) + ",\"adx\":" + JNum(adx,2) +
        ",\"atr\":" + JNum(atr,dg) + ",\"spreadPoints\":" + IntegerToString(spreadPts) + "},";
   // The trailing stop the arrows and candle colours are drawn from, so a consumer can
   // see WHY a candle is green without re-deriving it.
   j += "\"trail\":{\"direction\":\"" +
        (g_trailDir > 0 ? "LONG" : (g_trailDir < 0 ? "SHORT" : "FLAT")) + "\"" +
        ",\"atrPeriod\":" + IntegerToString(MathMax(1, InpMomSmoothing * 7)) +
        ",\"multiplier\":" + IntegerToString(MathMax(1, InpMomAmplitude)) + "},";
   // THE FULL LADDER, with the ratio each level was built from, so a consumer can
   // check the geometry instead of trusting five bare numbers.
   string tpJson = "";
   for(int i = 0; i < 5; i++)
      tpJson += (i ? "," : "") + StringFormat("{\"level\":%d,\"fib\":%.3f,\"price\":%s}",
                                              i + 1, FIB_TP[i], JNum(tp[i], dg));
   double riskDist = MathAbs(entry - sl);
   j += "\"ticket\":" + (vDecision == V_WAIT ? "null" :
        ("{\"direction\":\"" + VerdictText(vDecision) + "\",\"entry\":" + JNum(entry,dg) +
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
      PrintFormat("ATOMIC V84: feed written -> %s  (%s %.0f pct)",
                  path, headline, confidence);
     }
}
//+------------------------------------------------------------------+
