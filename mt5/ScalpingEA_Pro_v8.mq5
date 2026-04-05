//+------------------------------------------------------------------+
//|                               ScalpingEA_Pro_v8.mq5              |
//|                   Scalping AI Pro v8.02 - AI Trading Dashboard   |
//|  CHANGELOG v8.0:                                                 |
//|   BUG FIX 1 - Store res.order (position ticket) not res.deal     |
//|   BUG FIX 2 - CheckClosed inner loop renamed mi (was m, shadow)  |
//|   BUG FIX 3 - R:R recalculated from actual slD when SwingSL used |
//|   IMP  1  - Additive regime/session scoring (was multiplicative) |
//|   IMP  2  - 3-bar momentum confirmation filter                   |
//|   IMP  3  - ATR expansion filter (+1.0 score)                    |
//|   IMP  4  - Minimum R:R enforcement (default 1.5)                |
//|   IMP  5  - Per-symbol cooldown after loss                       |
//|   IMP  6  - Early breakeven at 0.75R (was only at TP1)           |
//|   IMP  7  - Trail from breakeven (not just after TP1)            |
//|   IMP  8  - Auto-exit stale trades > MaxTradeHours               |
//|   IMP  9  - AI brain adapts at 10 trades (was 20)                |
//|   IMP  10 - BB bounce logic (was breakout)                       |
//|   IMP  11 - Minimum ATR filter to skip dead markets              |
//+------------------------------------------------------------------+
#property copyright   "AI Trading Dashboard"
#property link        ""
#property version     "8.02"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\OrderInfo.mqh>

//--- Constants
#define MAX_A          30      // max symbols
#define MAX_M          200     // max open managed trades
#define MAX_B          8       // max brain nodes
#define MAX_SIG_LOG    50      // signal log entries
#define BRAIN_FILE     "ScalpingAIPro_v8_brain.bin"
#define MAGIC_NUM      88001

//============================================================
//  INPUT GROUPS
//============================================================
input group "=== CORE ==="
input bool     EA_On             = true;    // Enable EA
input long     MagicBase         = 88001;   // Magic Number Base
input string   TradeComment      = "SAIPv8"; // Trade Comment

input group "=== SYMBOLS ==="
input string   Symbols           = "EURUSD,GBPUSD,USDJPY,XAUUSD"; // Symbols — use exact names from your broker's Market Watch

input group "=== RISK ==="
input double   RiskPct           = 1.0;     // Risk % per trade
input double   MaxDailyDD        = 5.0;     // Max daily drawdown %
input double   MaxTotalDD        = 10.0;    // Max total drawdown %
input int      MaxPositions      = 3;       // Max simultaneous positions
input double   MinRR             = 1.5;     // v8: Minimum R:R to enter trade

input group "=== SIGNAL SCORING ==="
input double   MinScore          = 2.0;     // Minimum signal score to trade
input bool     UseSwingSL        = true;    // Use swing-high/low as SL

input group "=== ATR ==="
input int      ATR_Period        = 14;      // ATR Period
input double   ATR_SL_Mult       = 1.5;     // ATR SL Multiplier
input double   ATR_TP1_Mult      = 2.5;     // ATR TP1 Multiplier  ← v8 fix: was 1.5 (gave R:R=1.0, always blocked)
input double   ATR_TP2_Mult      = 4.0;     // ATR TP2 Multiplier
input double   ATR_Trail_Mult    = 1.5;     // ATR Trail Multiplier (v8.02: 1.0->1.5, gives more room)

input group "=== TRADE MANAGEMENT ==="
input double   PartialClosePct   = 30.0;    // Partial close % at TP1 (v8.02: 50->30, keeps more for TP2)
input int      MaxTradeHours     = 8;       // v8: Max hours in trade before auto-exit
input double   CooldownMins      = 30.0;    // Per-symbol cooldown after loss (minutes)

input group "=== INDICATORS ==="
input int      EMA_Fast          = 8;       // Fast EMA
input int      EMA_Slow          = 21;      // Slow EMA
input int      EMA_Trend         = 50;      // Trend EMA
input int      RSI_Period        = 14;      // RSI Period
input int      BB_Period         = 20;      // Bollinger Bands Period
input double   BB_Dev            = 2.0;     // BB Standard Deviations
input int      OB_Lookback       = 20;      // Order Block lookback bars

input group "=== SESSIONS ==="
input bool     UseTimeFilter     = true;    // Enable session filter
input int      LondonOpen        = 8;       // London session open hour
input int      LondonClose       = 17;      // London session close hour
input int      NYOpen            = 13;      // NY session open hour
input int      NYClose           = 22;      // NY session close hour

input group "=== AI BRAIN ==="
input bool     AI_On             = true;    // Enable AI brain
input bool     AI_Save           = true;    // Save brain to file
input bool     AI_Load           = true;    // Load brain from file

input group "=== TELEGRAM ==="
input bool     TG_On             = false;   // Enable Telegram
input string   TG_Token          = "";      // Bot Token
input string   TG_ChatID         = "";      // Chat ID
input bool     TG_AutoSignals    = true;    // Auto-send signals to TG

input group "=== SPREAD ==="
input int      MaxSpreadPts      = 30;      // Max spread in points

//============================================================
//  STRUCTURES
//============================================================

struct ManagedTrade
{
   ulong    ticket;       // v8: position ticket (res.order) - was res.deal
   string   symbol;
   int      direction;    // 1=buy -1=sell
   double   openPrice;
   double   sl;
   double   tp1;
   double   tp2;
   double   lots;
   double   slD;          // SL distance in price
   double   tp1D;         // TP1 distance in price
   double   tp2D;         // TP2 distance in price
   bool     tp1Hit;
   bool     beSet;
   bool     partialDone;
   double   highWater;    // highest favorable price
   datetime openTime;
   int      symIdx;
   double   grade;        // signal grade 0-10
};

struct BrainNode
{
   double   sumScore;
   double   sumPnl;
   int      wins;
   int      losses;
   int      adaptCnt;
   double   dynScore;     // dynamic minimum score threshold
   double   lotMult;      // lot multiplier
   string   regime;
};

struct SignalLog
{
   datetime   time;
   string     symbol;
   int        direction;
   double     score;
   string     grade;
   string     reason;
   bool       traded;
};

//============================================================
//  GLOBALS
//============================================================

string         g_syms[];
int            g_symCnt       = 0;
bool           g_symEnabled[];   // v8 fix: per-symbol enabled flag (false = bad symbol, skip)
datetime       g_symLastBar[];   // v8: per-symbol new-bar gate

// Indicator handles per symbol
int            g_hEMAFast[];
int            g_hEMASlow[];
int            g_hEMATrend[];
int            g_hRSI[];
int            g_hATR[];
int            g_hBB[];

// Managed trades
ManagedTrade   g_M[MAX_M];
int            g_mCnt         = 0;

// AI Brain nodes (one per symbol pair type)
BrainNode      g_B[MAX_B];
int            g_bCnt         = 0;

// Signal log
SignalLog      g_SL[MAX_SIG_LOG];
int            g_slCnt        = 0;

// Monthly stats
double         g_monthly_pnl[];
int            g_monthly_cnt  = 0;
int            g_monthly_wins = 0;
int            g_monthly_loss = 0;

// Daily stats
double         g_daily_start_balance = 0;
double         g_total_start_balance = 0;
datetime       g_daily_reset_time    = 0;

// v8: Per-symbol cooldown array
datetime       g_symCoolUntil[MAX_A]; // v8: per-symbol cooldown datetime

// Telegram
datetime       g_tgLastPoll   = 0;
string         g_tgLastUpdate = "0";

// Dashboard
datetime       g_lastDash     = 0;

// Trade object
CTrade         g_trade;

//============================================================
//  HELPER: String split
//============================================================
int StringSplit(string src, string sep, string &out[])
{
   int cnt = 0;
   string tmp = src;
   while(true)
   {
      int p = StringFind(tmp, sep);
      if(p < 0) { ArrayResize(out, cnt+1); out[cnt++] = tmp; break; }
      ArrayResize(out, cnt+1);
      out[cnt++] = StringSubstr(tmp, 0, p);
      tmp = StringSubstr(tmp, p+StringLen(sep));
   }
   return cnt;
}

//============================================================
//  INIT
//============================================================
int OnInit()
{
   g_trade.SetExpertMagicNumber(MagicBase);
   g_trade.SetDeviationInPoints(20);
   g_trade.SetTypeFilling(ORDER_FILLING_IOC);

   // Parse symbols
   g_symCnt = StringSplit(Symbols, ",", g_syms);
   if(g_symCnt <= 0 || g_symCnt > MAX_A)
   {
      Print("ERROR: Invalid symbol list. Count=", g_symCnt);
      return INIT_PARAMETERS_INCORRECT;
   }

   // Trim whitespace from symbol names
   for(int i=0; i<g_symCnt; i++)
   {
      StringTrimLeft(g_syms[i]);
      StringTrimRight(g_syms[i]);
   }

   // Allocate indicator handle arrays
   ArrayResize(g_hEMAFast,   g_symCnt);
   ArrayResize(g_hEMASlow,   g_symCnt);
   ArrayResize(g_hEMATrend,  g_symCnt);
   ArrayResize(g_hRSI,       g_symCnt);
   ArrayResize(g_hATR,       g_symCnt);
   ArrayResize(g_hBB,        g_symCnt);
   ArrayResize(g_symEnabled, g_symCnt);
   ArrayResize(g_symLastBar, g_symCnt);
   ArrayInitialize(g_symEnabled, 1);   // default all enabled
   ArrayInitialize(g_symLastBar, 0);

   // Init per-symbol cooldown (v8)
   ArrayInitialize(g_symCoolUntil, 0);

   // v8 FIX: Validate symbol exists BEFORE creating indicators
   //         Bad symbol = skip gracefully (no INIT_FAILED for whole EA)
   for(int i=0; i<g_symCnt; i++)
   {
      string s = g_syms[i];
      // Check symbol is known to the broker
      if(!SymbolSelect(s, true) || SymbolInfoDouble(s, SYMBOL_POINT) <= 0)
      {
         PrintFormat("WARNING: Symbol '%s' not found on broker — SKIPPED. Check Market Watch name.", s);
         g_symEnabled[i] = false;
         g_hEMAFast[i] = g_hEMASlow[i] = g_hEMATrend[i] =
         g_hRSI[i] = g_hATR[i] = g_hBB[i] = INVALID_HANDLE;
         continue;
      }

      g_hEMAFast[i]  = iMA(s, PERIOD_M5, EMA_Fast,  0, MODE_EMA, PRICE_CLOSE);
      g_hEMASlow[i]  = iMA(s, PERIOD_M5, EMA_Slow,  0, MODE_EMA, PRICE_CLOSE);
      g_hEMATrend[i] = iMA(s, PERIOD_M5, EMA_Trend, 0, MODE_EMA, PRICE_CLOSE);
      g_hRSI[i]      = iRSI(s, PERIOD_M5, RSI_Period, PRICE_CLOSE);
      g_hATR[i]      = iATR(s, PERIOD_M5, ATR_Period);
      g_hBB[i]       = iBands(s, PERIOD_M5, BB_Period, 0, BB_Dev, PRICE_CLOSE);

      if(g_hEMAFast[i]==INVALID_HANDLE || g_hEMASlow[i]==INVALID_HANDLE ||
         g_hEMATrend[i]==INVALID_HANDLE || g_hRSI[i]==INVALID_HANDLE ||
         g_hATR[i]==INVALID_HANDLE || g_hBB[i]==INVALID_HANDLE)
      {
         PrintFormat("WARNING: Indicator handles failed for '%s' — SKIPPED.", s);
         g_symEnabled[i] = false;
      }
      else
         PrintFormat("Symbol '%s' ready.", s);
   }

   // Init brain nodes
   g_bCnt = g_symCnt;
   for(int i=0; i<g_bCnt; i++)
   {
      g_B[i].dynScore  = MinScore;
      g_B[i].lotMult   = 1.0;
      g_B[i].adaptCnt  = 0;
      g_B[i].wins      = 0;
      g_B[i].losses    = 0;
      g_B[i].sumPnl    = 0;
      g_B[i].sumScore  = 0;
      g_B[i].regime    = "neutral";
   }

   // Balance tracking
   g_daily_start_balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   g_total_start_balance  = g_daily_start_balance;
   g_daily_reset_time     = TimeCurrent();

   // Load brain
   if(AI_On && AI_Load) LoadBrain();

   // Init risk stats and symbol performance arrays
   InitGlobalArrays();

   // Validate symbol accessibility
   ValidateSymbols();

   // Log startup diagnostics
   PrintStartupDiagnostics();

   // Register timer for periodic tasks (brain save, TG heartbeat)
   EventSetTimer(60); // fire every 60 seconds

   PrintFormat("Scalping AI Pro v8.0 initialized. Symbols=%d Magic=%d", g_symCnt, MagicBase);
   if(TG_On) TGSend("Scalping AI Pro v8.0 started. Symbols: " + Symbols);
   return INIT_SUCCEEDED;
}

//============================================================
//  DEINIT
//============================================================
void OnDeinit(const int reason)
{
   EventKillTimer();
   if(AI_On && AI_Save) SaveBrain();
   for(int i=0; i<g_symCnt; i++)
   {
      IndicatorRelease(g_hEMAFast[i]);
      IndicatorRelease(g_hEMASlow[i]);
      IndicatorRelease(g_hEMATrend[i]);
      IndicatorRelease(g_hRSI[i]);
      IndicatorRelease(g_hATR[i]);
      IndicatorRelease(g_hBB[i]);
   }
   Comment("");
   PrintFormat("Scalping AI Pro v8.0 stopped. Reason=%d", reason);
}

//============================================================
//  MAIN TICK
//============================================================
void OnTick()
{
   if(!EA_On) return;

   // Daily reset check
   DailyReset();

   // Check drawdown limits
   if(!CheckDrawdownOK()) return;

   // Manage existing trades (every tick)
   ManageTrades();

   // Check for closed trades
   CheckClosed();

   // Scan for new entries (rate-limited to new bars)
   Scan();

   // Telegram polling
   if(TG_On && TimeCurrent() - g_tgLastPoll >= 5)
   {
      PollTelegram();
      g_tgLastPoll = TimeCurrent();
   }

   // Dashboard refresh
   if(TimeCurrent() - g_lastDash >= 2)
   {
      DrawDashboardFull();
      g_lastDash = TimeCurrent();
   }
}
//============================================================
//  DAILY RESET
//============================================================
void DailyReset()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   MqlDateTime dr; TimeToStruct(g_daily_reset_time, dr);
   if(dt.day != dr.day)
   {
      g_daily_start_balance = AccountInfoDouble(ACCOUNT_BALANCE);
      g_daily_reset_time    = TimeCurrent();
      g_monthly_wins        = 0;
      g_monthly_loss        = 0;
      g_consecLoss          = 0;     // reset streak each new day
      g_tradingPaused       = false; // always resume at day start
      if(TG_On) TGSend(StringFormat("Daily reset. Balance: %.2f", g_daily_start_balance));
   }
}

//============================================================
//  DRAWDOWN CHECK
//============================================================
bool CheckDrawdownOK()
{
   double bal   = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq    = AccountInfoDouble(ACCOUNT_EQUITY);

   // Daily DD
   if(g_daily_start_balance > 0)
   {
      double dayDD = (g_daily_start_balance - eq) / g_daily_start_balance * 100.0;
      if(dayDD >= MaxDailyDD)
      {
         Comment("EA PAUSED: Daily DD limit reached (" + DoubleToString(dayDD,1) + "%)");
         return false;
      }
   }

   // Total DD
   if(g_total_start_balance > 0)
   {
      double totDD = (g_total_start_balance - eq) / g_total_start_balance * 100.0;
      if(totDD >= MaxTotalDD)
      {
         Comment("EA PAUSED: Total DD limit reached (" + DoubleToString(totDD,1) + "%)");
         return false;
      }
   }
   return true;
}

//============================================================
//  EFFECTIVE SL/TP MULTIPLIERS (brain-adjusted)
//============================================================
double EffSL(int bi)
{
   return ATR_SL_Mult; // Brain may override in future versions
}
double EffTP1(int bi)
{
   return ATR_TP1_Mult;
}
double EffTP2(int bi)
{
   return ATR_TP2_Mult;
}
double EffLot(int bi, double baseLot)
{
   if(!AI_On) return baseLot;
   return baseLot * g_B[bi].lotMult;
}

//============================================================
//  LOT SIZING
//============================================================
double CalcLots(string sym, double slDist)
{
   double bal     = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmt = bal * RiskPct / 100.0;
   double tv      = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double ts      = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   if(ts==0 || tv==0 || slDist==0) return NormLot(sym, 0.01);
   double lots = riskAmt / (slDist / ts * tv);
   return NormLot(sym, lots);
}

double NormLot(string sym, double lots)
{
   double mn = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double mx = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double st = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(st<=0) st=0.01;
   lots = MathMax(lots, mn);
   lots = MathMin(lots, mx);
   lots = MathFloor(lots/st)*st;
   return NormalizeDouble(lots, 2);
}

//============================================================
//  SESSION CHECK
//============================================================
bool IsSessionOK()
{
   if(!UseTimeFilter) return true;
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   int h = dt.hour;
   bool london = (h >= LondonOpen && h < LondonClose);
   bool ny     = (h >= NYOpen     && h < NYClose);
   return (london || ny);
}

//============================================================
//  SPREAD CHECK
//============================================================
bool IsSpreadOK(string sym)
{
   long sp = SymbolInfoInteger(sym, SYMBOL_SPREAD);
   return (sp <= MaxSpreadPts);
}

//============================================================
//  REGIME DETECTION
//  Returns: "trend_up","trend_dn","range","volatile"
//============================================================
string DetectRegime(string sym, double atr, double atrAvg)
{
   double fast[], slow[], trend[]; // v8 fix: dynamic arrays for ArraySetAsSeries
   int si = GetSymIdx(sym);
   if(si<0) return "neutral";
   if(CopyBuffer(g_hEMAFast[si],  0,1,3,fast)  < 3) return "neutral";
   if(CopyBuffer(g_hEMASlow[si],  0,1,3,slow)  < 3) return "neutral";
   if(CopyBuffer(g_hEMATrend[si], 0,1,3,trend) < 3) return "neutral";
   ArraySetAsSeries(fast,true); ArraySetAsSeries(slow,true); ArraySetAsSeries(trend,true);

   double close1 = iClose(sym, PERIOD_M5, 1);
   bool upTrend   = (fast[0] > slow[0] && slow[0] > trend[0] && close1 > trend[0]);
   bool downTrend = (fast[0] < slow[0] && slow[0] < trend[0] && close1 < trend[0]);
   bool volatile_ = (atr > atrAvg * 1.5);

   if(volatile_)  return "volatile";
   if(upTrend)    return "trend_up";
   if(downTrend)  return "trend_dn";
   return "range";
}

//============================================================
//  GET SYMBOL INDEX
//============================================================
int GetSymIdx(string sym)
{
   for(int i=0; i<g_symCnt; i++)
      if(g_syms[i] == sym) return i;
   return -1;
}

//============================================================
//  BB SIGNAL - v8: BOUNCE LOGIC (was breakout)
//  Buy when price bounced from lower band back inside.
//  Sell when price bounced from upper band back inside.
//============================================================
int GetBBSignal(int si, string sym)
{
   // v8: BB bounce logic instead of breakout
   double bbUpper[], bbLower[], bbMid[]; // v8 fix: dynamic arrays
   if(CopyBuffer(g_hBB[si], 1, 1, 3, bbUpper) < 3) return 0; // upper band
   if(CopyBuffer(g_hBB[si], 2, 1, 3, bbLower) < 3) return 0; // lower band
   if(CopyBuffer(g_hBB[si], 0, 1, 3, bbMid)   < 3) return 0; // middle band
   ArraySetAsSeries(bbUpper, true);
   ArraySetAsSeries(bbLower, true);
   ArraySetAsSeries(bbMid,   true);

   double close1 = iClose(sym, PERIOD_M5, 1); // last closed bar
   double close2 = iClose(sym, PERIOD_M5, 2); // bar before that

   // v8 BOUNCE BUY: bar[2] closed below lower band, bar[1] closed back inside
   if(close2 < bbLower[1] && close1 > bbLower[0]) return 1;

   // v8 BOUNCE SELL: bar[2] closed above upper band, bar[1] closed back inside
   if(close2 > bbUpper[1] && close1 < bbUpper[0]) return -1;

   return 0;
}

//============================================================
//  RSI DIVERGENCE SIGNAL
//  Bullish: price lower low, RSI higher low
//  Bearish: price higher high, RSI lower high
//============================================================
int GetRSIDivSignal(int si, string sym)
{
   double rsi[]; // dynamic array required for ArraySetAsSeries
   if(CopyBuffer(g_hRSI[si], 0, 1, 5, rsi) < 5) return 0;
   ArraySetAsSeries(rsi, true);

   double lo1 = iLow(sym, PERIOD_M5, 1);
   double lo3 = iLow(sym, PERIOD_M5, 3);
   double hi1 = iHigh(sym, PERIOD_M5, 1);
   double hi3 = iHigh(sym, PERIOD_M5, 3);

   // Bullish divergence
   if(lo1 < lo3 && rsi[0] > rsi[2] && rsi[0] < 50) return 1;

   // Bearish divergence
   if(hi1 > hi3 && rsi[0] < rsi[2] && rsi[0] > 50) return -1;

   return 0;
}

//============================================================
//  ORDER BLOCK DETECTION
//  Finds last significant OB level and returns bias
//============================================================
int GetOBSignal(string sym, double curPrice)
{
   double hi[], lo[], cl[];
   int n = OB_Lookback + 2;
   if(CopyHigh(sym, PERIOD_M5, 1, n, hi) < n) return 0;
   if(CopyLow( sym, PERIOD_M5, 1, n, lo) < n) return 0;
   if(CopyClose(sym, PERIOD_M5,1, n, cl) < n) return 0;
   ArraySetAsSeries(hi, true);
   ArraySetAsSeries(lo, true);
   ArraySetAsSeries(cl, true);

   // Find last bearish OB (potential supply zone: big up bar before down move)
   // Find last bullish OB (potential demand zone: big down bar before up move)
   double atrVal[1];
   int si = GetSymIdx(sym);
   if(si<0) return 0;
   if(CopyBuffer(g_hATR[si],0,1,1,atrVal)<1) return 0;
   double atr = atrVal[0];

   for(int i=2; i<OB_Lookback; i++)
   {
      double bodySize = MathAbs(cl[i] - iOpen(sym, PERIOD_M5, i+1));
      if(bodySize < atr * 0.5) continue;

      // Bullish OB: big down bar, price now near top of that bar
      if(cl[i] < iOpen(sym, PERIOD_M5, i+1)) // down bar
      {
         double obTop = MathMax(cl[i], iOpen(sym, PERIOD_M5, i+1));
         double obBot = MathMin(cl[i], iOpen(sym, PERIOD_M5, i+1));
         if(curPrice >= obBot && curPrice <= obTop + atr*0.3) return 1;
      }

      // Bearish OB: big up bar, price now near bottom of that bar
      if(cl[i] > iOpen(sym, PERIOD_M5, i+1)) // up bar
      {
         double obTop = MathMax(cl[i], iOpen(sym, PERIOD_M5, i+1));
         double obBot = MathMin(cl[i], iOpen(sym, PERIOD_M5, i+1));
         if(curPrice >= obBot - atr*0.3 && curPrice <= obTop) return -1;
      }
   }
   return 0;
}

//============================================================
//  LIQUIDITY SWEEP DETECTION
//  Detects if recent candle swept a swing high/low then reversed
//============================================================
int GetLiqSweepSignal(string sym)
{
   double hi[], lo[], cl[];
   int n = 10;
   if(CopyHigh(sym, PERIOD_M5, 1, n, hi)  < n) return 0;
   if(CopyLow( sym, PERIOD_M5, 1, n, lo)  < n) return 0;
   if(CopyClose(sym, PERIOD_M5,1, n, cl)  < n) return 0;
   ArraySetAsSeries(hi,true); ArraySetAsSeries(lo,true); ArraySetAsSeries(cl,true);

   // Find swing high/low in bars 2-9
   double swHi = hi[2], swLo = lo[2];
   for(int i=3; i<n; i++) { if(hi[i]>swHi) swHi=hi[i]; if(lo[i]<swLo) swLo=lo[i]; }

   // Bar[1] swept above swing high but closed below it = bearish sweep
   if(hi[0] > swHi && cl[0] < swHi) return -1;

   // Bar[1] swept below swing low but closed above it = bullish sweep
   if(lo[0] < swLo && cl[0] > swLo) return 1;

   return 0;
}

//============================================================
//  EMA SIGNAL
//============================================================
int GetEMASignal(int si, string sym)
{
   double fast[], slow[], trend[]; // v8 fix: dynamic arrays
   if(CopyBuffer(g_hEMAFast[si],  0,1,3,fast)  < 3) return 0;
   if(CopyBuffer(g_hEMASlow[si],  0,1,3,slow)  < 3) return 0;
   if(CopyBuffer(g_hEMATrend[si], 0,1,3,trend) < 3) return 0;
   ArraySetAsSeries(fast,true); ArraySetAsSeries(slow,true); ArraySetAsSeries(trend,true);

   double close1 = iClose(sym, PERIOD_M5, 1);

   // Bullish crossover with trend filter
   bool bullCross = (fast[1] < slow[1]) && (fast[0] > slow[0]);
   bool bearCross = (fast[1] > slow[1]) && (fast[0] < slow[0]);
   bool upTrend   = (close1 > trend[0]);
   bool downTrend = (close1 < trend[0]);

   if(bullCross && upTrend)   return  1;
   if(bearCross && downTrend) return -1;
   return 0;
}

//============================================================
//  RSI SIGNAL
//============================================================
int GetRSISignal(int si)
{
   double rsi[]; // v8 fix: dynamic array
   if(CopyBuffer(g_hRSI[si], 0,1,2,rsi) < 2) return 0;
   ArraySetAsSeries(rsi, true);
   if(rsi[0] > 40 && rsi[0] < 60) return 0; // No edge in middle
   if(rsi[0] > 50 && rsi[0] < 70) return  1; // Bullish momentum zone
   if(rsi[0] < 50 && rsi[0] > 30) return -1; // Bearish momentum zone
   return 0;
}

//============================================================
//  v8 IMPROVEMENT 2: 3-BAR MOMENTUM FILTER
//  Count how many of last 3 closed bars closed in signal direction.
//  Returns count (0-3) and direction check.
//============================================================
int Count3BarMomentum(string sym, int dir)
{
   // v8: 3-bar momentum confirmation
   int count = 0;
   for(int i=1; i<=3; i++)
   {
      double o = iOpen(sym,  PERIOD_M5, i);
      double c = iClose(sym, PERIOD_M5, i);
      if(dir == 1  && c > o) count++;
      if(dir == -1 && c < o) count++;
   }
   return count;
}

//============================================================
//  v8 IMPROVEMENT 3: ATR EXPANSION FILTER
//  Returns true if ATR is expanding (> 20-bar avg * 1.1)
//============================================================
bool IsATRExpanding(int si, double curATR)
{
   // v8: ATR expansion filter
   double atrBuf[20];
   if(CopyBuffer(g_hATR[si], 0, 1, 20, atrBuf) < 20) return false;
   double sum = 0;
   for(int i=0; i<20; i++) sum += atrBuf[i];
   double avg = sum / 20.0;
   return (curATR > avg * 1.1);
}

//============================================================
//  SWING SL DETECTION
//============================================================
double GetSwingSL(string sym, int dir)
{
   // Find swing high/low in last 20 bars as SL reference
   double swLevel = 0;
   int lookback = 20;
   if(dir == 1)
   {
      swLevel = iLow(sym, PERIOD_M5, 1);
      for(int i=2; i<=lookback; i++)
      {
         double lo = iLow(sym, PERIOD_M5, i);
         if(lo < swLevel) swLevel = lo;
      }
   }
   else
   {
      swLevel = iHigh(sym, PERIOD_M5, 1);
      for(int i=2; i<=lookback; i++)
      {
         double hi = iHigh(sym, PERIOD_M5, i);
         if(hi > swLevel) swLevel = hi;
      }
   }
   return swLevel;
}

//============================================================
//  SIGNAL GRADE
//============================================================
string ScoreToGrade(double score)
{
   if(score >= 9.0) return "A+";
   if(score >= 8.0) return "A";
   if(score >= 7.0) return "B+";
   if(score >= 6.0) return "B";
   if(score >= 5.0) return "C+";
   if(score >= 4.0) return "C";
   return "D";
}

//============================================================
//  LOG SIGNAL
//============================================================
void LogSignal(string sym, int dir, double score, string grade, string reason, bool traded)
{
   int idx = g_slCnt % MAX_SIG_LOG;
   g_SL[idx].time      = TimeCurrent();
   g_SL[idx].symbol    = sym;
   g_SL[idx].direction = dir;
   g_SL[idx].score     = score;
   g_SL[idx].grade     = grade;
   g_SL[idx].reason    = reason;
   g_SL[idx].traded    = traded;
   g_slCnt++;
}

//============================================================
//  SCAN - Entry logic with all v8 improvements
//============================================================
void Scan()
{
   if(!IsSessionOK()) return;

   // Count total managed trades
   if(g_mCnt >= MaxPositions) return;

   // Only scan on new bar per symbol
   for(int si=0; si<g_symCnt; si++)
   {
      string sym = g_syms[si];

      // v8 fix: skip symbols that failed to initialise
      if(!g_symEnabled[si]) continue;

      // v8 fix: per-symbol new-bar gate — only scan on a new M5 bar
      datetime barTime = iTime(sym, PERIOD_M5, 0);
      if(barTime == 0 || barTime == g_symLastBar[si]) continue;
      g_symLastBar[si] = barTime;

      // Check if already have open trade on this symbol
      bool hasOpen = false;
      for(int m=0; m<g_mCnt; m++)
         if(g_M[m].symbol == sym) { hasOpen=true; break; }
      if(hasOpen) continue;

      // v8 IMP 5: Per-symbol cooldown check
      if(TimeCurrent() < g_symCoolUntil[si]) continue;

      // Spread check
      if(!IsSpreadOK(sym)) continue;

      // Get ATR
      double atrBuf[1];
      if(CopyBuffer(g_hATR[si], 0, 1, 1, atrBuf) < 1) continue;
      double atr = atrBuf[0];

      // v8 IMP 11: Minimum ATR filter — skip dead markets
      double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
      double minATR = pt * 5; // at least 5 points of volatility
      // For JPY pairs adjust threshold
      if(StringFind(sym,"JPY")>=0) minATR = pt * 50;
      if(atr < minATR) continue; // v8: skip if market is dead

      // Get 20-bar ATR average for regime + expansion filter
      double atrBuf20[20];
      double atrAvg = atr;
      if(CopyBuffer(g_hATR[si], 0, 1, 20, atrBuf20) >= 20)
      {
         double sum=0; for(int k=0;k<20;k++) sum+=atrBuf20[k];
         atrAvg = sum/20.0;
      }

      // === SIGNAL GATHERING ===
      // PRIMARY trigger: EMA crossover with trend filter
      // All other signals are score BOOSTERS, not hard requirements
      int emaSig = GetEMASignal(si, sym);
      if(emaSig == 0) continue; // No EMA cross = no trade

      int dir = emaSig; // Direction set by EMA cross

      // RSI guard: block entries against extreme RSI (overbought buys / oversold sells)
      double rsiVal = GetRSIValue(si, 1);
      if(dir ==  1 && rsiVal > 75.0) continue; // Don't buy overbought
      if(dir == -1 && rsiVal < 25.0) continue; // Don't sell oversold

      // Secondary signals — used for scoring only
      int rsiSig  = GetRSISignal(si);
      int bbSig   = GetBBSignal(si, sym);
      int divSig  = GetRSIDivSignal(si, sym);
      int liqSig  = GetLiqSweepSignal(sym);
      double curPrice = SymbolInfoDouble(sym, SYMBOL_BID);
      int obSig   = GetOBSignal(sym, curPrice);

      // Run extended pre-checks (news, consec loss, correlation, HTF, volume)
      if(!ScanPreChecks(sym, si, dir)) continue;

      // 3-bar momentum count — used as SCORE BONUS, not a hard block
      int momentum3 = Count3BarMomentum(sym, dir);

      // === BASE SCORING ===
      double score = 2.0;              // Base score: EMA cross confirmed
      if(rsiSig == dir) score += 1.5;
      if(bbSig  == dir) score += 1.5;
      if(divSig == dir) score += 2.0;
      if(obSig  == dir) score += 2.0;
      if(liqSig == dir) score += 1.5;

      // Momentum bonus (was a hard block in v8.0 — caused no trades)
      if(momentum3 >= 2) score += 1.5; // 2+ confirming bars = bonus
      else if(momentum3 == 1) score += 0.5;

      // v8 IMP 3: ATR expansion bonus
      if(IsATRExpanding(si, atr)) score += 1.0; // v8: expanding ATR = bonus

      // v8 IMP 1: ADDITIVE regime modifier (was multiplicative)
      string regime = DetectRegime(sym, atr, atrAvg);
      if(regime == "trend_up" && dir == 1)  score += 1.5; // v8: additive (was *=1.2)
      if(regime == "trend_dn" && dir == -1) score += 1.5; // v8: additive
      if(regime == "range")                 score -= 0.5;
      if(regime == "volatile")              score -= 1.0;

      // v8 IMP 1: ADDITIVE session modifier
      MqlDateTime dtnow; TimeToStruct(TimeCurrent(), dtnow);
      int h = dtnow.hour;
      bool peakSession = ((h==9||h==10||h==14||h==15)); // London/NY overlap
      if(peakSession) score += 1.0; // v8: additive (was *=1.1)

      // Extended score bonus (candle patterns, pivot, volume, day range)
      score += GetExtendedScoreBonus(sym, si, dir, atr, curPrice);

      // Brain dynamic threshold
      int bi = si; // brain index = symbol index
      double dynScore = (AI_On) ? g_B[bi].dynScore : MinScore;

      if(score < dynScore) continue;

      string grade = ScoreToGrade(score);

      // === POSITION SIZING & SL/TP ===
      double slD, tp1D, tp2D;
      double entry = (dir==1) ? SymbolInfoDouble(sym, SYMBOL_ASK)
                              : SymbolInfoDouble(sym, SYMBOL_BID);

      if(UseSwingSL)
      {
         double swSL = GetSwingSL(sym, dir);
         // v8 BUG FIX 3: Use actual SL distance, recalculate TP from it
         if(dir == 1)  slD = entry - swSL;
         else          slD = swSL - entry;
         if(slD <= 0 || slD > atr * 3.0)
            slD = atr * EffSL(bi); // fallback to ATR SL if swing SL invalid
         // v8 BUG FIX 3: TP now proportional to ACTUAL slD (R:R consistent)
         tp1D = slD * (ATR_TP1_Mult / ATR_SL_Mult); // maintain R:R ratio
         tp2D = slD * (ATR_TP2_Mult / ATR_SL_Mult);
      }
      else
      {
         slD  = atr * EffSL(bi);
         tp1D = atr * EffTP1(bi);
         tp2D = atr * EffTP2(bi);
      }

      // v8 IMP 4: Minimum R:R enforcement
      double rr = (slD > 0) ? tp1D / slD : 0;
      if(rr < MinRR) // v8: skip if R:R below minimum
      {
         LogSignal(sym, dir, score, grade,
            StringFormat("SKIP RR=%.2f < %.2f", rr, MinRR), false);
         continue;
      }

      double sl  = (dir==1) ? entry - slD  : entry + slD;
      double tp1 = (dir==1) ? entry + tp1D : entry - tp1D;
      double tp2 = (dir==1) ? entry + tp2D : entry - tp2D;

      int    dg    = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      sl   = NormalizeDouble(sl,  dg);
      tp1  = NormalizeDouble(tp1, dg);
      tp2  = NormalizeDouble(tp2, dg);

      double baseLots = CalcLots(sym, slD);
      double lots     = EffLot(bi, baseLots);

      // === PLACE ORDER ===
      bool ok = false;
      MqlTradeRequest rq; ZeroMemory(rq);
      MqlTradeResult  res; ZeroMemory(res);

      rq.action    = TRADE_ACTION_DEAL;
      rq.symbol    = sym;
      rq.volume    = lots;
      rq.sl        = sl;
      rq.tp        = tp2;  // full TP2, partial at TP1 in ManageTrades
      rq.comment   = TradeComment + " " + grade;
      rq.magic     = MagicBase;
      rq.deviation = 20;

      if(dir == 1)
      {
         rq.type  = ORDER_TYPE_BUY;
         rq.price = SymbolInfoDouble(sym, SYMBOL_ASK);
      }
      else
      {
         rq.type  = ORDER_TYPE_SELL;
         rq.price = SymbolInfoDouble(sym, SYMBOL_BID);
      }
      rq.type_filling = ORDER_FILLING_IOC;

      ok = OrderSend(rq, res);

      if(ok && res.retcode == TRADE_RETCODE_DONE)
      {
         // v8 BUG FIX 1: Store res.order (position ticket), NOT res.deal
         g_M[g_mCnt].ticket      = res.order;  // v8: was res.deal — CRITICAL FIX
         g_M[g_mCnt].symbol      = sym;
         g_M[g_mCnt].direction   = dir;
         g_M[g_mCnt].openPrice   = res.price;
         g_M[g_mCnt].sl          = sl;
         g_M[g_mCnt].tp1         = tp1;
         g_M[g_mCnt].tp2         = tp2;
         g_M[g_mCnt].lots        = lots;
         g_M[g_mCnt].slD         = slD;
         g_M[g_mCnt].tp1D        = tp1D;
         g_M[g_mCnt].tp2D        = tp2D;
         g_M[g_mCnt].tp1Hit      = false;
         g_M[g_mCnt].beSet       = false;
         g_M[g_mCnt].partialDone = false;
         g_M[g_mCnt].highWater   = res.price;
         g_M[g_mCnt].openTime    = TimeCurrent();
         g_M[g_mCnt].symIdx      = si;
         g_M[g_mCnt].grade       = score;
         g_mCnt++;

         string tgMsg = StringFormat(
            "[%s] %s %s | Score:%.1f %s | SL:%.5f TP1:%.5f TP2:%.5f | Lots:%.2f",
            sym, (dir==1?"BUY":"SELL"), TimeToString(TimeCurrent(), TIME_MINUTES),
            score, grade, sl, tp1, tp2, lots);
         PrintFormat("NEW TRADE: %s", tgMsg);
         LogSignal(sym, dir, score, grade, "TRADED", true);
         if(TG_On && TG_AutoSignals) TGSend(tgMsg);
      }
      else
      {
         PrintFormat("OrderSend FAILED %s retcode=%d", sym, res.retcode);
         LogSignal(sym, dir, score, grade,
            StringFormat("ORDER_FAIL rc=%d", res.retcode), false);
      }

      if(g_mCnt >= MaxPositions) break;
   }
}

//============================================================
//  MANAGE TRADES - v8 improvements: early BE, trail from BE, stale exit
//============================================================
void ManageTrades()
{
   for(int m=0; m<g_mCnt; m++)
   {
      // v8 BUG FIX 1: PositionSelectByTicket uses position ticket (res.order)
      if(!PositionSelectByTicket(g_M[m].ticket)) continue;

      string sym  = g_M[m].symbol;
      int    dir  = g_M[m].direction;
      int    dg   = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double bid  = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask  = SymbolInfoDouble(sym, SYMBOL_ASK);
      double curP = (dir==1) ? bid : ask;
      double sprd = ask - bid;
      double curSL = PositionGetDouble(POSITION_SL);

      // Update high water mark
      if(dir ==  1 && curP > g_M[m].highWater) g_M[m].highWater = curP;
      if(dir == -1 && curP < g_M[m].highWater) g_M[m].highWater = curP;

      double priceMove = (dir==1) ? (curP - g_M[m].openPrice)
                                  : (g_M[m].openPrice - curP);

      // v8 IMP 8: Auto-exit stale trades
      int hoursOpen = (int)((TimeCurrent() - g_M[m].openTime) / 3600);
      if(hoursOpen >= MaxTradeHours && !g_M[m].tp1Hit) // v8: stale trade exit
      {
         MqlTradeRequest rq; ZeroMemory(rq);
         MqlTradeResult  rs; ZeroMemory(rs);
         rq.action   = TRADE_ACTION_DEAL;
         rq.symbol   = sym;
         rq.position = g_M[m].ticket;
         rq.volume   = PositionGetDouble(POSITION_VOLUME);
         rq.price    = (dir==1) ? bid : ask;
         rq.type     = (dir==1) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
         rq.type_filling = ORDER_FILLING_IOC;
         rq.deviation = 20;
         rq.magic    = MagicBase;
         rq.comment  = "SAIPv8_STALE";
         if(OrderSend(rq, rs))
            PrintFormat("STALE EXIT %s after %dh", sym, hoursOpen);
         continue;
      }

      // v8 IMP 6: Early breakeven at 0.75R (was only at tp1Hit)
      if(!g_M[m].beSet && priceMove >= g_M[m].slD * 0.75) // v8: 0.75R BE trigger
      {
         double newSL = (dir==1) ? g_M[m].openPrice + sprd
                                 : g_M[m].openPrice - sprd;
         newSL = NormalizeDouble(newSL, dg);
         bool beOK = false;
         if(dir==1  && newSL > curSL) beOK = true;
         if(dir==-1 && (curSL==0 || newSL < curSL)) beOK = true;
         if(beOK)
         {
            MqlTradeRequest rq; ZeroMemory(rq);
            MqlTradeResult  rs; ZeroMemory(rs);
            rq.action   = TRADE_ACTION_SLTP;
            rq.symbol   = sym;
            rq.position = g_M[m].ticket;
            rq.sl       = newSL;
            rq.tp       = PositionGetDouble(POSITION_TP);
            if(OrderSend(rq, rs))
            {
               g_M[m].beSet = true;
               g_M[m].sl    = newSL;
               PrintFormat("BREAKEVEN SET %s @ %.5f (0.75R trigger v8)", sym, newSL);
            }
         }
      }

      // TP1 partial close
      if(!g_M[m].partialDone)
      {
         bool tp1Reached = (dir==1 && curP >= g_M[m].tp1)
                        || (dir==-1 && curP <= g_M[m].tp1);
         if(tp1Reached)
         {
            double volTotal   = PositionGetDouble(POSITION_VOLUME);
            double volPartial = NormLot(sym, volTotal * PartialClosePct / 100.0);
            if(volPartial >= SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN))
            {
               MqlTradeRequest rq; ZeroMemory(rq);
               MqlTradeResult  rs; ZeroMemory(rs);
               rq.action    = TRADE_ACTION_DEAL;
               rq.symbol    = sym;
               rq.position  = g_M[m].ticket; // v8 BUG FIX 1: position ticket
               rq.volume    = volPartial;
               rq.price     = (dir==1) ? bid : ask;
               rq.type      = (dir==1) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
               rq.type_filling = ORDER_FILLING_IOC;
               rq.deviation = 20;
               rq.magic     = MagicBase;
               rq.comment   = "SAIPv8_PARTIAL";
               if(OrderSend(rq, rs))
               {
                  g_M[m].partialDone = true;
                  g_M[m].tp1Hit      = true;
                  PrintFormat("PARTIAL CLOSE %s %.2f lots at TP1", sym, volPartial);
               }
            }
            else
            {
               g_M[m].tp1Hit = true;
            }
         }
      }

      // v8 IMP 7: Trail from breakeven (not just after tp1Hit)
      // v8: Was: if(g_M[m].tp1Hit) ... trail ...
      // v8: Now: trail once beSet = true (catches early runs)
      if(g_M[m].beSet) // v8: trail from BE, was tp1Hit
      {
         double atrBuf[1];
         if(CopyBuffer(g_hATR[g_M[m].symIdx], 0, 0, 1, atrBuf) >= 1)
         {
            double trailDist = atrBuf[0] * ATR_Trail_Mult;
            double newTrailSL = (dir==1) ? curP - trailDist : curP + trailDist;
            newTrailSL = NormalizeDouble(newTrailSL, dg);

            bool trailOK = false;
            if(dir==1  && newTrailSL > curSL && newTrailSL > g_M[m].openPrice)
               trailOK = true;
            if(dir==-1 && (curSL==0 || newTrailSL < curSL) && newTrailSL < g_M[m].openPrice)
               trailOK = true;

            if(trailOK)
            {
               MqlTradeRequest rq; ZeroMemory(rq);
               MqlTradeResult  rs; ZeroMemory(rs);
               rq.action   = TRADE_ACTION_SLTP;
               rq.symbol   = sym;
               rq.position = g_M[m].ticket;
               rq.sl       = newTrailSL;
               rq.tp       = PositionGetDouble(POSITION_TP);
               if(OrderSend(rq, rs))
                  g_M[m].sl = newTrailSL;
            }
         }
      }
   }
}

//============================================================
//  CHECK CLOSED - v8 fixes: inner loop renamed mi, fix HistorySelectByPosition
//============================================================
void CheckClosed()
{
   for(int m=0; m<g_mCnt; m++)
   {
      // v8 BUG FIX 1: PositionSelectByTicket uses position ticket (res.order)
      if(PositionSelectByTicket(g_M[m].ticket)) continue; // still open

      // Position closed — check history
      // v8 BUG FIX 2: renamed inner mi loop (was m, caused variable shadow)
      // v8 BUG FIX 1: HistorySelectByPosition needs position ticket
      double closedPnl = 0;
      bool   foundClose = false;

      if(HistorySelectByPosition(g_M[m].ticket)) // v8 BUG FIX 1: position ticket
      {
         int total = HistoryDealsTotal();
         for(int mi=0; mi<total; mi++) // v8 BUG FIX 2: was int m (shadow) — now mi
         {
            ulong dTicket = HistoryDealGetTicket(mi);
            if(dTicket == 0) continue;
            ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dTicket, DEAL_ENTRY);
            if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
            {
               closedPnl  += HistoryDealGetDouble(dTicket, DEAL_PROFIT);
               closedPnl  += HistoryDealGetDouble(dTicket, DEAL_COMMISSION);
               closedPnl  += HistoryDealGetDouble(dTicket, DEAL_SWAP);
               foundClose  = true;
            }
         }
      }

      // Update monthly stats
      ArrayResize(g_monthly_pnl, g_monthly_cnt+1);
      g_monthly_pnl[g_monthly_cnt] = closedPnl;
      g_monthly_cnt++;
      if(closedPnl >= 0) g_monthly_wins++;
      else               g_monthly_loss++;

      // Update risk stats and per-symbol performance
      UpdateRiskStats(closedPnl);
      UpdateConsecLoss(closedPnl);
      UpdateSymbolPerf(g_M[m].symIdx, closedPnl);

      // v8 IMP 5: Per-symbol cooldown after a loss
      if(closedPnl < 0)
      {
         int si = g_M[m].symIdx;
         if(si >= 0 && si < MAX_A)
         {
            g_symCoolUntil[si] = TimeCurrent() + (int)(CooldownMins * 60); // v8: per-symbol cooldown
            PrintFormat("COOLDOWN SET: %s for %.0f min", g_M[m].symbol, CooldownMins);
         }
      }

      // AI Brain update
      if(AI_On)
      {
         int bi = g_M[m].symIdx;
         g_B[bi].sumPnl  += closedPnl;
         g_B[bi].sumScore += g_M[m].grade;
         g_B[bi].adaptCnt++;
         if(closedPnl >= 0) g_B[bi].wins++;
         else               g_B[bi].losses++;

         // v8 IMP 9: Brain adapts at 10 trades (was 20)
         if(g_B[bi].adaptCnt >= 10) // v8: was >= 20
         {
            double winRate = (g_B[bi].wins + g_B[bi].losses > 0)
                           ? (double)g_B[bi].wins / (g_B[bi].wins + g_B[bi].losses)
                           : 0.5;

            // v8.02 fix: dynScore adaptation — removed hardcoded 3.0 floor that was
            // RAISING threshold above MinScore when MinScore<3.0; reduced penalty to +0.5
            if(winRate >= 0.6)      g_B[bi].dynScore = MathMax(MinScore - 0.3, 1.5);  // reward good WR
            else if(winRate <= 0.4) g_B[bi].dynScore = MathMin(MinScore + 0.5, MinScore * 1.5); // gentle penalty
            else                   g_B[bi].dynScore = MinScore;

            // Adjust lot multiplier based on expectancy
            // v8.02: raised floor from 0.5 to 0.7 (don't halve lots too aggressively)
            double avgPnl = (g_B[bi].adaptCnt > 0) ? g_B[bi].sumPnl / g_B[bi].adaptCnt : 0;
            if(avgPnl > 0 && winRate >= 0.55) g_B[bi].lotMult = MathMin(g_B[bi].lotMult * 1.1, 2.0);
            else if(avgPnl < 0)               g_B[bi].lotMult = MathMax(g_B[bi].lotMult * 0.9, 0.7);

            // Reset counter for next adaptation cycle
            g_B[bi].adaptCnt = 0;
            g_B[bi].wins     = 0;
            g_B[bi].losses   = 0;
            g_B[bi].sumPnl   = 0;
            g_B[bi].sumScore = 0;

            if(AI_Save) SaveBrain();
         }
      }

      // Telegram notification
      if(TG_On)
      {
         string emoji = (closedPnl >= 0) ? "PROFIT" : "LOSS";
         TGSend(StringFormat("[%s] Trade CLOSED (%s) PnL: %.2f",
                g_M[m].symbol, emoji, closedPnl));
      }

      PrintFormat("CLOSED %s dir=%d PnL=%.2f", g_M[m].symbol, g_M[m].direction, closedPnl);

      // Remove from managed array (shift)
      for(int k=m; k<g_mCnt-1; k++) g_M[k] = g_M[k+1];
      g_mCnt--;
      m--; // re-check this index
   }
}

//============================================================
//  BRAIN SAVE/LOAD
//============================================================
void SaveBrain()
{
   int fh = FileOpen(BRAIN_FILE, FILE_WRITE|FILE_BIN);
   if(fh == INVALID_HANDLE) { Print("Brain save failed"); return; }
   FileWriteInteger(fh, g_bCnt);
   for(int i=0; i<g_bCnt; i++)
   {
      FileWriteDouble(fh, g_B[i].sumScore);
      FileWriteDouble(fh, g_B[i].sumPnl);
      FileWriteInteger(fh, g_B[i].wins);
      FileWriteInteger(fh, g_B[i].losses);
      FileWriteInteger(fh, g_B[i].adaptCnt);
      FileWriteDouble(fh, g_B[i].dynScore);
      FileWriteDouble(fh, g_B[i].lotMult);
   }
   FileClose(fh);
   Print("Brain saved to ", BRAIN_FILE);
}

void LoadBrain()
{
   if(!FileIsExist(BRAIN_FILE)) { Print("No brain file, starting fresh"); return; }
   int fh = FileOpen(BRAIN_FILE, FILE_READ|FILE_BIN);
   if(fh == INVALID_HANDLE) { Print("Brain load failed"); return; }
   int saved = FileReadInteger(fh);
   int toLoad = MathMin(saved, g_bCnt);
   for(int i=0; i<toLoad; i++)
   {
      g_B[i].sumScore  = FileReadDouble(fh);
      g_B[i].sumPnl    = FileReadDouble(fh);
      g_B[i].wins      = FileReadInteger(fh);
      g_B[i].losses    = FileReadInteger(fh);
      g_B[i].adaptCnt  = FileReadInteger(fh);
      g_B[i].dynScore  = FileReadDouble(fh);
      g_B[i].lotMult   = FileReadDouble(fh);
   }
   FileClose(fh);
   PrintFormat("Brain loaded from %s (%d nodes)", BRAIN_FILE, toLoad);
}

//============================================================
//  TELEGRAM
//============================================================
void TGSend(string msg)
{
   if(!TG_On || TG_Token=="" || TG_ChatID=="") return;
   string url = "https://api.telegram.org/bot" + TG_Token + "/sendMessage";
   string postData = "chat_id=" + TG_ChatID + "&text=" + msg + "&parse_mode=HTML";
   char   post[]; StringToCharArray(postData, post);
   char   result[]; string resHeaders;
   int    timeout = 5000;
   WebRequest("POST", url, "Content-Type: application/x-www-form-urlencoded\r\n",
              timeout, post, result, resHeaders);
}

void PollTelegram()
{
   if(!TG_On || TG_Token=="" || TG_ChatID=="") return;
   string url = "https://api.telegram.org/bot" + TG_Token
              + "/getUpdates?offset=" + g_tgLastUpdate + "&timeout=1&limit=5";
   char   data[]; char result[]; string resHeaders;
   int res = WebRequest("GET", url, "", 3000, data, result, resHeaders);
   if(res == -1) return;

   string body = CharArrayToString(result);
   // Parse text commands — all command processors
   ProcessTGCommands(body);
   ProcessTGCommandsExtended(body);
   ProcessTGCommandsMarket(body);
}

void ProcessTGCommands(string body)
{
   // Command: /status
   if(StringFind(body, "/status") >= 0)
   {
      double bal = AccountInfoDouble(ACCOUNT_BALANCE);
      double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
      TGSend(StringFormat(
         "Status: Balance=%.2f Equity=%.2f Trades=%d WinRate=%d/%d",
         bal, eq, g_mCnt, g_monthly_wins, g_monthly_wins+g_monthly_loss));
   }
   // Command: /trades
   if(StringFind(body, "/trades") >= 0)
   {
      if(g_mCnt == 0) { TGSend("No open trades"); return; }
      string msg = StringFormat("Open trades: %d\n", g_mCnt);
      for(int m=0; m<g_mCnt; m++)
      {
         double ep = AccountInfoDouble(ACCOUNT_EQUITY);
         msg += StringFormat("  [%s] %s ticket=%llu\n",
                g_M[m].symbol, (g_M[m].direction==1?"BUY":"SELL"),
                g_M[m].ticket);
      }
      TGSend(msg);
   }
   // Command: /signals
   if(StringFind(body, "/signals") >= 0)
   {
      string msg = "Last signals:\n";
      int start = MathMax(0, g_slCnt - 5);
      for(int i=start; i<g_slCnt && i<MAX_SIG_LOG; i++)
      {
         int idx = i % MAX_SIG_LOG;
         msg += StringFormat("  %s %s %.1f %s %s\n",
                g_SL[idx].symbol,
                (g_SL[idx].direction==1?"BUY":"SELL"),
                g_SL[idx].score, g_SL[idx].grade,
                (g_SL[idx].traded?"TRADED":"SKIP"));
      }
      TGSend(msg);
   }
   // Command: /closeall
   if(StringFind(body, "/closeall") >= 0)
   {
      CloseAllTrades();
      TGSend("All trades closed by /closeall command");
   }
   // Command: /brain
   if(StringFind(body, "/brain") >= 0)
   {
      string msg = "Brain nodes:\n";
      for(int i=0; i<g_bCnt; i++)
      {
         msg += StringFormat("  [%s] dynScore=%.1f lotMult=%.2f W/L=%d/%d\n",
                g_syms[i], g_B[i].dynScore, g_B[i].lotMult,
                g_B[i].wins, g_B[i].losses);
      }
      TGSend(msg);
   }
   // Command: /pause
   if(StringFind(body, "/pause") >= 0)
   {
      // handled via EA_On input — inform user
      TGSend("Use EA settings to pause. Current EA_On=" + (string)EA_On);
   }
}

//============================================================
//  CLOSE ALL TRADES
//============================================================
void CloseAllTrades()
{
   for(int m=g_mCnt-1; m>=0; m--)
   {
      if(!PositionSelectByTicket(g_M[m].ticket)) continue;
      string sym = g_M[m].symbol;
      int    dir = g_M[m].direction;
      double bid = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
      MqlTradeRequest rq; ZeroMemory(rq);
      MqlTradeResult  rs; ZeroMemory(rs);
      rq.action       = TRADE_ACTION_DEAL;
      rq.symbol       = sym;
      rq.position     = g_M[m].ticket;
      rq.volume       = PositionGetDouble(POSITION_VOLUME);
      rq.price        = (dir==1) ? bid : ask;
      rq.type         = (dir==1) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
      rq.type_filling = ORDER_FILLING_IOC;
      rq.deviation    = 20;
      rq.magic        = MagicBase;
      rq.comment      = "SAIPv8_FORCE";
      if(!OrderSend(rq, rs)) // v8 fix: check return value
         Print("CloseAllTrades failed: ", sym, " rc=", rs.retcode);
   }
}

//============================================================
//  DASHBOARD
//============================================================
void DrawDashboard()
{
   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   double flt  = eq - bal;
   double dayDD= 0;
   if(g_daily_start_balance>0)
      dayDD = (g_daily_start_balance - eq) / g_daily_start_balance * 100.0;

   int    tot  = g_monthly_wins + g_monthly_loss;
   double wr   = (tot>0) ? (double)g_monthly_wins/tot*100.0 : 0;

   string dash = "";
   dash += "=== Scalping AI Pro v8.0 ===\n";
   dash += TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES) + "\n";
   dash += StringFormat("Balance: %.2f  Equity: %.2f  Float: %.2f\n", bal, eq, flt);
   dash += StringFormat("Day DD: %.2f%%  MaxDay: %.1f%%\n", dayDD, MaxDailyDD);
   dash += StringFormat("WinRate: %.0f%% (%d/%d)  Symbols: %d\n", wr, g_monthly_wins, tot, g_symCnt);
   dash += StringFormat("Open Trades: %d / %d\n", g_mCnt, MaxPositions);
   dash += "---\n";

   for(int m=0; m<g_mCnt; m++)
   {
      if(!PositionSelectByTicket(g_M[m].ticket)) continue;
      double pnl = PositionGetDouble(POSITION_PROFIT);
      int    hh  = (int)((TimeCurrent()-g_M[m].openTime)/3600);
      int    mm_ = (int)(((TimeCurrent()-g_M[m].openTime)%3600)/60);
      dash += StringFormat("  %s %s | PnL:%.2f | Grade:%.1f | %s | %dh%dm\n",
             g_M[m].symbol,
             (g_M[m].direction==1?"BUY":"SEL"),
             pnl,
             g_M[m].grade,
             (g_M[m].beSet?"BE":"   "),
             hh, mm_);
   }

   dash += "--- AI Brain ---\n";
   for(int i=0; i<MathMin(g_bCnt,5); i++)
   {
      dash += StringFormat("  %s dyn=%.1f lot=%.2f\n",
             g_syms[i], g_B[i].dynScore, g_B[i].lotMult);
   }

   // Signal log (last 5)
   dash += "--- Signals ---\n";
   int sigStart = MathMax(0, g_slCnt-5);
   for(int i=sigStart; i<g_slCnt && i<MAX_SIG_LOG; i++)
   {
      int idx = i % MAX_SIG_LOG;
      dash += StringFormat("  %s %s %.1f%s %s\n",
             g_SL[idx].symbol,
             (g_SL[idx].direction==1?"B":"S"),
             g_SL[idx].score,
             g_SL[idx].grade,
             (g_SL[idx].traded?"[T]":""));
   }

   // Cooldowns
   bool hasCool = false;
   for(int i=0; i<g_symCnt; i++)
   {
      if(TimeCurrent() < g_symCoolUntil[i])
      {
         if(!hasCool) { dash += "--- Cooldowns ---\n"; hasCool=true; }
         int secsLeft = (int)(g_symCoolUntil[i] - TimeCurrent());
         dash += StringFormat("  %s: %ds remaining\n", g_syms[i], secsLeft);
      }
   }

   Comment(dash);
}

//============================================================
//  ON CHART EVENT - manual TG command testing
//============================================================
void OnChartEvent(const int id, const long& lparam,
                  const double& dparam, const string& sparam)
{
   if(id == CHARTEVENT_KEYDOWN)
   {
      if(lparam == 67) // C key: close all
      {
         CloseAllTrades();
         Print("Manual close all triggered (C key)");
      }
      if(lparam == 83) // S key: send status
      {
         DrawDashboard();
         if(TG_On)
         {
            double bal = AccountInfoDouble(ACCOUNT_BALANCE);
            TGSend(StringFormat("Manual Status: Bal=%.2f Trades=%d WR=%d/%d",
                   bal, g_mCnt, g_monthly_wins,
                   g_monthly_wins+g_monthly_loss));
         }
      }
      if(lparam == 66) // B key: save brain
      {
         SaveBrain();
         Print("Manual brain save triggered (B key)");
      }
   }
}

//============================================================
//  ON TRADE - hook for real-time trade event logging
//============================================================
void OnTrade()
{
   // Force a check of closed trades when a trade event fires
   CheckClosed();
}


//============================================================
//  ADDITIONAL UTILITY FUNCTIONS
//============================================================

// Get pip/point value for normalization
double GetPoint(string sym)
{
   return SymbolInfoDouble(sym, SYMBOL_POINT);
}

// Get digits for a symbol
int GetDigits(string sym)
{
   return (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
}

// Convert points to price distance
double PtsToDist(string sym, double pts)
{
   return pts * SymbolInfoDouble(sym, SYMBOL_POINT);
}

// Format price with symbol digits
string FmtPrice(string sym, double price)
{
   int dg = GetDigits(sym);
   return DoubleToString(price, dg);
}

// Format a trade direction
string DirStr(int dir)
{
   return (dir == 1) ? "BUY" : (dir == -1) ? "SELL" : "NONE";
}

// Check if symbol is a JPY pair
bool IsJPYPair(string sym)
{
   return (StringFind(sym, "JPY") >= 0);
}

// Check if symbol is a precious metal or index
bool IsMetalOrIndex(string sym)
{
   return (StringFind(sym,"XAU")>=0 || StringFind(sym,"XAG")>=0 ||
           StringFind(sym,"US30")>=0 || StringFind(sym,"NAS")>=0 ||
           StringFind(sym,"SPX")>=0  || StringFind(sym,"GER")>=0);
}

//============================================================
//  ATR AVERAGE CALCULATOR
//  Returns n-period average of ATR for the given symbol/index
//============================================================
double GetATRAverage(int si, int nBars)
{
   if(nBars <= 0) return 0;
   double buf[];
   ArrayResize(buf, nBars);
   if(CopyBuffer(g_hATR[si], 0, 1, nBars, buf) < nBars) return 0;
   double sum = 0;
   for(int i=0; i<nBars; i++) sum += buf[i];
   return sum / nBars;
}

//============================================================
//  RSI VALUE FETCH
//============================================================
double GetRSIValue(int si, int barShift)
{
   double buf[1];
   if(CopyBuffer(g_hRSI[si], 0, barShift, 1, buf) < 1) return 50;
   return buf[0];
}

//============================================================
//  EMA VALUE FETCH
//============================================================
double GetEMAValue(int hEMA, int barShift)
{
   double buf[1];
   if(CopyBuffer(hEMA, 0, barShift, 1, buf) < 1) return 0;
   return buf[0];
}

//============================================================
//  CONFIRM TREND DIRECTION USING HIGHER TIMEFRAME (H1)
//  Returns 1 (uptrend), -1 (downtrend), 0 (neutral)
//============================================================
int GetHTFTrend(string sym)
{
   // Use a simple H1 EMA50 vs price check
   int hEMA50h1 = iMA(sym, PERIOD_H1, 50, 0, MODE_EMA, PRICE_CLOSE);
   if(hEMA50h1 == INVALID_HANDLE) return 0;
   double ema[1];
   if(CopyBuffer(hEMA50h1, 0, 1, 1, ema) < 1) { IndicatorRelease(hEMA50h1); return 0; }
   double close1 = iClose(sym, PERIOD_H1, 1);
   IndicatorRelease(hEMA50h1);
   if(close1 > ema[0]) return  1;
   if(close1 < ema[0]) return -1;
   return 0;
}

//============================================================
//  MULTI-TIMEFRAME CONFIRMATION
//  Called optionally before placing a trade to get HTF bias
//============================================================
bool HTFAligned(string sym, int dir)
{
   int htf = GetHTFTrend(sym);
   if(htf == 0) return true;  // neutral = no filter
   return (htf == dir);        // must align with signal direction
}

//============================================================
//  ACCOUNT METRICS HELPERS
//============================================================
double GetDailyPnL()
{
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   return eq - g_daily_start_balance;
}

double GetTotalPnL()
{
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   return eq - g_total_start_balance;
}

double GetWinRate()
{
   int tot = g_monthly_wins + g_monthly_loss;
   if(tot == 0) return 0;
   return (double)g_monthly_wins / tot * 100.0;
}

//============================================================
//  TRADE COUNT HELPERS
//============================================================
int CountOpenBySymbol(string sym)
{
   int cnt = 0;
   for(int m=0; m<g_mCnt; m++)
      if(g_M[m].symbol == sym) cnt++;
   return cnt;
}

int CountOpenTotal()
{
   return g_mCnt;
}

//============================================================
//  POSITION PROFIT HELPER
//  Returns current floating P&L of a managed trade
//============================================================
double GetTradePnL(int mIdx)
{
   if(!PositionSelectByTicket(g_M[mIdx].ticket)) return 0;
   return PositionGetDouble(POSITION_PROFIT);
}

//============================================================
//  CANDLE PATTERN HELPERS
//============================================================

// Detect a doji at bar shift
bool IsDoji(string sym, int barShift)
{
   double o = iOpen(sym,  PERIOD_M5, barShift);
   double c = iClose(sym, PERIOD_M5, barShift);
   double h = iHigh(sym,  PERIOD_M5, barShift);
   double l = iLow(sym,   PERIOD_M5, barShift);
   double range  = h - l;
   double body   = MathAbs(c - o);
   if(range <= 0) return false;
   return (body / range < 0.1); // body < 10% of range = doji
}

// Detect an engulfing pattern
// dir=1: bullish engulf (bar[1] bearish, bar[0] bullish and wider)
// dir=-1: bearish engulf
bool IsEngulfing(string sym, int dir)
{
   double o0 = iOpen(sym,  PERIOD_M5, 1);
   double c0 = iClose(sym, PERIOD_M5, 1);
   double o1 = iOpen(sym,  PERIOD_M5, 2);
   double c1 = iClose(sym, PERIOD_M5, 2);
   if(dir == 1)
   {
      bool prev_bear  = (c1 < o1);
      bool cur_bull   = (c0 > o0);
      bool engulf     = (o0 <= c1 && c0 >= o1);
      return (prev_bear && cur_bull && engulf);
   }
   if(dir == -1)
   {
      bool prev_bull  = (c1 > o1);
      bool cur_bear   = (c0 < o0);
      bool engulf     = (o0 >= c1 && c0 <= o1);
      return (prev_bull && cur_bear && engulf);
   }
   return false;
}

// Detect a pin bar (rejection wick)
// dir=1: bullish pin (long lower wick)
// dir=-1: bearish pin (long upper wick)
bool IsPinBar(string sym, int barShift, int dir)
{
   double o  = iOpen(sym,  PERIOD_M5, barShift);
   double c  = iClose(sym, PERIOD_M5, barShift);
   double h  = iHigh(sym,  PERIOD_M5, barShift);
   double l  = iLow(sym,   PERIOD_M5, barShift);
   double range  = h - l;
   if(range <= 0) return false;
   double body   = MathAbs(c - o);
   double lowerW = MathMin(o,c) - l;
   double upperW = h - MathMax(o,c);
   if(dir == 1)  return (lowerW > range * 0.6 && body < range * 0.3);
   if(dir == -1) return (upperW > range * 0.6 && body < range * 0.3);
   return false;
}

//============================================================
//  CANDLE PATTERN SCORE CONTRIBUTION
//  Returns additional score points based on candle patterns
//============================================================
double GetCandlePatternScore(string sym, int dir)
{
   double bonus = 0;
   if(IsEngulfing(sym, dir)) bonus += 1.5;
   if(IsPinBar(sym, 1, dir)) bonus += 1.0;
   if(IsDoji(sym, 2))        bonus += 0.5; // consolidation before move
   return bonus;
}



//============================================================
//  SWING HIGH / LOW DETECTION (Extended)
//  Finds the most recent swing high and low in a window
//============================================================
double FindSwingHigh(string sym, int startBar, int lookback)
{
   double swHigh = iHigh(sym, PERIOD_M5, startBar);
   for(int i=startBar+1; i<=startBar+lookback; i++)
   {
      double h = iHigh(sym, PERIOD_M5, i);
      if(h > swHigh) swHigh = h;
   }
   return swHigh;
}

double FindSwingLow(string sym, int startBar, int lookback)
{
   double swLow = iLow(sym, PERIOD_M5, startBar);
   for(int i=startBar+1; i<=startBar+lookback; i++)
   {
      double l = iLow(sym, PERIOD_M5, i);
      if(l < swLow) swLow = l;
   }
   return swLow;
}

// Check if price is near a significant level (within 1 ATR)
bool IsNearLevel(double price, double level, double atr, double tolerance)
{
   return (MathAbs(price - level) <= atr * tolerance);
}

//============================================================
//  SUPPORT & RESISTANCE LEVELS
//  Simple pivot point calculation from prior day
//============================================================
struct PivotPoints
{
   double P, R1, R2, R3, S1, S2, S3;
};

PivotPoints CalcDailyPivots(string sym)
{
   PivotPoints pp;
   ZeroMemory(pp);
   // Get previous day OHLC
   double prevH = iHigh(sym,  PERIOD_D1, 1);
   double prevL = iLow(sym,   PERIOD_D1, 1);
   double prevC = iClose(sym, PERIOD_D1, 1);
   if(prevH==0 || prevL==0 || prevC==0) return pp;
   pp.P  = (prevH + prevL + prevC) / 3.0;
   pp.R1 = 2.0 * pp.P - prevL;
   pp.R2 = pp.P + (prevH - prevL);
   pp.R3 = prevH + 2.0 * (pp.P - prevL);
   pp.S1 = 2.0 * pp.P - prevH;
   pp.S2 = pp.P - (prevH - prevL);
   pp.S3 = prevL - 2.0 * (prevH - pp.P);
   return pp;
}

// Get pivot alignment score contribution
// Returns +1.0 if price is near a support (for buys) or resistance (for sells)
double GetPivotScore(string sym, int dir, double curPrice, double atr)
{
   PivotPoints pp = CalcDailyPivots(sym);
   if(pp.P == 0) return 0;
   double tol = 0.3; // within 0.3 ATR of pivot
   if(dir == 1)
   {
      // Near support = good for buys
      if(IsNearLevel(curPrice, pp.S1, atr, tol)) return 1.0;
      if(IsNearLevel(curPrice, pp.S2, atr, tol)) return 1.0;
      if(IsNearLevel(curPrice, pp.P,  atr, tol)) return 0.5;
   }
   if(dir == -1)
   {
      // Near resistance = good for sells
      if(IsNearLevel(curPrice, pp.R1, atr, tol)) return 1.0;
      if(IsNearLevel(curPrice, pp.R2, atr, tol)) return 1.0;
      if(IsNearLevel(curPrice, pp.P,  atr, tol)) return 0.5;
   }
   return 0;
}

//============================================================
//  VOLUME ANALYSIS
//  Check if tick volume on current bar is above average
//  High volume = confirmation of move
//============================================================
bool IsHighVolume(string sym, double multiplier)
{
   long vol1  = iVolume(sym, PERIOD_M5, 1);
   // Average of last 20 bars volume
   long sumV  = 0;
   int  nV    = 20;
   for(int i=2; i<=nV+1; i++) sumV += iVolume(sym, PERIOD_M5, i);
   double avgV = (nV>0) ? (double)sumV/nV : 0;
   if(avgV <= 0) return false;
   return ((double)vol1 >= avgV * multiplier);
}

//============================================================
//  MARKET HOURS HELPERS
//============================================================
bool IsLondonSession()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= LondonOpen && dt.hour < LondonClose);
}

bool IsNYSession()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= NYOpen && dt.hour < NYClose);
}

bool IsOverlapSession()
{
   return (IsLondonSession() && IsNYSession());
}

bool IsAsiaSession()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= 0 && dt.hour < 8);
}

bool IsWeekend()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   return (dt.day_of_week == 0 || dt.day_of_week == 6);
}

string GetSessionName()
{
   if(IsOverlapSession()) return "London/NY_Overlap";
   if(IsLondonSession())  return "London";
   if(IsNYSession())      return "NewYork";
   if(IsAsiaSession())    return "Asia";
   return "Off";
}



//============================================================
//  RISK MANAGEMENT STATISTICS
//  Computes running statistics for risk management decisions
//============================================================
struct RiskStats
{
   double maxDD;        // max drawdown seen
   double peakEquity;   // highest equity reached
   double avgWin;       // average win amount
   double avgLoss;      // average loss amount
   double expectancy;   // (winRate * avgWin) - (lossRate * avgLoss)
   int    streak;       // current win/loss streak (positive=wins, negative=losses)
};

RiskStats g_riskStats;

void UpdateRiskStats(double pnl)
{
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);

   // Peak equity
   if(eq > g_riskStats.peakEquity) g_riskStats.peakEquity = eq;

   // Max drawdown
   if(g_riskStats.peakEquity > 0)
   {
      double dd = (g_riskStats.peakEquity - eq) / g_riskStats.peakEquity * 100.0;
      if(dd > g_riskStats.maxDD) g_riskStats.maxDD = dd;
   }

   // Streak
   if(pnl >= 0)
   {
      if(g_riskStats.streak < 0) g_riskStats.streak  = 1;
      else                        g_riskStats.streak++;
   }
   else
   {
      if(g_riskStats.streak > 0) g_riskStats.streak  = -1;
      else                        g_riskStats.streak--;
   }

   // Running win/loss averages
   int tot = g_monthly_wins + g_monthly_loss;
   if(tot <= 0) return;
   double wr = (double)g_monthly_wins / tot;
   double lr = 1.0 - wr;
   if(pnl >= 0 && g_monthly_wins > 0)
      g_riskStats.avgWin = (g_riskStats.avgWin * (g_monthly_wins-1) + pnl) / g_monthly_wins;
   if(pnl < 0 && g_monthly_loss > 0)
      g_riskStats.avgLoss = (g_riskStats.avgLoss * (g_monthly_loss-1) + MathAbs(pnl)) / g_monthly_loss;
   g_riskStats.expectancy = (wr * g_riskStats.avgWin) - (lr * g_riskStats.avgLoss);
}

//============================================================
//  POSITION SIZE SCALER
//  Reduces lot size on losing streaks, increases on winning
//============================================================
double GetStreakLotMultiplier()
{
   int streak = g_riskStats.streak;
   if(streak <= -3) return 0.5;   // 3+ losses: half size
   if(streak == -2) return 0.75;  // 2 losses: 75% size
   if(streak >= 3)  return 1.25;  // 3+ wins: 125% size (capped)
   return 1.0;
}

//============================================================
//  SYMBOL PERFORMANCE TRACKING
//  Per-symbol P&L tracking array
//============================================================
double g_symPnl[MAX_A];      // cumulative P&L per symbol
int    g_symTrades[MAX_A];   // trade count per symbol
int    g_symWins[MAX_A];     // wins per symbol

void UpdateSymbolPerf(int si, double pnl)
{
   if(si < 0 || si >= MAX_A) return;
   g_symPnl[si]    += pnl;
   g_symTrades[si]++;
   if(pnl >= 0) g_symWins[si]++;
}

double GetSymbolWinRate(int si)
{
   if(si < 0 || si >= MAX_A) return 0;
   if(g_symTrades[si] <= 0) return 0;
   return (double)g_symWins[si] / g_symTrades[si] * 100.0;
}

//============================================================
//  MACD SIGNAL (Additional confirmation)
//  Uses built-in MACD indicator for additional confluence
//============================================================
int GetMACDSignal(string sym)
{
   int hMACD = iMACD(sym, PERIOD_M5, 12, 26, 9, PRICE_CLOSE);
   if(hMACD == INVALID_HANDLE) return 0;
   double macdMain[], macdSignal[]; // v8 fix: dynamic arrays
   if(CopyBuffer(hMACD, 0, 1, 2, macdMain)   < 2) { IndicatorRelease(hMACD); return 0; }
   if(CopyBuffer(hMACD, 1, 1, 2, macdSignal) < 2) { IndicatorRelease(hMACD); return 0; }
   ArraySetAsSeries(macdMain,   true);
   ArraySetAsSeries(macdSignal, true);
   IndicatorRelease(hMACD);
   // MACD cross: main crosses above signal = bullish
   bool bullCross = (macdMain[1] < macdSignal[1]) && (macdMain[0] > macdSignal[0]);
   bool bearCross = (macdMain[1] > macdSignal[1]) && (macdMain[0] < macdSignal[0]);
   if(bullCross) return  1;
   if(bearCross) return -1;
   return 0;
}

//============================================================
//  STOCHASTIC SIGNAL
//  Returns oversold bounce (buy) or overbought reversal (sell)
//============================================================
int GetStochSignal(string sym)
{
   int hStoch = iStochastic(sym, PERIOD_M5, 14, 3, 3, MODE_SMA, STO_LOWHIGH);
   if(hStoch == INVALID_HANDLE) return 0;
   double kBuf[3], dBuf[3];
   if(CopyBuffer(hStoch, 0, 1, 3, kBuf) < 3) { IndicatorRelease(hStoch); return 0; }
   if(CopyBuffer(hStoch, 1, 1, 3, dBuf) < 3) { IndicatorRelease(hStoch); return 0; }
   ArraySetAsSeries(kBuf, true); ArraySetAsSeries(dBuf, true);
   IndicatorRelease(hStoch);
   // Oversold cross: K crosses above D from below 20
   bool bullCross = (kBuf[1] < dBuf[1]) && (kBuf[0] > dBuf[0]) && (kBuf[0] < 30);
   // Overbought cross: K crosses below D from above 80
   bool bearCross = (kBuf[1] > dBuf[1]) && (kBuf[0] < dBuf[0]) && (kBuf[0] > 70);
   if(bullCross) return  1;
   if(bearCross) return -1;
   return 0;
}

//============================================================
//  NEWS FILTER PLACEHOLDER
//  In production, connect to a news API or calendar
//  For now, avoids trading within 30 min of top-of-hour
//  (a rough proxy for scheduled news releases)
//============================================================
bool IsNewsTime()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   int minsPastHour = dt.min;
   // Avoid 0:00 to 0:05 of each hour (hard news times)
   if(minsPastHour <= 5) return true;
   // Also avoid 55-59 minutes (approaching next hour)
   if(minsPastHour >= 55) return true;
   return false;
}

//============================================================
//  PROFIT TARGET MANAGEMENT
//  If daily profit target reached, stop trading for the day
//============================================================
input double   DailyProfitTarget = 3.0; // Daily profit target % (0=off)

bool IsDailyTargetHit()
{
   if(DailyProfitTarget <= 0) return false;
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   double pct = (g_daily_start_balance > 0)
              ? (eq - g_daily_start_balance) / g_daily_start_balance * 100.0
              : 0;
   return (pct >= DailyProfitTarget);
}

//============================================================
//  CONSECUTIVE LOSS GUARD
//  Pause EA after N consecutive losses to prevent revenge trading
//============================================================
input int      MaxConsecLoss = 3; // Max consecutive losses before pause

int  g_consecLoss  = 0;
bool g_tradingPaused = false;

void UpdateConsecLoss(double pnl)
{
   if(pnl < 0)
   {
      g_consecLoss++;
      if(g_consecLoss >= MaxConsecLoss)
      {
         g_tradingPaused = true;
         string msg = StringFormat("PAUSED: %d consecutive losses. Resume tomorrow.", g_consecLoss);
         Print(msg);
         if(TG_On) TGSend(msg);
      }
   }
   else
   {
      g_consecLoss   = 0;     // reset streak on any win
      g_tradingPaused = false; // auto-resume after a winning trade
   }
}

bool IsTradingAllowed()
{
   if(g_tradingPaused) return false;
   if(IsDailyTargetHit()) return false;
   if(IsWeekend()) return false;
   if(!IsSessionOK()) return false;
   return true;
}

//============================================================
//  SIGNAL STRENGTH DISPLAY STRING
//  Builds a human-readable signal summary for logs/TG
//============================================================
string BuildSignalSummary(string sym, int dir, double score, string grade,
                          int emaSig, int rsiSig, int bbSig,
                          int divSig, int obSig, int liqSig,
                          int mom3, bool atrExp)
{
   string d = (dir==1) ? "BUY" : "SELL";
   string flags = "";
   if(emaSig == dir)  flags += "EMA ";
   if(rsiSig == dir)  flags += "RSI ";
   if(bbSig  == dir)  flags += "BB ";
   if(divSig == dir)  flags += "DIV ";
   if(obSig  == dir)  flags += "OB ";
   if(liqSig == dir)  flags += "LIQ ";
   if(mom3 == 3)      flags += "MOM3 ";
   if(atrExp)         flags += "ATRX ";
   return StringFormat("[%s] %s %.1f %s | %s", sym, d, score, grade, flags);
}

//============================================================
//  PERFORMANCE REPORT
//  Generates a full performance report string for TG/log
//============================================================
string BuildPerfReport()
{
   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   int    tot  = g_monthly_wins + g_monthly_loss;
   double wr   = GetWinRate();
   double dayPnl = GetDailyPnL();
   double totPnl = GetTotalPnL();

   string rpt = "=== PERFORMANCE REPORT ===\n";
   rpt += StringFormat("Date: %s\n", TimeToString(TimeCurrent(), TIME_DATE));
   rpt += StringFormat("Balance: %.2f  Equity: %.2f\n", bal, eq);
   rpt += StringFormat("Day PnL: %.2f  Total: %.2f\n", dayPnl, totPnl);
   rpt += StringFormat("WinRate: %.1f%% (%d/%d)\n", wr, g_monthly_wins, tot);
   rpt += StringFormat("MaxDD: %.2f%%\n", g_riskStats.maxDD);
   rpt += StringFormat("Expectancy: %.2f\n", g_riskStats.expectancy);
   rpt += StringFormat("Streak: %d\n", g_riskStats.streak);
   rpt += StringFormat("Session: %s\n", GetSessionName());
   rpt += "--- Per Symbol ---\n";
   for(int i=0; i<g_symCnt; i++)
   {
      if(g_symTrades[i] > 0)
         rpt += StringFormat("  %s: PnL=%.2f WR=%.0f%% (%d trades)\n",
                g_syms[i], g_symPnl[i], GetSymbolWinRate(i), g_symTrades[i]);
   }
   return rpt;
}

//============================================================
//  EXTENDED TELEGRAM COMMANDS
//  Additional commands for advanced control
//============================================================
void ProcessTGCommandsExtended(string body)
{
   // Command: /report - full performance report
   if(StringFind(body, "/report") >= 0)
      TGSend(BuildPerfReport());

   // Command: /symbols - per-symbol performance
   if(StringFind(body, "/symbols") >= 0)
   {
      string msg = "Symbol Performance:\n";
      for(int i=0; i<g_symCnt; i++)
         msg += StringFormat("  %s: PnL=%.2f WR=%.0f%%\n",
                g_syms[i], g_symPnl[i], GetSymbolWinRate(i));
      TGSend(msg);
   }

   // Command: /session - current session info
   if(StringFind(body, "/session") >= 0)
   {
      TGSend("Current session: " + GetSessionName() +
             " | Trading: " + (IsTradingAllowed()?"YES":"PAUSED"));
   }

   // Command: /risk - risk stats
   if(StringFind(body, "/risk") >= 0)
   {
      TGSend(StringFormat("Risk Stats: MaxDD=%.2f%% Streak=%d Expect=%.2f",
             g_riskStats.maxDD, g_riskStats.streak, g_riskStats.expectancy));
   }

   // Command: /cooldowns - show active cooldowns
   if(StringFind(body, "/cooldowns") >= 0)
   {
      string msg = "Active Cooldowns:\n";
      bool any = false;
      for(int i=0; i<g_symCnt; i++)
      {
         if(TimeCurrent() < g_symCoolUntil[i])
         {
            any = true;
            int secs = (int)(g_symCoolUntil[i] - TimeCurrent());
            msg += StringFormat("  %s: %ds\n", g_syms[i], secs);
         }
      }
      if(!any) msg += "  None";
      TGSend(msg);
   }

   // Command: /resume - resume after consecutive loss pause
   if(StringFind(body, "/resume") >= 0)
   {
      g_tradingPaused = false;
      g_consecLoss    = 0;
      TGSend("Trading resumed by /resume command");
   }
}



//============================================================
//  ORDER MODIFICATION HELPER
//  Safe wrapper for modifying position SL/TP
//============================================================
bool ModifySLTP(ulong ticket, double newSL, double newTP)
{
   if(!PositionSelectByTicket(ticket)) return false;
   MqlTradeRequest rq; ZeroMemory(rq);
   MqlTradeResult  rs; ZeroMemory(rs);
   rq.action   = TRADE_ACTION_SLTP;
   rq.symbol   = PositionGetString(POSITION_SYMBOL);
   rq.position = ticket;
   rq.sl       = newSL;
   rq.tp       = newTP;
   return OrderSend(rq, rs);
}

//============================================================
//  PARTIAL CLOSE HELPER
//  Closes a specified volume of an open position
//============================================================
bool PartialClose(ulong ticket, double volume)
{
   if(!PositionSelectByTicket(ticket)) return false;
   string sym = PositionGetString(POSITION_SYMBOL);
   int    dir = (int)PositionGetInteger(POSITION_TYPE); // 0=buy 1=sell
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   MqlTradeRequest rq; ZeroMemory(rq);
   MqlTradeResult  rs; ZeroMemory(rs);
   rq.action       = TRADE_ACTION_DEAL;
   rq.symbol       = sym;
   rq.position     = ticket;
   rq.volume       = volume;
   rq.price        = (dir==0) ? bid : ask; // close buy at bid, sell at ask
   rq.type         = (dir==0) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   rq.type_filling = ORDER_FILLING_IOC;
   rq.deviation    = 20;
   rq.magic        = MagicBase;
   return OrderSend(rq, rs);
}

//============================================================
//  ATR-BASED TRAILING STOP CALCULATOR
//  Returns the new SL level based on ATR trail distance
//  Returns 0 if no update needed
//============================================================
double CalcTrailSL(int mIdx, double curATR)
{
   if(mIdx < 0 || mIdx >= g_mCnt) return 0;
   int    dir    = g_M[mIdx].direction;
   string sym    = g_M[mIdx].symbol;
   int    dg     = GetDigits(sym);
   double curSL  = g_M[mIdx].sl;
   double trail  = curATR * ATR_Trail_Mult;
   double bid    = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask    = SymbolInfoDouble(sym, SYMBOL_ASK);
   double curP   = (dir==1) ? bid : ask;

   double newSL = (dir==1) ? NormalizeDouble(curP - trail, dg)
                           : NormalizeDouble(curP + trail, dg);

   if(dir ==  1 && newSL > curSL && newSL > g_M[mIdx].openPrice) return newSL;
   if(dir == -1 && (curSL==0 || newSL < curSL) && newSL < g_M[mIdx].openPrice) return newSL;
   return 0;
}

//============================================================
//  BREAKEVEN CALCULATOR
//  Returns the breakeven SL level (entry + spread buffer)
//============================================================
double CalcBESL(int mIdx)
{
   if(mIdx < 0 || mIdx >= g_mCnt) return 0;
   string sym  = g_M[mIdx].symbol;
   int    dir  = g_M[mIdx].direction;
   int    dg   = GetDigits(sym);
   double bid  = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask  = SymbolInfoDouble(sym, SYMBOL_ASK);
   double sprd = ask - bid;
   double be   = (dir==1) ? g_M[mIdx].openPrice + sprd
                          : g_M[mIdx].openPrice - sprd;
   return NormalizeDouble(be, dg);
}

//============================================================
//  PRICE MOVE CALCULATOR
//  Returns how far price has moved in our direction
//  as a multiple of SL distance (R-multiples)
//============================================================
double GetRMultiple(int mIdx)
{
   if(mIdx < 0 || mIdx >= g_mCnt) return 0;
   if(g_M[mIdx].slD <= 0) return 0;
   int    dir  = g_M[mIdx].direction;
   string sym  = g_M[mIdx].symbol;
   double bid  = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask  = SymbolInfoDouble(sym, SYMBOL_ASK);
   double curP = (dir==1) ? bid : ask;
   double move = (dir==1) ? (curP - g_M[mIdx].openPrice)
                          : (g_M[mIdx].openPrice - curP);
   return move / g_M[mIdx].slD;
}

//============================================================
//  BRAIN NODE PERFORMANCE STRING
//  Build a display string for a single brain node
//============================================================
string BrainNodeStr(int bi)
{
   if(bi < 0 || bi >= g_bCnt) return "";
   int tot = g_B[bi].wins + g_B[bi].losses;
   double wr = (tot>0) ? (double)g_B[bi].wins/tot*100.0 : 0;
   return StringFormat("[%s] dyn=%.1f lot=%.2f WR=%.0f%% (%d/%d) pnl=%.2f",
          (bi<g_symCnt?g_syms[bi]:"?"),
          g_B[bi].dynScore, g_B[bi].lotMult,
          wr, g_B[bi].wins, tot, g_B[bi].sumPnl);
}

//============================================================
//  SIGNAL LOG DISPLAY
//  Returns last N signal log entries as string
//============================================================
string GetSignalLogStr(int nEntries)
{
   string s = "";
   int start = MathMax(0, g_slCnt - nEntries);
   for(int i=start; i<g_slCnt; i++)
   {
      int idx = i % MAX_SIG_LOG;
      s += StringFormat("%s %s %s %.1f%s %s\n",
           TimeToString(g_SL[idx].time, TIME_MINUTES),
           g_SL[idx].symbol,
           (g_SL[idx].direction==1?"BUY":"SEL"),
           g_SL[idx].score,
           g_SL[idx].grade,
           (g_SL[idx].traded?"[T]":"[S]"));
   }
   return s;
}

//============================================================
//  MARKET CONDITION REPORTER
//  Returns a formatted string of current market conditions
//  for all symbols — useful for dashboard and TG /market command
//============================================================
string GetMarketConditionsStr()
{
   string s = "Market Conditions:\n";
   for(int si=0; si<g_symCnt; si++)
   {
      string sym = g_syms[si];
      double atrVal[1];
      if(CopyBuffer(g_hATR[si], 0, 1, 1, atrVal) < 1) continue;
      double atr = atrVal[0];
      double atrAvg = GetATRAverage(si, 20);
      string regime = DetectRegime(sym, atr, atrAvg);
      long   spread = SymbolInfoInteger(sym, SYMBOL_SPREAD);
      bool   cooled = (TimeCurrent() < g_symCoolUntil[si]);
      s += StringFormat("  %s | %s | ATR=%.5f | Sprd=%d | %s\n",
             sym, regime, atr, (int)spread, (cooled?"COOL":"OK"));
   }
   return s;
}

//============================================================
//  EXTENDED TELEGRAM MARKET COMMAND
//============================================================
void ProcessTGCommandsMarket(string body)
{
   if(StringFind(body, "/market") >= 0)
      TGSend(GetMarketConditionsStr());
   if(StringFind(body, "/signals") >= 0)
      TGSend("Recent signals:\n" + GetSignalLogStr(10));
   if(StringFind(body, "/brain") >= 0)
   {
      string msg = "Brain Status:\n";
      for(int i=0; i<g_bCnt; i++) msg += "  " + BrainNodeStr(i) + "\n";
      TGSend(msg);
   }
}

//============================================================
//  INITIALIZATION VALIDATION
//  Checks symbol accessibility, lot constraints, etc.
//============================================================
bool ValidateSymbols()
{
   bool ok = true;
   for(int i=0; i<g_symCnt; i++)
   {
      string sym = g_syms[i];
      if(!SymbolSelect(sym, true))
      {
         PrintFormat("WARNING: Symbol %s not available in Market Watch", sym);
         ok = false;
         continue;
      }
      double minLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
      double maxLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
      if(minLot <= 0 || maxLot <= 0)
      {
         PrintFormat("WARNING: Invalid lot constraints for %s min=%.2f max=%.2f",
                sym, minLot, maxLot);
      }
   }
   return ok;
}

//============================================================
//  STARTUP DIAGNOSTICS
//  Logs key configuration settings on startup
//============================================================
void PrintStartupDiagnostics()
{
   PrintFormat("=== Scalping AI Pro v8.0 - Startup Diagnostics ===");
   PrintFormat("Account: %s #%d", AccountInfoString(ACCOUNT_COMPANY),
               (int)AccountInfoInteger(ACCOUNT_LOGIN));
   PrintFormat("Balance: %.2f %s", AccountInfoDouble(ACCOUNT_BALANCE),
               AccountInfoString(ACCOUNT_CURRENCY));
   PrintFormat("Leverage: 1:%d", (int)AccountInfoInteger(ACCOUNT_LEVERAGE));
   PrintFormat("Symbols: %d -> %s", g_symCnt, Symbols);
   PrintFormat("Risk: %.1f%% MaxPos:%d MinRR:%.1f", RiskPct, MaxPositions, MinRR);
   PrintFormat("MinScore:%.1f MaxDayDD:%.1f%% MaxTotDD:%.1f%%",
               MinScore, MaxDailyDD, MaxTotalDD);
   PrintFormat("MaxTradeHours:%d CooldownMins:%.0f", MaxTradeHours, CooldownMins);
   PrintFormat("AI:%s TG:%s AutoSig:%s SwingSL:%s",
               (string)AI_On, (string)TG_On,
               (string)TG_AutoSignals, (string)UseSwingSL);
   PrintFormat("v8 FIXES ACTIVE: DealTicket=FIXED LoopShadow=FIXED RR=FIXED");
   PrintFormat("v8 IMPS ACTIVE: AdditiveScore 3BarMom ATRExp MinRR PerSymCool BE75R TrailBE StaleExit FasterAI BBBounce MinATR");
   PrintFormat("=================================================");
}

//============================================================
//  SECOND INIT CALL (called at end of OnInit)
//  Validates and logs diagnostics
//  Note: called separately after main init block
//============================================================
// (Diagnostics and validation are called within OnInit above)

//============================================================
//  GLOBAL INIT FOR RISK STATS AND SYMBOL PERF
//  Called from within OnInit via ArrayInitialize
//============================================================
void InitGlobalArrays()
{
   ZeroMemory(g_riskStats);
   g_riskStats.peakEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   ArrayInitialize(g_symPnl,    0);
   ArrayInitialize(g_symTrades, 0);
   ArrayInitialize(g_symWins,   0);
   g_consecLoss    = 0;
   g_tradingPaused = false;
}

//============================================================
//  MONTHLY STATS SUMMARY
//  Returns a brief summary for the dashboard
//============================================================
string GetMonthlyStatsSummary()
{
   int tot = g_monthly_wins + g_monthly_loss;
   double wr = (tot>0) ? (double)g_monthly_wins/tot*100.0 : 0;
   double totalPnl = 0;
   for(int i=0; i<g_monthly_cnt; i++) totalPnl += g_monthly_pnl[i];
   return StringFormat("Trades:%d WR:%.0f%% PnL:%.2f", tot, wr, totalPnl);
}

//============================================================
//  SYMBOL ENABLED CHECK
//  Checks if a symbol is available and not halted
//============================================================
bool IsSymbolTradeAllowed(string sym)
{
   long tradeMode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   return (tradeMode == SYMBOL_TRADE_MODE_FULL ||
           tradeMode == SYMBOL_TRADE_MODE_LONGONLY ||
           tradeMode == SYMBOL_TRADE_MODE_SHORTONLY);
}

//============================================================
//  MIN LOT ENFORCEMENT
//  Returns true if proposed lot size is at least min lot
//============================================================
bool IsLotViable(string sym, double lots)
{
   double minLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   return (lots >= minLot);
}

//============================================================
//  TIME-BASED TRADE ID
//  Generates a unique string ID for a trade based on symbol + time
//============================================================
string MakeTradeID(string sym, datetime t)
{
   return sym + "_" + IntegerToString((long)t);
}

//============================================================
//  NORMALIZE PRICE
//  Normalizes a price value to the symbol tick size
//============================================================
double NormalizeToTick(string sym, double price)
{
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0) return price;
   return NormalizeDouble(MathRound(price / tickSize) * tickSize, GetDigits(sym));
}

//============================================================
//  DEVIATION GUARD
//  Returns true if price has not moved too far from last check
//  (prevents stale price execution)
//============================================================
bool IsExecutionPriceOK(string sym, int dir, double requestPrice, int maxSlipPts)
{
   double curP  = (dir==1) ? SymbolInfoDouble(sym, SYMBOL_ASK)
                           : SymbolInfoDouble(sym, SYMBOL_BID);
   double pt    = SymbolInfoDouble(sym, SYMBOL_POINT);
   double diff  = MathAbs(curP - requestPrice) / pt;
   return (diff <= (double)maxSlipPts);
}

//============================================================
//  DAILY HIGH / LOW
//  Returns today s high and low for context
//============================================================
void GetDayRange(string sym, double &dayHigh, double &dayLow)
{
   dayHigh = iHigh(sym, PERIOD_D1, 0);
   dayLow  = iLow(sym,  PERIOD_D1, 0);
}

// Returns how far price is from day high/low as fraction of range
double PctFromDayHigh(string sym)
{
   double dH, dL;
   GetDayRange(sym, dH, dL);
   double range = dH - dL;
   if(range <= 0) return 0;
   double cur = SymbolInfoDouble(sym, SYMBOL_BID);
   return (dH - cur) / range;
}

double PctFromDayLow(string sym)
{
   double dH, dL;
   GetDayRange(sym, dH, dL);
   double range = dH - dL;
   if(range <= 0) return 0;
   double cur = SymbolInfoDouble(sym, SYMBOL_BID);
   return (cur - dL) / range;
}



//============================================================
//  MULTI-CURRENCY CORRELATION GUARD
//  Prevents entering opposing trades on highly correlated pairs
//  e.g. avoid simultaneous EURUSD BUY and GBPUSD SELL (they move together)
//============================================================
bool IsCorrelationConflict(string sym, int dir)
{
   // Define correlated pairs (simplified static groups)
   // Group A: EUR/GBP/CHF/CAD tend to be correlated vs USD
   // If we have a BUY on EURUSD, do not take SELL on GBPUSD
   string groupA[] = {"EURUSD","GBPUSD","EURGBP","USDCHF","USDCAD"};

   bool symInGroupA = false;
   for(int g=0; g<ArraySize(groupA); g++)
      if(groupA[g] == sym) { symInGroupA=true; break; }
   if(!symInGroupA) return false;

   // Check existing trades for correlation conflict
   for(int m=0; m<g_mCnt; m++)
   {
      bool existInGroupA = false;
      for(int g=0; g<ArraySize(groupA); g++)
         if(groupA[g] == g_M[m].symbol) { existInGroupA=true; break; }
      if(!existInGroupA) continue;
      if(g_M[m].symbol == sym) continue; // same symbol, not a conflict

      // If existing trade is in opposite direction on a correlated pair = conflict
      // Special case: USDCHF/USDCAD inverse to EUR/GBP
      bool existIsUSD = (StringFind(g_M[m].symbol,"USD")==0);
      bool newIsUSD   = (StringFind(sym,"USD")==0);
      int  effectiveDir = g_M[m].direction;
      if(existIsUSD != newIsUSD) effectiveDir = -g_M[m].direction; // invert for USD-base

      if(effectiveDir != dir)
      {
         PrintFormat("Correlation conflict: %s %s vs existing %s %s",
                sym, DirStr(dir), g_M[m].symbol, DirStr(g_M[m].direction));
         return true;
      }
   }
   return false;
}

//============================================================
//  EQUITY HIGH WATER MARK TRAILING
//  Tracks equity peak for max drawdown calculation
//  Called periodically from OnTick
//============================================================
void UpdateEquityPeak()
{
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq > g_riskStats.peakEquity)
      g_riskStats.peakEquity = eq;
}

//============================================================
//  DASHBOARD FULL LINE BUILDER
//  Extended version with more detail for the chart comment
//============================================================
string BuildFullDashboard()
{
   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   double flt  = eq - bal;
   double dayDD = 0;
   if(g_daily_start_balance > 0)
      dayDD = (g_daily_start_balance - eq) / g_daily_start_balance * 100.0;
   double totDD = 0;
   if(g_riskStats.peakEquity > 0)
      totDD = (g_riskStats.peakEquity - eq) / g_riskStats.peakEquity * 100.0;

   string d = "";
   d += "+-----------------------------------------+\n";
   d += "|     SCALPING AI PRO v8.0 DASHBOARD      |\n";
   d += "+-----------------------------------------+\n";
   d += StringFormat("| %-39s|\n", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES));
   d += StringFormat("| Bal: %-8.2f  Eq: %-8.2f Flt: %-6.2f|\n", bal, eq, flt);
   d += StringFormat("| DayDD:%-5.2f%%  TotDD:%-5.2f%%  MaxDD:%-5.2f%%|\n",
          dayDD, totDD, g_riskStats.maxDD);
   d += StringFormat("| Session: %-10s  Trading: %-3s   |\n",
          GetSessionName(), (IsTradingAllowed()?"YES":"NO"));
   d += StringFormat("| %s               |\n", GetMonthlyStatsSummary());
   d += "+-----------------------------------------+\n";

   // Open trades
   if(g_mCnt > 0)
   {
      d += "| OPEN TRADES:                            |\n";
      for(int m=0; m<g_mCnt; m++)
      {
         if(!PositionSelectByTicket(g_M[m].ticket)) continue;
         double pnl = PositionGetDouble(POSITION_PROFIT);
         double rmult = GetRMultiple(m);
         d += StringFormat("| %-6s %-4s PnL:%-7.2f R:%-4.2f BE:%-3s  |\n",
                g_M[m].symbol,
                DirStr(g_M[m].direction),
                pnl, rmult,
                (g_M[m].beSet?"YES":"NO"));
      }
      d += "+-----------------------------------------+\n";
   }

   // AI Brain (condensed)
   d += "| AI BRAIN:                               |\n";
   for(int i=0; i<MathMin(g_bCnt,3); i++)
   {
      int tot = g_B[i].wins + g_B[i].losses;
      double wr = (tot>0)?(double)g_B[i].wins/tot*100.0:0;
      d += StringFormat("| %-6s dyn=%-4.1f lot=%-4.2f WR=%-4.0f%%  |\n",
             (i<g_symCnt?g_syms[i]:"?"),
             g_B[i].dynScore, g_B[i].lotMult, wr);
   }
   d += "+-----------------------------------------+\n";

   return d;
}

//============================================================
//  ENHANCED DRAW DASHBOARD
//  Overrides the basic dashboard with the extended version
//  when DetailedDash input is enabled
//============================================================
input bool DetailedDash = true; // Show detailed dashboard

void DrawDashboardFull()
{
   if(DetailedDash)
      Comment(BuildFullDashboard());
   else
      DrawDashboard();
}

//============================================================
//  STOCHASTIC OVERBOUGHT / OVERSOLD CHECK
//  Quick helper - returns true if stoch is in zone
//============================================================
bool IsStochOversold(string sym)
{
   int hS = iStochastic(sym, PERIOD_M5, 14, 3, 3, MODE_SMA, STO_LOWHIGH);
   if(hS == INVALID_HANDLE) return false;
   double k[1];
   bool res = false;
   if(CopyBuffer(hS, 0, 1, 1, k) >= 1) res = (k[0] < 20);
   IndicatorRelease(hS);
   return res;
}

bool IsStochOverbought(string sym)
{
   int hS = iStochastic(sym, PERIOD_M5, 14, 3, 3, MODE_SMA, STO_LOWHIGH);
   if(hS == INVALID_HANDLE) return false;
   double k[1];
   bool res = false;
   if(CopyBuffer(hS, 0, 1, 1, k) >= 1) res = (k[0] > 80);
   IndicatorRelease(hS);
   return res;
}

//============================================================
//  OPEN INTEREST / COMMITMENT OF TRADERS STUB
//  Placeholder for future COT integration via external data feed
//============================================================
// double GetCOTNetPosition(string sym) { return 0; } // TODO: integrate COT API

//============================================================
//  INPUT: ADDITIONAL FILTERS (v8 extended)
//============================================================
input bool   UseHTFFilter      = false;  // Use H1 trend filter (HTF)
input bool   UseCorrelFilter   = true;   // Use correlation conflict filter
input bool   UsePivotScore     = true;   // Add pivot point score
input bool   UseVolumeFilter   = false;  // Require above-avg volume
input double VolumeMinMult     = 1.2;    // Min volume multiplier for filter
input bool   UseNewsFilter     = true;   // Avoid trading near news times
input bool   UseCandlePatterns = true;   // Score candle patterns
input bool   UseConsecLossGuard= true;   // Enable consecutive loss guard

//============================================================
//  EXTENDED SCAN PRE-CHECKS
//  Helper called from Scan() to run all optional filters
//  Returns false if any active filter blocks the trade
//============================================================
bool ScanPreChecks(string sym, int si, int dir)
{
   // News filter
   if(UseNewsFilter && IsNewsTime()) return false;

   // Consecutive loss guard
   if(UseConsecLossGuard && g_tradingPaused) return false;

   // Daily profit target
   if(IsDailyTargetHit()) return false;

   // Symbol trade allowed
   if(!IsSymbolTradeAllowed(sym)) return false;

   // Correlation conflict
   if(UseCorrelFilter && IsCorrelationConflict(sym, dir)) return false;

   // HTF filter
   if(UseHTFFilter && !HTFAligned(sym, dir)) return false;

   // Volume filter
   if(UseVolumeFilter && !IsHighVolume(sym, VolumeMinMult)) return false;

   return true;
}

//============================================================
//  EXTENDED SCORE MODIFIERS
//  Called from Scan() to add optional score components
//  Returns additional score points
//============================================================
double GetExtendedScoreBonus(string sym, int si, int dir, double atr, double curPrice)
{
   double bonus = 0;

   // Candle pattern score
   if(UseCandlePatterns) bonus += GetCandlePatternScore(sym, dir);

   // Pivot score
   if(UsePivotScore) bonus += GetPivotScore(sym, dir, curPrice, atr);

   // Volume bonus
   if(UseVolumeFilter && IsHighVolume(sym, 1.5)) bonus += 0.5;

   // Session overlap bonus (London/NY overlap = highest liquidity)
   if(IsOverlapSession()) bonus += 0.5;

   // Day range position: buy near low, sell near high = bonus
   if(dir ==  1 && PctFromDayLow(sym)  < 0.3) bonus += 0.5;
   if(dir == -1 && PctFromDayHigh(sym) < 0.3) bonus += 0.5;

   return bonus;
}

//============================================================
//  OnTimer: periodic tasks (brain save, TG heartbeat)
//  Registered in OnInit with EventSetTimer()
//============================================================
void OnTimer()
{
   // Save brain every 30 minutes
   static datetime lastBrainSave = 0;
   if(AI_On && AI_Save && TimeCurrent() - lastBrainSave >= 1800)
   {
      SaveBrain();
      lastBrainSave = TimeCurrent();
   }

   // TG heartbeat every 60 min
   static datetime lastHeartbeat = 0;
   if(TG_On && TimeCurrent() - lastHeartbeat >= 3600)
   {
      TGSend(StringFormat("[Heartbeat] %s | Trades:%d | %s",
             TimeToString(TimeCurrent(), TIME_MINUTES),
             g_mCnt, GetMonthlyStatsSummary()));
      lastHeartbeat = TimeCurrent();
   }

   // Update equity peak
   UpdateEquityPeak();
}


//+------------------------------------------------------------------+
//  END OF ScalpingEA_Pro_v8.mq5
//  Version 8.01 - 2026-04-05
//  v8.01 CRITICAL FIX: Vote system replaced with EMA primary trigger
//    - Was: required 2+ votes from 6 rare signals (never fired)
//    - Now: EMA cross = primary trigger, others = score bonus
//    - MinScore 4.0 -> 2.0 (EMA cross alone = valid trade)
//    - momentum3==0 hard block removed (now a score bonus)
//    - Dashboard: DrawDashboard() -> DrawDashboardFull() in OnTick
//+------------------------------------------------------------------+