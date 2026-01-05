import { useEffect, useState } from "react";

/* ================== HELPERS ================== */
function getHighLow(data, lookback = 96) {
  const slice = data.slice(-lookback);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  return { high, low };
}

function getBias(data) {
  if (data.length < 10) return "NO DATA";

  const highs = data.map(c => c.high);
  const lows = data.map(c => c.low);

  const hh = highs.at(-1) > highs.at(-5);
  const hl = lows.at(-1) > lows.at(-5);
  const lh = highs.at(-1) < highs.at(-5);
  const ll = lows.at(-1) < lows.at(-5);

  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
}

/* ================== APP ================== */
export default function App() {
  const [price, setPrice] = useState(null);
  const [analysis, setAnalysis] = useState("Loading analysis…");

  useEffect(() => {
    const fetchData = async () => {
      const res = await fetch(
        "https://min-api.cryptocompare.com/data/v2/histohour?fsym=BTC&tsym=USD&limit=120"
      );
      const json = await res.json();
      const data = json.Data.Data;

      const currentPrice = data.at(-1).close;
      setPrice(currentPrice);

      const bias = getBias(data);
      const { high, low } = getHighLow(data, 96);

      let text = "";

      if (bias === "BULLISH") {
        const discountZoneLow = low + (high - low) * 0.25;
        const discountZoneHigh = low + (high - low) * 0.4;

        text = `
Bias: BULLISH

Market is in a higher-timeframe uptrend.
Today, I am only interested in LONG setups.

Best buy zone:
${discountZoneLow.toFixed(0)} – ${discountZoneHigh.toFixed(0)}

Invalidation:
Below ${low.toFixed(0)}

Confirmation to enter:
• Price reacts strongly from the zone
• Higher low forms on lower timeframe
• Strong bullish candle (displacement)

If price holds above the zone → look for longs.
If price breaks below → no trade today.
`;
      } else if (bias === "BEARISH") {
        const premiumZoneLow = high - (high - low) * 0.4;
        const premiumZoneHigh = high - (high - low) * 0.25;

        text = `
Bias: BEARISH

Market is in a higher-timeframe downtrend.
Today, I am only interested in SHORT setups.

Best sell zone:
${premiumZoneLow.toFixed(0)} – ${premiumZoneHigh.toFixed(0)}

Invalidation:
Above ${high.toFixed(0)}

Confirmation to enter:
• Price rejects the zone
• Lower high forms
• Strong bearish candle

If price rejects the zone → look for shorts.
If price breaks above → no trade today.
`;
      } else {
        text = `
Bias: RANGE / NO-TRADE

Market is consolidating.
Risk of false breakouts is high.

Best action:
• Wait for clear break and structure shift
• No aggressive trades today
`;
      }

      setAnalysis(text.trim());
    };

    fetchData();
  }, []);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Daily Market Analyst</h1>

      <div style={{ marginBottom: 12 }}>
        BTCUSD: {price ? `$${price}` : "Loading…"}
      </div>

      <pre style={{
        whiteSpace: "pre-wrap",
        background: "#111827",
        padding: 16,
        borderRadius: 10,
        fontSize: 14
      }}>
        {analysis}
      </pre>
    </div>
  );
}