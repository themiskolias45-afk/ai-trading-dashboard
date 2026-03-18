//+------------------------------------------------------------------+
//|  SmartEntryPro_EA.mq5                                            |
//|  Smart Entry Pro — MT5 Expert Advisor                            |
//|  Connects to the Smart Entry Pro Node.js signal API              |
//|  Supports: BTC, GOLD, SP500, MSFT, AMZN                         |
//|  Features: Auto lot sizing, SL/TP management, confidence filter  |
//+------------------------------------------------------------------+
#property copyright  "Smart Entry Pro"
#property version    "2.00"
#property description "Connects to Smart Entry Pro API and auto-trades based on signals"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- Inputs
input group "=== API CONNECTION ==="
input string   InpApiBase       = "http://localhost:4000";  // API base URL (local or deployed)
input string   InpAsset         = "BTC";                    // Asset: BTC | GOLD | SP500 | MSFT | AMZN
input int      InpRefreshSec    = 30;                       // Signal refresh interval (seconds)

input group "=== SYMBOL MAPPING ==="
input string   InpMtSymbol      = "";      // MT5 symbol (blank = auto-detect from asset)

input group "=== RISK MANAGEMENT ==="
input double   InpRiskPct       = 1.0;     // Risk per trade (% of balance)
input double   InpMinConfidence = 60.0;    // Minimum signal confidence to trade (%)
input int      InpMagicNumber   = 20250101;// EA magic number (unique per EA instance)
input bool     InpEnableTrading = true;    // Enable live order execution
input bool     InpCloseOnHold   = false;   // Close open position when signal turns HOLD

input group "=== TAKE PROFIT SELECTION ==="
input int      InpTPLevel       = 2;       // TP level to use: 1=TP1  2=TP2  3=TP3

input group "=== DISPLAY ==="
input bool     InpShowComment   = true;    // Show signal info in chart comment

//--- Symbol map: API asset ID → default MT5 symbol name
string SYMBOL_MAP[][2] = {
  {"BTC",   "BTCUSD"},
  {"GOLD",  "XAUUSD"},
  {"SP500", "US500"},
  {"MSFT",  "MSFT"},
  {"AMZN",  "AMZN"},
};

//--- Globals
CTrade   g_trade;
string   g_symbol;
datetime g_lastFetch  = 0;
string   g_lastSignal = "";

struct SignalData {
  string signal;      // BUY | SELL | HOLD | ERROR
  string bias;
  string trend;
  double price;
  double entry;
  double sl;
  double tp1;
  double tp2;
  double tp3;
  double rsi;
  double atr;
  double ema9;
  double ema21;
  double confidence;
  bool   valid;
};

//+------------------------------------------------------------------+
//| Expert initialization                                             |
//+------------------------------------------------------------------+
int OnInit() {
  g_trade.SetExpertMagicNumber(InpMagicNumber);
  g_trade.SetDeviationInPoints(20);

  g_symbol = ResolveSymbol();
  if (g_symbol == "") {
    Alert("SmartEntryPro: Cannot determine symbol for asset '", InpAsset, "'");
    return INIT_FAILED;
  }

  if (!SymbolInfoInteger(g_symbol, SYMBOL_SELECT)) {
    Alert("SmartEntryPro: Symbol '", g_symbol, "' not found in Market Watch. Add it first.");
    return INIT_FAILED;
  }

  EventSetTimer(InpRefreshSec);

  Print("=== Smart Entry Pro V2 EA Initialized ===");
  Print("Asset:   ", InpAsset);
  Print("Symbol:  ", g_symbol);
  Print("API:     ", InpApiBase);
  Print("Risk:    ", InpRiskPct, "% | Min Conf: ", InpMinConfidence, "%");
  Print("Trading: ", InpEnableTrading ? "ENABLED" : "DISABLED (simulation)");
  return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
  EventKillTimer();
  Comment("");
}

//+------------------------------------------------------------------+
//| Resolve MT5 symbol from asset ID                                 |
//+------------------------------------------------------------------+
string ResolveSymbol() {
  if (InpMtSymbol != "") return InpMtSymbol;
  int rows = ArrayRange(SYMBOL_MAP, 0);
  for (int i = 0; i < rows; i++) {
    if (SYMBOL_MAP[i][0] == InpAsset) return SYMBOL_MAP[i][1];
  }
  return InpAsset; // fallback: use asset name directly
}

//+------------------------------------------------------------------+
//| Extract a string value from JSON  {"key":"value"}                |
//+------------------------------------------------------------------+
string JsonStr(const string json, const string key) {
  string search = "\"" + key + "\":\"";
  int s = StringFind(json, search);
  if (s < 0) return "";
  s += StringLen(search);
  int e = StringFind(json, "\"", s);
  if (e < 0) return "";
  return StringSubstr(json, s, e - s);
}

//+------------------------------------------------------------------+
//| Extract a number value from JSON  {"key":123.45}                 |
//+------------------------------------------------------------------+
double JsonNum(const string json, const string key) {
  string search = "\"" + key + "\":";
  int s = StringFind(json, search);
  if (s < 0) return 0.0;
  s += StringLen(search);
  string buf = "";
  for (int i = s; i < s + 30 && i < StringLen(json); i++) {
    string c = StringSubstr(json, i, 1);
    if (c == "," || c == "}" || c == " " || c == "\r" || c == "\n") break;
    buf += c;
  }
  return StringToDouble(buf);
}

//+------------------------------------------------------------------+
//| Fetch and parse signal from API                                   |
//+------------------------------------------------------------------+
SignalData FetchSignal() {
  SignalData sig;
  sig.valid = false;

  string url = InpApiBase + "/api/signal?asset=" + InpAsset;

  char   reqData[];
  char   respData[];
  string respHeaders;

  ResetLastError();
  int code = WebRequest("GET", url, "Content-Type: application/json\r\n", 5000, reqData, respData, respHeaders);

  if (code < 0) {
    int err = GetLastError();
    if (err == 4014) {
      Print("WebRequest blocked. Go to: Tools > Options > Expert Advisors > Allow WebRequest for: ", InpApiBase);
    } else {
      Print("WebRequest error ", err, " for URL: ", url);
    }
    return sig;
  }

  if (code != 200) {
    Print("API returned HTTP ", code);
    return sig;
  }

  string json = CharArrayToString(respData, 0, WHOLE_ARRAY, CP_UTF8);

  sig.signal     = JsonStr(json, "signal");
  sig.bias       = JsonStr(json, "bias");
  sig.trend      = JsonStr(json, "trend");
  sig.price      = JsonNum(json, "price");
  sig.entry      = JsonNum(json, "entry");
  sig.sl         = JsonNum(json, "sl");
  sig.tp1        = JsonNum(json, "tp1");
  sig.tp2        = JsonNum(json, "tp2");
  sig.tp3        = JsonNum(json, "tp3");
  sig.rsi        = JsonNum(json, "rsi");
  sig.atr        = JsonNum(json, "atr");
  sig.ema9       = JsonNum(json, "ema9");
  sig.ema21      = JsonNum(json, "ema21");
  sig.confidence = JsonNum(json, "confidence");

  if (sig.signal == "" || sig.entry == 0.0) {
    Print("Incomplete signal data received");
    return sig;
  }

  sig.valid = true;
  return sig;
}

//+------------------------------------------------------------------+
//| Select the correct TP level                                       |
//+------------------------------------------------------------------+
double SelectTP(const SignalData &sig) {
  if (InpTPLevel == 1) return sig.tp1;
  if (InpTPLevel == 3) return sig.tp3;
  return sig.tp2; // default TP2
}

//+------------------------------------------------------------------+
//| Calculate lot size based on risk %                               |
//+------------------------------------------------------------------+
double CalcLots(double entry, double sl) {
  double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
  double riskAmt   = balance * InpRiskPct / 100.0;
  double slDist    = MathAbs(entry - sl);
  if (slDist == 0.0) return SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_MIN);

  double tickSize  = SymbolInfoDouble(g_symbol, SYMBOL_TRADE_TICK_SIZE);
  double tickValue = SymbolInfoDouble(g_symbol, SYMBOL_TRADE_TICK_VALUE);
  double lotStep   = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_STEP);
  double minLot    = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_MIN);
  double maxLot    = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_MAX);

  if (tickSize == 0.0 || tickValue == 0.0) return minLot;

  double slTicks = slDist / tickSize;
  double lots    = riskAmt / (slTicks * tickValue);
  lots = MathFloor(lots / lotStep) * lotStep;
  lots = MathMax(minLot, MathMin(maxLot, lots));
  return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//| Check if we already have an open EA position                     |
//+------------------------------------------------------------------+
bool HasOpenPosition(ENUM_POSITION_TYPE &posType) {
  for (int i = PositionsTotal() - 1; i >= 0; i--) {
    ulong ticket = PositionGetTicket(i);
    if (!PositionSelectByTicket(ticket)) continue;
    if (PositionGetString(POSITION_SYMBOL)   != g_symbol)     continue;
    if (PositionGetInteger(POSITION_MAGIC)   != InpMagicNumber) continue;
    posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
    return true;
  }
  return false;
}

//+------------------------------------------------------------------+
//| Close all EA positions on this symbol                            |
//+------------------------------------------------------------------+
void CloseAllPositions() {
  for (int i = PositionsTotal() - 1; i >= 0; i--) {
    ulong ticket = PositionGetTicket(i);
    if (!PositionSelectByTicket(ticket)) continue;
    if (PositionGetString(POSITION_SYMBOL)  != g_symbol)      continue;
    if (PositionGetInteger(POSITION_MAGIC)  != InpMagicNumber) continue;
    if (!g_trade.PositionClose(ticket)) {
      Print("Close failed: ", g_trade.ResultRetcodeDescription());
    }
  }
}

//+------------------------------------------------------------------+
//| Update chart comment                                             |
//+------------------------------------------------------------------+
void UpdateComment(const SignalData &sig) {
  if (!InpShowComment) return;
  string sigIcon = sig.signal == "BUY" ? "▲" : sig.signal == "SELL" ? "▼" : "◆";
  Comment(
    "━━━ Smart Entry Pro V2 ━━━\n",
    "Asset:  ", InpAsset, "  (", g_symbol, ")\n",
    "Signal: ", sigIcon, " ", sig.signal, "  (Conf: ", DoubleToString(sig.confidence, 0), "%)\n",
    "Bias:   ", sig.bias, "   Trend: ", sig.trend, "\n",
    "Price:  ", DoubleToString(sig.price, 2), "\n",
    "Entry:  ", DoubleToString(sig.entry, 2), "\n",
    "SL:     ", DoubleToString(sig.sl, 2), "\n",
    "TP1:    ", DoubleToString(sig.tp1, 2),
    "  TP2: ", DoubleToString(sig.tp2, 2),
    "  TP3: ", DoubleToString(sig.tp3, 2), "\n",
    "RSI:    ", DoubleToString(sig.rsi, 1),
    "   ATR: ", DoubleToString(sig.atr, 2), "\n",
    "EMA9:   ", DoubleToString(sig.ema9, 2),
    "  EMA21: ", DoubleToString(sig.ema21, 2), "\n",
    "━━━━━━━━━━━━━━━━━━━━━━━━━\n",
    "Refreshed: ", TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS), "\n",
    "Trading: ", InpEnableTrading ? "ON" : "OFF (sim mode)"
  );
}

//+------------------------------------------------------------------+
//| Core logic — fetch signal and act on it                          |
//+------------------------------------------------------------------+
void ProcessSignal() {
  SignalData sig = FetchSignal();
  if (!sig.valid) return;

  UpdateComment(sig);
  g_lastSignal = sig.signal;

  Print("Signal[", InpAsset, "]: ", sig.signal,
        " Conf:", sig.confidence, "%",
        " Entry:", sig.entry,
        " SL:", sig.sl, " TP2:", sig.tp2,
        " RSI:", sig.rsi);

  if (!InpEnableTrading) return;

  if (sig.confidence < InpMinConfidence) {
    Print("Skipping — confidence ", sig.confidence, "% < minimum ", InpMinConfidence, "%");
    return;
  }

  ENUM_POSITION_TYPE existingType;
  bool hasPos = HasOpenPosition(existingType);
  double tp   = SelectTP(sig);

  if (sig.signal == "BUY") {
    // Close any existing SELL before opening BUY
    if (hasPos && existingType == POSITION_TYPE_SELL) {
      Print("Closing SELL — signal flipped to BUY");
      CloseAllPositions();
      hasPos = false;
    }
    if (!hasPos) {
      double ask  = SymbolInfoDouble(g_symbol, SYMBOL_ASK);
      double lots = CalcLots(ask, sig.sl);
      Print("Opening BUY: ", lots, " lots @ ", ask, "  SL:", sig.sl, "  TP:", tp);
      if (!g_trade.Buy(lots, g_symbol, ask, sig.sl, tp, "SEP_BUY")) {
        Print("BUY failed: ", g_trade.ResultRetcodeDescription());
      }
    }

  } else if (sig.signal == "SELL") {
    // Close any existing BUY before opening SELL
    if (hasPos && existingType == POSITION_TYPE_BUY) {
      Print("Closing BUY — signal flipped to SELL");
      CloseAllPositions();
      hasPos = false;
    }
    if (!hasPos) {
      double bid  = SymbolInfoDouble(g_symbol, SYMBOL_BID);
      double lots = CalcLots(bid, sig.sl);
      Print("Opening SELL: ", lots, " lots @ ", bid, "  SL:", sig.sl, "  TP:", tp);
      if (!g_trade.Sell(lots, g_symbol, bid, sig.sl, tp, "SEP_SELL")) {
        Print("SELL failed: ", g_trade.ResultRetcodeDescription());
      }
    }

  } else if (sig.signal == "HOLD" && InpCloseOnHold && hasPos) {
    Print("HOLD signal — closing position (InpCloseOnHold=true)");
    CloseAllPositions();
  }
}

//+------------------------------------------------------------------+
//| Timer — runs every InpRefreshSec seconds                         |
//+------------------------------------------------------------------+
void OnTimer() {
  ProcessSignal();
}

//+------------------------------------------------------------------+
//| Tick — lightweight (main logic driven by timer)                  |
//+------------------------------------------------------------------+
void OnTick() {
  // Intentionally empty — all logic is timer-based to avoid
  // hammering the API on every tick.
}
//+------------------------------------------------------------------+
