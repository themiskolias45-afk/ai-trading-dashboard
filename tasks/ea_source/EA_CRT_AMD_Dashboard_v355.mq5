//+------------------------------------------------------------------+
//|                                              EA_CRT_AMD_Dashboard |
//|                        Multi-timeframe CRT + AMD execution for MT5|
//+------------------------------------------------------------------+
#property strict
// #property version   "3.50" // v3.51 suppressed
#property version   "3.55"   // v3.53 ADDITIVE: ticket-addressed position management
#property description "CRT + AMD multi-timeframe EA with professional dashboard"
// v1.10 ADDITIVE UPGRADE (2026-07-04):
//   - Size buttons (S / N / B / FULL) re-enabled: real sizes, header row, active highlight
//   - TRUE full-screen mode: FULL now fills the entire chart
//   - All original logic preserved. Suppressed lines commented with //, never deleted.
// v3.51 ADDITIVE UPGRADE (2026-07-07) - QUALITY ENGINE:
//   - CONFIG SENTRY: dashboard audits live inputs vs the 5-month validated profile
//     (XAUUSD trail 1.2 / BTCUSD trail 1.5, risk 0.5%, spread 35, sessions 7-12/13-17)
//     and names any drifted input in orange. Verdict also printed at attach.
//   - SETUP QUALITY GRADE A/B/C: score margin + range quality + key-level confluence
//     + prime session. Shown live on the SETUP line and stamped on every AUTO trade.
//     Optional InpTradeOnlyAB filter (default OFF = live behavior identical to v3.50).
//   - EDGE STATS row: BUY vs SELL win rates, rolling last-20 net & WR, daily loss
//     limit progress with color escalation.
//   - LIVE TRAIL STATE on the position card: RISK ON -> BE ARMED -> TRAIL ACTIVE.
//   - All original logic preserved. Suppressed lines commented with //, never deleted.

#include <Trade/Trade.mqh>

input group "Strategy - Timeframes"
input ENUM_TIMEFRAMES InpBiasTF_D1 = PERIOD_D1;
input ENUM_TIMEFRAMES InpBiasTF_H4 = PERIOD_H4;
input ENUM_TIMEFRAMES InpBiasTF_H1 = PERIOD_H1;
input ENUM_TIMEFRAMES InpAmdTF_H1 = PERIOD_H1;
input ENUM_TIMEFRAMES InpAmdTF_M15 = PERIOD_M15;
// input ENUM_TIMEFRAMES InpCrtExecTF = PERIOD_M5; // v3.10 suppressed - execution moves to M15 per true CRT model
input ENUM_TIMEFRAMES InpCrtRangeTF = PERIOD_H4;   // v3.10 ADDITIVE: HTF candle range for CRT - THE CORE of the strategy
input ENUM_TIMEFRAMES InpCrtExecTF = PERIOD_M15;   // v3.10 ADDITIVE: execution timeframe (M15)

input group "Strategy - Logic"
input int    InpFastEMA = 20;
input int    InpSlowEMA = 50;
input int    InpAMDRangeBars = 12;
input int    InpCRTLookbackBars = 6;
input double InpMinBodyRangeRatio = 0.35;
input int    InpSwingBarsSL = 5;
input int    InpEntryBufferPoints = 40;
input int    InpMinBiasScore = 2;

input group "Risk"
input bool   InpUseFixedLot = false;
input double InpFixedLot = 0.10;
input double InpRiskPercent = 0.50;
input double InpRiskReward = 2.0;
input int    InpMaxSpreadPoints = 35;
input int    InpSlippagePoints = 10;
// input ulong  InpMagicNumber = 26070401; // v3.55 suppressed - shared magic let multiple attached copies manage each other's positions
input ulong  InpMagicNumber = 26070455;   // v3.55 ADDITIVE: distinct magic for the v3.55 line
input double InpMaxDailyLossPercent = 2.00;
input int    InpMaxTradesPerDay = 3;
input int    InpCooldownMinutes = 30;

input group "Execution Filters"
input bool   InpUseSessionFilter = true;
input int    InpLondonStartHour = 7;
input int    InpLondonEndHour = 12;
input int    InpNewYorkStartHour = 13;
input int    InpNewYorkEndHour = 17;

input group "Trade Management"
input bool   InpUseBreakEven = true;
input double InpBreakEvenAtRR = 1.0;
input int    InpBreakEvenOffsetPoints = 20;
// input bool   InpUseTrailingStop = true; // v3.55 suppressed - the trail measured -551 GBP over 13 months of real ticks on XAUUSD
input bool   InpUseTrailingStop = false;  // v3.55 ADDITIVE: default OFF. Measured 2026-09-04: ON -15.28 / OFF +536.27, PF 1.00->1.18, maxDD 9.71%->6.77%
// input double InpTrailStartRR = 1.2; // v3.50 suppressed - trail strangled winners at ~1R (only 3/67 trades ever reached TP)
input double InpTrailStartRR = 1.5;   // v3.50 ADDITIVE: breathing room toward the 2R / CRT range target
input int    InpTrailStepPoints = 120;
input bool   InpUsePartialTP = true;
input double InpPartialAtRR = 1.0;
input double InpPartialClosePercent = 50.0;

input group "v3.52 Exit Repair (sandbox)"
input int    InpTrailMinStepPoints = 0;           // v3.52 ADDITIVE: min SL improvement before a modify is sent. 0 = legacy 1-point tick ratchet
input bool   InpPersistPartialAcrossDays = false; // v3.52 ADDITIVE: keep the partial-done ticket list across the day boundary

input group "v3.51 Quality Engine"                 // v3.51 ADDITIVE
input bool   InpUseQualityGrade  = true;    // v3.51 ADDITIVE: compute & display A/B/C setup grade
input bool   InpTradeOnlyAB      = false;   // v3.51 ADDITIVE: AUTO takes only A/B setups (OFF = behavior identical to validated v3.50)
input bool   InpShowConfigSentry = true;    // v3.51 ADDITIVE: validate live inputs vs tested per-symbol profile

input group "Advanced Confirmations"
input bool   InpUseFVGConfirm = true;
input bool   InpUseLiquiditySweepConfirm = true;
input ENUM_TIMEFRAMES InpConfirmTF = PERIOD_M15;
input int    InpSignalScoreThreshold = 3;
input int    InpNewsRiskExtraScore = 1;
input int    InpNewsOverrideScore = 5;

input group "Soft News Filter"
input bool   InpUseSoftNewsFilter = true;
input double InpNewsRangeSpikeMultiplier = 2.0;
input double InpNewsSpreadSpikeMultiplier = 1.30;
input int    InpNewsLookbackBars = 24;

input group "Portfolio / Auto Presets"
input bool   InpUsePortfolioMode = false;
input string InpPortfolioSymbols = "EURUSD,GBPUSD,USDJPY,XAUUSD";
input int    InpMaxConcurrentPositions = 3;
input bool   InpUseAutoPresets = true;

input group "Dashboard"
input bool   InpShowDashboard = true;
input color  InpDashTextColor = clrWhite;
input color  InpDashBullColor = clrLime;
input color  InpDashBearColor = clrTomato;
input color  InpDashPanelColor = clrBlack;
input color  InpDashHeaderColor = clrDodgerBlue;
input color  InpDashBtnTextColor = clrWhite;
input color  InpDashBtnPrimaryColor = clrDodgerBlue;
input color  InpDashBtnNeutralColor = clrDimGray;
input color  InpDashBtnOnColor = clrDarkGreen;
input color  InpDashBtnOffColor = clrFireBrick;
input color  InpDashBtnWarnColor = clrDarkOrange;
input color  InpDashBtnDangerColor = clrMaroon;
input bool   InpDashUseProfessionalPreset = true;
input bool   InpDashUseBackgroundPanel = true;
input int    InpDashPanelOpacity = 220;
input bool   InpDashDockRight = false;
input int    InpDashX = 12;
input int    InpDashY = 18;
input int    InpDashFontSize = 11;
input int    InpDashWidth = 600;
input int    InpDashHeight = 330;

CTrade trade;
datetime g_lastExecBarTime = 0;
string g_dashName = "CRT_AMD_DASH_MAIN";
string g_dashPanelName = "CRT_AMD_DASH_PANEL";
string g_dashHeaderName = "CRT_AMD_DASH_HEADER";
string g_dashAlgoName = "CRT_AMD_DASH_ALGO";
string g_dashAlgo2Name = "CRT_AMD_DASH_ALGO2";
string g_dashUniverseName = "CRT_AMD_DASH_UNIVERSE";
string g_dashActionName = "CRT_AMD_DASH_ACTION";
string g_dashMeta1Name = "CRT_AMD_DASH_META1";
string g_dashMeta2Name = "CRT_AMD_DASH_META2";
string g_dashMeta3Name = "CRT_AMD_DASH_META3";
string g_dashMeta4Name = "CRT_AMD_DASH_META4";
string g_dashBoxOverview = "CRT_AMD_DASH_BOX_OVERVIEW";
string g_dashBoxSignal = "CRT_AMD_DASH_BOX_SIGNAL";
string g_dashBoxAction = "CRT_AMD_DASH_BOX_ACTION";
string g_btnOpenTrade = "CRT_AMD_BTN_OPEN";
string g_btnHideShow = "CRT_AMD_BTN_HIDE_SHOW";
string g_btnSmall = "CRT_AMD_BTN_SMALL";
string g_btnNormal = "CRT_AMD_BTN_NORMAL";
string g_btnBig = "CRT_AMD_BTN_BIG";
string g_btnFull = "CRT_AMD_BTN_FULL";
string g_btnEA = "CRT_AMD_BTN_EA";
string g_btnCRT = "CRT_AMD_BTN_CRT";
string g_btnFVG = "CRT_AMD_BTN_FVG";
string g_btnBZ = "CRT_AMD_BTN_BZ";
string g_btnMode = "CRT_AMD_BTN_MODE";
string g_btnRisk = "CRT_AMD_BTN_RISK";
string g_btnTrail = "CRT_AMD_BTN_TRAIL";
string g_btnCloseAll = "CRT_AMD_BTN_CLOSE_ALL";
int g_currentDayKey = -1;
double g_dayStartEquity = 0.0;
ulong g_partialDoneTickets[];
string g_scanSymbols[];
datetime g_lastExecBarTimes[];
bool g_dashboardVisible = true;
int g_dashSizeMode = 1; // 0=small,1=normal,2=big,3=fullchart
string g_uiLastAction = "READY";
int g_dashCurrentX = 0;
int g_dashCurrentY = 0;
int g_dashCurrentWidth = 0;
int g_dashCurrentHeight = 0;
bool g_eaRunning = true;
bool g_useCRT = true;
bool g_useFVG = true;
bool g_showBreakZone = true;
bool g_autoMode = true;
bool g_riskEnabled = true;
bool g_useTrailing = true;
string g_breakZoneRect = "CRT_AMD_BREAK_ZONE";
// v3.00 ADDITIVE: runtime strategy controls + status
bool g_useNewsFilter = true;
bool g_useSessionFilter = true;
bool g_useBreakEven = true;
bool g_usePartialTP = true;
int  g_threshold = 3;
string g_autoStatus = "IDLE";
datetime g_lastEntryCacheTime = 0;
datetime g_lastEntryCacheVal = 0;
string g_btnNews     = "CRT_AMD_BTN_NEWS";
string g_btnSession  = "CRT_AMD_BTN_SESSION";
string g_btnBE       = "CRT_AMD_BTN_BE";
string g_btnPTP      = "CRT_AMD_BTN_PTP";
string g_btnThrMinus = "CRT_AMD_BTN_THRMINUS";
string g_btnThrPlus  = "CRT_AMD_BTN_THRPLUS";
string g_proPosBox   = "CRT_PRO_POS_BOX";
string g_proPosTxt   = "CRT_PRO_POS_TXT";
string g_proPosBarBg = "CRT_PRO_POS_BAR_BG";
string g_proPosBarFg = "CRT_PRO_POS_BAR_FG";
// v3.10 ADDITIVE: chart appearance controls
int g_bgThemeIdx = 0;
int g_candleThemeIdx = 0;
string g_btnBgTheme     = "CRT_AMD_BTN_BGTHEME";
string g_btnCandleTheme = "CRT_AMD_BTN_CANDLETHEME";
// v3.20 ADDITIVE: key levels, CRT target, performance memory, decision log
bool g_showKeyLevels = true;
bool g_useCrtTarget  = true;
string g_btnLevels = "CRT_AMD_BTN_LEVELS";
string g_btnCrtTp  = "CRT_AMD_BTN_CRTTP";
// v3.30 ADDITIVE: breakout companion strategy + manual trade buttons
bool g_useBreakout = true;
// v3.41 ADDITIVE: fast-tester mode - skip ALL invisible visual work in non-visual backtests
bool g_fastTester = false;
// v3.50 ADDITIVE: one-trade-per-H4-setup memory - the same sweep must never fire twice
string g_setupSym[16];
datetime g_setupH4[16];
int g_setupDir[16];
int g_setupCount = 0;
// v3.40 ADDITIVE: broker spread memory - the EA learns the NORMAL spread and never blocks it
string g_sprSym[16];
double g_sprEma[16];
int g_sprCount = 0;
string g_btnBreakout = "CRT_AMD_BTN_BREAKOUT";
string g_btnManBuy   = "CRT_AMD_BTN_MANBUY";
string g_btnManSell  = "CRT_AMD_BTN_MANSELL";
int g_statTrades = 0;
double g_statWR = 0.0, g_statNet = 0.0, g_statPF = 0.0;
double g_dayNet[7]; int g_dayTot[7]; int g_dayWin[7];
double g_hrNet[6];  int g_hrTot[6];
int g_bestDay = -1, g_bestHr = -1;
datetime g_statsLastCalc = 0;
string g_logLines[3] = {"", "", ""};
string g_prevUiAction = "";
string g_prevAutoStatus = "";
string g_proPerfBox0 = "CRT_PRO_PERF_BOX0";
string g_proPerfBox1 = "CRT_PRO_PERF_BOX1";
string g_proPerfBox2 = "CRT_PRO_PERF_BOX2";
string g_proPerfBox3 = "CRT_PRO_PERF_BOX3";
string g_proPerfLab0 = "CRT_PRO_PERF_LAB0";
string g_proPerfLab1 = "CRT_PRO_PERF_LAB1";
string g_proPerfLab2 = "CRT_PRO_PERF_LAB2";
string g_proPerfLab3 = "CRT_PRO_PERF_LAB3";
string g_proPerfVal0 = "CRT_PRO_PERF_VAL0";
string g_proPerfVal1 = "CRT_PRO_PERF_VAL1";
string g_proPerfVal2 = "CRT_PRO_PERF_VAL2";
string g_proPerfVal3 = "CRT_PRO_PERF_VAL3";
string g_proLog1 = "CRT_PRO_LOG1";
string g_proLog2 = "CRT_PRO_LOG2";
// ------- v3.51 ADDITIVE: Quality Engine state -------
string g_proCfgBox  = "CRT_PRO_CFG_BOX";    // v3.51 ADDITIVE: config sentry row
string g_proCfgTxt  = "CRT_PRO_CFG_TXT";    // v3.51 ADDITIVE
string g_proEdgeTxt = "CRT_PRO_EDGE_TXT";   // v3.51 ADDITIVE: edge stats row
bool     g_cfgSentryOK   = true;            // v3.51 ADDITIVE
string   g_cfgSentryMsg  = "CHECKING...";   // v3.51 ADDITIVE
datetime g_cfgSentryLast = 0;               // v3.51 ADDITIVE
int      g_lastAutoGrade = 0;               // v3.51 ADDITIVE: 0=none 1=C 2=B 3=A (last AUTO evaluation)
string   g_lastAutoGradeSym = "";           // v3.51 ADDITIVE
int    g_edgeBuyTot = 0, g_edgeBuyWin = 0;  // v3.51 ADDITIVE: per-direction edge stats
int    g_edgeSellTot = 0, g_edgeSellWin = 0;// v3.51 ADDITIVE
double g_edgeL20Net = 0.0;                  // v3.51 ADDITIVE: rolling last-20 closed trades net
double g_edgeL20WR  = 0.0;                  // v3.51 ADDITIVE: rolling last-20 win rate
int    g_edgeL20Cnt = 0;                    // v3.51 ADDITIVE

enum SignalDirection
{
   SIGNAL_NONE = 0,
   SIGNAL_BUY  = 1,
   SIGNAL_SELL = -1
};

struct BiasSnapshot
{
   int d1;
   int h4;
   int h1;
   int net;
};

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber((long)InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippagePoints);
   EventSetTimer(1);
   ChartSetInteger(0, CHART_EVENT_MOUSE_MOVE, true);
   RefreshDayState();
   InitializeSymbolUniverse();
   g_dashboardVisible = InpShowDashboard;
   g_dashSizeMode = 1;
   g_eaRunning = true;
   g_useCRT = true;
   g_useFVG = true;
   g_showBreakZone = true;
   g_autoMode = true;
   g_riskEnabled = true;
   g_useTrailing = InpUseTrailingStop;
   g_useNewsFilter = InpUseSoftNewsFilter;       // v3.00 ADDITIVE
   g_useSessionFilter = InpUseSessionFilter;     // v3.00 ADDITIVE
   g_useBreakEven = InpUseBreakEven;             // v3.00 ADDITIVE
   g_usePartialTP = InpUsePartialTP;             // v3.00 ADDITIVE
   g_threshold = InpSignalScoreThreshold;        // v3.00 ADDITIVE
   g_fastTester = (MQLInfoInteger(MQL_TESTER) && !MQLInfoInteger(MQL_VISUAL_MODE));   // v3.41 ADDITIVE
   if(g_fastTester)
      Print("v3.41 FAST TESTER MODE: dashboard/visual rendering skipped (trading logic 100% unchanged)");
   LoadSettings();                               // v3.20 ADDITIVE: restore panel state across restarts
   if(g_bgThemeIdx > 0) ApplyBgTheme();          // v3.20 ADDITIVE
   if(g_candleThemeIdx > 0) ApplyCandleTheme();  // v3.20 ADDITIVE
   // DashboardEnsure(); // v2.00 suppressed - legacy dashboard replaced by PRO dashboard
   ProDashEnsure();      // v2.00 ADDITIVE
   // v3.51 ADDITIVE: CONFIG SENTRY - audit live inputs vs the 5-month validated profile at attach
   if(InpShowConfigSentry)
   {
      ValidateConfigSentry();
      Print("v3.51 ", g_cfgSentryMsg);
      LogEvent(g_cfgSentryMsg);
   }
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   ProDashDeleteAll();   // v2.00 ADDITIVE
   ObjectDelete(0, g_dashName);
   ObjectDelete(0, g_dashPanelName);
   ObjectDelete(0, g_dashHeaderName);
   ObjectDelete(0, g_dashAlgoName);
   ObjectDelete(0, g_dashAlgo2Name);
   ObjectDelete(0, g_dashUniverseName);
   ObjectDelete(0, g_dashActionName);
   ObjectDelete(0, g_dashMeta1Name);
   ObjectDelete(0, g_dashMeta2Name);
   ObjectDelete(0, g_dashMeta3Name);
   ObjectDelete(0, g_dashMeta4Name);
   ObjectDelete(0, g_dashBoxOverview);
   ObjectDelete(0, g_dashBoxSignal);
   ObjectDelete(0, g_dashBoxAction);
   ObjectDelete(0, g_btnOpenTrade);
   ObjectDelete(0, g_btnHideShow);
   ObjectDelete(0, g_btnSmall);
   ObjectDelete(0, g_btnNormal);
   ObjectDelete(0, g_btnBig);
   ObjectDelete(0, g_btnFull);
   ObjectDelete(0, g_btnEA);
   ObjectDelete(0, g_btnCRT);
   ObjectDelete(0, g_btnFVG);
   ObjectDelete(0, g_btnBZ);
   ObjectDelete(0, g_btnMode);
   ObjectDelete(0, g_btnRisk);
   ObjectDelete(0, g_btnTrail);
   ObjectDelete(0, g_btnCloseAll);
   ObjectDelete(0, g_btnNews);        // v3.00 ADDITIVE
   ObjectDelete(0, g_btnSession);     // v3.00 ADDITIVE
   ObjectDelete(0, g_btnBE);          // v3.00 ADDITIVE
   ObjectDelete(0, g_btnPTP);         // v3.00 ADDITIVE
   ObjectDelete(0, g_btnThrMinus);    // v3.00 ADDITIVE
   ObjectDelete(0, g_btnThrPlus);     // v3.00 ADDITIVE
   ObjectDelete(0, g_btnBgTheme);     // v3.10 ADDITIVE
   ObjectDelete(0, g_btnCandleTheme); // v3.10 ADDITIVE
   ObjectDelete(0, g_btnLevels);      // v3.20 ADDITIVE
   ObjectDelete(0, g_btnCrtTp);       // v3.20 ADDITIVE
   ObjectDelete(0, "CRT_PRO_LVL_PDH"); // v3.20 ADDITIVE
   ObjectDelete(0, "CRT_PRO_LVL_PDL"); // v3.20 ADDITIVE
   ObjectDelete(0, "CRT_PRO_LVL_PWH"); // v3.20 ADDITIVE
   ObjectDelete(0, "CRT_PRO_LVL_PWL"); // v3.20 ADDITIVE
   ObjectDelete(0, g_btnBreakout);    // v3.30 ADDITIVE
   ObjectDelete(0, g_btnManBuy);      // v3.30 ADDITIVE
   ObjectDelete(0, g_btnManSell);     // v3.30 ADDITIVE
   SaveSettings();                    // v3.20 ADDITIVE
   ObjectDelete(0, g_proPosBox);      // v3.00 ADDITIVE
   ObjectDelete(0, g_proPosTxt);      // v3.00 ADDITIVE
   ObjectDelete(0, g_proPosBarBg);    // v3.00 ADDITIVE
   ObjectDelete(0, g_proPosBarFg);    // v3.00 ADDITIVE
   ObjectDelete(0, g_breakZoneRect);
}

//+------------------------------------------------------------------+
void OnTick()
{
   RefreshDayState();
   ManageOpenPositions();
   UpdateBreakZoneVisual();
   UpdateKeyLevelsVisual();   // v3.20 ADDITIVE
   // DashboardUpdate(); // v2.00 suppressed
   ProDashUpdate();      // v2.00 ADDITIVE
   // HandleUIButtonStates(); // v2.10 suppressed - clicks handled ONLY by OnChartEvent (polling caused double-fire = "stuck" toggles)
   EvaluateUniverse(false);
}

//+------------------------------------------------------------------+
void OnTimer()
{
   RefreshDayState();
   ManageOpenPositions();
   UpdateBreakZoneVisual();
   UpdateKeyLevelsVisual();   // v3.20 ADDITIVE
   EvaluateUniverse(true);
   // DashboardUpdate(); // v2.00 suppressed
   ProDashUpdate();      // v2.00 ADDITIVE
    // HandleUIButtonStates(); // v2.10 suppressed - clicks handled ONLY by OnChartEvent
}

//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
color GetDashboardPanelColor()
{
   if(!InpDashUseBackgroundPanel)
      return clrNONE;

   int a = InpDashPanelOpacity;
   if(a < 0) a = 0;
   if(a > 255) a = 255;
   if(a == 0)
      return clrNONE;
   return (color)ColorToARGB(InpDashPanelColor, (uchar)a);
}

//+------------------------------------------------------------------+
void ResolveDashboardTheme(color &txt, color &header, color &bull, color &bear,
                           color &btnText, color &btnPrimary, color &btnNeutral,
                           color &btnOn, color &btnOff, color &btnWarn, color &btnDanger,
                           color &panelBg, color &panelBorder, color &sectionBg, color &sectionBorder)
{
   txt = clrWhite;
   header = clrDeepSkyBlue;
   bull = clrLime;
   bear = clrTomato;
   btnText = clrWhite;
   btnPrimary = (color)C'0,102,204';
   btnNeutral = (color)C'45,58,82';
   btnOn = (color)C'0,140,90';
   btnOff = (color)C'160,40,60';
   btnWarn = (color)C'180,120,20';
   btnDanger = (color)C'150,40,40';
   panelBg = (color)ColorToARGB((color)C'14,23,43', 235);
   panelBorder = (color)C'30,78,140';
   sectionBg = (color)ColorToARGB((color)C'20,34,60', 190);
   sectionBorder = (color)C'35,110,180';
}

//+------------------------------------------------------------------+
void ExecuteManualOpenTrade()
{
   if(!g_eaRunning)
   {
      g_uiLastAction = "MANUAL BLOCKED: EA OFF";
      return;
   }

   g_uiLastAction = "CLICK OPEN TRADE";
   int scoreBuy = 0;
   int scoreSell = 0;
   int threshold = 0;
   bool newsRisk = false;
   int signal = ComputeCompositeSignal(_Symbol, scoreBuy, scoreSell, threshold, newsRisk);
   if(signal == SIGNAL_NONE)
   {
      g_uiLastAction = "OPEN TRADE BLOCKED: NO SIGNAL";
      Print("Manual Open Trade blocked: no valid algorithm signal on ", _Symbol);
      return;
   }

   if(!SpreadOK(_Symbol))
   {
      g_uiLastAction = "OPEN TRADE BLOCKED: SPREAD";
      Print("Manual Open Trade blocked: spread too high on ", _Symbol);
      return;
   }

   if(HasOpenPositionForThisEA(_Symbol))
   {
      g_uiLastAction = "OPEN TRADE BLOCKED: POSITION EXISTS";
      Print("Manual Open Trade blocked: existing EA position on ", _Symbol);
      return;
   }

   if(GetOpenPositionCountForEA() >= InpMaxConcurrentPositions)
   {
      g_uiLastAction = "OPEN TRADE BLOCKED: MAX POSITIONS";
      Print("Manual Open Trade blocked: max concurrent positions reached");
      return;
   }

   if(!PlaceTrade(_Symbol, signal, GetEffectiveRiskReward(_Symbol)))
   {
      g_uiLastAction = "OPEN TRADE FAILED";
      Print("Manual Open Trade failed for ", _Symbol);
   }
   else
   {
      g_uiLastAction = "OPEN TRADE SUCCESS " + SignalText(signal);
      Print("Manual Open Trade executed for ", _Symbol, " direction=", SignalText(signal));
   }
}

//+------------------------------------------------------------------+
void SetDashboardSizeMode(const int mode)
{
   g_dashSizeMode = mode;
   if(g_dashSizeMode == 0) g_uiLastAction = "SIZE SMALL";
   else if(g_dashSizeMode == 1) g_uiLastAction = "SIZE NORMAL";
   else if(g_dashSizeMode == 2) g_uiLastAction = "SIZE BIG";
   else g_uiLastAction = "SIZE FULL";
}

//+------------------------------------------------------------------+
void ProcessUIButtonAction(const string name)
{
   if(name == "")
      return;

   // v2.10 ADDITIVE: debounce - ignore duplicate events on the same button within 250ms
   static ulong  s_lastBtnTick = 0;
   static string s_lastBtnName = "";
   ulong nowTick = GetTickCount64();
   if(name == s_lastBtnName && (nowTick - s_lastBtnTick) < 250)
   {
      if(ObjectFind(0, name) >= 0)
         ObjectSetInteger(0, name, OBJPROP_STATE, false);
      return;
   }
   s_lastBtnName = name;
   s_lastBtnTick = nowTick;

   if(ObjectFind(0, name) >= 0)
      ObjectSetInteger(0, name, OBJPROP_STATE, false);

   if(name == g_btnOpenTrade)
   {
      ExecuteManualOpenTrade();
      return;
   }

   if(name == g_btnHideShow)
   {
      g_dashboardVisible = !g_dashboardVisible;
      g_uiLastAction = (g_dashboardVisible ? "SHOW DASHBOARD" : "HIDE DASHBOARD");
      ChartRedraw(0);
      return;
   }

   if(name == g_btnSmall) { SetDashboardSizeMode(0); return; }
   if(name == g_btnNormal) { SetDashboardSizeMode(1); return; }
   if(name == g_btnBig) { SetDashboardSizeMode(2); return; }
   if(name == g_btnFull) { SetDashboardSizeMode(3); return; }
   if(name == g_btnEA) { g_eaRunning = !g_eaRunning; g_uiLastAction = (g_eaRunning ? "EA START" : "EA STOP"); return; }
   if(name == g_btnCRT) { g_useCRT = !g_useCRT; g_uiLastAction = (g_useCRT ? "CRT ON" : "CRT OFF"); return; }
   if(name == g_btnFVG) { g_useFVG = !g_useFVG; g_uiLastAction = (g_useFVG ? "FVG ON" : "FVG OFF"); return; }
   if(name == g_btnBZ) { g_showBreakZone = !g_showBreakZone; g_uiLastAction = (g_showBreakZone ? "BREAK ZONE ON" : "BREAK ZONE OFF"); return; }
   if(name == g_btnMode) { g_autoMode = !g_autoMode; g_uiLastAction = (g_autoMode ? "MODE AUTO" : "MODE MANUAL"); return; }
   if(name == g_btnRisk) { g_riskEnabled = !g_riskEnabled; g_uiLastAction = (g_riskEnabled ? "RISK ON" : "RISK OFF"); return; }
   if(name == g_btnTrail) { g_useTrailing = !g_useTrailing; g_uiLastAction = (g_useTrailing ? "TRAIL ON" : "TRAIL OFF"); return; }
   // v3.00 ADDITIVE: filter & threshold runtime controls
   if(name == g_btnNews) { g_useNewsFilter = !g_useNewsFilter; g_uiLastAction = (g_useNewsFilter ? "NEWS FILTER ON" : "NEWS FILTER OFF"); return; }
   if(name == g_btnSession) { g_useSessionFilter = !g_useSessionFilter; g_uiLastAction = (g_useSessionFilter ? "SESSION FILTER ON" : "SESSION FILTER OFF"); return; }
   if(name == g_btnBE) { g_useBreakEven = !g_useBreakEven; g_uiLastAction = (g_useBreakEven ? "BREAK-EVEN ON" : "BREAK-EVEN OFF"); return; }
   if(name == g_btnPTP) { g_usePartialTP = !g_usePartialTP; g_uiLastAction = (g_usePartialTP ? "PARTIAL TP ON" : "PARTIAL TP OFF"); return; }
   if(name == g_btnThrMinus) { g_threshold = (int)MathMax(1, g_threshold - 1); g_uiLastAction = "THRESHOLD " + IntegerToString(g_threshold); return; }
   if(name == g_btnThrPlus) { g_threshold = (int)MathMin(6, g_threshold + 1); g_uiLastAction = "THRESHOLD " + IntegerToString(g_threshold); return; }
   // v3.10 ADDITIVE: chart appearance controls
   if(name == g_btnBgTheme) { g_bgThemeIdx = (g_bgThemeIdx + 1) % 4; ApplyBgTheme(); g_uiLastAction = "BACKGROUND: " + BgThemeName(g_bgThemeIdx); return; }
   if(name == g_btnCandleTheme) { g_candleThemeIdx = (g_candleThemeIdx + 1) % 4; ApplyCandleTheme(); g_uiLastAction = "CANDLES: " + CandleThemeName(g_candleThemeIdx); return; }
   // v3.20 ADDITIVE: key levels + CRT range-target controls
   if(name == g_btnLevels) { g_showKeyLevels = !g_showKeyLevels; g_uiLastAction = (g_showKeyLevels ? "KEY LEVELS ON" : "KEY LEVELS OFF"); return; }
   if(name == g_btnCrtTp) { g_useCrtTarget = !g_useCrtTarget; g_uiLastAction = (g_useCrtTarget ? "CRT RANGE TARGET ON" : "FIXED RR TARGET"); return; }
   // v3.30 ADDITIVE: breakout toggle + manual direct trades
   if(name == g_btnBreakout) { g_useBreakout = !g_useBreakout; g_uiLastAction = (g_useBreakout ? "BREAKOUT ON" : "BREAKOUT OFF"); return; }
   if(name == g_btnManBuy) { ManualDirectTrade(SIGNAL_BUY); return; }
   if(name == g_btnManSell) { ManualDirectTrade(SIGNAL_SELL); return; }
   if(name == g_btnCloseAll) { CloseAllEAPositions(); return; }
}

//+------------------------------------------------------------------+
void HandleUIButtonStates()
{
   string names[14];
   names[0] = g_btnOpenTrade;
   names[1] = g_btnHideShow;
   names[2] = g_btnSmall;
   names[3] = g_btnNormal;
   names[4] = g_btnBig;
   names[5] = g_btnFull;
   names[6] = g_btnEA;
   names[7] = g_btnCRT;
   names[8] = g_btnFVG;
   names[9] = g_btnBZ;
    names[10] = g_btnMode;
    names[11] = g_btnRisk;
    names[12] = g_btnTrail;
    names[13] = g_btnCloseAll;

   for(int i = 0; i < 14; ++i)
   {
      string n = names[i];
      if(ObjectFind(0, n) < 0)
         continue;
      bool pressed = (bool)ObjectGetInteger(0, n, OBJPROP_STATE);
      if(pressed)
      {
         ProcessUIButtonAction(n);
         // DashboardUpdate(); // v2.00 suppressed
         ProDashUpdate();      // v2.00 ADDITIVE
      }
   }
}

//+------------------------------------------------------------------+
void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
   if(id != CHARTEVENT_OBJECT_CLICK)
      return;
   ProcessUIButtonAction(sparam);
   // DashboardUpdate(); // v2.00 suppressed
   ProDashUpdate();      // v2.00 ADDITIVE
   SaveSettings();       // v3.20 ADDITIVE: every control change survives restarts
   ChartRedraw(0);       // v2.10 ADDITIVE: instant visual feedback, no stuck-pressed buttons
}

//+------------------------------------------------------------------+
void EvaluateAndTrade()
{
   EvaluateAndTradeForSymbol(_Symbol);
}

//+------------------------------------------------------------------+
void EvaluateUniverse(const bool fromTimer)
{
   // if(!g_eaRunning || !g_autoMode) return; // v3.00 suppressed - now reports why idle
   if(!g_eaRunning) { g_autoStatus = "EA STOPPED"; return; }         // v3.00 ADDITIVE
   if(!g_autoMode)  { g_autoStatus = "MANUAL MODE"; return; }        // v3.00 ADDITIVE

   int totalSymbols = ArraySize(g_scanSymbols);
   if(totalSymbols <= 0)
      return;

   for(int i = 0; i < totalSymbols; ++i)
   {
      string sym = g_scanSymbols[i];
      datetime t = iTime(sym, InpCrtExecTF, 0);
      if(t <= 0)
         continue;

      if(fromTimer)
      {
         if(g_lastExecBarTimes[i] == t)
            continue;
         g_lastExecBarTimes[i] = t;
         EvaluateAndTradeForSymbol(sym);
      }
      else
      {
         if(sym != _Symbol)
            continue;
         if(g_lastExecBarTimes[i] == t)
            continue;
         g_lastExecBarTimes[i] = t;
         EvaluateAndTradeForSymbol(sym);
      }
   }
}

//+------------------------------------------------------------------+
void CloseAllEAPositions()
{
   int closed = 0;
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; --i)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;

      long mg = PositionGetInteger(POSITION_MAGIC);
      string sym = PositionGetString(POSITION_SYMBOL);
      if((ulong)mg != InpMagicNumber)
         continue;

      // if(trade.PositionClose(sym)) // v3.53 suppressed - symbol overload closes the FIRST position on the symbol, any magic
      if(trade.PositionClose(ticket))                                              // v3.53 ADDITIVE
         closed++;
   }

   g_uiLastAction = "CLOSE ALL DONE: " + IntegerToString(closed);
}

//+------------------------------------------------------------------+
void EvaluateAndTradeForSymbol(const string sym)
{
   if(g_riskEnabled)
   {
      if(!SpreadOK(sym))
      {
         g_autoStatus = "BLOCKED: SPREAD " + sym;      // v3.00 ADDITIVE
         return;
      }
   }

   if(!SessionAllowedNow())
   {
      g_autoStatus = "WAITING: SESSION CLOSED";        // v3.00 ADDITIVE
      return;
   }

   if(g_riskEnabled)
   {
      if(IsDailyLossLimitHit())
      {
         g_autoStatus = "BLOCKED: DAILY LOSS LIMIT";   // v3.00 ADDITIVE
         return;
      }

      if(GetTodayEntryCount() >= InpMaxTradesPerDay)
      {
         g_autoStatus = "BLOCKED: MAX TRADES/DAY";     // v3.00 ADDITIVE
         return;
      }

      if(!CooldownPassed())
      {
         g_autoStatus = "WAITING: COOLDOWN";           // v3.00 ADDITIVE
         return;
      }
   }

   if(GetOpenPositionCountForEA() >= InpMaxConcurrentPositions)
   {
      g_autoStatus = "BLOCKED: MAX POSITIONS";         // v3.00 ADDITIVE
      return;
   }

   if(HasOpenPositionForThisEA(sym))
   {
      g_autoStatus = "IN POSITION: " + sym;            // v3.00 ADDITIVE
      return;
   }

   BiasSnapshot bias = GetBiasSnapshot(sym);
   int effectiveMinBias = GetEffectiveMinBias(sym);
   int amdH1 = DetectAMD(sym, InpAmdTF_H1);
   int amdM15 = DetectAMD(sym, InpAmdTF_M15);
   // int crtExec = (g_useCRT ? DetectCRT(sym, InpCrtExecTF, InpCRTLookbackBars) : SIGNAL_NONE); // v3.10 suppressed - old M5-lookback CRT
   int crtExec = (g_useCRT ? DetectCRT_HTF(sym) : SIGNAL_NONE);   // v3.10 ADDITIVE: H4 candle-range CRT + M15 confirmation
   int brkExec = (g_useBreakout ? DetectBreakout_HTF(sym) : SIGNAL_NONE);   // v3.30 ADDITIVE: acceptance/continuation companion
   int fvg = ((InpUseFVGConfirm && g_useFVG) ? DetectFVG(sym, InpConfirmTF) : SIGNAL_NONE);
   int sweep = (InpUseLiquiditySweepConfirm ? DetectLiquiditySweep(sym, InpConfirmTF) : SIGNAL_NONE);
   // v3.30 suppressed - key confluence now also rewards breakouts through key levels
   // int keyBuy = ((g_useCRT && crtExec == SIGNAL_BUY) ? KeyLevelConfluence(sym, SIGNAL_BUY) : 0);
   // int keySell = ((g_useCRT && crtExec == SIGNAL_SELL) ? KeyLevelConfluence(sym, SIGNAL_SELL) : 0);
   int keyBuy = (((g_useCRT && crtExec == SIGNAL_BUY) || brkExec == SIGNAL_BUY) ? KeyLevelConfluence(sym, SIGNAL_BUY) : 0);      // v3.30 ADDITIVE
   int keySell = (((g_useCRT && crtExec == SIGNAL_SELL) || brkExec == SIGNAL_SELL) ? KeyLevelConfluence(sym, SIGNAL_SELL) : 0);   // v3.30 ADDITIVE

   bool buyBias = (bias.net >= effectiveMinBias);
   bool sellBias = (bias.net <= -effectiveMinBias);
   bool amdBuy = (amdH1 == SIGNAL_BUY || amdM15 == SIGNAL_BUY);
   bool amdSell = (amdH1 == SIGNAL_SELL || amdM15 == SIGNAL_SELL);
   // bool crtBuy = (!g_useCRT || crtExec == SIGNAL_BUY); // v3.30 suppressed
   bool crtBuy = (!g_useCRT || crtExec == SIGNAL_BUY || brkExec == SIGNAL_BUY);   // v3.30 ADDITIVE: rejection OR acceptance
   // bool crtSell = (!g_useCRT || crtExec == SIGNAL_SELL); // v3.30 suppressed
   bool crtSell = (!g_useCRT || crtExec == SIGNAL_SELL || brkExec == SIGNAL_SELL);   // v3.30 ADDITIVE

   // int scoreBuy = (buyBias ? 2 : 0) + (amdBuy ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_BUY) ? 1 : 0) + (fvg == SIGNAL_BUY ? 1 : 0) + (sweep == SIGNAL_BUY ? 1 : 0); // v3.10 suppressed
   int scoreBuy = (buyBias ? 2 : 0) + (amdBuy ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_BUY) ? 2 : 0) + (brkExec == SIGNAL_BUY ? 2 : 0) + (fvg == SIGNAL_BUY ? 1 : 0) + (sweep == SIGNAL_BUY ? 1 : 0) + keyBuy;   // v3.30 ADDITIVE: breakout = 2pts
   // int scoreSell = (sellBias ? 2 : 0) + (amdSell ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_SELL) ? 1 : 0) + (fvg == SIGNAL_SELL ? 1 : 0) + (sweep == SIGNAL_SELL ? 1 : 0); // v3.10 suppressed
   int scoreSell = (sellBias ? 2 : 0) + (amdSell ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_SELL) ? 2 : 0) + (brkExec == SIGNAL_SELL ? 2 : 0) + (fvg == SIGNAL_SELL ? 1 : 0) + (sweep == SIGNAL_SELL ? 1 : 0) + keySell;   // v3.30 ADDITIVE

   // int threshold = InpSignalScoreThreshold; // v3.00 suppressed - runtime adjustable
   int threshold = g_threshold;                  // v3.00 ADDITIVE
   bool newsRisk = IsNewsRiskNow(sym);
   if(newsRisk)
      threshold += InpNewsRiskExtraScore;

   int signal = SIGNAL_NONE;
   if(crtBuy && scoreBuy >= threshold && scoreBuy > scoreSell)
      signal = SIGNAL_BUY;
   else if(crtSell && scoreSell >= threshold && scoreSell > scoreBuy)
      signal = SIGNAL_SELL;
   else if(newsRisk)
   {
      // Strong confluence can still pass during risk windows.
      if(crtBuy && scoreBuy >= InpNewsOverrideScore && scoreBuy > scoreSell)
         signal = SIGNAL_BUY;
      else if(crtSell && scoreSell >= InpNewsOverrideScore && scoreSell > scoreBuy)
         signal = SIGNAL_SELL;
   }

   if(signal == SIGNAL_NONE)
   {
      g_autoStatus = "SCANNING " + sym + " (B" + IntegerToString(scoreBuy) + "/S" + IntegerToString(scoreSell) + "/T" + IntegerToString(threshold) + ")";   // v3.00 ADDITIVE
      return;
   }

   // v3.51 ADDITIVE: SETUP QUALITY GRADE - every AUTO setup is scored A/B/C before firing.
   // Default InpTradeOnlyAB=false keeps live behavior identical to the validated v3.50.
   int setupGrade = ComputeSetupGrade(sym, signal, (signal == SIGNAL_BUY ? scoreBuy : scoreSell), threshold);
   g_lastAutoGrade = setupGrade;
   g_lastAutoGradeSym = sym;
   if(InpUseQualityGrade && InpTradeOnlyAB && setupGrade == 1)
   {
      g_autoStatus = "BLOCKED: GRADE C " + sym + " " + SignalText(signal);
      return;   // decision-log matcher already captures BLOCKED statuses
   }

   // v3.50 ADDITIVE: one trade per H4 setup - the report showed 3 entries on the SAME sweep
   // (Feb 4, Feb 26, Mar 25 clusters). One idea = one trade.
   if(SetupAlreadyTraded(sym, signal))
   {
      g_autoStatus = "BLOCKED: SETUP TRADED " + sym + " " + SignalText(signal);
      return;
   }

   // PlaceTrade(sym, signal, GetEffectiveRiskReward(sym)); // v3.00 suppressed - now reports result
   if(PlaceTrade(sym, signal, GetEffectiveRiskReward(sym)))
   {
      // g_autoStatus = "TRADE OPENED: " + sym + " " + SignalText(signal);   // v3.51 suppressed - now carries the setup grade
      g_autoStatus = "TRADE OPENED: " + sym + " " + SignalText(signal) + " [GRADE " + GradeText(setupGrade) + "]";   // v3.51 ADDITIVE
      MarkSetupTraded(sym, signal);   // v3.50 ADDITIVE: this H4 candle + direction is now consumed
   }
   else
      g_autoStatus = "ORDER FAILED: " + sym;                              // v3.00 ADDITIVE
}

//+------------------------------------------------------------------+
bool PlaceTrade(const string sym, const int direction, const double riskReward)
{
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(bid <= 0 || ask <= 0)
      return false;

   double sl = 0.0;
   double tp = 0.0;
   double entry = (direction == SIGNAL_BUY ? ask : bid);

   if(direction == SIGNAL_BUY)
   {
      // sl = FindRecentLow(sym, InpCrtExecTF, InpSwingBarsSL) - (InpEntryBufferPoints * SymbolInfoDouble(sym, SYMBOL_POINT)); // v3.00 suppressed
      sl = FindRecentLow(sym, InpCrtExecTF, InpSwingBarsSL) - (EffectiveBufferPoints(sym) * SymbolInfoDouble(sym, SYMBOL_POINT));   // v3.00 ADDITIVE: symbol-adaptive
      if(sl <= 0 || sl >= entry)
         return false;
      tp = entry + ((entry - sl) * riskReward);
   }
   else
   {
      // sl = FindRecentHigh(sym, InpCrtExecTF, InpSwingBarsSL) + (InpEntryBufferPoints * SymbolInfoDouble(sym, SYMBOL_POINT)); // v3.00 suppressed
      sl = FindRecentHigh(sym, InpCrtExecTF, InpSwingBarsSL) + (EffectiveBufferPoints(sym) * SymbolInfoDouble(sym, SYMBOL_POINT));   // v3.00 ADDITIVE: symbol-adaptive
      if(sl <= entry)
         return false;
      tp = entry - ((sl - entry) * riskReward);
   }

   // v3.20 ADDITIVE: CRT RANGE TARGET - the textbook CRT play targets the OPPOSITE side of the H4 range
   if(g_useCrtTarget)
   {
      double crtHi = iHigh(sym, InpCrtRangeTF, 1);
      double crtLo = iLow(sym, InpCrtRangeTF, 1);
      double riskDist = MathAbs(entry - sl);
      if(direction == SIGNAL_BUY && crtHi > entry && (crtHi - entry) >= riskDist)
         tp = crtHi;
      else if(direction == SIGNAL_SELL && crtLo > 0.0 && crtLo < entry && (entry - crtLo) >= riskDist)
         tp = crtLo;
      // if the range target is closer than 1R, the fixed-RR tp computed above stays
   }

   if(!StopsAreValid(sym, entry, sl, tp))
      return false;

   double volume = CalculateVolume(sym, entry, sl);
   if(volume <= 0.0)
      return false;

   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(point <= 0.0)
      return false;
   int riskPts = (int)MathRound(MathAbs(entry - sl) / point);
   if(riskPts <= 0)
      return false;

   string orderComment = (direction == SIGNAL_BUY ? "CRTB:R" : "CRTS:R") + IntegerToString(riskPts);
   bool ok = false;
   if(direction == SIGNAL_BUY)
      ok = trade.Buy(volume, sym, 0.0, sl, tp, orderComment);
   else
      ok = trade.Sell(volume, sym, 0.0, sl, tp, orderComment);

   if(ok)
      g_lastEntryCacheTime = 0;   // v3.00 ADDITIVE: refresh cooldown cache after a new entry

   return ok;
}

//+------------------------------------------------------------------+
bool SpreadOK(const string sym)
{
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(bid <= 0 || ask <= 0)
      return false;

   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(point <= 0.0)
      return false;
   double spreadPts = (ask - bid) / point;
   UpdateSpreadEma(sym, spreadPts);   // v3.40 ADDITIVE: learn the broker's normal spread
   // return (spreadPts <= InpMaxSpreadPoints); // v3.00 suppressed - fixed FX-calibrated cap blocked crypto/metals permanently
   return (spreadPts <= EffectiveMaxSpreadPoints(sym));   // v3.00 ADDITIVE: symbol-adaptive
}

//+------------------------------------------------------------------+
bool HasOpenPositionForThisEA(const string symFilter)
{
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; --i)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;

      string sym = PositionGetString(POSITION_SYMBOL);
      long mg = PositionGetInteger(POSITION_MAGIC);
      if(sym == symFilter && (ulong)mg == InpMagicNumber)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
int GetTrendBias(const string sym, const ENUM_TIMEFRAMES tf)
{
   double close1 = iClose(sym, tf, 1);
   double emaFast = GetEMAValue(sym, tf, InpFastEMA, 1);
   double emaSlow = GetEMAValue(sym, tf, InpSlowEMA, 1);

   if(close1 == 0 || emaFast == 0 || emaSlow == 0)
      return 0;

   if(close1 > emaFast && emaFast > emaSlow)
      return 1;
   if(close1 < emaFast && emaFast < emaSlow)
      return -1;
   return 0;
}

//+------------------------------------------------------------------+
double GetEMAValue(const string sym, const ENUM_TIMEFRAMES tf, const int period, const int shift)
{
   int handle = iMA(sym, tf, period, 0, MODE_EMA, PRICE_CLOSE);
   if(handle == INVALID_HANDLE)
      return 0.0;

   double buffer[];
   ArraySetAsSeries(buffer, true);
   int copied = CopyBuffer(handle, 0, shift, 1, buffer);
   IndicatorRelease(handle);
   if(copied < 1)
      return 0.0;

   return buffer[0];
}

//+------------------------------------------------------------------+
BiasSnapshot GetBiasSnapshot(const string sym)
{
   BiasSnapshot b;
   b.d1 = GetTrendBias(sym, InpBiasTF_D1);
   b.h4 = GetTrendBias(sym, InpBiasTF_H4);
   b.h1 = GetTrendBias(sym, InpBiasTF_H1);
   b.net = b.d1 + b.h4 + b.h1;
   return b;
}

//+------------------------------------------------------------------+
int DetectAMD(const string sym, const ENUM_TIMEFRAMES tf)
{
   int minBars = InpAMDRangeBars + 5;
   if(Bars(sym, tf) < minBars)
      return SIGNAL_NONE;

   double rangeHigh = -DBL_MAX;
   double rangeLow = DBL_MAX;

   for(int s = InpAMDRangeBars + 2; s >= 3; --s)
   {
      double h = iHigh(sym, tf, s);
      double l = iLow(sym, tf, s);
      if(h > rangeHigh) rangeHigh = h;
      if(l < rangeLow) rangeLow = l;
   }

   double manipHigh = iHigh(sym, tf, 2);
   double manipLow = iLow(sym, tf, 2);
   double distClose = iClose(sym, tf, 1);
   double distOpen = iOpen(sym, tf, 1);

   // v3.00 suppressed - original demanded closing beyond the ENTIRE opposite range extreme in one candle (fires almost never; AMD score was dead weight)
   // bool bearishAMD = (manipHigh > rangeHigh && distClose < rangeLow && distClose < distOpen);
   // bool bullishAMD = (manipLow < rangeLow && distClose > rangeHigh && distClose > distOpen);
   double rangeMid = (rangeHigh + rangeLow) / 2.0;   // v3.00 ADDITIVE: true AMD = sweep one side + decisive close beyond midpoint
   bool bearishAMD = (manipHigh > rangeHigh && distClose < rangeMid && distClose < distOpen);
   bool bullishAMD = (manipLow < rangeLow && distClose > rangeMid && distClose > distOpen);

   if(bearishAMD) return SIGNAL_SELL;
   if(bullishAMD) return SIGNAL_BUY;
   return SIGNAL_NONE;
}

//+------------------------------------------------------------------+
int DetectCRT(const string sym, const ENUM_TIMEFRAMES tf, const int lookbackBars)
{
   int minBars = lookbackBars + 4;
   if(Bars(sym, tf) < minBars)
      return SIGNAL_NONE;

   double rangeHigh = -DBL_MAX;
   double rangeLow = DBL_MAX;
   for(int s = lookbackBars + 1; s >= 2; --s)
   {
      double h = iHigh(sym, tf, s);
      double l = iLow(sym, tf, s);
      if(h > rangeHigh) rangeHigh = h;
      if(l < rangeLow) rangeLow = l;
   }

   double o1 = iOpen(sym, tf, 1);
   double c1 = iClose(sym, tf, 1);
   double h1 = iHigh(sym, tf, 1);
   double l1 = iLow(sym, tf, 1);
   double body = MathAbs(c1 - o1);
   double range = (h1 - l1);
   if(range <= 0.0)
      return SIGNAL_NONE;

   double bodyRatio = body / range;
   bool strongBody = (bodyRatio >= InpMinBodyRangeRatio);

   bool bearishCRT = (h1 > rangeHigh && c1 < rangeHigh && c1 < o1 && strongBody);
   bool bullishCRT = (l1 < rangeLow && c1 > rangeLow && c1 > o1 && strongBody);

   if(bearishCRT) return SIGNAL_SELL;
   if(bullishCRT) return SIGNAL_BUY;
   return SIGNAL_NONE;
}

//+------------------------------------------------------------------+
//| v3.10 ADDITIVE: TRUE Candle Range Theory                          |
//| Range = previous H4 candle high/low. Signal = current H4 candle   |
//| sweeps that high/low AND the last closed M15 candle rejects back  |
//| inside the range in the opposite direction with a strong body.    |
//+------------------------------------------------------------------+
int DetectCRT_HTF(const string sym)
{
   if(Bars(sym, InpCrtRangeTF) < 3 || Bars(sym, InpCrtExecTF) < 3)
      return SIGNAL_NONE;

   double rangeHigh = iHigh(sym, InpCrtRangeTF, 1);
   double rangeLow  = iLow(sym, InpCrtRangeTF, 1);
   if(rangeHigh <= rangeLow)
      return SIGNAL_NONE;
   if(!CrtRangeQualityOK(sym))   // v3.50 ADDITIVE: no noise ranges (R545...), no outlier monsters (R11945...)
      return SIGNAL_NONE;

   double curH = iHigh(sym, InpCrtRangeTF, 0);
   double curL = iLow(sym, InpCrtRangeTF, 0);

   double c1 = iClose(sym, InpCrtExecTF, 1);
   double o1 = iOpen(sym, InpCrtExecTF, 1);
   double h1 = iHigh(sym, InpCrtExecTF, 1);
   double l1 = iLow(sym, InpCrtExecTF, 1);
   double body = MathAbs(c1 - o1);
   double rng = (h1 - l1);
   bool strongBody = (rng > 0.0 && (body / rng) >= InpMinBodyRangeRatio);

   bool bullishCRT = (curL < rangeLow  && c1 > rangeLow  && c1 > o1 && strongBody);
   bool bearishCRT = (curH > rangeHigh && c1 < rangeHigh && c1 < o1 && strongBody);

   if(bullishCRT) return SIGNAL_BUY;
   if(bearishCRT) return SIGNAL_SELL;
   return SIGNAL_NONE;
}

//+------------------------------------------------------------------+
string BgThemeName(const int i)   // v3.10 ADDITIVE
{
   if(i == 1) return "PITCH BLACK";
   if(i == 2) return "CHARCOAL";
   if(i == 3) return "LIGHT";
   return "DARK NAVY";
}

//+------------------------------------------------------------------+
void ApplyBgTheme()   // v3.10 ADDITIVE: chart background control
{
   color bg = (color)C'10,15,26';
   color fg = clrWhite;
   color grid = (color)C'26,34,52';
   if(g_bgThemeIdx == 1) { bg = clrBlack; fg = clrWhite; grid = (color)C'22,22,22'; }
   else if(g_bgThemeIdx == 2) { bg = (color)C'24,26,30'; fg = clrGainsboro; grid = (color)C'42,46,52'; }
   else if(g_bgThemeIdx == 3) { bg = clrWhite; fg = clrBlack; grid = (color)C'228,230,234'; }
   ChartSetInteger(0, CHART_COLOR_BACKGROUND, bg);
   ChartSetInteger(0, CHART_COLOR_FOREGROUND, fg);
   ChartSetInteger(0, CHART_COLOR_GRID, grid);
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
string CandleThemeName(const int i)   // v3.10 ADDITIVE
{
   if(i == 1) return "NEON";
   if(i == 2) return "GOLD";
   if(i == 3) return "OCEAN";
   return "CLASSIC";
}

//+------------------------------------------------------------------+
void ApplyCandleTheme()   // v3.10 ADDITIVE: candle color control
{
   color bull = clrLime, bear = clrTomato, lineC = clrSilver;
   if(g_candleThemeIdx == 1) { bull = clrAqua; bear = clrMagenta; lineC = clrAqua; }
   else if(g_candleThemeIdx == 2) { bull = clrGold; bear = (color)C'96,96,108'; lineC = clrGold; }
   else if(g_candleThemeIdx == 3) { bull = clrDodgerBlue; bear = clrOrangeRed; lineC = clrDodgerBlue; }
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, bull);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, bear);
   ChartSetInteger(0, CHART_COLOR_CHART_UP, bull);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN, bear);
   ChartSetInteger(0, CHART_COLOR_CHART_LINE, lineC);
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
double FindRecentLow(const string sym, const ENUM_TIMEFRAMES tf, const int barsCount)
{
   double lowVal = DBL_MAX;
   for(int s = 1; s <= barsCount; ++s)
   {
      double l = iLow(sym, tf, s);
      if(l < lowVal) lowVal = l;
   }
   return lowVal;
}

//+------------------------------------------------------------------+
double FindRecentHigh(const string sym, const ENUM_TIMEFRAMES tf, const int barsCount)
{
   double highVal = -DBL_MAX;
   for(int s = 1; s <= barsCount; ++s)
   {
      double h = iHigh(sym, tf, s);
      if(h > highVal) highVal = h;
   }
   return highVal;
}

//+------------------------------------------------------------------+
bool StopsAreValid(const string sym, const double entry, const double sl, const double tp)
{
   if(entry <= 0.0 || sl <= 0.0 || tp <= 0.0)
      return false;

   long stopLevelPts = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(point <= 0.0)
      return false;
   double minStop = stopLevelPts * point;
   double distSL = MathAbs(entry - sl);
   double distTP = MathAbs(entry - tp);
   return (distSL >= minStop && distTP >= minStop);
}

//+------------------------------------------------------------------+
double NormalizeVolume(const string sym, const double volumeRaw)
{
   double minLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(step <= 0.0)
      return 0.0;

   double v = MathMax(minLot, MathMin(maxLot, volumeRaw));
   v = MathFloor(v / step) * step;
   v = NormalizeDouble(v, 2);
   if(v < minLot)
      return 0.0;
   return v;
}

//+------------------------------------------------------------------+
double CalculateVolume(const string sym, const double entry, const double sl)
{
   if(!g_riskEnabled)
      return NormalizeVolume(sym, InpFixedLot);

   if(InpUseFixedLot)
      return NormalizeVolume(sym, InpFixedLot);

   double riskMoney = AccountInfoDouble(ACCOUNT_EQUITY) * (InpRiskPercent / 100.0);
   if(riskMoney <= 0.0)
      return 0.0;

   double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue <= 0.0 || tickSize <= 0.0)
      return 0.0;

   double stopDistance = MathAbs(entry - sl);
   if(stopDistance <= 0.0)
      return 0.0;

   double moneyPerLot = (stopDistance / tickSize) * tickValue;
   if(moneyPerLot <= 0.0)
      return 0.0;

   double rawLots = riskMoney / moneyPerLot;
   return NormalizeVolume(sym, rawLots);
}

//+------------------------------------------------------------------+
int GetDayKey(const datetime t)
{
   MqlDateTime dt;
   TimeToStruct(t, dt);
   return (dt.year * 1000 + dt.day_of_year);
}

//+------------------------------------------------------------------+
datetime GetDayStartTime(const datetime t)
{
   MqlDateTime dt;
   TimeToStruct(t, dt);
   dt.hour = 0;
   dt.min = 0;
   dt.sec = 0;
   return StructToTime(dt);
}

//+------------------------------------------------------------------+
void RefreshDayState()
{
   datetime now = TimeCurrent();
   int dayKey = GetDayKey(now);
   if(dayKey != g_currentDayKey)
   {
      g_currentDayKey = dayKey;
      g_dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
      // ArrayResize(g_partialDoneTickets, 0); // v3.52 suppressed - wiping this re-partialed any position held overnight
      if(!InpPersistPartialAcrossDays)                                                // v3.52 ADDITIVE
         ArrayResize(g_partialDoneTickets, 0);                                        // v3.52 ADDITIVE
   }
}

//+------------------------------------------------------------------+
bool IsHourInRange(const int hour, const int startHour, const int endHour)
{
   if(startHour == endHour)
      return true;

   if(startHour < endHour)
      return (hour >= startHour && hour < endHour);

   return (hour >= startHour || hour < endHour);
}

//+------------------------------------------------------------------+
bool SessionAllowedNow()
{
   if(!InpUseSessionFilter)
      return true;
   if(!g_useSessionFilter)      // v3.00 ADDITIVE: runtime toggle from dashboard
      return true;

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   bool london = IsHourInRange(dt.hour, InpLondonStartHour, InpLondonEndHour);
   bool newYork = IsHourInRange(dt.hour, InpNewYorkStartHour, InpNewYorkEndHour);
   return (london || newYork);
}

//+------------------------------------------------------------------+
double GetTodayClosedPnL()
{
   datetime now = TimeCurrent();
   datetime dayStart = GetDayStartTime(now);
   if(!HistorySelect(dayStart, now))
      return 0.0;

   double pnl = 0.0;
   int deals = HistoryDealsTotal();
   for(int i = deals - 1; i >= 0; --i)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0)
         continue;

      long mg = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if((ulong)mg != InpMagicNumber || entry != DEAL_ENTRY_OUT)
         continue;

      pnl += HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
      pnl += HistoryDealGetDouble(dealTicket, DEAL_SWAP);
      pnl += HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
   }

   return pnl;
}

//+------------------------------------------------------------------+
bool IsDailyLossLimitHit()
{
   if(InpMaxDailyLossPercent <= 0.0 || g_dayStartEquity <= 0.0)
      return false;

   double maxLossMoney = g_dayStartEquity * (InpMaxDailyLossPercent / 100.0);
   double pnl = GetTodayClosedPnL();
   return (pnl <= -maxLossMoney);
}

//+------------------------------------------------------------------+
int GetTodayEntryCount()
{
   datetime now = TimeCurrent();
   datetime dayStart = GetDayStartTime(now);
   if(!HistorySelect(dayStart, now))
      return 0;

   int count = 0;
   int deals = HistoryDealsTotal();
   for(int i = deals - 1; i >= 0; --i)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0)
         continue;

      long mg = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if((ulong)mg == InpMagicNumber && entry == DEAL_ENTRY_IN)
         count++;
   }
   return count;
}

//+------------------------------------------------------------------+
datetime GetLastEntryTime()
{
   datetime now = TimeCurrent();
   // v3.00 ADDITIVE: 30s cache - a full-history scan every tick lags the chart on old accounts
   if(g_lastEntryCacheTime > 0 && (now - g_lastEntryCacheTime) < 30)
      return g_lastEntryCacheVal;
   if(!HistorySelect(0, now))
      return 0;

   datetime lastEntry = 0;
   int deals = HistoryDealsTotal();
   for(int i = deals - 1; i >= 0; --i)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0)
         continue;

      long mg = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if((ulong)mg != InpMagicNumber || entry != DEAL_ENTRY_IN)
         continue;

      datetime t = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
      if(t > lastEntry)
         lastEntry = t;
   }
   g_lastEntryCacheVal = lastEntry;    // v3.00 ADDITIVE
   g_lastEntryCacheTime = now;         // v3.00 ADDITIVE
   return lastEntry;
}

//+------------------------------------------------------------------+
bool CooldownPassed()
{
   if(InpCooldownMinutes <= 0)
      return true;

   datetime lastEntry = GetLastEntryTime();
   if(lastEntry <= 0)
      return true;

   return ((TimeCurrent() - lastEntry) >= (InpCooldownMinutes * 60));
}

//+------------------------------------------------------------------+
int GetOpenPositionCountForEA()
{
   int count = 0;
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; --i)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;
      long mg = PositionGetInteger(POSITION_MAGIC);
      if((ulong)mg == InpMagicNumber)
         count++;
   }
   return count;
}

//+------------------------------------------------------------------+
void AddScanSymbol(const string sym)
{
   string s = sym;
   StringReplace(s, " ", "");
   StringReplace(s, "\t", "");
   if(s == "")
      return;

   if(!SymbolSelect(s, true))
      return;

   int n = ArraySize(g_scanSymbols);
   for(int i = 0; i < n; ++i)
   {
      if(g_scanSymbols[i] == s)
         return;
   }

   ArrayResize(g_scanSymbols, n + 1);
   ArrayResize(g_lastExecBarTimes, n + 1);
   g_scanSymbols[n] = s;
   g_lastExecBarTimes[n] = 0;
}

//+------------------------------------------------------------------+
void InitializeSymbolUniverse()
{
   ArrayResize(g_scanSymbols, 0);
   ArrayResize(g_lastExecBarTimes, 0);
   AddScanSymbol(_Symbol);
   if(!InpUsePortfolioMode)
      return;

   string parts[];
   int cnt = StringSplit(InpPortfolioSymbols, ',', parts);
   for(int i = 0; i < cnt; ++i)
      AddScanSymbol(parts[i]);
}

//+------------------------------------------------------------------+
bool IsMetalsSymbol(const string sym)
{
   string s = sym;
   StringToUpper(s);
   return (StringFind(s, "XAU") >= 0 || StringFind(s, "GOLD") >= 0 || StringFind(s, "XAG") >= 0 || StringFind(s, "SILVER") >= 0);
}

//+------------------------------------------------------------------+
bool IsJpyPair(const string sym)
{
   string s = sym;
   StringToUpper(s);
   return (StringFind(s, "JPY") >= 0);
}

//+------------------------------------------------------------------+
double GetEffectiveRiskReward(const string sym)
{
   double rr = InpRiskReward;
   if(!InpUseAutoPresets)
      return rr;

   if(IsMetalsSymbol(sym))
      rr = MathMax(rr, 2.5);
   else if(IsJpyPair(sym))
      rr = MathMax(rr, 2.0);
   else
      rr = MathMax(rr, 1.8);

   return rr;
}

//+------------------------------------------------------------------+
int GetEffectiveMinBias(const string sym)
{
   int v = InpMinBiasScore;
   if(!InpUseAutoPresets)
      return v;

   if(IsMetalsSymbol(sym))
      v = MathMax(v, 3);
   else
      v = MathMax(v, 2);

   return v;
}

//+------------------------------------------------------------------+
//| v3.00 ADDITIVE: symbol-adaptive point calibration                 |
//| Fixed FX-calibrated point inputs are meaningless on BTCUSD or     |
//| XAUUSD. Scale by the symbol's own average M5 range so every       |
//| symbol gets proportionally correct spread caps, buffers, BE       |
//| offsets and trail steps. FX behavior stays unchanged.             |
//+------------------------------------------------------------------+
double GetAvgM5RangePts(const string sym)
{
   double r = AverageRangePoints(sym, PERIOD_M5, 1, 48);
   return (r > 0.0 ? r : 0.0);
}

int EffectiveMaxSpreadPoints(const string sym)
{
   // return (int)MathMax((double)InpMaxSpreadPoints, GetAvgM5RangePts(sym) * 0.25); // v3.40 suppressed
   // v3.40 ADDITIVE: quiet-market range shrank the cap BELOW the broker's real spread and
   // blocked good entries (seen live: SPREAD 1701/1218 BLOCKING on BTCUSD). The limit now
   // also learns the broker's average spread and allows up to 1.6x it - normal spread never
   // blocks, only abnormal spikes (news, rollover, thin liquidity) do.
   double byRange = GetAvgM5RangePts(sym) * 0.25;
   double ema = GetSpreadEma(sym);
   double byBroker = (ema > 0.0 ? ema * 1.6 : 0.0);
   return (int)MathMax((double)InpMaxSpreadPoints, MathMax(byRange, byBroker));
}

int EffectiveBufferPoints(const string sym)
{
   return (int)MathMax((double)InpEntryBufferPoints, GetAvgM5RangePts(sym) * 0.15);
}

int EffectiveBEOffsetPoints(const string sym)
{
   return (int)MathMax((double)InpBreakEvenOffsetPoints, GetAvgM5RangePts(sym) * 0.08);
}

int EffectiveTrailStepPoints(const string sym)
{
   // return (int)MathMax((double)InpTrailStepPoints, GetAvgM5RangePts(sym) * 0.60); // v3.50 suppressed - too tight, choked winners
   return (int)MathMax((double)InpTrailStepPoints, GetAvgM5RangePts(sym) * 0.90);   // v3.50 ADDITIVE: wider trail
}

//+------------------------------------------------------------------+
string NewsReasonText(const string sym)   // v3.00 ADDITIVE: show WHY news risk fires
{
   if(!InpUseSoftNewsFilter || !g_useNewsFilter)
      return "OFF";

   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(point <= 0.0 || bid <= 0.0 || ask <= 0.0)
      return "OK";

   double spreadPts = (ask - bid) / point;
   double spreadBaseline = MathMax(1.0, EffectiveMaxSpreadPoints(sym) * 0.70);
   bool spreadSpike = (spreadPts >= spreadBaseline * InpNewsSpreadSpikeMultiplier);

   int lb = MathMax(10, InpNewsLookbackBars);
   bool rangeSpike = false;
   if(Bars(sym, PERIOD_M5) >= lb + 3)
   {
      double currentRange = (iHigh(sym, PERIOD_M5, 1) - iLow(sym, PERIOD_M5, 1)) / point;
      double avgRange = AverageRangePoints(sym, PERIOD_M5, 2, lb);
      rangeSpike = (avgRange > 0.0 && currentRange >= avgRange * InpNewsRangeSpikeMultiplier);
   }

   if(spreadSpike && rangeSpike) return "SPREAD+RANGE";
   if(spreadSpike) return "SPREAD";
   if(rangeSpike) return "RANGE";
   return "OK";
}

//+------------------------------------------------------------------+
int DetectFVG(const string sym, const ENUM_TIMEFRAMES tf)
{
   if(Bars(sym, tf) < 5)
      return SIGNAL_NONE;

   double h3 = iHigh(sym, tf, 3);
   double l3 = iLow(sym, tf, 3);
   double h1 = iHigh(sym, tf, 1);
   double l1 = iLow(sym, tf, 1);
   double c1 = iClose(sym, tf, 1);

   bool bullishGap = (l1 > h3 && c1 > h3);
   bool bearishGap = (h1 < l3 && c1 < l3);
   if(bullishGap) return SIGNAL_BUY;
   if(bearishGap) return SIGNAL_SELL;
   return SIGNAL_NONE;
}

//+------------------------------------------------------------------+
int DetectLiquiditySweep(const string sym, const ENUM_TIMEFRAMES tf)
{
   if(Bars(sym, tf) < 8)
      return SIGNAL_NONE;

   double prevHigh = -DBL_MAX;
   double prevLow = DBL_MAX;
   for(int s = 3; s <= 7; ++s)
   {
      double h = iHigh(sym, tf, s);
      double l = iLow(sym, tf, s);
      if(h > prevHigh) prevHigh = h;
      if(l < prevLow) prevLow = l;
   }

   double high2 = iHigh(sym, tf, 2);
   double low2 = iLow(sym, tf, 2);
   double close1 = iClose(sym, tf, 1);
   double open1 = iOpen(sym, tf, 1);

   bool bearishSweep = (high2 > prevHigh && close1 < prevHigh && close1 < open1);
   bool bullishSweep = (low2 < prevLow && close1 > prevLow && close1 > open1);
   if(bullishSweep) return SIGNAL_BUY;
   if(bearishSweep) return SIGNAL_SELL;
   return SIGNAL_NONE;
}

//+------------------------------------------------------------------+
double AverageRangePoints(const string sym, const ENUM_TIMEFRAMES tf, const int startShift, const int barsCount)
{
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(point <= 0.0 || barsCount <= 0)
      return 0.0;

   double sum = 0.0;
   for(int i = 0; i < barsCount; ++i)
   {
      int s = startShift + i;
      sum += (iHigh(sym, tf, s) - iLow(sym, tf, s)) / point;
   }
   return (sum / barsCount);
}

//+------------------------------------------------------------------+
bool IsNewsRiskNow(const string sym)
{
   if(!InpUseSoftNewsFilter)
      return false;
   if(!g_useNewsFilter)         // v3.00 ADDITIVE: runtime toggle from dashboard
      return false;

   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(point <= 0.0)
      return false;

   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(bid <= 0.0 || ask <= 0.0)
      return false;

   double spreadPts = (ask - bid) / point;
   // double spreadBaseline = MathMax(1.0, InpMaxSpreadPoints * 0.70); // v3.00 suppressed - FX baseline made news risk PERMANENT on BTC (threshold stuck at 4)
   double spreadBaseline = MathMax(1.0, EffectiveMaxSpreadPoints(sym) * 0.70);   // v3.00 ADDITIVE: symbol-adaptive
   bool spreadSpike = (spreadPts >= spreadBaseline * InpNewsSpreadSpikeMultiplier);

   int lb = MathMax(10, InpNewsLookbackBars);
   if(Bars(sym, PERIOD_M5) < lb + 3)
      return spreadSpike;

   double currentRange = (iHigh(sym, PERIOD_M5, 1) - iLow(sym, PERIOD_M5, 1)) / point;
   double avgRange = AverageRangePoints(sym, PERIOD_M5, 2, lb);
   bool rangeSpike = (avgRange > 0.0 && currentRange >= avgRange * InpNewsRangeSpikeMultiplier);

   return (spreadSpike || rangeSpike);
}

//+------------------------------------------------------------------+
int ParseRiskPointsFromComment(const string cmt)
{
   int pos = StringFind(cmt, ":R");
   if(pos < 0)
      return 0;

   string r = StringSubstr(cmt, pos + 2);
   return (int)StringToInteger(r);
}

//+------------------------------------------------------------------+
double PositionRR(const string sym, const int posType, const double openPrice, const int riskPts)
{
   if(riskPts <= 0 || openPrice <= 0.0)
      return 0.0;

   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(point <= 0.0 || bid <= 0 || ask <= 0)
      return 0.0;

   double profitPts = 0.0;
   if(posType == POSITION_TYPE_BUY)
      profitPts = (bid - openPrice) / point;
   else if(posType == POSITION_TYPE_SELL)
      profitPts = (openPrice - ask) / point;

   return (profitPts / (double)riskPts);
}

//+------------------------------------------------------------------+
bool IsPartialDone(const ulong ticket)
{
   int n = ArraySize(g_partialDoneTickets);
   for(int i = 0; i < n; ++i)
   {
      if(g_partialDoneTickets[i] == ticket)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
void MarkPartialDone(const ulong ticket)
{
   if(IsPartialDone(ticket))
      return;

   int n = ArraySize(g_partialDoneTickets);
   ArrayResize(g_partialDoneTickets, n + 1);
   g_partialDoneTickets[n] = ticket;
}

//+------------------------------------------------------------------+
void ManageOpenPositions()
{
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; --i)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;

      string sym = PositionGetString(POSITION_SYMBOL);
      long mg = PositionGetInteger(POSITION_MAGIC);
      if((ulong)mg != InpMagicNumber)
         continue;

      int posType = (int)PositionGetInteger(POSITION_TYPE);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double volume = PositionGetDouble(POSITION_VOLUME);
      string cmt = PositionGetString(POSITION_COMMENT);
      int riskPts = ParseRiskPointsFromComment(cmt);
      // v3.00 ADDITIVE: fallback when the broker strips comments - without this, partial/BE/trailing silently skipped the position
      if(riskPts <= 0 && sl > 0.0)
      {
         double pt0 = SymbolInfoDouble(sym, SYMBOL_POINT);
         if(pt0 > 0.0)
            riskPts = (int)MathRound(MathAbs(openPrice - sl) / pt0);
      }
      double rr = PositionRR(sym, posType, openPrice, riskPts);
      if(riskPts <= 0)
         continue;
      double point = SymbolInfoDouble(sym, SYMBOL_POINT);
      if(point <= 0.0)
         continue;

      // if(InpUsePartialTP && !IsPartialDone(ticket) && rr >= InpPartialAtRR) // v3.00 suppressed
      if(InpUsePartialTP && g_usePartialTP && !IsPartialDone(ticket) && rr >= InpPartialAtRR)   // v3.00 ADDITIVE: runtime toggle
      {
         double closeVol = NormalizeVolume(sym, volume * (InpPartialClosePercent / 100.0));
         if(closeVol > 0.0 && closeVol < volume)
         {
            // if(trade.PositionClosePartial(sym, closeVol)) // v3.53 suppressed - symbol overload
            if(trade.PositionClosePartial(ticket, closeVol))                       // v3.53 ADDITIVE
               MarkPartialDone(ticket);
         }
      }

      // if(InpUseBreakEven && rr >= InpBreakEvenAtRR) // v3.00 suppressed
      if(InpUseBreakEven && g_useBreakEven && rr >= InpBreakEvenAtRR)   // v3.00 ADDITIVE: runtime toggle
      {
         double beSL = sl;
         if(posType == POSITION_TYPE_BUY)
         {
            // double targetSL = openPrice + (InpBreakEvenOffsetPoints * point); // v3.00 suppressed
            double targetSL = openPrice + (EffectiveBEOffsetPoints(sym) * point);   // v3.00 ADDITIVE
            if(targetSL > sl)
               beSL = targetSL;
         }
         else if(posType == POSITION_TYPE_SELL)
         {
            // double targetSL = openPrice - (InpBreakEvenOffsetPoints * point); // v3.00 suppressed
            double targetSL = openPrice - (EffectiveBEOffsetPoints(sym) * point);   // v3.00 ADDITIVE
            if(sl <= 0.0 || targetSL < sl)
               beSL = targetSL;
         }

         if(beSL > 0.0 && MathAbs(beSL - sl) >= point)
            // trade.PositionModify(sym, beSL, tp); // v3.53 suppressed - symbol overload
            trade.PositionModify(ticket, beSL, tp);                                // v3.53 ADDITIVE
      }

      if(InpUseTrailingStop && g_useTrailing && rr >= InpTrailStartRR)
      {
         double bid = SymbolInfoDouble(sym, SYMBOL_BID);
         double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
         double trailSL = sl;

         if(posType == POSITION_TYPE_BUY && bid > 0.0)
         {
            // double candidate = bid - (InpTrailStepPoints * point); // v3.00 suppressed
            double candidate = bid - (EffectiveTrailStepPoints(sym) * point);   // v3.00 ADDITIVE
            if(candidate > trailSL)
               trailSL = candidate;
         }
         else if(posType == POSITION_TYPE_SELL && ask > 0.0)
         {
            // double candidate = ask + (InpTrailStepPoints * point); // v3.00 suppressed
            double candidate = ask + (EffectiveTrailStepPoints(sym) * point);   // v3.00 ADDITIVE
            if(trailSL <= 0.0 || candidate < trailSL)
               trailSL = candidate;
         }

         // if(trailSL > 0.0 && MathAbs(trailSL - sl) >= point) // v3.52 suppressed - 1-point threshold made the trail a per-tick ratchet
         double trailMinStep = MathMax(1.0, (double)InpTrailMinStepPoints) * point;   // v3.52 ADDITIVE
         if(trailSL > 0.0 && MathAbs(trailSL - sl) >= trailMinStep)                   // v3.52 ADDITIVE
            // trade.PositionModify(sym, trailSL, tp); // v3.53 suppressed - symbol overload
            trade.PositionModify(ticket, trailSL, tp);                             // v3.53 ADDITIVE
      }
   }
}

//+------------------------------------------------------------------+
string SignalText(const int signal)
{
   if(signal == SIGNAL_BUY) return "BUY";
   if(signal == SIGNAL_SELL) return "SELL";
   return "NONE";
}

//+------------------------------------------------------------------+
string BiasText(const int v)
{
   if(v > 0) return "BULL";
   if(v < 0) return "BEAR";
   return "NEUTRAL";
}

//+------------------------------------------------------------------+
string ClipText(const string txt, const int maxChars)
{
   if(maxChars <= 4)
      return txt;

   int n = StringLen(txt);
   if(n <= maxChars)
      return txt;

   return StringSubstr(txt, 0, maxChars - 3) + "...";
}

//+------------------------------------------------------------------+
void UpdateBreakZoneVisual()
{
   if(g_fastTester)
      return;   // v3.41 ADDITIVE: nobody can see it in a non-visual test
   if(!g_showBreakZone)
   {
      ObjectDelete(0, g_breakZoneRect);
      return;
   }

   string sym = _Symbol;
   /* v3.10 suppressed - zone now shows the true H4 CRT candle range, not an M5 lookback range
   ENUM_TIMEFRAMES tf = InpCrtExecTF;
   int look = MathMax(4, InpCRTLookbackBars);
   if(Bars(sym, tf) < look + 4) return;
   double rangeHigh = -DBL_MAX; double rangeLow = DBL_MAX;
   for(int s = look + 1; s >= 2; --s) { ... }
   datetime t1 = iTime(sym, tf, look + 1);
   datetime t2 = iTime(sym, tf, 0); */
   if(Bars(sym, InpCrtRangeTF) < 3)
      return;
   double rangeHigh = iHigh(sym, InpCrtRangeTF, 1);   // v3.10 ADDITIVE: previous H4 candle = the CRT range
   double rangeLow  = iLow(sym, InpCrtRangeTF, 1);
   datetime t1 = iTime(sym, InpCrtRangeTF, 1);
   datetime t2 = TimeCurrent();
   if(t1 <= 0 || t2 <= 0 || rangeHigh <= rangeLow)
      return;

   if(ObjectFind(0, g_breakZoneRect) < 0)
      ObjectCreate(0, g_breakZoneRect, OBJ_RECTANGLE, 0, t1, rangeHigh, t2, rangeLow);
   else
   {
      ObjectMove(0, g_breakZoneRect, 0, t1, rangeHigh);
      ObjectMove(0, g_breakZoneRect, 1, t2, rangeLow);
   }

   ObjectSetInteger(0, g_breakZoneRect, OBJPROP_COLOR, clrDarkSlateGray);
   ObjectSetInteger(0, g_breakZoneRect, OBJPROP_FILL, true);
   ObjectSetInteger(0, g_breakZoneRect, OBJPROP_BACK, true);
   ObjectSetInteger(0, g_breakZoneRect, OBJPROP_STYLE, STYLE_DOT);
   ObjectSetInteger(0, g_breakZoneRect, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, g_breakZoneRect, OBJPROP_SELECTABLE, false);
}

//+------------------------------------------------------------------+
void DashboardEnsure()
{
   if(!InpShowDashboard)
      return;

   color dashText, dashHeader, dashBull, dashBear;
   color btnTextColor, btnPrimary, btnNeutral, btnOn, btnOff, btnWarn, btnDanger;
   color panelBg, panelBorder, sectionBg, sectionBorder;
   ResolveDashboardTheme(dashText, dashHeader, dashBull, dashBear,
                         btnTextColor, btnPrimary, btnNeutral, btnOn, btnOff, btnWarn, btnDanger,
                         panelBg, panelBorder, sectionBg, sectionBorder);

   if(ObjectFind(0, g_btnOpenTrade) < 0)
   {
      ObjectCreate(0, g_btnOpenTrade, OBJ_BUTTON, 0, 0, 0);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_XSIZE, 100);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_YSIZE, 22);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_BGCOLOR, InpDashBtnPrimaryColor);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_COLOR, InpDashBtnTextColor);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_BACK, false);
      ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_STATE, false);
   }

   if(ObjectFind(0, g_btnHideShow) < 0)
   {
      ObjectCreate(0, g_btnHideShow, OBJ_BUTTON, 0, 0, 0);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_XSIZE, 70);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_YSIZE, 22);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_BGCOLOR, InpDashBtnNeutralColor);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_COLOR, InpDashBtnTextColor);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_BACK, false);
      ObjectSetInteger(0, g_btnHideShow, OBJPROP_STATE, false);
   }

   if(ObjectFind(0, g_btnSmall) < 0) { ObjectCreate(0, g_btnSmall, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnSmall, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnSmall, OBJPROP_XSIZE, 58); ObjectSetInteger(0, g_btnSmall, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnSmall, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnSmall, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnSmall, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnSmall, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnSmall, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnNormal) < 0) { ObjectCreate(0, g_btnNormal, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnNormal, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnNormal, OBJPROP_XSIZE, 58); ObjectSetInteger(0, g_btnNormal, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnNormal, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnNormal, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnNormal, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnNormal, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnNormal, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnBig) < 0) { ObjectCreate(0, g_btnBig, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnBig, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnBig, OBJPROP_XSIZE, 58); ObjectSetInteger(0, g_btnBig, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnBig, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnBig, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnBig, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnBig, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnBig, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnFull) < 0) { ObjectCreate(0, g_btnFull, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnFull, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnFull, OBJPROP_XSIZE, 58); ObjectSetInteger(0, g_btnFull, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnFull, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnFull, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnFull, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnFull, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnFull, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnEA) < 0) { ObjectCreate(0, g_btnEA, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnEA, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnEA, OBJPROP_XSIZE, 88); ObjectSetInteger(0, g_btnEA, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnEA, OBJPROP_BGCOLOR, InpDashBtnOnColor); ObjectSetInteger(0, g_btnEA, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnEA, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnEA, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnEA, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnCRT) < 0) { ObjectCreate(0, g_btnCRT, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnCRT, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnCRT, OBJPROP_XSIZE, 88); ObjectSetInteger(0, g_btnCRT, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnCRT, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnCRT, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnCRT, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnCRT, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnCRT, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnFVG) < 0) { ObjectCreate(0, g_btnFVG, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnFVG, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnFVG, OBJPROP_XSIZE, 88); ObjectSetInteger(0, g_btnFVG, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnFVG, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnFVG, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnFVG, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnFVG, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnFVG, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnBZ) < 0) { ObjectCreate(0, g_btnBZ, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnBZ, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnBZ, OBJPROP_XSIZE, 112); ObjectSetInteger(0, g_btnBZ, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnBZ, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnBZ, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnBZ, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnBZ, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnBZ, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnMode) < 0) { ObjectCreate(0, g_btnMode, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnMode, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnMode, OBJPROP_XSIZE, 110); ObjectSetInteger(0, g_btnMode, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnMode, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnMode, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnMode, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnMode, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnMode, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnRisk) < 0) { ObjectCreate(0, g_btnRisk, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnRisk, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnRisk, OBJPROP_XSIZE, 90); ObjectSetInteger(0, g_btnRisk, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnRisk, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnRisk, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnRisk, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnRisk, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnRisk, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnTrail) < 0) { ObjectCreate(0, g_btnTrail, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnTrail, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnTrail, OBJPROP_XSIZE, 92); ObjectSetInteger(0, g_btnTrail, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnTrail, OBJPROP_BGCOLOR, InpDashBtnNeutralColor); ObjectSetInteger(0, g_btnTrail, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnTrail, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnTrail, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnTrail, OBJPROP_STATE, false); }
   if(ObjectFind(0, g_btnCloseAll) < 0) { ObjectCreate(0, g_btnCloseAll, OBJ_BUTTON, 0, 0, 0); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_CORNER, CORNER_LEFT_UPPER); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_XSIZE, 130); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_YSIZE, 22); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_BGCOLOR, InpDashBtnDangerColor); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_COLOR, InpDashBtnTextColor); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_SELECTABLE, false); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_BACK, false); ObjectSetInteger(0, g_btnCloseAll, OBJPROP_STATE, false); }

   int chartW = (int)ChartGetInteger(0, CHART_WIDTH_IN_PIXELS, 0);
   int chartH = (int)ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS, 0);
   int width = InpDashWidth;
   int height = InpDashHeight;
   int buttonHeight = 18;
   int rowGap = 3;
   int panelY = (int)MathMax(2, InpDashY + 2);
   int buttonY = panelY + 24;
   int row2Y = buttonY + buttonHeight + rowGap;
   int dashCorner = (InpDashDockRight ? CORNER_RIGHT_UPPER : CORNER_LEFT_UPPER);
   if(g_dashSizeMode == 0) { width = 360; height = 210; }
   else if(g_dashSizeMode == 1) { width = 420; height = 235; }
   else if(g_dashSizeMode == 2) { width = 480; height = 260; }
   else if(g_dashSizeMode == 3)
   {
      width = 540;
      height = 300;
   }
   int maxWidth = MathMax(360, MathMin(620, chartW - (InpDashX * 2)));
   // v1.10 ADDITIVE: FULL mode ignores the 620px clamp and fills the chart width
   if(g_dashSizeMode == 3)
      maxWidth = MathMax(360, chartW - (InpDashX * 2));
   if(width > maxWidth)
      width = maxWidth;
   if(width < 360)
      width = 360;
   int maxHeight = chartH - panelY - 8;
   if(maxHeight < 210)
      maxHeight = 210;
   if(height > maxHeight)
      height = maxHeight;
   if(height < 210)
      height = 210;
   // v1.10 ADDITIVE: TRUE FULL-SCREEN — FULL mode expands to the whole chart
   if(g_dashSizeMode == 3)
   {
      width  = (int)MathMax(360, chartW - (InpDashX * 2));
      height = (int)MathMax(210, chartH - panelY - 10);
   }

   int panelX = InpDashX;

   g_dashCurrentX = panelX;
   g_dashCurrentY = panelY;
   g_dashCurrentWidth = width;
   g_dashCurrentHeight = height;
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnNormal, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnBig, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnFull, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnEA, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnMode, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_CORNER, dashCorner);
   bool compactButtons = (width < 430);
   int btnGap = 4;
   int wOpen = (compactButtons ? 64 : 72);
   int wHide = (compactButtons ? 52 : 56);
   // int wSize = 1; // hidden                                  // v1.10: suppressed — size buttons are now real
   int wSizeBtn = (compactButtons ? 26 : 30);                   // v1.10 ADDITIVE: S / N / B button width
   int wFullBtn = (compactButtons ? 38 : 44);                   // v1.10 ADDITIVE: FULL button width
   int wEA = (compactButtons ? 62 : 68);
   int wCRT = (compactButtons ? 66 : 72);
   int wFVG = (compactButtons ? 66 : 72);
   int wBZ = (compactButtons ? 72 : 82);
   int wMode = (compactButtons ? 66 : 72);
   int wRisk = (compactButtons ? 66 : 72);
   int wTrail = (compactButtons ? 66 : 72);
   int wClose = (compactButtons ? 70 : 78);

   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_XSIZE, wOpen);
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_XSIZE, wHide);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_YSIZE, buttonHeight);
   // v1.10: suppressed the 1x1 hiding of size buttons — they are now real controls
   // ObjectSetInteger(0, g_btnSmall, OBJPROP_XSIZE, 1);
   // ObjectSetInteger(0, g_btnSmall, OBJPROP_YSIZE, 1);
   // ObjectSetInteger(0, g_btnNormal, OBJPROP_XSIZE, 1);
   // ObjectSetInteger(0, g_btnNormal, OBJPROP_YSIZE, 1);
   // ObjectSetInteger(0, g_btnBig, OBJPROP_XSIZE, 1);
   // ObjectSetInteger(0, g_btnBig, OBJPROP_YSIZE, 1);
   // ObjectSetInteger(0, g_btnFull, OBJPROP_XSIZE, 1);
   // ObjectSetInteger(0, g_btnFull, OBJPROP_YSIZE, 1);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_XSIZE, wSizeBtn);    // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnSmall, OBJPROP_YSIZE, buttonHeight);// v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnNormal, OBJPROP_XSIZE, wSizeBtn);   // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnNormal, OBJPROP_YSIZE, buttonHeight);// v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnBig, OBJPROP_XSIZE, wSizeBtn);      // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnBig, OBJPROP_YSIZE, buttonHeight);  // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnFull, OBJPROP_XSIZE, wFullBtn);     // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnFull, OBJPROP_YSIZE, buttonHeight); // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnEA, OBJPROP_XSIZE, wEA);
   ObjectSetInteger(0, g_btnEA, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_XSIZE, wCRT);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_XSIZE, wFVG);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_XSIZE, wBZ);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnMode, OBJPROP_XSIZE, wMode);
   ObjectSetInteger(0, g_btnMode, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_XSIZE, wRisk);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_XSIZE, wTrail);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_YSIZE, buttonHeight);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_XSIZE, wClose);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_YSIZE, buttonHeight);

   int x = panelX + 8;
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_YDISTANCE, buttonY);
   x += wOpen + btnGap;
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_YDISTANCE, buttonY);
   x += wHide + btnGap;
   ObjectSetInteger(0, g_btnEA, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnEA, OBJPROP_YDISTANCE, buttonY);
   x += wEA + btnGap;
   ObjectSetInteger(0, g_btnCRT, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_YDISTANCE, buttonY);
   x += wCRT + btnGap;
   ObjectSetInteger(0, g_btnFVG, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_YDISTANCE, buttonY);
   // v1.10: suppressed off-panel parking of size buttons
   // ObjectSetInteger(0, g_btnSmall, OBJPROP_XDISTANCE, panelX + width + 300);
   // ObjectSetInteger(0, g_btnNormal, OBJPROP_XDISTANCE, panelX + width + 320);
   // ObjectSetInteger(0, g_btnBig, OBJPROP_XDISTANCE, panelX + width + 340);
   // ObjectSetInteger(0, g_btnFull, OBJPROP_XDISTANCE, panelX + width + 360);
   // ObjectSetInteger(0, g_btnSmall, OBJPROP_YDISTANCE, panelY + 2);
   // ObjectSetInteger(0, g_btnNormal, OBJPROP_YDISTANCE, panelY + 2);
   // ObjectSetInteger(0, g_btnBig, OBJPROP_YDISTANCE, panelY + 2);
   // ObjectSetInteger(0, g_btnFull, OBJPROP_YDISTANCE, panelY + 2);
   // v1.10 ADDITIVE: size buttons live in the panel header row, right-aligned
   int sizeRowX = panelX + width - (wSizeBtn * 3 + wFullBtn + btnGap * 3) - 8;
   if(sizeRowX < panelX + 8)
      sizeRowX = panelX + 8;
   ObjectSetInteger(0, g_btnSmall, OBJPROP_XDISTANCE, sizeRowX);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_YDISTANCE, panelY + 4);
   ObjectSetInteger(0, g_btnNormal, OBJPROP_XDISTANCE, sizeRowX + wSizeBtn + btnGap);
   ObjectSetInteger(0, g_btnNormal, OBJPROP_YDISTANCE, panelY + 4);
   ObjectSetInteger(0, g_btnBig, OBJPROP_XDISTANCE, sizeRowX + (wSizeBtn + btnGap) * 2);
   ObjectSetInteger(0, g_btnBig, OBJPROP_YDISTANCE, panelY + 4);
   ObjectSetInteger(0, g_btnFull, OBJPROP_XDISTANCE, sizeRowX + (wSizeBtn + btnGap) * 3);
   ObjectSetInteger(0, g_btnFull, OBJPROP_YDISTANCE, panelY + 4);

   x = panelX + 8;
   ObjectSetInteger(0, g_btnBZ, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_YDISTANCE, row2Y);
   x += wBZ + btnGap;
   ObjectSetInteger(0, g_btnMode, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnMode, OBJPROP_YDISTANCE, row2Y);
   x += wMode + btnGap;
   ObjectSetInteger(0, g_btnRisk, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_YDISTANCE, row2Y);
   x += wRisk + btnGap;
   ObjectSetInteger(0, g_btnTrail, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_YDISTANCE, row2Y);
   x += wTrail + btnGap;
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_YDISTANCE, row2Y);

   int btnFont = (compactButtons ? 8 : 9);
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnNormal, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnBig, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnFull, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnEA, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnMode, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_FONTSIZE, btnFont);
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnNormal, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnBig, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnFull, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnEA, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnMode, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_COLOR, btnTextColor);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_COLOR, btnTextColor);

   ObjectSetString(0, g_btnOpenTrade, OBJPROP_TEXT, "OPEN");
   ObjectSetString(0, g_btnHideShow, OBJPROP_TEXT, (g_dashboardVisible ? "HIDE" : "SHOW"));
   // v1.10: suppressed empty labels — size buttons now carry real text
   // ObjectSetString(0, g_btnSmall, OBJPROP_TEXT, "");
   // ObjectSetString(0, g_btnNormal, OBJPROP_TEXT, "");
   // ObjectSetString(0, g_btnBig, OBJPROP_TEXT, "");
   // ObjectSetString(0, g_btnFull, OBJPROP_TEXT, "");
   ObjectSetString(0, g_btnSmall, OBJPROP_TEXT, "S");        // v1.10 ADDITIVE
   ObjectSetString(0, g_btnNormal, OBJPROP_TEXT, "N");       // v1.10 ADDITIVE
   ObjectSetString(0, g_btnBig, OBJPROP_TEXT, "B");          // v1.10 ADDITIVE
   ObjectSetString(0, g_btnFull, OBJPROP_TEXT, "FULL");      // v1.10 ADDITIVE
   ObjectSetString(0, g_btnEA, OBJPROP_TEXT, (g_eaRunning ? "EA ON" : "EA OFF"));
   ObjectSetString(0, g_btnCRT, OBJPROP_TEXT, (g_useCRT ? "CRT ON" : "CRT OFF"));
   ObjectSetString(0, g_btnFVG, OBJPROP_TEXT, (g_useFVG ? "FVG ON" : "FVG OFF"));
   ObjectSetString(0, g_btnBZ, OBJPROP_TEXT, (g_showBreakZone ? "BZ ON" : "BZ OFF"));
   ObjectSetString(0, g_btnMode, OBJPROP_TEXT, (g_autoMode ? "AUTO" : "MAN"));
   ObjectSetString(0, g_btnRisk, OBJPROP_TEXT, (g_riskEnabled ? "RISK ON" : "RISK OFF"));
   ObjectSetString(0, g_btnTrail, OBJPROP_TEXT, (g_useTrailing ? "TRL ON" : "TRL OFF"));
   ObjectSetString(0, g_btnCloseAll, OBJPROP_TEXT, "CLOSE");
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_HIDDEN, false);
   // v1.10: suppressed hiding — size buttons are visible controls now
   // ObjectSetInteger(0, g_btnSmall, OBJPROP_HIDDEN, true);
   // ObjectSetInteger(0, g_btnNormal, OBJPROP_HIDDEN, true);
   // ObjectSetInteger(0, g_btnBig, OBJPROP_HIDDEN, true);
   // ObjectSetInteger(0, g_btnFull, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_HIDDEN, false);   // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnNormal, OBJPROP_HIDDEN, false);  // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnBig, OBJPROP_HIDDEN, false);     // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnFull, OBJPROP_HIDDEN, false);    // v1.10 ADDITIVE
   ObjectSetInteger(0, g_btnEA, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnMode, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_BGCOLOR, btnPrimary);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_BGCOLOR, btnNeutral);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_BGCOLOR, (g_dashSizeMode == 0 ? btnPrimary : btnNeutral));
   ObjectSetInteger(0, g_btnNormal, OBJPROP_BGCOLOR, (g_dashSizeMode == 1 ? btnPrimary : btnNeutral));
   ObjectSetInteger(0, g_btnBig, OBJPROP_BGCOLOR, (g_dashSizeMode == 2 ? btnPrimary : btnNeutral));
   ObjectSetInteger(0, g_btnFull, OBJPROP_BGCOLOR, (g_dashSizeMode == 3 ? btnPrimary : btnNeutral));
   ObjectSetInteger(0, g_btnEA, OBJPROP_BGCOLOR, (g_eaRunning ? btnOn : btnOff));
   ObjectSetInteger(0, g_btnCRT, OBJPROP_BGCOLOR, (g_useCRT ? btnOn : btnOff));
   ObjectSetInteger(0, g_btnFVG, OBJPROP_BGCOLOR, (g_useFVG ? btnOn : btnOff));
   ObjectSetInteger(0, g_btnBZ, OBJPROP_BGCOLOR, (g_showBreakZone ? btnOn : btnOff));
   ObjectSetInteger(0, g_btnMode, OBJPROP_BGCOLOR, (g_autoMode ? btnOn : btnWarn));
   ObjectSetInteger(0, g_btnRisk, OBJPROP_BGCOLOR, (g_riskEnabled ? btnOn : btnOff));
   ObjectSetInteger(0, g_btnTrail, OBJPROP_BGCOLOR, (g_useTrailing ? btnOn : btnOff));
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_BGCOLOR, btnDanger);

   if(!g_dashboardVisible)
   {
      ObjectDelete(0, g_dashName);
      ObjectDelete(0, g_dashPanelName);
      ObjectDelete(0, g_dashHeaderName);
      ObjectDelete(0, g_dashAlgoName);
      ObjectDelete(0, g_dashAlgo2Name);
      ObjectDelete(0, g_dashUniverseName);
      ObjectDelete(0, g_dashActionName);
      ObjectDelete(0, g_dashMeta1Name);
      ObjectDelete(0, g_dashMeta2Name);
      ObjectDelete(0, g_dashMeta3Name);
      ObjectDelete(0, g_dashMeta4Name);
      ObjectDelete(0, g_dashBoxOverview);
      ObjectDelete(0, g_dashBoxSignal);
      ObjectDelete(0, g_dashBoxAction);
      return;
   }

   if(ObjectFind(0, g_dashPanelName) < 0) ObjectCreate(0, g_dashPanelName, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_XDISTANCE, panelX);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_YDISTANCE, panelY);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_XSIZE, width);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_YSIZE, height);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_BGCOLOR, panelBg);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_COLOR, panelBorder);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_BACK, false);
   ObjectSetInteger(0, g_dashPanelName, OBJPROP_ZORDER, 50);

   if(ObjectFind(0, g_dashBoxOverview) < 0) ObjectCreate(0, g_dashBoxOverview, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashBoxSignal) < 0) ObjectCreate(0, g_dashBoxSignal, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashBoxAction) < 0) ObjectCreate(0, g_dashBoxAction, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashHeaderName) < 0) ObjectCreate(0, g_dashHeaderName, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashName) < 0) ObjectCreate(0, g_dashName, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashMeta1Name) < 0) ObjectCreate(0, g_dashMeta1Name, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashMeta2Name) < 0) ObjectCreate(0, g_dashMeta2Name, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashMeta3Name) < 0) ObjectCreate(0, g_dashMeta3Name, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashMeta4Name) < 0) ObjectCreate(0, g_dashMeta4Name, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashAlgoName) < 0) ObjectCreate(0, g_dashAlgoName, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashAlgo2Name) < 0) ObjectCreate(0, g_dashAlgo2Name, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashUniverseName) < 0) ObjectCreate(0, g_dashUniverseName, OBJ_LABEL, 0, 0, 0);
   if(ObjectFind(0, g_dashActionName) < 0) ObjectCreate(0, g_dashActionName, OBJ_LABEL, 0, 0, 0);

   ObjectSetInteger(0, g_dashHeaderName, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashHeaderName, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashHeaderName, OBJPROP_YDISTANCE, panelY + 6);
   ObjectSetInteger(0, g_dashHeaderName, OBJPROP_COLOR, dashHeader);
   ObjectSetInteger(0, g_dashHeaderName, OBJPROP_FONTSIZE, InpDashFontSize + (g_dashSizeMode >= 2 ? 3 : 1));
   ObjectSetString(0, g_dashHeaderName, OBJPROP_FONT, "Segoe UI");

   int baseFont = (g_dashSizeMode == 0 ? 10 : 11);
   if(g_dashSizeMode >= 2)
      baseFont = 12;

   int lineH = baseFont + 5;
   int cardGap = 4;
   int cardX = panelX + 8;
   int cardW = width - 16;
   int cardOverviewY = row2Y + buttonHeight + 3;
   int cardOverviewH = (lineH * 5) + 16;
   int cardSignalY = cardOverviewY + cardOverviewH + cardGap;
   int cardSignalH = (lineH * 2) + 14;
   int cardActionY = cardSignalY + cardSignalH + cardGap;
   int cardActionH = (lineH * 2) + 14;

   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_XDISTANCE, cardX);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_YDISTANCE, cardOverviewY);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_XSIZE, cardW);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_YSIZE, cardOverviewH);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_BGCOLOR, sectionBg);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_COLOR, sectionBorder);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_BACK, false);
   ObjectSetInteger(0, g_dashBoxOverview, OBJPROP_ZORDER, 60);

   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_XDISTANCE, cardX);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_YDISTANCE, cardSignalY);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_XSIZE, cardW);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_YSIZE, cardSignalH);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_BGCOLOR, sectionBg);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_COLOR, sectionBorder);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_BACK, false);
   ObjectSetInteger(0, g_dashBoxSignal, OBJPROP_ZORDER, 60);

   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_XDISTANCE, cardX);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_YDISTANCE, cardActionY);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_XSIZE, cardW);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_YSIZE, cardActionH);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_BGCOLOR, sectionBg);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_COLOR, sectionBorder);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_BACK, false);
   ObjectSetInteger(0, g_dashBoxAction, OBJPROP_ZORDER, 60);

   int baseY = cardOverviewY + 7;
   ObjectSetInteger(0, g_dashName, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashName, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashName, OBJPROP_YDISTANCE, baseY + (lineH * 0));
   ObjectSetInteger(0, g_dashName, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashName, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashName, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashMeta1Name, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashMeta1Name, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashMeta1Name, OBJPROP_YDISTANCE, baseY + (lineH * 1));
   ObjectSetInteger(0, g_dashMeta1Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta1Name, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashMeta1Name, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashMeta2Name, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashMeta2Name, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashMeta2Name, OBJPROP_YDISTANCE, baseY + (lineH * 2));
   ObjectSetInteger(0, g_dashMeta2Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta2Name, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashMeta2Name, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashMeta3Name, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashMeta3Name, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashMeta3Name, OBJPROP_YDISTANCE, baseY + (lineH * 3));
   ObjectSetInteger(0, g_dashMeta3Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta3Name, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashMeta3Name, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashMeta4Name, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashMeta4Name, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashMeta4Name, OBJPROP_YDISTANCE, baseY + (lineH * 4));
   ObjectSetInteger(0, g_dashMeta4Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta4Name, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashMeta4Name, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashAlgoName, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashAlgoName, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashAlgoName, OBJPROP_YDISTANCE, cardSignalY + 7);
   ObjectSetInteger(0, g_dashAlgoName, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashAlgoName, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashAlgo2Name, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashAlgo2Name, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashAlgo2Name, OBJPROP_YDISTANCE, cardSignalY + 7 + lineH);
   ObjectSetInteger(0, g_dashAlgo2Name, OBJPROP_COLOR, clrAqua);
   ObjectSetInteger(0, g_dashAlgo2Name, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashAlgo2Name, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashUniverseName, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashUniverseName, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashUniverseName, OBJPROP_YDISTANCE, cardActionY + 7 + lineH);
   ObjectSetInteger(0, g_dashUniverseName, OBJPROP_COLOR, clrLightGreen);
   ObjectSetInteger(0, g_dashUniverseName, OBJPROP_FONTSIZE, (int)MathMax(8, baseFont - 1));
   ObjectSetString(0, g_dashUniverseName, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_dashActionName, OBJPROP_CORNER, dashCorner);
   ObjectSetInteger(0, g_dashActionName, OBJPROP_XDISTANCE, panelX + 8);
   ObjectSetInteger(0, g_dashActionName, OBJPROP_YDISTANCE, cardActionY + 7);
   ObjectSetInteger(0, g_dashActionName, OBJPROP_COLOR, clrGold);
   ObjectSetInteger(0, g_dashActionName, OBJPROP_FONTSIZE, baseFont);
   ObjectSetString(0, g_dashActionName, OBJPROP_FONT, "Segoe UI");

   ObjectSetInteger(0, g_btnOpenTrade, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnHideShow, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnSmall, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnNormal, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnBig, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnFull, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnEA, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnCRT, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnFVG, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnBZ, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnMode, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnRisk, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnTrail, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_btnCloseAll, OBJPROP_ZORDER, 100);
   ObjectSetInteger(0, g_dashName, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashMeta1Name, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashMeta2Name, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashMeta3Name, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashMeta4Name, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashAlgoName, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashAlgo2Name, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashUniverseName, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashActionName, OBJPROP_ZORDER, 80);
   ObjectSetInteger(0, g_dashHeaderName, OBJPROP_ZORDER, 90);
}

//+------------------------------------------------------------------+
int ComputeCompositeSignal(const string sym, int &scoreBuy, int &scoreSell, int &threshold, bool &newsRisk)
{
   scoreBuy = 0;
   scoreSell = 0;
   // threshold = InpSignalScoreThreshold; // v3.00 suppressed - runtime adjustable via THR-/THR+
   threshold = g_threshold;                  // v3.00 ADDITIVE
   newsRisk = IsNewsRiskNow(sym);

   BiasSnapshot bias = GetBiasSnapshot(sym);
   int effectiveMinBias = GetEffectiveMinBias(sym);
   int amdH1 = DetectAMD(sym, InpAmdTF_H1);
   int amdM15 = DetectAMD(sym, InpAmdTF_M15);
   // int crtExec = (g_useCRT ? DetectCRT(sym, InpCrtExecTF, InpCRTLookbackBars) : SIGNAL_NONE); // v3.10 suppressed - old M5-lookback CRT
   int crtExec = (g_useCRT ? DetectCRT_HTF(sym) : SIGNAL_NONE);   // v3.10 ADDITIVE: H4 candle-range CRT + M15 confirmation
   int brkExec = (g_useBreakout ? DetectBreakout_HTF(sym) : SIGNAL_NONE);   // v3.30 ADDITIVE: acceptance/continuation companion
   int fvg = ((InpUseFVGConfirm && g_useFVG) ? DetectFVG(sym, InpConfirmTF) : SIGNAL_NONE);
   int sweep = (InpUseLiquiditySweepConfirm ? DetectLiquiditySweep(sym, InpConfirmTF) : SIGNAL_NONE);
   // v3.30 suppressed - key confluence now also rewards breakouts through key levels
   // int keyBuy = ((g_useCRT && crtExec == SIGNAL_BUY) ? KeyLevelConfluence(sym, SIGNAL_BUY) : 0);
   // int keySell = ((g_useCRT && crtExec == SIGNAL_SELL) ? KeyLevelConfluence(sym, SIGNAL_SELL) : 0);
   int keyBuy = (((g_useCRT && crtExec == SIGNAL_BUY) || brkExec == SIGNAL_BUY) ? KeyLevelConfluence(sym, SIGNAL_BUY) : 0);      // v3.30 ADDITIVE
   int keySell = (((g_useCRT && crtExec == SIGNAL_SELL) || brkExec == SIGNAL_SELL) ? KeyLevelConfluence(sym, SIGNAL_SELL) : 0);   // v3.30 ADDITIVE

   bool buyBias = (bias.net >= effectiveMinBias);
   bool sellBias = (bias.net <= -effectiveMinBias);
   bool amdBuy = (amdH1 == SIGNAL_BUY || amdM15 == SIGNAL_BUY);
   bool amdSell = (amdH1 == SIGNAL_SELL || amdM15 == SIGNAL_SELL);
   // bool crtBuy = (!g_useCRT || crtExec == SIGNAL_BUY); // v3.30 suppressed
   bool crtBuy = (!g_useCRT || crtExec == SIGNAL_BUY || brkExec == SIGNAL_BUY);   // v3.30 ADDITIVE: rejection OR acceptance
   // bool crtSell = (!g_useCRT || crtExec == SIGNAL_SELL); // v3.30 suppressed
   bool crtSell = (!g_useCRT || crtExec == SIGNAL_SELL || brkExec == SIGNAL_SELL);   // v3.30 ADDITIVE

   // scoreBuy = (buyBias ? 2 : 0) + (amdBuy ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_BUY) ? 1 : 0) + (fvg == SIGNAL_BUY ? 1 : 0) + (sweep == SIGNAL_BUY ? 1 : 0); // v3.10 suppressed
   scoreBuy = (buyBias ? 2 : 0) + (amdBuy ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_BUY) ? 2 : 0) + (brkExec == SIGNAL_BUY ? 2 : 0) + (fvg == SIGNAL_BUY ? 1 : 0) + (sweep == SIGNAL_BUY ? 1 : 0) + keyBuy;   // v3.30 ADDITIVE
   // scoreSell = (sellBias ? 2 : 0) + (amdSell ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_SELL) ? 1 : 0) + (fvg == SIGNAL_SELL ? 1 : 0) + (sweep == SIGNAL_SELL ? 1 : 0); // v3.10 suppressed
   scoreSell = (sellBias ? 2 : 0) + (amdSell ? 1 : 0) + ((g_useCRT && crtExec == SIGNAL_SELL) ? 2 : 0) + (brkExec == SIGNAL_SELL ? 2 : 0) + (fvg == SIGNAL_SELL ? 1 : 0) + (sweep == SIGNAL_SELL ? 1 : 0) + keySell;   // v3.30 ADDITIVE

   if(newsRisk)
      threshold += InpNewsRiskExtraScore;

   int signal = SIGNAL_NONE;
   if(crtBuy && scoreBuy >= threshold && scoreBuy > scoreSell)
      signal = SIGNAL_BUY;
   else if(crtSell && scoreSell >= threshold && scoreSell > scoreBuy)
      signal = SIGNAL_SELL;
   else if(newsRisk)
   {
      if(crtBuy && scoreBuy >= InpNewsOverrideScore && scoreBuy > scoreSell)
         signal = SIGNAL_BUY;
      else if(crtSell && scoreSell >= InpNewsOverrideScore && scoreSell > scoreBuy)
         signal = SIGNAL_SELL;
   }

   return signal;
}

//+------------------------------------------------------------------+
string BuildSymbolDashboardStatus(const string sym, const bool compact)
{
   int scoreBuy = 0;
   int scoreSell = 0;
   int threshold = 0;
   bool newsRisk = false;
   int signal = ComputeCompositeSignal(sym, scoreBuy, scoreSell, threshold, newsRisk);

   if(compact)
      return sym + ":" + SignalText(signal) + " B" + IntegerToString(scoreBuy) + "/S" + IntegerToString(scoreSell) + "/T" + IntegerToString(threshold);

   BiasSnapshot bias = GetBiasSnapshot(sym);
   int amdH1 = DetectAMD(sym, InpAmdTF_H1);
   int amdM15 = DetectAMD(sym, InpAmdTF_M15);
   // int crtExec = (g_useCRT ? DetectCRT(sym, InpCrtExecTF, InpCRTLookbackBars) : SIGNAL_NONE); // v3.10 suppressed - old M5-lookback CRT
   int crtExec = (g_useCRT ? DetectCRT_HTF(sym) : SIGNAL_NONE);   // v3.10 ADDITIVE: H4 candle-range CRT + M15 confirmation
   int brkExec = (g_useBreakout ? DetectBreakout_HTF(sym) : SIGNAL_NONE);   // v3.30 ADDITIVE: acceptance/continuation companion
   int fvg = ((InpUseFVGConfirm && g_useFVG) ? DetectFVG(sym, InpConfirmTF) : SIGNAL_NONE);
   int sweep = (InpUseLiquiditySweepConfirm ? DetectLiquiditySweep(sym, InpConfirmTF) : SIGNAL_NONE);

   return "ALGO " + sym + " => " + SignalText(signal) +
          " | B/S/T:" + IntegerToString(scoreBuy) + "/" + IntegerToString(scoreSell) + "/" + IntegerToString(threshold) +
          " | Bias:" + BiasText(bias.d1) + "/" + BiasText(bias.h4) + "/" + BiasText(bias.h1) +
          " | AMD:" + SignalText(amdH1) + "," + SignalText(amdM15) +
          " | CRT:" + SignalText(crtExec) +
          " | FVG:" + SignalText(fvg) +
          " | SWP:" + SignalText(sweep) +
          " | News:" + (newsRisk ? "YES" : "NO");
}

//+------------------------------------------------------------------+
int GetCooldownRemainingSeconds()
{
   if(InpCooldownMinutes <= 0)
      return 0;
   datetime lastEntry = GetLastEntryTime();
   if(lastEntry <= 0)
      return 0;
   int remaining = (InpCooldownMinutes * 60) - (int)(TimeCurrent() - lastEntry);
   if(remaining < 0)
      remaining = 0;
   return remaining;
}

//+------------------------------------------------------------------+
void DashboardUpdate()
{
   if(!InpShowDashboard)
   {
      ObjectDelete(0, g_dashName);
      ObjectDelete(0, g_dashPanelName);
      ObjectDelete(0, g_dashHeaderName);
      ObjectDelete(0, g_dashAlgoName);
      ObjectDelete(0, g_dashAlgo2Name);
      ObjectDelete(0, g_dashUniverseName);
      ObjectDelete(0, g_dashActionName);
      ObjectDelete(0, g_dashMeta1Name);
      ObjectDelete(0, g_dashMeta2Name);
      ObjectDelete(0, g_dashMeta3Name);
      ObjectDelete(0, g_dashMeta4Name);
      ObjectDelete(0, g_dashBoxOverview);
      ObjectDelete(0, g_dashBoxSignal);
      ObjectDelete(0, g_dashBoxAction);
      ObjectDelete(0, g_btnOpenTrade);
      ObjectDelete(0, g_btnHideShow);
      ObjectDelete(0, g_btnSmall);
      ObjectDelete(0, g_btnNormal);
      ObjectDelete(0, g_btnBig);
      ObjectDelete(0, g_btnFull);
      ObjectDelete(0, g_btnEA);
      ObjectDelete(0, g_btnCRT);
      ObjectDelete(0, g_btnFVG);
      ObjectDelete(0, g_btnBZ);
      ObjectDelete(0, g_btnMode);
      ObjectDelete(0, g_btnRisk);
      ObjectDelete(0, g_btnTrail);
      ObjectDelete(0, g_btnCloseAll);
      return;
   }

   DashboardEnsure();
   if(!g_dashboardVisible)
      return;

   color dashText, dashHeader, dashBull, dashBear;
   color btnTextColor, btnPrimary, btnNeutral, btnOn, btnOff, btnWarn, btnDanger;
   color panelBg, panelBorder, sectionBg, sectionBorder;
   ResolveDashboardTheme(dashText, dashHeader, dashBull, dashBear,
                         btnTextColor, btnPrimary, btnNeutral, btnOn, btnOff, btnWarn, btnDanger,
                         panelBg, panelBorder, sectionBg, sectionBorder);

   int scoreBuy = 0;
   int scoreSell = 0;
   int threshold = 0;
   bool newsRisk = false;
   int signal = ComputeCompositeSignal(_Symbol, scoreBuy, scoreSell, threshold, newsRisk);
   BiasSnapshot bias = GetBiasSnapshot(_Symbol);
   int amdH1 = DetectAMD(_Symbol, InpAmdTF_H1);
   int amdM15 = DetectAMD(_Symbol, InpAmdTF_M15);
   // int crtExec = (g_useCRT ? DetectCRT(_Symbol, InpCrtExecTF, InpCRTLookbackBars) : SIGNAL_NONE); // v3.10 suppressed
   int crtExec = (g_useCRT ? DetectCRT_HTF(_Symbol) : SIGNAL_NONE);   // v3.10 ADDITIVE
   int brkExec = (g_useBreakout ? DetectBreakout_HTF(_Symbol) : SIGNAL_NONE);   // v3.30 ADDITIVE
   int fvg = ((InpUseFVGConfirm && g_useFVG) ? DetectFVG(_Symbol, InpConfirmTF) : SIGNAL_NONE);
   int sweep = (InpUseLiquiditySweepConfirm ? DetectLiquiditySweep(_Symbol, InpConfirmTF) : SIGNAL_NONE);

   int cooldownLeft = GetCooldownRemainingSeconds();
   int cdMin = cooldownLeft / 60;
   int cdSec = cooldownLeft % 60;

   string head = "CRT/AMD CONTROL PANEL";
   string line1 = _Symbol + "  |  SIGNAL: " + SignalText(signal) + "  |  SESSION: " + (SessionAllowedNow() ? "OPEN" : "CLOSED");
   string line2 = "B/S/T " + IntegerToString(scoreBuy) + "/" + IntegerToString(scoreSell) + "/" + IntegerToString(threshold) +
                  "  |  BIAS " + BiasText(bias.net);
   string line3 = "EQUITY " + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
                  "  |  PnL " + DoubleToString(GetTodayClosedPnL(), 2);
   string line4 = "TRADES " + IntegerToString(GetTodayEntryCount()) + "/" + IntegerToString(InpMaxTradesPerDay) +
                  "  |  OPEN " + IntegerToString(GetOpenPositionCountForEA()) + "/" + IntegerToString(InpMaxConcurrentPositions);
   string line5 = "COOLDOWN " + IntegerToString(cdMin) + "m " + IntegerToString(cdSec) + "s  |  LAST: " + g_uiLastAction;

   bool compactMode = (g_dashSizeMode == 0);

   string algoTxt = "AMD " + SignalText(amdH1) + "/" + SignalText(amdM15) +
                    " | CRT " + SignalText(crtExec) +
                    " | FVG " + SignalText(fvg) +
                    " | SWEEP " + SignalText(sweep);
   string algoTxt2 = "RR " + DoubleToString(GetEffectiveRiskReward(_Symbol), 1) +
                     " | NEWS " + (newsRisk ? "HIGH" : "OK") +
                     " | EA " + (g_eaRunning ? "ON" : "OFF") +
                     " | MODE " + (g_autoMode ? "AUTO" : "MANUAL");

   string uniTxt = "UNIVERSE: ";
   int n = ArraySize(g_scanSymbols);
   int maxItems = (compactMode ? 1 : 2);
   if(g_dashSizeMode == 2) maxItems = 3;
   else if(g_dashSizeMode == 3) maxItems = 4;
   int limit = MathMin(n, maxItems);
   for(int i = 0; i < limit; ++i)
   {
      if(i > 0) uniTxt += " || ";
      uniTxt += BuildSymbolDashboardStatus(g_scanSymbols[i], true);
   }
   if(n > limit)
      uniTxt += " || ... +" + IntegerToString(n - limit);

   color signalColor = dashText;
   if(signal == SIGNAL_BUY) signalColor = dashBull;
   if(signal == SIGNAL_SELL) signalColor = dashBear;
   if(signal == SIGNAL_NONE) signalColor = clrOrange;

   int maxChars = MathMax(32, g_dashCurrentWidth / 8);
   int maxHeaderChars = MathMax(24, g_dashCurrentWidth / 8);
   int maxUniverseChars = MathMax(24, g_dashCurrentWidth / 9);

   if(compactMode)
   {
      ObjectSetString(0, g_dashHeaderName, OBJPROP_TEXT, ClipText(head, maxHeaderChars));
      ObjectSetString(0, g_dashName, OBJPROP_TEXT, ClipText(line1, maxChars));
      ObjectSetString(0, g_dashMeta1Name, OBJPROP_TEXT, ClipText(line2, maxChars));
      ObjectSetString(0, g_dashMeta2Name, OBJPROP_TEXT, ClipText(line3, maxChars));
      ObjectSetString(0, g_dashMeta3Name, OBJPROP_TEXT, ClipText(line4, maxChars));
      ObjectSetString(0, g_dashMeta4Name, OBJPROP_TEXT, ClipText(line5, maxChars));
      ObjectSetString(0, g_dashAlgoName, OBJPROP_TEXT, ClipText(algoTxt, maxChars));
      ObjectSetString(0, g_dashAlgo2Name, OBJPROP_TEXT, "");
      ObjectSetString(0, g_dashUniverseName, OBJPROP_TEXT, ClipText(uniTxt, maxUniverseChars));
      ObjectSetString(0, g_dashActionName, OBJPROP_TEXT, "");
   }
   else
   {
      ObjectSetString(0, g_dashHeaderName, OBJPROP_TEXT, ClipText(head, maxHeaderChars));
      ObjectSetString(0, g_dashName, OBJPROP_TEXT, ClipText(line1, maxChars));
      ObjectSetString(0, g_dashMeta1Name, OBJPROP_TEXT, ClipText(line2, maxChars));
      ObjectSetString(0, g_dashMeta2Name, OBJPROP_TEXT, ClipText(line3, maxChars));
      ObjectSetString(0, g_dashMeta3Name, OBJPROP_TEXT, ClipText(line4, maxChars));
      ObjectSetString(0, g_dashMeta4Name, OBJPROP_TEXT, ClipText(line5, maxChars));
      ObjectSetString(0, g_dashAlgoName, OBJPROP_TEXT, ClipText(algoTxt, maxChars));
      ObjectSetString(0, g_dashAlgo2Name, OBJPROP_TEXT, ClipText(algoTxt2, maxChars));
      ObjectSetString(0, g_dashUniverseName, OBJPROP_TEXT, ClipText(uniTxt, maxUniverseChars));
      ObjectSetString(0, g_dashActionName, OBJPROP_TEXT, ClipText("STATE  " + (g_riskEnabled ? "RISK-ON" : "RISK-OFF") + "  |  " + (g_useTrailing ? "TRAIL-ON" : "TRAIL-OFF"), maxChars));
   }
   ObjectSetInteger(0, g_dashHeaderName, OBJPROP_COLOR, dashHeader);
   ObjectSetInteger(0, g_dashName, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta1Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta2Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta3Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashMeta4Name, OBJPROP_COLOR, dashText);
   ObjectSetInteger(0, g_dashAlgoName, OBJPROP_COLOR, signalColor);
   ObjectSetInteger(0, g_dashAlgo2Name, OBJPROP_COLOR, clrAqua);
   ObjectSetInteger(0, g_dashUniverseName, OBJPROP_COLOR, clrLightGreen);
   ObjectSetInteger(0, g_dashActionName, OBJPROP_COLOR, clrGold);
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//|  v2.00 PRO DASHBOARD (ADDITIVE, 2026-07-04)                       |
//|  Complete professional redesign. Legacy DashboardEnsure/Update    |
//|  remain above, preserved per additive rule, but no longer called. |
//|  All existing buttons (OPEN/EA/CRT/FVG/BZ/MODE/RISK/TRAIL/CLOSE/  |
//|  S/N/B/FULL/HIDE) keep their names and actions - only restyled.   |
//+------------------------------------------------------------------+
string g_proPanel     = "CRT_PRO_PANEL";
string g_proHeaderBar = "CRT_PRO_HEADER_BAR";
string g_proTitle     = "CRT_PRO_TITLE";
string g_proStatusDot = "CRT_PRO_STATUS_DOT";
string g_proStatusTxt = "CRT_PRO_STATUS_TXT";
string g_proKpiBox0 = "CRT_PRO_KPI_BOX0";
string g_proKpiBox1 = "CRT_PRO_KPI_BOX1";
string g_proKpiBox2 = "CRT_PRO_KPI_BOX2";
string g_proKpiBox3 = "CRT_PRO_KPI_BOX3";
string g_proKpiLab0 = "CRT_PRO_KPI_LAB0";
string g_proKpiLab1 = "CRT_PRO_KPI_LAB1";
string g_proKpiLab2 = "CRT_PRO_KPI_LAB2";
string g_proKpiLab3 = "CRT_PRO_KPI_LAB3";
string g_proKpiVal0 = "CRT_PRO_KPI_VAL0";
string g_proKpiVal1 = "CRT_PRO_KPI_VAL1";
string g_proKpiVal2 = "CRT_PRO_KPI_VAL2";
string g_proKpiVal3 = "CRT_PRO_KPI_VAL3";
string g_proSigBox  = "CRT_PRO_SIG_BOX";
string g_proSigTxt  = "CRT_PRO_SIG_TXT";
string g_proSigSub  = "CRT_PRO_SIG_SUB";
string g_proBarBLab = "CRT_PRO_BARB_LAB";
string g_proBarBBg  = "CRT_PRO_BARB_BG";
string g_proBarBFg  = "CRT_PRO_BARB_FG";
string g_proBarSLab = "CRT_PRO_BARS_LAB";
string g_proBarSBg  = "CRT_PRO_BARS_BG";
string g_proBarSFg  = "CRT_PRO_BARS_FG";
string g_proChipBox0 = "CRT_PRO_CHIP_BOX0";
string g_proChipBox1 = "CRT_PRO_CHIP_BOX1";
string g_proChipBox2 = "CRT_PRO_CHIP_BOX2";
string g_proChipBox3 = "CRT_PRO_CHIP_BOX3";
string g_proChipBox4 = "CRT_PRO_CHIP_BOX4";
string g_proChipBox5 = "CRT_PRO_CHIP_BOX5";
string g_proChipBox6 = "CRT_PRO_CHIP_BOX6";
string g_proChipTxt0 = "CRT_PRO_CHIP_TXT0";
string g_proChipTxt1 = "CRT_PRO_CHIP_TXT1";
string g_proChipTxt2 = "CRT_PRO_CHIP_TXT2";
string g_proChipTxt3 = "CRT_PRO_CHIP_TXT3";
string g_proChipTxt4 = "CRT_PRO_CHIP_TXT4";
string g_proChipTxt5 = "CRT_PRO_CHIP_TXT5";
string g_proChipTxt6 = "CRT_PRO_CHIP_TXT6";
string g_proInfo1  = "CRT_PRO_INFO1";
string g_proInfo2  = "CRT_PRO_INFO2";
string g_proUni    = "CRT_PRO_UNI";
string g_proFooter = "CRT_PRO_FOOTER";
int g_proX = 0, g_proY = 0, g_proW = 0, g_proH = 0, g_proCorner = CORNER_LEFT_UPPER;
int g_proFont = 9;
bool g_proButtonsReordered = false;   // v2.01 ADDITIVE: one-time draw-order fix

//+------------------------------------------------------------------+
void ProTheme(color &bgPanel, color &bgHeader, color &bgCard, color &brd,
              color &accent, color &txtMain, color &txtMuted,
              color &up, color &dn, color &warn, color &offc)
{
   bgPanel  = (color)ColorToARGB((color)C'10,15,26', 246);
   bgHeader = (color)ColorToARGB((color)C'17,26,45', 255);
   bgCard   = (color)ColorToARGB((color)C'19,28,48', 235);
   brd      = (color)C'44,84,148';
   accent   = (color)C'0,122,255';
   txtMain  = clrWhite;
   txtMuted = (color)C'148,163,190';
   up       = (color)C'0,176,116';
   dn       = (color)C'226,72,92';
   warn     = (color)C'232,158,36';
   offc     = (color)C'86,96,116';
}

//+------------------------------------------------------------------+
void ProRect(const string name, const int x, const int y, const int w, const int h,
             const color bg, const color brd, const int z)
{
   if(ObjectFind(0, name) < 0)
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_CORNER, g_proCorner);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
   ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
   ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bg);
   ObjectSetInteger(0, name, OBJPROP_COLOR, brd);
   ObjectSetInteger(0, name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, name, OBJPROP_BACK, false);
   ObjectSetInteger(0, name, OBJPROP_ZORDER, z);
   ObjectSetInteger(0, name, OBJPROP_TIMEFRAMES, OBJ_ALL_PERIODS);
}

//+------------------------------------------------------------------+
void ProText(const string name, const int x, const int y, const string txt,
             const color clr, const int fs, const int z, const string font)
{
   if(ObjectFind(0, name) < 0)
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_CORNER, g_proCorner);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetString(0, name, OBJPROP_TEXT, txt);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fs);
   ObjectSetString(0, name, OBJPROP_FONT, font);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, name, OBJPROP_BACK, false);
   ObjectSetInteger(0, name, OBJPROP_ZORDER, z);
   ObjectSetInteger(0, name, OBJPROP_TIMEFRAMES, OBJ_ALL_PERIODS);
}

//+------------------------------------------------------------------+
void ProButton(const string name, const int x, const int y, const int w, const int h,
               const string txt, const color bg, const color txtClr, const int fs)
{
   if(ObjectFind(0, name) < 0)
      return; // buttons are created by legacy DashboardEnsure objects or below in ProDashEnsure
   ObjectSetInteger(0, name, OBJPROP_CORNER, g_proCorner);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
   ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
   ObjectSetString(0, name, OBJPROP_TEXT, txt);
   ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bg);
   ObjectSetInteger(0, name, OBJPROP_COLOR, txtClr);
   ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, (color)C'8,12,22');
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fs);
   ObjectSetString(0, name, OBJPROP_FONT, "Segoe UI Semibold");
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, name, OBJPROP_BACK, false);
   ObjectSetInteger(0, name, OBJPROP_ZORDER, 200);
   ObjectSetInteger(0, name, OBJPROP_STATE, false);
   ObjectSetInteger(0, name, OBJPROP_TIMEFRAMES, OBJ_ALL_PERIODS);
}

//+------------------------------------------------------------------+
void ProEnsureButtonObject(const string name)
{
   if(ObjectFind(0, name) >= 0)
      return;
   ObjectCreate(0, name, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_CORNER, g_proCorner);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_BACK, false);
   ObjectSetInteger(0, name, OBJPROP_STATE, false);
}

//+------------------------------------------------------------------+
void ProShowObj(const string name, const bool show)
{
   if(ObjectFind(0, name) < 0)
      return;
   ObjectSetInteger(0, name, OBJPROP_TIMEFRAMES, (show ? OBJ_ALL_PERIODS : OBJ_NO_PERIODS));
}

//+------------------------------------------------------------------+
void ProDeleteVisuals()
{
   ObjectDelete(0, g_proPanel);
   ObjectDelete(0, g_proHeaderBar);
   ObjectDelete(0, g_proTitle);
   ObjectDelete(0, g_proStatusDot);
   ObjectDelete(0, g_proStatusTxt);
   ObjectDelete(0, g_proKpiBox0); ObjectDelete(0, g_proKpiBox1); ObjectDelete(0, g_proKpiBox2); ObjectDelete(0, g_proKpiBox3);
   ObjectDelete(0, g_proKpiLab0); ObjectDelete(0, g_proKpiLab1); ObjectDelete(0, g_proKpiLab2); ObjectDelete(0, g_proKpiLab3);
   ObjectDelete(0, g_proKpiVal0); ObjectDelete(0, g_proKpiVal1); ObjectDelete(0, g_proKpiVal2); ObjectDelete(0, g_proKpiVal3);
   ObjectDelete(0, g_proSigBox);
   ObjectDelete(0, g_proSigTxt);
   ObjectDelete(0, g_proSigSub);
   ObjectDelete(0, g_proCfgBox);    // v3.51 ADDITIVE
   ObjectDelete(0, g_proCfgTxt);    // v3.51 ADDITIVE
   ObjectDelete(0, g_proEdgeTxt);   // v3.51 ADDITIVE
   ObjectDelete(0, g_proBarBLab); ObjectDelete(0, g_proBarBBg); ObjectDelete(0, g_proBarBFg);
   ObjectDelete(0, g_proBarSLab); ObjectDelete(0, g_proBarSBg); ObjectDelete(0, g_proBarSFg);
   ObjectDelete(0, g_proChipBox0); ObjectDelete(0, g_proChipBox1); ObjectDelete(0, g_proChipBox2); ObjectDelete(0, g_proChipBox3);
   ObjectDelete(0, g_proChipBox4); ObjectDelete(0, g_proChipBox5); ObjectDelete(0, g_proChipBox6);
   ObjectDelete(0, g_proChipTxt0); ObjectDelete(0, g_proChipTxt1); ObjectDelete(0, g_proChipTxt2); ObjectDelete(0, g_proChipTxt3);
   ObjectDelete(0, g_proChipTxt4); ObjectDelete(0, g_proChipTxt5); ObjectDelete(0, g_proChipTxt6);
   ObjectDelete(0, g_proInfo1);
   ObjectDelete(0, g_proInfo2);
   ObjectDelete(0, g_proUni);
   ObjectDelete(0, g_proFooter);
   ObjectDelete(0, g_proPosBox);      // v3.00 ADDITIVE
   ObjectDelete(0, g_proPosTxt);      // v3.00 ADDITIVE
   ObjectDelete(0, g_proPosBarBg);    // v3.00 ADDITIVE
   ObjectDelete(0, g_proPosBarFg);    // v3.00 ADDITIVE
   ObjectDelete(0, g_proPerfBox0); ObjectDelete(0, g_proPerfBox1); ObjectDelete(0, g_proPerfBox2); ObjectDelete(0, g_proPerfBox3);   // v3.20 ADDITIVE
   ObjectDelete(0, g_proPerfLab0); ObjectDelete(0, g_proPerfLab1); ObjectDelete(0, g_proPerfLab2); ObjectDelete(0, g_proPerfLab3);   // v3.20 ADDITIVE
   ObjectDelete(0, g_proPerfVal0); ObjectDelete(0, g_proPerfVal1); ObjectDelete(0, g_proPerfVal2); ObjectDelete(0, g_proPerfVal3);   // v3.20 ADDITIVE
   ObjectDelete(0, g_proLog1);        // v3.20 ADDITIVE
   ObjectDelete(0, g_proLog2);        // v3.20 ADDITIVE
}

//+------------------------------------------------------------------+
void ProDashDeleteAll()
{
   ProDeleteVisuals();
   // legacy dashboard leftovers cleanup (objects, not code)
   ObjectDelete(0, g_dashName);
   ObjectDelete(0, g_dashPanelName);
   ObjectDelete(0, g_dashHeaderName);
   ObjectDelete(0, g_dashAlgoName);
   ObjectDelete(0, g_dashAlgo2Name);
   ObjectDelete(0, g_dashUniverseName);
   ObjectDelete(0, g_dashActionName);
   ObjectDelete(0, g_dashMeta1Name);
   ObjectDelete(0, g_dashMeta2Name);
   ObjectDelete(0, g_dashMeta3Name);
   ObjectDelete(0, g_dashMeta4Name);
   ObjectDelete(0, g_dashBoxOverview);
   ObjectDelete(0, g_dashBoxSignal);
   ObjectDelete(0, g_dashBoxAction);
}

//+------------------------------------------------------------------+
void ProDashLayout()
{
   int chartW = (int)ChartGetInteger(0, CHART_WIDTH_IN_PIXELS, 0);
   int chartH = (int)ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS, 0);
   g_proCorner = (InpDashDockRight ? CORNER_RIGHT_UPPER : CORNER_LEFT_UPPER);
   g_proX = InpDashX;
   g_proY = (int)MathMax(2, InpDashY);

   if(g_dashSizeMode == 0)      { g_proW = 400; g_proFont = 8;  }
   else if(g_dashSizeMode == 1) { g_proW = 480; g_proFont = 9;  }
   else if(g_dashSizeMode == 2) { g_proW = 580; g_proFont = 10; }
   else                          { g_proW = (int)MathMax(420, chartW - (g_proX * 2)); g_proFont = 10; }

   int lineH = g_proFont + 6;
   /* v3.00 suppressed - height before filter row & position card were added
   int contentH = 30 + 6 + 22 + 4 + 22 + 8 + 44 + 8 + 54 + 8 + 22
                + 8 + lineH + 2 + lineH + 4 + lineH + 4 + lineH + 8; */
   int contentH = 30            // header
                + 6 + 22        // control row
                + 4 + 22        // feature row
                + 4 + 22        // v3.00 ADDITIVE: filter/threshold row
                + 4 + 22        // v3.10 ADDITIVE: chart appearance row
                + 8 + 44        // KPI cards
                + 8 + 44        // v3.20 ADDITIVE: performance cards
                + 8 + 54        // signal card
                + 8 + 30        // v3.00 ADDITIVE: live position card
                + 8 + 22        // chips
                + 8 + lineH     // info1
                + 2 + lineH     // info2
                + 4 + lineH     // universe
                + 4 + lineH               // footer / log line 0
                + 2 + lineH + 2 + lineH + 8;   // v3.20 ADDITIVE: decision log lines 1-2
   contentH += 4 + 22 + 4 + lineH;   // v3.51 ADDITIVE: config sentry row + edge stats row
   g_proH = contentH;
   if(g_dashSizeMode == 3)
      g_proH = (int)MathMax(contentH, chartH - g_proY - 8);

   int maxW = chartW - (g_proX * 2);
   if(g_proW > maxW && maxW >= 360) g_proW = maxW;
   int maxH = chartH - g_proY - 6;
   if(g_proH > maxH && maxH >= 260) g_proH = maxH;
}

//+------------------------------------------------------------------+
void ProDashEnsure()
{
   if(g_fastTester)
      return;   // v3.41 ADDITIVE
   if(!InpShowDashboard)
      return;

   ProDashLayout();

   color bgPanel, bgHeader, bgCard, brd, accent, txtMain, txtMuted, up, dn, warn, offc;
   ProTheme(bgPanel, bgHeader, bgCard, brd, accent, txtMain, txtMuted, up, dn, warn, offc);

   // v2.01 ADDITIVE FIX: MT5 draws chart objects in CREATION order (ZORDER is
   // click-priority only). Panel must be created BEFORE the buttons, otherwise
   // it paints over them. Create panel+header first, then (once) recreate the
   // buttons so they land above the panel in the draw stack.
   if(g_dashboardVisible)
   {
      ProRect(g_proPanel, g_proX, g_proY, g_proW, g_proH, bgPanel, brd, 40);
      ProRect(g_proHeaderBar, g_proX + 1, g_proY + 1, g_proW - 2, 28, bgHeader, bgHeader, 45);
   }
   if(!g_proButtonsReordered)
   {
      ObjectDelete(0, g_btnOpenTrade);
      ObjectDelete(0, g_btnHideShow);
      ObjectDelete(0, g_btnSmall);
      ObjectDelete(0, g_btnNormal);
      ObjectDelete(0, g_btnBig);
      ObjectDelete(0, g_btnFull);
      ObjectDelete(0, g_btnEA);
      ObjectDelete(0, g_btnCRT);
      ObjectDelete(0, g_btnFVG);
      ObjectDelete(0, g_btnBZ);
      ObjectDelete(0, g_btnMode);
      ObjectDelete(0, g_btnRisk);
      ObjectDelete(0, g_btnTrail);
      ObjectDelete(0, g_btnCloseAll);
      ObjectDelete(0, g_btnNews);       // v3.00 ADDITIVE
      ObjectDelete(0, g_btnSession);    // v3.00 ADDITIVE
      ObjectDelete(0, g_btnBE);         // v3.00 ADDITIVE
      ObjectDelete(0, g_btnPTP);        // v3.00 ADDITIVE
      ObjectDelete(0, g_btnThrMinus);   // v3.00 ADDITIVE
      ObjectDelete(0, g_btnThrPlus);    // v3.00 ADDITIVE
      ObjectDelete(0, g_btnBgTheme);     // v3.10 ADDITIVE
      ObjectDelete(0, g_btnCandleTheme); // v3.10 ADDITIVE
      ObjectDelete(0, g_btnLevels);      // v3.20 ADDITIVE
      ObjectDelete(0, g_btnCrtTp);       // v3.20 ADDITIVE
      ObjectDelete(0, g_btnBreakout);    // v3.30 ADDITIVE
      ObjectDelete(0, g_btnManBuy);      // v3.30 ADDITIVE
      ObjectDelete(0, g_btnManSell);     // v3.30 ADDITIVE
      g_proButtonsReordered = true;
   }

   // make sure all reused button objects exist even though legacy Ensure is suppressed
   ProEnsureButtonObject(g_btnOpenTrade);
   ProEnsureButtonObject(g_btnHideShow);
   ProEnsureButtonObject(g_btnSmall);
   ProEnsureButtonObject(g_btnNormal);
   ProEnsureButtonObject(g_btnBig);
   ProEnsureButtonObject(g_btnFull);
   ProEnsureButtonObject(g_btnEA);
   ProEnsureButtonObject(g_btnCRT);
   ProEnsureButtonObject(g_btnFVG);
   ProEnsureButtonObject(g_btnBZ);
   ProEnsureButtonObject(g_btnMode);
   ProEnsureButtonObject(g_btnRisk);
   ProEnsureButtonObject(g_btnTrail);
   ProEnsureButtonObject(g_btnCloseAll);
   ProEnsureButtonObject(g_btnNews);       // v3.00 ADDITIVE
   ProEnsureButtonObject(g_btnSession);    // v3.00 ADDITIVE
   ProEnsureButtonObject(g_btnBE);         // v3.00 ADDITIVE
   ProEnsureButtonObject(g_btnPTP);        // v3.00 ADDITIVE
   ProEnsureButtonObject(g_btnThrMinus);   // v3.00 ADDITIVE
   ProEnsureButtonObject(g_btnThrPlus);    // v3.00 ADDITIVE
   ProEnsureButtonObject(g_btnBgTheme);     // v3.10 ADDITIVE
   ProEnsureButtonObject(g_btnCandleTheme); // v3.10 ADDITIVE
   ProEnsureButtonObject(g_btnLevels);      // v3.20 ADDITIVE
   ProEnsureButtonObject(g_btnCrtTp);       // v3.20 ADDITIVE
   ProEnsureButtonObject(g_btnBreakout);    // v3.30 ADDITIVE
   ProEnsureButtonObject(g_btnManBuy);      // v3.30 ADDITIVE
   ProEnsureButtonObject(g_btnManSell);     // v3.30 ADDITIVE

   int x0 = g_proX;
   int y0 = g_proY;
   int w  = g_proW;

   // ------- collapsed state: only a compact SHOW pill -------
   if(!g_dashboardVisible)
   {
      ProDeleteVisuals();
      ProButton(g_btnHideShow, x0, y0, 64, 22, "SHOW", accent, clrWhite, g_proFont);
      ProShowObj(g_btnHideShow, true);
      ProShowObj(g_btnOpenTrade, false);
      ProShowObj(g_btnSmall, false);
      ProShowObj(g_btnNormal, false);
      ProShowObj(g_btnBig, false);
      ProShowObj(g_btnFull, false);
      ProShowObj(g_btnEA, false);
      ProShowObj(g_btnCRT, false);
      ProShowObj(g_btnFVG, false);
      ProShowObj(g_btnBZ, false);
      ProShowObj(g_btnMode, false);
      ProShowObj(g_btnRisk, false);
      ProShowObj(g_btnTrail, false);
      ProShowObj(g_btnCloseAll, false);
      ProShowObj(g_btnNews, false);       // v3.00 ADDITIVE
      ProShowObj(g_btnSession, false);    // v3.00 ADDITIVE
      ProShowObj(g_btnBE, false);         // v3.00 ADDITIVE
      ProShowObj(g_btnPTP, false);        // v3.00 ADDITIVE
      ProShowObj(g_btnThrMinus, false);   // v3.00 ADDITIVE
      ProShowObj(g_btnThrPlus, false);    // v3.00 ADDITIVE
      ProShowObj(g_btnBgTheme, false);     // v3.10 ADDITIVE
      ProShowObj(g_btnCandleTheme, false); // v3.10 ADDITIVE
      ProShowObj(g_btnLevels, false);      // v3.20 ADDITIVE
      ProShowObj(g_btnCrtTp, false);       // v3.20 ADDITIVE
      ProShowObj(g_btnBreakout, false);    // v3.30 ADDITIVE
      ProShowObj(g_btnManBuy, false);      // v3.30 ADDITIVE
      ProShowObj(g_btnManSell, false);     // v3.30 ADDITIVE
      return;
   }

   // ------- panel + header -------
   ProRect(g_proPanel, x0, y0, w, g_proH, bgPanel, brd, 40);
   ProRect(g_proHeaderBar, x0 + 1, y0 + 1, w - 2, 28, bgHeader, bgHeader, 45);
   ProText(g_proTitle, x0 + 10, y0 + 7, "CRT / AMD  PRO", accent, g_proFont + 2, 90, "Segoe UI Semibold");
   // v2.01: suppressed - status overlapped the title at some font sizes
   // ProRect(g_proStatusDot, x0 + 128 + (g_proFont - 8) * 14, y0 + 11, 8, 8,
   //         (g_eaRunning ? up : dn), (g_eaRunning ? up : dn), 90);
   // ProText(g_proStatusTxt, x0 + 142 + (g_proFont - 8) * 14, y0 + 8,
   //         (g_eaRunning ? "RUNNING" : "STOPPED"),
   //         (g_eaRunning ? up : dn), g_proFont - 1, 90, "Segoe UI Semibold");
   int statusX = x0 + 118 + g_proFont * 6;   // v2.01 ADDITIVE: clean spacing after title
   ProRect(g_proStatusDot, statusX, y0 + 11, 8, 8,
           (g_eaRunning ? up : dn), (g_eaRunning ? up : dn), 90);
   ProText(g_proStatusTxt, statusX + 14, y0 + 8,
           (g_eaRunning ? "RUNNING" : "STOPPED"),
           (g_eaRunning ? up : dn), g_proFont - 1, 90, "Segoe UI Semibold");

   // header-right: size controls + hide
   int hb = 20;
   int gap = 3;
   int wS = 24, wF = 40, wHide = 46;
   // int hx = x0 + w - 8 - wHide; // v2.10 suppressed - touched the panel border
   int hx = x0 + w - 14 - wHide;   // v2.10 ADDITIVE
   ProButton(g_btnHideShow, hx, y0 + 4, wHide, hb, "HIDE", offc, clrWhite, g_proFont - 1);
   hx -= (wF + gap);
   ProButton(g_btnFull, hx, y0 + 4, wF, hb, "FULL", (g_dashSizeMode == 3 ? accent : offc), clrWhite, g_proFont - 1);
   hx -= (wS + gap);
   ProButton(g_btnBig, hx, y0 + 4, wS, hb, "B", (g_dashSizeMode == 2 ? accent : offc), clrWhite, g_proFont - 1);
   hx -= (wS + gap);
   ProButton(g_btnNormal, hx, y0 + 4, wS, hb, "N", (g_dashSizeMode == 1 ? accent : offc), clrWhite, g_proFont - 1);
   hx -= (wS + gap);
   ProButton(g_btnSmall, hx, y0 + 4, wS, hb, "S", (g_dashSizeMode == 0 ? accent : offc), clrWhite, g_proFont - 1);

   // ------- control row -------
   int rowY = y0 + 30 + 6;
   int bh = 22;
   int innerW = w - 16;
   int cGap = 4;
   /* v3.30 suppressed - control row expanded with MANUAL BUY / SELL
   int bwOpen 28% / bwEA 26% / bwMode 22% / bwClose rest, "OPEN TRADE" */
   int bwOpen  = (innerW - cGap * 5) * 18 / 100;   // v3.30 ADDITIVE
   int bwBuy   = (innerW - cGap * 5) * 13 / 100;   // v3.30 ADDITIVE
   int bwSell  = (innerW - cGap * 5) * 13 / 100;   // v3.30 ADDITIVE
   int bwEA    = (innerW - cGap * 5) * 18 / 100;
   int bwMode  = (innerW - cGap * 5) * 15 / 100;
   int bwClose = innerW - bwOpen - bwBuy - bwSell - bwEA - bwMode - cGap * 5;
   int bx = x0 + 8;
   ProButton(g_btnOpenTrade, bx, rowY, bwOpen, bh, "OPEN ALGO", accent, clrWhite, g_proFont - 1);
   bx += bwOpen + cGap;
   ProButton(g_btnManBuy, bx, rowY, bwBuy, bh, "BUY", up, clrWhite, g_proFont - 1);   // v3.30 ADDITIVE: manual, EA risk engine
   bx += bwBuy + cGap;
   ProButton(g_btnManSell, bx, rowY, bwSell, bh, "SELL", dn, clrWhite, g_proFont - 1);   // v3.30 ADDITIVE
   bx += bwSell + cGap;
   // ProButton(g_btnEA, bx, rowY, bwEA, bh, (g_eaRunning ? "EA  START" : "EA  STOP"), (g_eaRunning ? up : dn), clrWhite, g_proFont); // v2.10 suppressed - label was confusing
   ProButton(g_btnEA, bx, rowY, bwEA, bh, (g_eaRunning ? "EA: ON" : "EA: OFF"), (g_eaRunning ? up : dn), clrWhite, g_proFont);   // v2.10 ADDITIVE
   bx += bwEA + cGap;
   ProButton(g_btnMode, bx, rowY, bwMode, bh, (g_autoMode ? "AUTO" : "MANUAL"), (g_autoMode ? up : warn), clrWhite, g_proFont);
   bx += bwMode + cGap;
   ProButton(g_btnCloseAll, bx, rowY, bwClose, bh, "CLOSE ALL", dn, clrWhite, g_proFont);

   // ------- feature row -------
   /* v3.30 suppressed - feature row expanded from 5 to 6 (BRK strategy toggle added) */
   int rowY2 = rowY + bh + 4;
   int fw = (innerW - cGap * 5) / 6;   // v3.30 ADDITIVE
   int fwLast = innerW - fw * 5 - cGap * 5;   // v3.30 ADDITIVE
   bx = x0 + 8;
   ProButton(g_btnCRT, bx, rowY2, fw, bh, (g_useCRT ? "CRT ON" : "CRT OFF"), (g_useCRT ? up : offc), clrWhite, g_proFont - 1);
   bx += fw + cGap;
   ProButton(g_btnBreakout, bx, rowY2, fw, bh, (g_useBreakout ? "BRK ON" : "BRK OFF"), (g_useBreakout ? up : offc), clrWhite, g_proFont - 1);   // v3.30 ADDITIVE
   bx += fw + cGap;
   ProButton(g_btnFVG, bx, rowY2, fw, bh, (g_useFVG ? "FVG ON" : "FVG OFF"), (g_useFVG ? up : offc), clrWhite, g_proFont - 1);
   bx += fw + cGap;
   ProButton(g_btnBZ, bx, rowY2, fw, bh, (g_showBreakZone ? "ZONE ON" : "ZONE OFF"), (g_showBreakZone ? up : offc), clrWhite, g_proFont - 1);
   bx += fw + cGap;
   ProButton(g_btnRisk, bx, rowY2, fw, bh, (g_riskEnabled ? "RISK ON" : "RISK OFF"), (g_riskEnabled ? up : offc), clrWhite, g_proFont - 1);
   bx += fw + cGap;
   ProButton(g_btnTrail, bx, rowY2, fwLast, bh, (g_useTrailing ? "TRAIL ON" : "TRAIL OFF"), (g_useTrailing ? up : offc), clrWhite, g_proFont - 1);

   // v3.00 ADDITIVE: filter & threshold control row - full runtime control, no restarts
   int rowY3 = rowY2 + bh + 4;
   int gw = (innerW - cGap * 5) / 6;
   int gwLast = innerW - gw * 5 - cGap * 5;
   bx = x0 + 8;
   ProButton(g_btnNews, bx, rowY3, gw, bh, (g_useNewsFilter ? "NEWS ON" : "NEWS OFF"), (g_useNewsFilter ? up : offc), clrWhite, g_proFont - 1);
   bx += gw + cGap;
   ProButton(g_btnSession, bx, rowY3, gw, bh, (g_useSessionFilter ? "SESS ON" : "SESS OFF"), (g_useSessionFilter ? up : offc), clrWhite, g_proFont - 1);
   bx += gw + cGap;
   ProButton(g_btnBE, bx, rowY3, gw, bh, (g_useBreakEven ? "BE ON" : "BE OFF"), (g_useBreakEven ? up : offc), clrWhite, g_proFont - 1);
   bx += gw + cGap;
   ProButton(g_btnPTP, bx, rowY3, gw, bh, (g_usePartialTP ? "PART ON" : "PART OFF"), (g_usePartialTP ? up : offc), clrWhite, g_proFont - 1);
   bx += gw + cGap;
   ProButton(g_btnThrMinus, bx, rowY3, gw, bh, "THR -", offc, clrWhite, g_proFont - 1);
   bx += gw + cGap;
   ProButton(g_btnThrPlus, bx, rowY3, gwLast, bh, "THR + (" + IntegerToString(g_threshold) + ")", accent, clrWhite, g_proFont - 1);

   /* v3.20 suppressed - appearance row expanded from 2 to 4 buttons */
   // v3.20 ADDITIVE: appearance + strategy row (BG, CANDLES, KEY LEVELS, CRT TARGET)
   int rowY4 = rowY3 + bh + 4;
   int qw = (innerW - cGap * 3) / 4;
   int qwLast = innerW - qw * 3 - cGap * 3;
   bx = x0 + 8;
   ProButton(g_btnBgTheme, bx, rowY4, qw, bh, "BG: " + BgThemeName(g_bgThemeIdx), (color)C'52,60,86', clrWhite, g_proFont - 1);
   bx += qw + cGap;
   ProButton(g_btnCandleTheme, bx, rowY4, qw, bh, "CNDL: " + CandleThemeName(g_candleThemeIdx), (color)C'52,60,86', clrWhite, g_proFont - 1);
   bx += qw + cGap;
   ProButton(g_btnLevels, bx, rowY4, qw, bh, (g_showKeyLevels ? "LEVELS ON" : "LEVELS OFF"), (g_showKeyLevels ? up : offc), clrWhite, g_proFont - 1);
   bx += qw + cGap;
   ProButton(g_btnCrtTp, bx, rowY4, qwLast, bh, (g_useCrtTarget ? "CRT-TP ON" : "RR-TP"), (g_useCrtTarget ? up : warn), clrWhite, g_proFont - 1);

   ProShowObj(g_btnOpenTrade, true);
   ProShowObj(g_btnHideShow, true);
   ProShowObj(g_btnSmall, true);
   ProShowObj(g_btnNormal, true);
   ProShowObj(g_btnBig, true);
   ProShowObj(g_btnFull, true);
   ProShowObj(g_btnEA, true);
   ProShowObj(g_btnCRT, true);
   ProShowObj(g_btnFVG, true);
   ProShowObj(g_btnBZ, true);
   ProShowObj(g_btnMode, true);
   ProShowObj(g_btnRisk, true);
   ProShowObj(g_btnTrail, true);
   ProShowObj(g_btnCloseAll, true);
   ProShowObj(g_btnNews, true);       // v3.00 ADDITIVE
   ProShowObj(g_btnSession, true);    // v3.00 ADDITIVE
   ProShowObj(g_btnBE, true);         // v3.00 ADDITIVE
   ProShowObj(g_btnPTP, true);        // v3.00 ADDITIVE
   ProShowObj(g_btnThrMinus, true);   // v3.00 ADDITIVE
   ProShowObj(g_btnThrPlus, true);    // v3.00 ADDITIVE
   ProShowObj(g_btnBgTheme, true);     // v3.10 ADDITIVE
   ProShowObj(g_btnCandleTheme, true); // v3.10 ADDITIVE
   ProShowObj(g_btnLevels, true);      // v3.20 ADDITIVE
   ProShowObj(g_btnCrtTp, true);       // v3.20 ADDITIVE
   ProShowObj(g_btnBreakout, true);    // v3.30 ADDITIVE
   ProShowObj(g_btnManBuy, true);      // v3.30 ADDITIVE
   ProShowObj(g_btnManSell, true);     // v3.30 ADDITIVE
}

//+------------------------------------------------------------------+
void ProDashUpdate()
{
   if(g_fastTester)
      return;   // v3.41 ADDITIVE
   if(!InpShowDashboard)
   {
      ProDashDeleteAll();
      return;
   }

   ProDashEnsure();
   if(!g_dashboardVisible)
      return;

   color bgPanel, bgHeader, bgCard, brd, accent, txtMain, txtMuted, up, dn, warn, offc;
   ProTheme(bgPanel, bgHeader, bgCard, brd, accent, txtMain, txtMuted, up, dn, warn, offc);

   int x0 = g_proX;
   int y0 = g_proY;
   int w  = g_proW;
   int innerW = w - 16;
   int cGap = 4;
   int lineH = g_proFont + 6;

   // live data
   int scoreBuy = 0, scoreSell = 0, threshold = 0;
   bool newsRisk = false;
   int signal = ComputeCompositeSignal(_Symbol, scoreBuy, scoreSell, threshold, newsRisk);
   BiasSnapshot bias = GetBiasSnapshot(_Symbol);
   int amdH1 = DetectAMD(_Symbol, InpAmdTF_H1);
   int amdM15 = DetectAMD(_Symbol, InpAmdTF_M15);
   int amdNet = (amdH1 != SIGNAL_NONE ? amdH1 : amdM15);
   // int crtExec = (g_useCRT ? DetectCRT(_Symbol, InpCrtExecTF, InpCRTLookbackBars) : SIGNAL_NONE); // v3.10 suppressed
   int crtExec = (g_useCRT ? DetectCRT_HTF(_Symbol) : SIGNAL_NONE);   // v3.10 ADDITIVE
   int brkExec = (g_useBreakout ? DetectBreakout_HTF(_Symbol) : SIGNAL_NONE);   // v3.30 ADDITIVE
   int fvg = ((InpUseFVGConfirm && g_useFVG) ? DetectFVG(_Symbol, InpConfirmTF) : SIGNAL_NONE);
   int sweep = (InpUseLiquiditySweepConfirm ? DetectLiquiditySweep(_Symbol, InpConfirmTF) : SIGNAL_NONE);
   double dayPnl = GetTodayClosedPnL();
   int cooldownLeft = GetCooldownRemainingSeconds();

   // ------- KPI cards -------
   // int kpiY = y0 + 30 + 6 + 22 + 4 + 22 + 8; // v3.00 suppressed
   // int kpiY = y0 + 30 + 6 + 22 + 4 + 22 + 4 + 22 + 8; // v3.10 suppressed
   int kpiY = y0 + 30 + 6 + 22 + 4 + 22 + 4 + 22 + 4 + 22 + 8;   // v3.10 ADDITIVE: accounts for theme row
   int kpiH = 44;
   int kw = (innerW - cGap * 3) / 4;
   int kwLast = innerW - kw * 3 - cGap * 3;
   int kx = x0 + 8;

   ProRect(g_proKpiBox0, kx, kpiY, kw, kpiH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proKpiLab0, kx + 8, kpiY + 5, "EQUITY", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proKpiVal0, kx + 8, kpiY + 5 + lineH - 2,
           DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2), txtMain, g_proFont + 2, 90, "Segoe UI Semibold");
   kx += kw + cGap;
   ProRect(g_proKpiBox1, kx, kpiY, kw, kpiH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proKpiLab1, kx + 8, kpiY + 5, "DAY P/L", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proKpiVal1, kx + 8, kpiY + 5 + lineH - 2,
           DoubleToString(dayPnl, 2), (dayPnl > 0.0 ? up : (dayPnl < 0.0 ? dn : txtMain)), g_proFont + 2, 90, "Segoe UI Semibold");
   kx += kw + cGap;
   ProRect(g_proKpiBox2, kx, kpiY, kw, kpiH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proKpiLab2, kx + 8, kpiY + 5, "TRADES TODAY", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proKpiVal2, kx + 8, kpiY + 5 + lineH - 2,
           IntegerToString(GetTodayEntryCount()) + " / " + IntegerToString(InpMaxTradesPerDay), txtMain, g_proFont + 2, 90, "Segoe UI Semibold");
   kx += kw + cGap;
   ProRect(g_proKpiBox3, kx, kpiY, kwLast, kpiH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proKpiLab3, kx + 8, kpiY + 5, "OPEN POS", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proKpiVal3, kx + 8, kpiY + 5 + lineH - 2,
           IntegerToString(GetOpenPositionCountForEA()) + " / " + IntegerToString(InpMaxConcurrentPositions), txtMain, g_proFont + 2, 90, "Segoe UI Semibold");

   // ------- v3.20 ADDITIVE: PERFORMANCE cards (the EA's own closed trades, this magic number) -------
   RefreshPerformanceStats();
   int perfY = kpiY + kpiH + 8;
   int perfH = 44;
   kx = x0 + 8;
   ProRect(g_proPerfBox0, kx, perfY, kw, perfH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proPerfLab0, kx + 8, perfY + 5, "WIN RATE", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proPerfVal0, kx + 8, perfY + 5 + lineH - 2,
           (g_statTrades > 0 ? DoubleToString(g_statWR, 1) + "%  (" + IntegerToString(g_statTrades) + ")" : "NO TRADES"),
           txtMain, g_proFont + 2, 90, "Segoe UI Semibold");
   kx += kw + cGap;
   ProRect(g_proPerfBox1, kx, perfY, kw, perfH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proPerfLab1, kx + 8, perfY + 5, "NET P/L (ALL)", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proPerfVal1, kx + 8, perfY + 5 + lineH - 2, DoubleToString(g_statNet, 2),
           (g_statNet > 0.0 ? up : (g_statNet < 0.0 ? dn : txtMain)), g_proFont + 2, 90, "Segoe UI Semibold");
   kx += kw + cGap;
   ProRect(g_proPerfBox2, kx, perfY, kw, perfH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proPerfLab2, kx + 8, perfY + 5, "PROFIT FACTOR", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proPerfVal2, kx + 8, perfY + 5 + lineH - 2,
           (g_statTrades > 0 ? DoubleToString(g_statPF, 2) : "-"),
           (g_statPF >= 1.0 ? up : dn), g_proFont + 2, 90, "Segoe UI Semibold");
   kx += kw + cGap;
   ProRect(g_proPerfBox3, kx, perfY, kwLast, perfH, (color)ColorToARGB((color)C'19,28,48',235), brd, 60);
   ProText(g_proPerfLab3, kx + 8, perfY + 5, "BEST DAY / HOURS", txtMuted, g_proFont - 2, 90, "Segoe UI");
   ProText(g_proPerfVal3, kx + 8, perfY + 5 + lineH - 2,
           (g_bestDay >= 0 ? DayNameShort(g_bestDay) + "  " + HourBucketText(g_bestHr) : "COLLECTING..."),
           clrGold, g_proFont + 1, 90, "Segoe UI Semibold");

   // ------- signal card -------
   // int sigY = kpiY + kpiH + 8; // v3.20 suppressed - performance row inserted above
   int sigY = perfY + perfH + 8;   // v3.20 ADDITIVE
   int sigH = 54;
   color sigClr = warn;
   if(signal == SIGNAL_BUY)  sigClr = up;
   if(signal == SIGNAL_SELL) sigClr = dn;
   ProRect(g_proSigBox, x0 + 8, sigY, innerW, sigH, (color)ColorToARGB((color)C'19,28,48',235), sigClr, 60);
   ProText(g_proSigTxt, x0 + 18, sigY + 8, "SIGNAL:  " + SignalText(signal), sigClr, g_proFont + 4, 90, "Segoe UI Semibold");
   // v3.30 ADDITIVE: SETUP indicator - which strategy is firing right now
   string setupTxt = "NO SETUP";
   if(crtExec != SIGNAL_NONE) setupTxt = "CRT-REJECT " + SignalText(crtExec);
   else if(brkExec != SIGNAL_NONE) setupTxt = "BREAKOUT " + SignalText(brkExec);
   // v3.40 ADDITIVE: clip the sub-line to the card's left half so it never overlaps the score bars
   int maxSubChars = (int)MathMax(22, ((g_proW / 2) - 26) * 10 / (g_proFont * 6));
   // v3.51 ADDITIVE: live A/B/C setup grade on the SETUP line
   int dashGrade = ComputeSetupGrade(_Symbol, signal, (signal == SIGNAL_BUY ? scoreBuy : scoreSell), threshold);
   string gradeTag = ((InpUseQualityGrade && signal != SIGNAL_NONE) ? " | GRADE " + GradeText(dashGrade) : "");
   /* v3.51 suppressed - sub-line upgraded to carry the setup grade
   ProText(g_proSigSub, x0 + 18, sigY + 8 + lineH + 6,
           ClipText(_Symbol + " | SETUP: " + setupTxt + " | THR " + IntegerToString(threshold) + (newsRisk ? " | NEWS RISK" : ""), maxSubChars),
           txtMuted, g_proFont - 1, 90, "Segoe UI"); */
   ProText(g_proSigSub, x0 + 18, sigY + 8 + lineH + 6,
           ClipText(_Symbol + " | SETUP: " + setupTxt + gradeTag + " | THR " + IntegerToString(threshold) + (newsRisk ? " | NEWS RISK" : ""), maxSubChars),
           txtMuted, g_proFont - 1, 90, "Segoe UI");   // v3.51 ADDITIVE

   // score bars (right half of the signal card)
   int barMax = (int)MathMax(60, innerW / 2 - 90);
   int barX = x0 + 8 + innerW - barMax - 16;
   int barBY = sigY + 12;
   int barSY = sigY + 32;
   int bFill = (int)MathMax(2, MathMin(barMax, barMax * scoreBuy / 6.0));
   int sFill = (int)MathMax(2, MathMin(barMax, barMax * scoreSell / 6.0));
   ProText(g_proBarBLab, barX - 46, barBY - 2, "BUY " + IntegerToString(scoreBuy), up, g_proFont - 1, 90, "Segoe UI Semibold");
   ProRect(g_proBarBBg, barX, barBY, barMax, 9, (color)C'28,38,60', (color)C'28,38,60', 70);
   ProRect(g_proBarBFg, barX, barBY, bFill, 9, up, up, 80);
   ProText(g_proBarSLab, barX - 46, barSY - 2, "SELL " + IntegerToString(scoreSell), dn, g_proFont - 1, 90, "Segoe UI Semibold");
   ProRect(g_proBarSBg, barX, barSY, barMax, 9, (color)C'28,38,60', (color)C'28,38,60', 70);
   ProRect(g_proBarSFg, barX, barSY, sFill, 9, dn, dn, 80);

   // ------- confluence chips -------
   // int chipY = sigY + sigH + 8; // v3.00 suppressed - position card now sits between signal and chips
   // v3.00 ADDITIVE: LIVE POSITION CARD - direction, lots, P/L, RR progress toward target
   int posY = sigY + sigH + 8;
   int posH = 30;
   bool havePos = false;
   string posTxt = "NO OPEN POSITION";
   double posRR = 0.0;
   double posTargetRR = GetEffectiveRiskReward(_Symbol);
   color posClr = txtMuted;
   int totalP = PositionsTotal();
   for(int pi = totalP - 1; pi >= 0; --pi)
   {
      ulong ptk = PositionGetTicket(pi);
      if(ptk == 0 || !PositionSelectByTicket(ptk))
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagicNumber)
         continue;
      string psym = PositionGetString(POSITION_SYMBOL);
      int ptyp = (int)PositionGetInteger(POSITION_TYPE);
      double pop = PositionGetDouble(POSITION_PRICE_OPEN);
      double pvol = PositionGetDouble(POSITION_VOLUME);
      double ppl = PositionGetDouble(POSITION_PROFIT);
      double psl = PositionGetDouble(POSITION_SL);
      int prisk = ParseRiskPointsFromComment(PositionGetString(POSITION_COMMENT));
      if(prisk <= 0 && psl > 0.0)
      {
         double ppnt = SymbolInfoDouble(psym, SYMBOL_POINT);
         if(ppnt > 0.0)
            prisk = (int)MathRound(MathAbs(pop - psl) / ppnt);
      }
      posRR = PositionRR(psym, ptyp, pop, prisk);
      posTargetRR = GetEffectiveRiskReward(psym);
      // v3.51 ADDITIVE: live exit-engine state - watch the validated trail doing its work in real time
      string trailState = "RISK ON";
      if(InpUseTrailingStop && g_useTrailing && posRR >= InpTrailStartRR) trailState = "TRAIL ACTIVE";
      else if(InpUseBreakEven && posRR >= InpBreakEvenAtRR)               trailState = "BE ARMED";
      /* v3.51 suppressed - upgraded to include the live trail state
      posTxt = psym + "  " + (ptyp == POSITION_TYPE_BUY ? "BUY " : "SELL ") + DoubleToString(pvol, 2) +
               " @ " + DoubleToString(pop, (int)SymbolInfoInteger(psym, SYMBOL_DIGITS)) +
               "    P/L " + DoubleToString(ppl, 2) +
               "    RR " + DoubleToString(posRR, 2) + " / " + DoubleToString(posTargetRR, 1); */
      posTxt = psym + "  " + (ptyp == POSITION_TYPE_BUY ? "BUY " : "SELL ") + DoubleToString(pvol, 2) +
               " @ " + DoubleToString(pop, (int)SymbolInfoInteger(psym, SYMBOL_DIGITS)) +
               "    P/L " + DoubleToString(ppl, 2) +
               "    RR " + DoubleToString(posRR, 2) + "/" + DoubleToString(posTargetRR, 1) +
               "  | " + trailState;   // v3.51 ADDITIVE
      posClr = (ppl > 0.0 ? up : (ppl < 0.0 ? dn : txtMain));
      havePos = true;
      break;
   }
   ProRect(g_proPosBox, x0 + 8, posY, innerW, posH, (color)ColorToARGB((color)C'19,28,48', 235), (havePos ? posClr : brd), 60);
   ProText(g_proPosTxt, x0 + 18, posY + 6, posTxt, posClr, g_proFont - 1, 90, "Segoe UI Semibold");
   int pbarMax = innerW - 36;
   int pbarY = posY + posH - 7;
   double pfrac = (havePos && posTargetRR > 0.0 ? MathMax(0.0, MathMin(1.0, posRR / posTargetRR)) : 0.0);
   ProRect(g_proPosBarBg, x0 + 18, pbarY, pbarMax, 4, (color)C'28,38,60', (color)C'28,38,60', 70);
   ProRect(g_proPosBarFg, x0 + 18, pbarY, (int)MathMax(1, pbarMax * pfrac), 4,
           (havePos ? posClr : (color)C'28,38,60'), (havePos ? posClr : (color)C'28,38,60'), 80);

   // ------- v3.51 ADDITIVE: CONFIG SENTRY row - the dashboard audits its own inputs -------
   int qY = posY + posH + 8;
   int qH = 22;
   if(InpShowConfigSentry)
      ValidateConfigSentry();   // throttled internally to 60s
   color cfgClr = (g_cfgSentryOK ? up : warn);
   string cfgShow = (InpShowConfigSentry ? g_cfgSentryMsg : "CONFIG SENTRY OFF");
   if(!InpShowConfigSentry) cfgClr = txtMuted;
   ProRect(g_proCfgBox, x0 + 8, qY, innerW, qH, (color)ColorToARGB((color)C'19,28,48', 235), cfgClr, 60);
   int maxCfgChars = (int)MathMax(40, (g_proW - 24) * 10 / (g_proFont * 6));
   ProText(g_proCfgTxt, x0 + 18, qY + 4, ClipText(cfgShow, maxCfgChars), cfgClr, g_proFont - 1, 90, "Segoe UI Semibold");

   // ------- v3.51 ADDITIVE: EDGE STATS row - direction split + rolling last-20 + daily loss limit -------
   int edgeY = qY + qH + 4;
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double dayLossPct = ((dayPnl < 0.0 && eq > 0.0) ? (-dayPnl / eq) * 100.0 : 0.0);
   string edgeTxt = "EDGE  ";
   if(g_edgeBuyTot + g_edgeSellTot > 0)
   {
      edgeTxt += "BUY " + (g_edgeBuyTot > 0 ? DoubleToString(g_edgeBuyWin * 100.0 / g_edgeBuyTot, 0) + "% (" + IntegerToString(g_edgeBuyTot) + ")" : "-") +
                 "  |  SELL " + (g_edgeSellTot > 0 ? DoubleToString(g_edgeSellWin * 100.0 / g_edgeSellTot, 0) + "% (" + IntegerToString(g_edgeSellTot) + ")" : "-") +
                 "  |  L20 " + DoubleToString(g_edgeL20WR, 0) + "% " + (g_edgeL20Net >= 0.0 ? "+" : "") + DoubleToString(g_edgeL20Net, 2);
   }
   else
      edgeTxt += "COLLECTING...";
   edgeTxt += "  |  DAYLIM " + DoubleToString(dayLossPct, 1) + "/" + DoubleToString(InpMaxDailyLossPercent, 1) + "%";
   color edgeClr = (dayLossPct >= InpMaxDailyLossPercent ? dn : (dayLossPct >= InpMaxDailyLossPercent * 0.75 ? warn : (color)C'120,220,170'));
   ProText(g_proEdgeTxt, x0 + 10, edgeY, ClipText(edgeTxt, maxCfgChars), edgeClr, g_proFont - 1, 90, "Segoe UI");

   // int chipY = posY + posH + 8;   // v3.00 ADDITIVE  // v3.51 suppressed - sentry + edge rows now sit above the chips
   int chipY = edgeY + lineH + 8;   // v3.51 ADDITIVE
   int chipH = 22;
   int cw = (innerW - cGap * 6) / 7;
   int cwLast = innerW - cw * 6 - cGap * 6;
   int cx = x0 + 8;

   string chipNames[7];
   chipNames[0] = "D1";  chipNames[1] = "H4";  chipNames[2] = "H1";
   chipNames[3] = "AMD"; chipNames[4] = "CRT"; chipNames[5] = "FVG"; chipNames[6] = "SWP";
   int chipVals[7];
   chipVals[0] = bias.d1; chipVals[1] = bias.h4; chipVals[2] = bias.h1;
   chipVals[3] = amdNet;  chipVals[4] = crtExec; chipVals[5] = fvg;  chipVals[6] = sweep;
   string chipBoxes[7];
   chipBoxes[0] = g_proChipBox0; chipBoxes[1] = g_proChipBox1; chipBoxes[2] = g_proChipBox2;
   chipBoxes[3] = g_proChipBox3; chipBoxes[4] = g_proChipBox4; chipBoxes[5] = g_proChipBox5; chipBoxes[6] = g_proChipBox6;
   string chipTexts[7];
   chipTexts[0] = g_proChipTxt0; chipTexts[1] = g_proChipTxt1; chipTexts[2] = g_proChipTxt2;
   chipTexts[3] = g_proChipTxt3; chipTexts[4] = g_proChipTxt4; chipTexts[5] = g_proChipTxt5; chipTexts[6] = g_proChipTxt6;

   for(int i = 0; i < 7; ++i)
   {
      int cwUse = (i == 6 ? cwLast : cw);
      color cc = offc;
      if(chipVals[i] > 0) cc = up;
      else if(chipVals[i] < 0) cc = dn;
      // ProRect(chipBoxes[i], cx, chipY, cwUse, chipH, (color)ColorToARGB(cc, 60), cc, 60); // v2.10 suppressed - washed out
      // v2.10 ADDITIVE: solid, high-contrast chips - active = solid signal color + white text, neutral = dark slate + muted text
      color chipBg  = (chipVals[i] == 0 ? (color)C'30,40,62' : cc);
      color chipTxt = (chipVals[i] == 0 ? txtMuted : clrWhite);
      ProRect(chipBoxes[i], cx, chipY, cwUse, chipH, chipBg, chipBg, 60);
      int chipTxtX = cx + (int)MathMax(4, (cwUse - StringLen(chipNames[i]) * (g_proFont - 2)) / 2);
      ProText(chipTexts[i], chipTxtX, chipY + 4, chipNames[i], chipTxt, g_proFont - 1, 90, "Segoe UI Semibold");
      cx += cwUse + cGap;
   }

   // ------- info + universe + footer -------
   int infoY = chipY + chipH + 8;
   int cdMin = cooldownLeft / 60;
   int cdSec = cooldownLeft % 60;
   /* v3.00 suppressed - upgraded to live spread + news reason + auto-engine status
   string info1 = "SESSION ..." ;
   string info2 = "BIAS ..." ; */
   double curBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);          // v3.00 ADDITIVE
   double curAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double curPnt = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int curSpread = ((curPnt > 0.0 && curBid > 0.0 && curAsk > 0.0) ? (int)((curAsk - curBid) / curPnt) : 0);
   if(curSpread > 0)
      UpdateSpreadEma(_Symbol, (double)curSpread);   // v3.40 ADDITIVE: continuous sampling
   int maxSpreadEff = EffectiveMaxSpreadPoints(_Symbol);
   string spreadTag = (curSpread > maxSpreadEff ? "  << BLOCKING" : "  OK");
   /* v3.40 suppressed - long labels clipped off the panel edge ("COOLDO...")
   string info1 = "SPREAD ..." + "SESSION ..." + "COOLDOWN ..." + "NEWS ..."; */
   string info1 = "SPR " + IntegerToString(curSpread) + "/" + IntegerToString(maxSpreadEff) + spreadTag +
                  "  |  SESS " + (SessionAllowedNow() ? "OPEN" : "CLOSED") +
                  "  |  CD " + IntegerToString(cdMin) + "m" + IntegerToString(cdSec) + "s" +
                  "  |  NEWS " + NewsReasonText(_Symbol);   // v3.40 ADDITIVE: compact tokens, fits on one line
   int symDigits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);   // v3.10 ADDITIVE
   string info2 = "AUTO:  " + g_autoStatus +
                  "   |   BIAS " + BiasText(bias.net) +
                  "   |   CRT[H4] " + DoubleToString(iHigh(_Symbol, InpCrtRangeTF, 1), symDigits) + " / " + DoubleToString(iLow(_Symbol, InpCrtRangeTF, 1), symDigits) +   // v3.10 ADDITIVE: the live CRT hunting range
                  "   |   RR " + DoubleToString(GetEffectiveRiskReward(_Symbol), 1);
   // v2.01: suppressed - unclipped text could spill past the panel edge
   // ProText(g_proInfo1, x0 + 10, infoY, info1, txtMuted, g_proFont - 1, 90, "Segoe UI");
   // ProText(g_proInfo2, x0 + 10, infoY + lineH + 2, info2, txtMuted, g_proFont - 1, 90, "Segoe UI");
   // int maxInfoChars = (int)MathMax(28, g_proW / (g_proFont - 2)); // v2.10 suppressed - underestimated fit, clipped "NEWS HIGH"
   int maxInfoChars = (int)MathMax(40, (g_proW - 24) * 10 / (g_proFont * 6));   // v2.10 ADDITIVE: Segoe UI avg char ~= 0.6 * fontsize
   ProText(g_proInfo1, x0 + 10, infoY, ClipText(info1, maxInfoChars), txtMuted, g_proFont - 1, 90, "Segoe UI");
   ProText(g_proInfo2, x0 + 10, infoY + lineH + 2, ClipText(info2, maxInfoChars), txtMuted, g_proFont - 1, 90, "Segoe UI");

   string uniTxt = "UNIVERSE:  ";
   int nSyms = ArraySize(g_scanSymbols);
   int maxItems = 2;
   if(g_dashSizeMode == 2) maxItems = 3;
   else if(g_dashSizeMode == 3) maxItems = 5;
   int limit = (int)MathMin(nSyms, maxItems);
   for(int i = 0; i < limit; ++i)
   {
      if(i > 0) uniTxt += "  ||  ";
      uniTxt += BuildSymbolDashboardStatus(g_scanSymbols[i], true);
   }
   if(nSyms > limit)
      uniTxt += "  ||  +" + IntegerToString(nSyms - limit);
   int uniY = infoY + (lineH + 2) * 2 + 2;
   // int maxUniChars = (int)MathMax(28, g_proW / (g_proFont - 2)); // v2.10 suppressed
   int maxUniChars = (int)MathMax(40, (g_proW - 24) * 10 / (g_proFont * 6));   // v2.10 ADDITIVE
   ProText(g_proUni, x0 + 10, uniY, ClipText(uniTxt, maxUniChars), (color)C'120,220,170', g_proFont - 1, 90, "Segoe UI");

   int footY = uniY + lineH + 4;
   // int maxFootChars = (int)MathMax(28, g_proW / (g_proFont - 2)); // v2.10 suppressed
   int maxFootChars = (int)MathMax(40, (g_proW - 24) * 10 / (g_proFont * 6));   // v2.10 ADDITIVE
   // v3.20 ADDITIVE: DECISION LOG - every action & key auto event, last 3 lines
   if(g_uiLastAction != g_prevUiAction)
   {
      LogEvent(g_uiLastAction);
      g_prevUiAction = g_uiLastAction;
   }
   if(g_autoStatus != g_prevAutoStatus)
   {
      if(StringFind(g_autoStatus, "TRADE OPENED") == 0 || StringFind(g_autoStatus, "ORDER FAILED") == 0 || StringFind(g_autoStatus, "BLOCKED") == 0)
         LogEvent(g_autoStatus);
      g_prevAutoStatus = g_autoStatus;
   }
   // v3.20 suppressed: single LAST line upgraded to 3-line log
   // ProText(g_proFooter, x0 + 10, footY, ClipText("LAST:  " + g_uiLastAction, maxFootChars), clrGold, g_proFont - 1, 90, "Segoe UI");
   ProText(g_proFooter, x0 + 10, footY, ClipText((g_logLines[0] == "" ? "LOG:  READY" : g_logLines[0]), maxFootChars), clrGold, g_proFont - 1, 90, "Segoe UI");
   ProText(g_proLog1, x0 + 10, footY + lineH + 2, ClipText(g_logLines[1], maxFootChars), txtMuted, g_proFont - 1, 90, "Segoe UI");
   ProText(g_proLog2, x0 + 10, footY + (lineH + 2) * 2, ClipText(g_logLines[2], maxFootChars), txtMuted, g_proFont - 1, 90, "Segoe UI");
   ChartRedraw(0);   // v2.10 ADDITIVE: keep panel state visually fresh even on quiet markets
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| v3.20 ADDITIVE ENGINE: settings memory, decision log, performance |
//| analytics, key-level engine                                       |
//+------------------------------------------------------------------+
string GvName(const string key)
{
   return "CRTAMD_" + IntegerToString((int)InpMagicNumber) + "_" + key;
}

//+------------------------------------------------------------------+
void SaveSettings()
{
   GlobalVariableSet(GvName("THR"), g_threshold);
   GlobalVariableSet(GvName("NEWS"), g_useNewsFilter ? 1 : 0);
   GlobalVariableSet(GvName("SESS"), g_useSessionFilter ? 1 : 0);
   GlobalVariableSet(GvName("BE"), g_useBreakEven ? 1 : 0);
   GlobalVariableSet(GvName("PTP"), g_usePartialTP ? 1 : 0);
   GlobalVariableSet(GvName("CRT"), g_useCRT ? 1 : 0);
   GlobalVariableSet(GvName("FVG"), g_useFVG ? 1 : 0);
   GlobalVariableSet(GvName("BZ"), g_showBreakZone ? 1 : 0);
   GlobalVariableSet(GvName("AUTO"), g_autoMode ? 1 : 0);
   GlobalVariableSet(GvName("RISK"), g_riskEnabled ? 1 : 0);
   GlobalVariableSet(GvName("TRAIL"), g_useTrailing ? 1 : 0);
   GlobalVariableSet(GvName("BGTH"), g_bgThemeIdx);
   GlobalVariableSet(GvName("CNTH"), g_candleThemeIdx);
   GlobalVariableSet(GvName("SIZE"), g_dashSizeMode);
   GlobalVariableSet(GvName("LVLS"), g_showKeyLevels ? 1 : 0);
   GlobalVariableSet(GvName("CRTTP"), g_useCrtTarget ? 1 : 0);
   GlobalVariableSet(GvName("BRK"), g_useBreakout ? 1 : 0);   // v3.30 ADDITIVE
}

//+------------------------------------------------------------------+
void LoadSettings()
{
   if(GlobalVariableCheck(GvName("THR")))   g_threshold = (int)MathMax(1, MathMin(7, GlobalVariableGet(GvName("THR"))));
   if(GlobalVariableCheck(GvName("NEWS")))  g_useNewsFilter = (GlobalVariableGet(GvName("NEWS")) > 0.5);
   if(GlobalVariableCheck(GvName("SESS")))  g_useSessionFilter = (GlobalVariableGet(GvName("SESS")) > 0.5);
   if(GlobalVariableCheck(GvName("BE")))    g_useBreakEven = (GlobalVariableGet(GvName("BE")) > 0.5);
   if(GlobalVariableCheck(GvName("PTP")))   g_usePartialTP = (GlobalVariableGet(GvName("PTP")) > 0.5);
   if(GlobalVariableCheck(GvName("CRT")))   g_useCRT = (GlobalVariableGet(GvName("CRT")) > 0.5);
   if(GlobalVariableCheck(GvName("FVG")))   g_useFVG = (GlobalVariableGet(GvName("FVG")) > 0.5);
   if(GlobalVariableCheck(GvName("BZ")))    g_showBreakZone = (GlobalVariableGet(GvName("BZ")) > 0.5);
   if(GlobalVariableCheck(GvName("AUTO")))  g_autoMode = (GlobalVariableGet(GvName("AUTO")) > 0.5);
   if(GlobalVariableCheck(GvName("RISK")))  g_riskEnabled = (GlobalVariableGet(GvName("RISK")) > 0.5);
   if(GlobalVariableCheck(GvName("TRAIL"))) g_useTrailing = (GlobalVariableGet(GvName("TRAIL")) > 0.5);
   if(GlobalVariableCheck(GvName("BGTH")))  g_bgThemeIdx = (int)MathMax(0, MathMin(3, GlobalVariableGet(GvName("BGTH"))));
   if(GlobalVariableCheck(GvName("CNTH")))  g_candleThemeIdx = (int)MathMax(0, MathMin(3, GlobalVariableGet(GvName("CNTH"))));
   if(GlobalVariableCheck(GvName("SIZE")))  g_dashSizeMode = (int)MathMax(0, MathMin(3, GlobalVariableGet(GvName("SIZE"))));
   if(GlobalVariableCheck(GvName("LVLS")))  g_showKeyLevels = (GlobalVariableGet(GvName("LVLS")) > 0.5);
   if(GlobalVariableCheck(GvName("CRTTP"))) g_useCrtTarget = (GlobalVariableGet(GvName("CRTTP")) > 0.5);
   if(GlobalVariableCheck(GvName("BRK")))   g_useBreakout = (GlobalVariableGet(GvName("BRK")) > 0.5);   // v3.30 ADDITIVE
}

//+------------------------------------------------------------------+
void LogEvent(const string txt)
{
   g_logLines[2] = g_logLines[1];
   g_logLines[1] = g_logLines[0];
   g_logLines[0] = TimeToString(TimeCurrent(), TIME_MINUTES) + "  " + txt;
}

//+------------------------------------------------------------------+
string DayNameShort(const int dow)
{
   if(dow == 1) return "MON";
   if(dow == 2) return "TUE";
   if(dow == 3) return "WED";
   if(dow == 4) return "THU";
   if(dow == 5) return "FRI";
   if(dow == 6) return "SAT";
   return "SUN";
}

//+------------------------------------------------------------------+
string HourBucketText(const int hb)
{
   if(hb < 0 || hb > 5) return "";
   return IntegerToString(hb * 4) + "-" + IntegerToString(hb * 4 + 4) + "h";
}

//+------------------------------------------------------------------+
void RefreshPerformanceStats()
{
   datetime now = TimeCurrent();
   if(g_statsLastCalc > 0 && (now - g_statsLastCalc) < 300)
      return;
   g_statsLastCalc = now;

   ArrayInitialize(g_dayNet, 0.0);
   ArrayInitialize(g_dayTot, 0);
   ArrayInitialize(g_dayWin, 0);
   ArrayInitialize(g_hrNet, 0.0);
   ArrayInitialize(g_hrTot, 0);
   g_statTrades = 0; g_statWR = 0.0; g_statNet = 0.0; g_statPF = 0.0;
   g_bestDay = -1; g_bestHr = -1;
   // v3.51 ADDITIVE: reset edge stats + rolling profit collector
   g_edgeBuyTot = 0; g_edgeBuyWin = 0; g_edgeSellTot = 0; g_edgeSellWin = 0;
   g_edgeL20Net = 0.0; g_edgeL20WR = 0.0; g_edgeL20Cnt = 0;
   double edgeProfits[];                        // v3.51 ADDITIVE
   ArrayResize(edgeProfits, 0);                 // v3.51 ADDITIVE

   if(!HistorySelect(0, now))
      return;

   double grossWin = 0.0, grossLoss = 0.0;
   int wins = 0;
   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; ++i)
   {
      ulong dtk = HistoryDealGetTicket(i);
      if(dtk == 0)
         continue;
      if((ulong)HistoryDealGetInteger(dtk, DEAL_MAGIC) != InpMagicNumber)
         continue;
      if(HistoryDealGetInteger(dtk, DEAL_ENTRY) != DEAL_ENTRY_OUT)
         continue;

      double p = HistoryDealGetDouble(dtk, DEAL_PROFIT)
               + HistoryDealGetDouble(dtk, DEAL_SWAP)
               + HistoryDealGetDouble(dtk, DEAL_COMMISSION);
      datetime t = (datetime)HistoryDealGetInteger(dtk, DEAL_TIME);
      MqlDateTime m;
      TimeToStruct(t, m);
      int dow = m.day_of_week;
      int hb = (int)MathMax(0, MathMin(5, m.hour / 4));

      g_statTrades++;
      g_statNet += p;
      if(p > 0.0) { wins++; grossWin += p; }
      else grossLoss += (-p);
      // v3.51 ADDITIVE: direction split - an OUT deal of type SELL closes a BUY position
      int dTyp = (int)HistoryDealGetInteger(dtk, DEAL_TYPE);
      if(dTyp == DEAL_TYPE_SELL)      { g_edgeBuyTot++;  if(p > 0.0) g_edgeBuyWin++;  }
      else if(dTyp == DEAL_TYPE_BUY)  { g_edgeSellTot++; if(p > 0.0) g_edgeSellWin++; }
      int en = ArraySize(edgeProfits);           // v3.51 ADDITIVE: chronological profit trail
      ArrayResize(edgeProfits, en + 1);          // v3.51 ADDITIVE
      edgeProfits[en] = p;                       // v3.51 ADDITIVE
      if(dow >= 0 && dow <= 6)
      {
         g_dayNet[dow] += p;
         g_dayTot[dow]++;
         if(p > 0.0) g_dayWin[dow]++;
      }
      g_hrNet[hb] += p;
      g_hrTot[hb]++;
   }

   if(g_statTrades > 0)
      g_statWR = wins * 100.0 / g_statTrades;
   g_statPF = (grossLoss > 0.0 ? grossWin / grossLoss : (grossWin > 0.0 ? 99.9 : 0.0));

   // v3.51 ADDITIVE: rolling last-20 closed trades - the EA's *current* edge
   int totalE = ArraySize(edgeProfits);
   int fromE = (int)MathMax(0, totalE - 20);
   int l20Wins = 0;
   for(int e = fromE; e < totalE; ++e)
   {
      g_edgeL20Cnt++;
      g_edgeL20Net += edgeProfits[e];
      if(edgeProfits[e] > 0.0) l20Wins++;
   }
   if(g_edgeL20Cnt > 0)
      g_edgeL20WR = l20Wins * 100.0 / g_edgeL20Cnt;

   double bestDayNet = -DBL_MAX;
   for(int d = 0; d < 7; ++d)
   {
      if(g_dayTot[d] > 0 && g_dayNet[d] > bestDayNet)
      {
         bestDayNet = g_dayNet[d];
         g_bestDay = d;
      }
   }
   double bestHrNet = -DBL_MAX;
   for(int h = 0; h < 6; ++h)
   {
      if(g_hrTot[h] > 0 && g_hrNet[h] > bestHrNet)
      {
         bestHrNet = g_hrNet[h];
         g_bestHr = h;
      }
   }
}

//+------------------------------------------------------------------+
int KeyLevelConfluence(const string sym, const int direction)
{
   double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(pt <= 0.0)
      return 0;

   double tol = MathMax(GetAvgM5RangePts(sym) * 0.35, 3.0) * pt;
   double rH = iHigh(sym, InpCrtRangeTF, 1);
   double rL = iLow(sym, InpCrtRangeTF, 1);
   double pdh = iHigh(sym, PERIOD_D1, 1);
   double pdl = iLow(sym, PERIOD_D1, 1);
   double pwh = iHigh(sym, PERIOD_W1, 1);
   double pwl = iLow(sym, PERIOD_W1, 1);

   if(direction == SIGNAL_BUY)
   {
      if(MathAbs(rL - pdl) <= tol || MathAbs(rL - pwl) <= tol)
         return 1;
   }
   else if(direction == SIGNAL_SELL)
   {
      if(MathAbs(rH - pdh) <= tol || MathAbs(rH - pwh) <= tol)
         return 1;
   }
   return 0;
}

//+------------------------------------------------------------------+
void UpdateKeyLevelsVisual()
{
   if(g_fastTester)
      return;   // v3.41 ADDITIVE
   string names[4] = {"CRT_PRO_LVL_PDH", "CRT_PRO_LVL_PDL", "CRT_PRO_LVL_PWH", "CRT_PRO_LVL_PWL"};
   if(!g_showKeyLevels)
   {
      for(int i = 0; i < 4; ++i)
         ObjectDelete(0, names[i]);
      return;
   }

   double vals[4];
   vals[0] = iHigh(_Symbol, PERIOD_D1, 1);
   vals[1] = iLow(_Symbol, PERIOD_D1, 1);
   vals[2] = iHigh(_Symbol, PERIOD_W1, 1);
   vals[3] = iLow(_Symbol, PERIOD_W1, 1);
   string labs[4] = {"PDH", "PDL", "PWH", "PWL"};
   color cols[4] = {clrOrange, clrOrange, clrMediumPurple, clrMediumPurple};
   int styles[4] = {STYLE_DASH, STYLE_DASH, STYLE_DASHDOT, STYLE_DASHDOT};

   for(int i = 0; i < 4; ++i)
   {
      if(vals[i] <= 0.0)
         continue;
      if(ObjectFind(0, names[i]) < 0)
         ObjectCreate(0, names[i], OBJ_HLINE, 0, 0, vals[i]);
      ObjectSetDouble(0, names[i], OBJPROP_PRICE, vals[i]);
      ObjectSetInteger(0, names[i], OBJPROP_COLOR, cols[i]);
      ObjectSetInteger(0, names[i], OBJPROP_STYLE, styles[i]);
      ObjectSetInteger(0, names[i], OBJPROP_WIDTH, 1);
      ObjectSetInteger(0, names[i], OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, names[i], OBJPROP_BACK, true);
      ObjectSetString(0, names[i], OBJPROP_TEXT, labs[i]);
   }
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| v3.30 ADDITIVE: BREAKOUT companion strategy + manual direct trade |
//| CRT trades REJECTION of the H4 range; Breakout trades ACCEPTANCE. |
//| Same levels, opposite logic - together they cover both behaviors. |
//+------------------------------------------------------------------+
int DetectBreakout_HTF(const string sym)
{
   if(Bars(sym, InpCrtRangeTF) < 3 || Bars(sym, InpCrtExecTF) < 3)
      return SIGNAL_NONE;

   double rangeHigh = iHigh(sym, InpCrtRangeTF, 1);
   double rangeLow  = iLow(sym, InpCrtRangeTF, 1);
   if(rangeHigh <= rangeLow)
      return SIGNAL_NONE;
   if(!CrtRangeQualityOK(sym))   // v3.50 ADDITIVE: same quality gate as CRT
      return SIGNAL_NONE;

   double c1 = iClose(sym, InpCrtExecTF, 1);
   double o1 = iOpen(sym, InpCrtExecTF, 1);
   double h1 = iHigh(sym, InpCrtExecTF, 1);
   double l1 = iLow(sym, InpCrtExecTF, 1);
   double body = MathAbs(c1 - o1);
   double rng = (h1 - l1);
   bool strongBody = (rng > 0.0 && (body / rng) >= InpMinBodyRangeRatio);

   // M15 candle opens at/inside the H4 range and closes decisively through it
   bool bullBrk = (c1 > rangeHigh && o1 <= rangeHigh && c1 > o1 && strongBody);
   bool bearBrk = (c1 < rangeLow  && o1 >= rangeLow  && c1 < o1 && strongBody);

   if(bullBrk) return SIGNAL_BUY;
   if(bearBrk) return SIGNAL_SELL;
   return SIGNAL_NONE;
}

//+------------------------------------------------------------------+
void ManualDirectTrade(const int direction)   // v3.30: trader override - EA risk engine, no signal required
{
   if(!g_eaRunning)
   {
      g_uiLastAction = "MANUAL BLOCKED: EA OFF";
      return;
   }
   if(HasOpenPositionForThisEA(_Symbol))
   {
      g_uiLastAction = "MANUAL BLOCKED: POSITION EXISTS";
      return;
   }
   if(GetOpenPositionCountForEA() >= InpMaxConcurrentPositions)
   {
      g_uiLastAction = "MANUAL BLOCKED: MAX POSITIONS";
      return;
   }
   if(g_riskEnabled && !SpreadOK(_Symbol))
   {
      g_uiLastAction = "MANUAL BLOCKED: SPREAD";
      return;
   }

   if(PlaceTrade(_Symbol, direction, GetEffectiveRiskReward(_Symbol)))
   {
      g_uiLastAction = "MANUAL " + SignalText(direction) + " OPENED";
      Print("Manual direct ", SignalText(direction), " opened on ", _Symbol);
   }
   else
   {
      g_uiLastAction = "MANUAL " + SignalText(direction) + " FAILED";
      Print("Manual direct ", SignalText(direction), " failed on ", _Symbol);
   }
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| v3.40 ADDITIVE: broker spread memory                              |
//| Rolling EMA of observed spread per symbol. The spread cap allows  |
//| up to 1.6x the broker's normal spread, so quiet-market range      |
//| compression can never block good entries again.                   |
//+------------------------------------------------------------------+
void UpdateSpreadEma(const string sym, const double spreadPts)
{
   if(spreadPts <= 0.0)
      return;
   for(int i = 0; i < g_sprCount; ++i)
   {
      if(g_sprSym[i] == sym)
      {
         g_sprEma[i] = g_sprEma[i] * 0.97 + spreadPts * 0.03;
         return;
      }
   }
   if(g_sprCount < 16)
   {
      g_sprSym[g_sprCount] = sym;
      g_sprEma[g_sprCount] = spreadPts;
      g_sprCount++;
   }
}

//+------------------------------------------------------------------+
double GetSpreadEma(const string sym)
{
   for(int i = 0; i < g_sprCount; ++i)
   {
      if(g_sprSym[i] == sym)
         return g_sprEma[i];
   }
   return 0.0;
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| v3.50 ADDITIVE: trade-quality engine                              |
//| A. One trade per H4 setup (candle time + direction is consumed)   |
//| B. Range quality gate (0.5x - 2.5x the average H4 range)          |
//+------------------------------------------------------------------+
bool SetupAlreadyTraded(const string sym, const int direction)
{
   datetime h4t = iTime(sym, InpCrtRangeTF, 0);
   if(h4t == 0)
      return false;
   for(int i = 0; i < g_setupCount; ++i)
   {
      if(g_setupSym[i] == sym && g_setupH4[i] == h4t && g_setupDir[i] == direction)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
void MarkSetupTraded(const string sym, const int direction)
{
   datetime h4t = iTime(sym, InpCrtRangeTF, 0);
   if(h4t == 0)
      return;
   // reuse this symbol's slot if present (keeps the array small)
   for(int i = 0; i < g_setupCount; ++i)
   {
      if(g_setupSym[i] == sym)
      {
         g_setupH4[i] = h4t;
         g_setupDir[i] = direction;
         return;
      }
   }
   if(g_setupCount < 16)
   {
      g_setupSym[g_setupCount] = sym;
      g_setupH4[g_setupCount] = h4t;
      g_setupDir[g_setupCount] = direction;
      g_setupCount++;
   }
}

//+------------------------------------------------------------------+
bool CrtRangeQualityOK(const string sym)
{
   double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(pt <= 0.0)
      return false;
   double rngPts = (iHigh(sym, InpCrtRangeTF, 1) - iLow(sym, InpCrtRangeTF, 1)) / pt;
   double avgPts = AverageRangePoints(sym, InpCrtRangeTF, 1, 20);
   if(avgPts <= 0.0)
      return true;   // not enough history to judge - do not block
   // Tester truth: R545-class noise ranges lost instantly (and got the BIGGEST lots via
   // risk sizing), R11945-class outliers produced the -89 worst losses. Trade the middle.
   return (rngPts >= avgPts * 0.5 && rngPts <= avgPts * 2.5);
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| v3.51 ADDITIVE ENGINE: CONFIG SENTRY + SETUP QUALITY GRADE        |
//| Sentry: validates live inputs against the 5-month tested profile  |
//| (XAUUSD TrailRR 1.2 / BTCUSD TrailRR 1.5, risk 0.5%, spread 35,   |
//| sessions 7-12/13-17). Grade: scores each live setup A/B/C.        |
//+------------------------------------------------------------------+
void ValidateConfigSentry()
{
   datetime now = TimeCurrent();
   if(g_cfgSentryLast > 0 && (now - g_cfgSentryLast) < 60)
      return;   // re-audit at most once per minute
   g_cfgSentryLast = now;

   g_cfgSentryOK = true;
   string issues = "";

   // per-symbol validated trail profile (the A/B verdict: gold 1.2, BTC 1.5)
   double expTrail = 0.0;
   if(StringFind(_Symbol, "XAU") >= 0)      expTrail = 1.2;
   else if(StringFind(_Symbol, "BTC") >= 0) expTrail = 1.5;
   if(expTrail > 0.0 && MathAbs(InpTrailStartRR - expTrail) > 0.001)
      issues += "TrailRR " + DoubleToString(InpTrailStartRR, 1) + "<>" + DoubleToString(expTrail, 1) + "  ";

   // shared tested-cell values
   if(MathAbs(InpRiskPercent - 0.5) > 0.001)   issues += "Risk% " + DoubleToString(InpRiskPercent, 2) + "<>0.5  ";
   if(InpUseFixedLot)                          issues += "FIXEDLOT(tested:risk%)  ";
   if(InpMaxSpreadPoints != 35)                issues += "Spread " + IntegerToString(InpMaxSpreadPoints) + "<>35  ";
   if(MathAbs(InpRiskReward - 2.0) > 0.001)    issues += "RR " + DoubleToString(InpRiskReward, 1) + "<>2.0  ";
   if(InpLondonStartHour != 7 || InpLondonEndHour != 12 ||
      InpNewYorkStartHour != 13 || InpNewYorkEndHour != 17) issues += "SESSIONS<>7-12/13-17  ";
   if(!InpUseBreakEven)   issues += "BE OFF  ";
   if(!InpUsePartialTP)   issues += "PTP OFF  ";
   if(!InpUseTrailingStop) issues += "TRAIL OFF  ";

   if(issues == "")
   {
      g_cfgSentryOK = true;
      g_cfgSentryMsg = "CONFIG: VALIDATED  [" + _Symbol + (expTrail > 0.0 ? " trail " + DoubleToString(expTrail, 1) : "") + " profile]";
   }
   else
   {
      g_cfgSentryOK = false;
      g_cfgSentryMsg = "CONFIG DRIFT: " + issues;
   }
}

//+------------------------------------------------------------------+
int ComputeSetupGrade(const string sym, const int direction, const int score, const int threshold)
{
   if(direction == SIGNAL_NONE || !InpUseQualityGrade)
      return 0;
   int q = 0;
   if(score >= threshold + 2)      q += 2;   // strong score margin above the gate
   else if(score >= threshold + 1) q += 1;
   // if(CrtRangeQualityOK(sym))            q += 1; // v3.54 suppressed - ALREADY a hard gate inside DetectCRT_HTF/DetectBreakout_HTF, so always true here
   if(KeyLevelConfluence(sym, direction) > 0) q += 1; // PDH/PDL/PWH/PWL confluence with the idea
   // if(SessionAllowedNow())               q += 1; // v3.54 suppressed - ALREADY a hard gate in EvaluateAndTradeForSymbol, so always true here
   // v3.54: the two suppressed terms put a floor of 2 on q, which made grade C unreachable
   // and InpTradeOnlyAB a no-op filter. q is now 0..3 and every band is reachable.
   // if(q >= 4) return 3;   // v3.54 suppressed - rescaled to the new 0..3 range
   // if(q >= 2) return 2;   // v3.54 suppressed
   if(q >= 3) return 3;   // A: strong margin AND key-level confluence
   if(q >= 1) return 2;   // B: margin above the gate, or confluence
   return 1;              // C: bare threshold, no confluence
}

//+------------------------------------------------------------------+
string GradeText(const int g)
{
   if(g == 3) return "A";
   if(g == 2) return "B";
   if(g == 1) return "C";
   return "-";
}
//+------------------------------------------------------------------+