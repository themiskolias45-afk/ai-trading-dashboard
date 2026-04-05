//+------------------------------------------------------------------+
//|                                                  ScalpingEA.mq5  |
//|                          AI Trading Dashboard - Scalping EA v1.0  |
//|                     Strategy: EMA Cross + RSI + ATR Risk Mgmt     |
//+------------------------------------------------------------------+
#property copyright   "AI Trading Dashboard"
#property link        ""
#property version     "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\OrderInfo.mqh>

//--- Input Parameters
input group "=== SYMBOL & LOT SIZING ==="
input double   InpLotSize          = 0.01;   // Fixed Lot Size (0 = use risk %)
input double   InpRiskPercent      = 1.0;    // Risk % per trade (if lot = 0)
input int      InpMaxPositions     = 1;      // Max simultaneous positions

input group "=== EMA SETTINGS ==="
input int      InpFastEMA          = 8;      // Fast EMA Period
input int      InpSlowEMA          = 21;     // Slow EMA Period
input int      InpTrendEMA         = 50;     // Trend Filter EMA Period
input ENUM_APPLIED_PRICE InpEMAPrice = PRICE_CLOSE; // EMA Applied Price

input group "=== RSI SETTINGS ==="
input int      InpRSIPeriod        = 14;     // RSI Period
input double   InpRSIOverbought    = 70.0;   // RSI Overbought Level
input double   InpRSIOversold      = 30.0;   // RSI Oversold Level

input group "=== ATR RISK MANAGEMENT ==="
input int      InpATRPeriod        = 14;     // ATR Period
input double   InpSLMultiplier     = 1.5;    // Stop Loss ATR Multiplier
input double   InpTPMultiplier     = 2.5;    // Take Profit ATR Multiplier
input bool     InpUseTrailingStop  = true;   // Enable Trailing Stop
input double   InpTrailMultiplier  = 1.0;    // Trailing Stop ATR Multiplier

input group "=== SPREAD & SESSION FILTER ==="
input int      InpMaxSpreadPips    = 20;     // Max Allowed Spread (points)
input bool     InpUseTimeFilter    = true;   // Enable Session Time Filter
input int      InpStartHour        = 8;      // Trading Start Hour (Server Time)
input int      InpEndHour          = 20;     // Trading End Hour (Server Time)

input group "=== MAGIC & COMMENTS ==="
input long     InpMagicNumber      = 202400; // EA Magic Number
input string   InpTradeComment     = "ScalpEA"; // Trade Comment

//--- Global Objects
CTrade         trade;
CPositionInfo  posInfo;

//--- Indicator Handles
int hFastEMA, hSlowEMA, hTrendEMA, hRSI, hATR;

//--- State Variables
datetime lastBarTime = 0;
int      signalBuy   = 0;
int      signalSell  = 0;

//+------------------------------------------------------------------+
//| Expert Initialization                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   //--- Validate inputs
   if(InpFastEMA >= InpSlowEMA)
   {
      Print("ERROR: Fast EMA must be less than Slow EMA.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(InpSlowEMA >= InpTrendEMA)
   {
      Print("ERROR: Slow EMA must be less than Trend EMA.");
      return INIT_PARAMETERS_INCORRECT;
   }

   //--- Setup trade object
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(10);
   trade.SetTypeFilling(ORDER_FILLING_IOC);

   //--- Create indicator handles
   hFastEMA  = iMA(_Symbol, PERIOD_CURRENT, InpFastEMA,  0, MODE_EMA, InpEMAPrice);
   hSlowEMA  = iMA(_Symbol, PERIOD_CURRENT, InpSlowEMA,  0, MODE_EMA, InpEMAPrice);
   hTrendEMA = iMA(_Symbol, PERIOD_CURRENT, InpTrendEMA, 0, MODE_EMA, InpEMAPrice);
   hRSI      = iRSI(_Symbol, PERIOD_CURRENT, InpRSIPeriod, InpEMAPrice);
   hATR      = iATR(_Symbol, PERIOD_CURRENT, InpATRPeriod);

   if(hFastEMA == INVALID_HANDLE || hSlowEMA == INVALID_HANDLE ||
      hTrendEMA == INVALID_HANDLE || hRSI == INVALID_HANDLE || hATR == INVALID_HANDLE)
   {
      Print("ERROR: Failed to create indicator handles.");
      return INIT_FAILED;
   }

   Print("ScalpingEA initialized successfully on ", _Symbol, " ", EnumToString(Period()));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert Deinitialization                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(hFastEMA);
   IndicatorRelease(hSlowEMA);
   IndicatorRelease(hTrendEMA);
   IndicatorRelease(hRSI);
   IndicatorRelease(hATR);
   Print("ScalpingEA stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| Expert Tick Function                                              |
//+------------------------------------------------------------------+
void OnTick()
{
   //--- Only process on new bar
   datetime currentBar = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBar == lastBarTime)
   {
      //--- Still manage trailing stops on every tick
      if(InpUseTrailingStop) ManageTrailingStop();
      return;
   }
   lastBarTime = currentBar;

   //--- Pre-checks
   if(!IsSessionAllowed())   return;
   if(!IsSpreadAcceptable()) return;

   //--- Read indicator values (bar 1 = last closed bar)
   double fastEMA[3], slowEMA[3], trendEMA[3], rsi[3], atr[3];

   if(!GetIndicatorValues(fastEMA, slowEMA, trendEMA, rsi, atr)) return;

   //--- Generate signal
   int signal = GetSignal(fastEMA, slowEMA, trendEMA, rsi);

   //--- Count open positions for this EA
   int openBuys = 0, openSells = 0;
   CountPositions(openBuys, openSells);

   //--- Close opposite positions on signal flip
   if(signal == 1 && openSells > 0) CloseAllSells();
   if(signal == -1 && openBuys > 0) CloseAllBuys();

   //--- Open new position
   int totalOpen = openBuys + openSells;
   if(totalOpen < InpMaxPositions)
   {
      double atrVal = atr[1];
      double sl = atrVal * InpSLMultiplier;
      double tp = atrVal * InpTPMultiplier;
      double lots = CalculateLots(sl);

      if(signal == 1)  OpenBuy(lots, sl, tp);
      if(signal == -1) OpenSell(lots, sl, tp);
   }
}

//+------------------------------------------------------------------+
//| Get indicator buffer values                                       |
//+------------------------------------------------------------------+
bool GetIndicatorValues(double &fast[], double &slow[], double &trend[],
                        double &rsi[], double &atr[])
{
   if(CopyBuffer(hFastEMA,  0, 0, 3, fast)  < 3) return false;
   if(CopyBuffer(hSlowEMA,  0, 0, 3, slow)  < 3) return false;
   if(CopyBuffer(hTrendEMA, 0, 0, 3, trend) < 3) return false;
   if(CopyBuffer(hRSI,      0, 0, 3, rsi)   < 3) return false;
   if(CopyBuffer(hATR,      0, 0, 3, atr)   < 3) return false;
   ArraySetAsSeries(fast,  true);
   ArraySetAsSeries(slow,  true);
   ArraySetAsSeries(trend, true);
   ArraySetAsSeries(rsi,   true);
   ArraySetAsSeries(atr,   true);
   return true;
}

//+------------------------------------------------------------------+
//| Generate trade signal                                             |
//| Returns: 1=BUY, -1=SELL, 0=NONE                                  |
//+------------------------------------------------------------------+
int GetSignal(const double &fast[], const double &slow[],
              const double &trend[], const double &rsi[])
{
   //--- EMA crossover on bar 1 (just closed)
   bool bullCross = (fast[2] < slow[2]) && (fast[1] > slow[1]);
   bool bearCross = (fast[2] > slow[2]) && (fast[1] < slow[1]);

   //--- Trend filter: price above/below trend EMA
   double closeBar1 = iClose(_Symbol, PERIOD_CURRENT, 1);
   bool upTrend   = (closeBar1 > trend[1]);
   bool downTrend = (closeBar1 < trend[1]);

   //--- RSI confirmation (avoid extremes / confirm momentum)
   bool rsiBuyOK  = (rsi[1] > 40.0 && rsi[1] < InpRSIOverbought);
   bool rsiSellOK = (rsi[1] < 60.0 && rsi[1] > InpRSIOversold);

   if(bullCross && upTrend && rsiBuyOK)  return  1;
   if(bearCross && downTrend && rsiSellOK) return -1;

   return 0;
}

//+------------------------------------------------------------------+
//| Open BUY position                                                 |
//+------------------------------------------------------------------+
void OpenBuy(double lots, double slDist, double tpDist)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int    digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   double sl = NormalizeDouble(ask - slDist, digits);
   double tp = NormalizeDouble(ask + tpDist, digits);

   if(trade.Buy(lots, _Symbol, ask, sl, tp, InpTradeComment))
      PrintFormat("BUY opened: lots=%.2f ask=%.5f SL=%.5f TP=%.5f", lots, ask, sl, tp);
   else
      PrintFormat("BUY failed: error=%d", GetLastError());
}

//+------------------------------------------------------------------+
//| Open SELL position                                                |
//+------------------------------------------------------------------+
void OpenSell(double lots, double slDist, double tpDist)
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   int    digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   double sl = NormalizeDouble(bid + slDist, digits);
   double tp = NormalizeDouble(bid - tpDist, digits);

   if(trade.Sell(lots, _Symbol, bid, sl, tp, InpTradeComment))
      PrintFormat("SELL opened: lots=%.2f bid=%.5f SL=%.5f TP=%.5f", lots, bid, sl, tp);
   else
      PrintFormat("SELL failed: error=%d", GetLastError());
}

//+------------------------------------------------------------------+
//| Trailing Stop Management (called on every tick)                   |
//+------------------------------------------------------------------+
void ManageTrailingStop()
{
   double atr[2];
   if(CopyBuffer(hATR, 0, 0, 2, atr) < 2) return;
   ArraySetAsSeries(atr, true);
   double trailDist = atr[1] * InpTrailMultiplier;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() != InpMagicNumber) continue;
      if(posInfo.Symbol() != _Symbol) continue;

      double currentSL = posInfo.StopLoss();
      double openPrice = posInfo.PriceOpen();

      if(posInfo.PositionType() == POSITION_TYPE_BUY)
      {
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         double newSL = NormalizeDouble(bid - trailDist, digits);
         if(newSL > currentSL && newSL > openPrice)
            trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
      }
      else if(posInfo.PositionType() == POSITION_TYPE_SELL)
      {
         double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         double newSL = NormalizeDouble(ask + trailDist, digits);
         if(newSL < currentSL && newSL < openPrice)
            trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
      }
   }
}

//+------------------------------------------------------------------+
//| Close all BUY positions for this EA                               |
//+------------------------------------------------------------------+
void CloseAllBuys()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() != InpMagicNumber) continue;
      if(posInfo.Symbol() != _Symbol) continue;
      if(posInfo.PositionType() == POSITION_TYPE_BUY)
         trade.PositionClose(posInfo.Ticket());
   }
}

//+------------------------------------------------------------------+
//| Close all SELL positions for this EA                              |
//+------------------------------------------------------------------+
void CloseAllSells()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() != InpMagicNumber) continue;
      if(posInfo.Symbol() != _Symbol) continue;
      if(posInfo.PositionType() == POSITION_TYPE_SELL)
         trade.PositionClose(posInfo.Ticket());
   }
}

//+------------------------------------------------------------------+
//| Count open positions for this EA                                  |
//+------------------------------------------------------------------+
void CountPositions(int &buys, int &sells)
{
   buys = 0; sells = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() != InpMagicNumber) continue;
      if(posInfo.Symbol() != _Symbol) continue;
      if(posInfo.PositionType() == POSITION_TYPE_BUY)  buys++;
      if(posInfo.PositionType() == POSITION_TYPE_SELL) sells++;
   }
}

//+------------------------------------------------------------------+
//| Calculate lot size based on risk %                                |
//+------------------------------------------------------------------+
double CalculateLots(double slDistance)
{
   if(InpLotSize > 0) return NormalizeLot(InpLotSize);

   double accountBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmount     = accountBalance * InpRiskPercent / 100.0;
   double tickValue      = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize       = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);

   if(tickSize == 0 || tickValue == 0 || slDistance == 0) return NormalizeLot(0.01);

   double lots = riskAmount / (slDistance / tickSize * tickValue);
   return NormalizeLot(lots);
}

//+------------------------------------------------------------------+
//| Normalize lot size to broker constraints                          |
//+------------------------------------------------------------------+
double NormalizeLot(double lots)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   lots = MathMax(lots, minLot);
   lots = MathMin(lots, maxLot);
   lots = MathFloor(lots / lotStep) * lotStep;
   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//| Check if current time is within allowed trading session           |
//+------------------------------------------------------------------+
bool IsSessionAllowed()
{
   if(!InpUseTimeFilter) return true;
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int hour = dt.hour;
   // Handle overnight sessions (e.g. 22-6)
   if(InpStartHour < InpEndHour)
      return (hour >= InpStartHour && hour < InpEndHour);
   else
      return (hour >= InpStartHour || hour < InpEndHour);
}

//+------------------------------------------------------------------+
//| Check if spread is within acceptable range                        |
//+------------------------------------------------------------------+
bool IsSpreadAcceptable()
{
   long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPips)
   {
      // Silent skip — logs would be too noisy on every tick
      return false;
   }
   return true;
}
//+------------------------------------------------------------------+
