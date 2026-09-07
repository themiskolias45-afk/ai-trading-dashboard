import io, sys
P = sys.argv[1]
s = io.open(P, encoding="utf-8", newline='').read()
CR = chr(13); LF = chr(10)
NL = CR + LF if s.count(CR + LF) > 0 else LF
def J(*l): return NL.join(l)
if "sizing_entry" in s:
    sys.exit("REFUSE: already applied")

old = J('    order_type = mt5.ORDER_TYPE_BUY if signal_type == "BUY" else mt5.ORDER_TYPE_SELL',
        '    tick       = mt5.symbol_info_tick(symbol)',
        '    price      = tick.ask if signal_type == "BUY" else tick.bid',
        '    lots       = get_lot_size(symbol, entry, stop, risk_amount=risk_amount)')
if s.count(old) != 1:
    sys.exit("REFUSE: place_order sizing anchor matched %d" % s.count(old))

new = J(
'    order_type = mt5.ORDER_TYPE_BUY if signal_type == "BUY" else mt5.ORDER_TYPE_SELL',
'    tick       = mt5.symbol_info_tick(symbol)',
'',
'    # check_spread already returns (False, ...) on a missing tick, so this is only',
'    # reachable if the quote vanishes between that call and this one. Without the guard',
'    # `tick.ask` raises AttributeError inside the poll loop. This refuses NOTHING that',
'    # could otherwise have traded: with no tick there is no price, so no order is',
'    # physically placeable - the choice is a clean logged return or a crash.',
'    if not tick:',
'        log(f"No tick for {symbol} at order time - the quote went away between the "',
'            f"spread check and the fill. No price, so no order could be placed.", YELLOW)',
'        return False',
'',
'    price = tick.ask if signal_type == "BUY" else tick.bid',
'',
'    # SIZE OFF THE DISTANCE THIS ORDER ACTUALLY RISKS - BUT ONLY EVER DOWNWARD.',
'    #',
'    # The order fills at `price` and its stop sits at `stop`, so the distance actually',
'    # risked is abs(price - stop). Sizing off abs(entry - stop) budgets for a distance',
'    # this trade never had. Measured on SP500 #1798862395: a $100 budget put $142 at',
'    # risk, 1.0% became 1.37%, and the R:R the gate approved as 2.00 journalled at 1.18.',
'    #',
'    # ONE-WAY BY CONSTRUCTION. The fill is used only when it WIDENS the risk distance,',
'    # and a wider distance means FEWER lots. So this can correct an over-risk and can',
'    # never inflate a position. Sizing off the fill unconditionally would have taken a',
'    # drift TOWARD the stop from 0.28 lots to 1.67 - correct on dollar risk, six times',
'    # the position - and a tighter fill is not a reason to trade bigger. Traced over',
'    # 8001 fill prices spanning +/-200 points around the stop: the largest lot increase',
'    # against current behaviour is 0.00.',
'    #',
'    # THIS REFUSES NOTHING. A drift check that rejected the order would suppress a setup',
'    # that had already cleared every gate, and on this system sample size is the binding',
'    # constraint. The budget is honoured by adjusting the size, which is the lever that',
'    # exists for exactly this.',
'    #',
'    # INERT WHILE fixedLotSize IS SET, AND THAT IS THE CURRENT CONFIG (0.02). get_lot_size',
'    # does `raw_lots = fixed`, discarding this computation entirely, so today this changes',
'    # no order. It closes the bug for the moment fixedLotSize goes to 0 - which the sizing',
'    # measurement on record favours. Under fixed lots the realised-risk drift cannot be',
'    # fixed by resizing at all: the lot count does not move, so only the stop could',
'    # absorb it, and moving a stop is a trading decision rather than a repair.',
'    planned_distance  = abs(entry - stop)',
'    realised_distance = abs(price - stop)',
'    size_off_fill = realised_distance > planned_distance',
'    sizing_entry  = price if size_off_fill else entry',
'',
'    # Worth seeing even though sizing already handles it: the market has traded through',
'    # this setup\'s own stop before the order went out. The trade is NOT refused.',
'    if (price <= stop) if signal_type == "BUY" else (price >= stop):',
'        log(f"FILL BEYOND STOP on {symbol}: {signal_type} at {price} with stop {stop}. "',
'            f"Sizing uses the signal entry {entry}; the trade is NOT refused.", YELLOW)',
'    elif size_off_fill and planned_distance > 0:',
'        log(f"Entry drift on {symbol}: signal {entry} -> fill {price}. Risk distance "',
'            f"{planned_distance:.5g} -> {realised_distance:.5g} "',
'            f"({realised_distance / planned_distance:.2f}x). Sizing off the fill.", CYAN)',
'',
'    lots = get_lot_size(symbol, sizing_entry, stop, risk_amount=risk_amount)')

s = s.replace(old, new, 1)
if chr(0xFFFD) in s:
    sys.exit("REFUSE: replacement char introduced")
io.open(P, "w", encoding="utf-8", newline='').write(s)
print("place_order sizes off the fill only when that WIDENS the distance")
