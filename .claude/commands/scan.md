Parallel market scan across all tracked assets. Usage: /scan [--all] [--debate] [BTC GOLD ETH ...]

$ARGUMENTS may contain asset symbols, --all flag, or --debate flag.

Run the scanner:
```
python market_scanner.py $ARGUMENTS
```

Then read the output and report:

**MARKET SCAN — [timestamp]**

For each asset with a live signal:
- Symbol, direction, confidence %, R:R ratio, setup name
- Historical win rate on this setup (from learning data)
- Score (0–100) — higher = better opportunity

**TOP PICK:** the highest-scored signal with a concise trade rationale (2 sentences max).

If no signals are ready: "No setups ready — market in accumulation/distribution. Next check in X min."

If --debate was passed and a debate already ran, show the debate verdict (TAKE/SKIP) for each signal.

After the scan output, ask: "Want to run the debate on [top pick]? (Y/N)"
If yes: python debate_agents.py [SYMBOL] [DIRECTION] [CONFIDENCE] [ENTRY] [STOP] [TARGET]
