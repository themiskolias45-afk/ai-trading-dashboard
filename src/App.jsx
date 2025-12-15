import { useEffect, useMemo, useState } from "react";

/* ================== CORE SMC HELPERS ================== */
function detectSwings(candles, n = 2) {
  const swings = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= n; k++) {
      if (candles[i - k].high >= c.high) isHigh = false;
      if (candles[i + k].high >= c.high) isHigh = false;
      if (candles[i - k].low <= c.low) isLow = false;
      if (candles[i + k].low <= c.low) isLow = false;
    }
    if (isHigh) swings.push({ type: "H", price: c.high, idx: i });
    if (isLow) swings.push({ type: "L", price: c.low, idx: i });
  }
  swings.sort((a, b) => a.idx - b.idx);
  const filtered = [];
  for (const s of swings) {
    const last = filtered[filtered.length - 1];
    if (!last) filtered.push(s);
    else if (last.type === s.type) {
      if (s.type === "H" && s.price > last.price) filtered[filtered.length - 1] = s;
      if (s.type === "L" && s.price < last.price) filtered[filtered.length - 1] = s;
    } else filtered.push(s);
  }
  return filtered;
}

function labelStructure(swings) {
  let lastHigh = null, lastLow = null;
  return swings.map(s => {
    if (s.type === "H") {
      const label = lastHigh === null ? "H" : s.price > lastHigh ? "HH" : "LH";
      lastHigh = s.price;
      return { ...s, label };
    } else {
      const label = lastLow === null ? "L" : s.price > lastLow ? "HL" : "LL";
      lastLow = s.price;
      return { ...s, label };
    }
  });
}

function detectBOS(labeled, price) {
  const highs = labeled.filter(x => x.type === "H");
  const lows = labeled.filter(x => x.type === "L");
  if (!price || highs.length === 0 || lows.length === 0) return null;
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  if (price > lastHigh.price) return { dir: "BULL", level: lastHigh.price };
  if (price < lastLow.price) return { dir: "BEAR", level: lastLow.price };
  return null;
}

function detectCHOCH(labeled, price) {
  if (!price || labeled.length < 4) return null;
  const highs = labeled.filter(x => x.type === "H").slice(-2);
  const lows = labeled.filter(x => x.type === "L").slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;

  const [ph, lh] = highs.map(x => x.price);
  const [pl, ll] = lows.map(x => x.price);

  if (lh > ph && price < ll) return { dir: "BEAR", level: ll };
  if (ll < pl && price > lh) return { dir: "BULL", level: lh };
  return null;
}

function detectFVG(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (prev.high < next.low) {
      fvgs.push({ dir: "BULL", from: prev.high, to: next.low });
    }
    if (prev.low > next.high) {
      fvgs.push({ dir: "BEAR", from: next.high, to: prev.low });
    }
  }
  return fvgs;
}

/* ================== APP ================== */
export default function App() {
  const [candles, setCandles] = useState([]);
  const [price, setPrice] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      const res = await fetch(
        "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=300"
      );
      const json = await res.json();
      const data = json.Data.Data;
      setCandles(data);
      setPrice(data[data.length - 1].close);
    };
    fetchData();
    const i = setInterval(fetchData, 60000);
    return () => clearInterval(i);
  }, []);

  const { entry } = useMemo(() => {
    if (!price || candles.length === 0) return {};

    const swings = detectSwings(candles, 2);
    const labeled = labelStructure(swings);
    const bos = detectBOS(labeled, price);
    const choch = detectCHOCH(labeled, price);
    const fvgs = detectFVG(candles);
    const lastFVG = fvgs.length ? fvgs[fvgs.length - 1] : null;

    if (!lastFVG) return {};

    const structureDir = bos?.dir || choch?.dir;
    if (!structureDir || structureDir !== lastFVG.dir) return {};

    const inFVG =
      price >= Math.min(lastFVG.from, lastFVG.to) &&
      price <= Math.max(lastFVG.from, lastFVG.to);

    if (!inFVG) return {};

    const lastLL = labeled.filter(x => x.label === "LL").slice(-1)[0];
    const lastHH = labeled.filter(x => x.label === "HH").slice(-1)[0];

    if (structureDir === "BEAR" && lastLL) {
      return {
        direction: "SELL",
        entry: price,
        sl: lastFVG.to,
        tp: lastLL.price
      };
    }

    if (structureDir === "BULL" && lastHH) {
      return {
        direction: "BUY",
        entry: price,
        sl: lastFVG.from,
        tp: lastHH.price
      };
    }

    return {};
  }, [candles, price]);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Trading Dashboard</h1>

      <div><strong>BTCUSD:</strong> {price ? `$${price}` : "Loading…"}</div>

      {entry?.direction ? (
        <div style={{ marginTop: 16, background: "#111827", padding: 16, borderRadius: 10 }}>
          <div><strong>ENTRY SIGNAL:</strong> {entry.direction}</div>
          <div>Entry: {entry.entry.toFixed(2)}</div>
          <div>Stop-Loss: {entry.sl.toFixed(2)}</div>
          <div>Take-Profit: {entry.tp.toFixed(2)}</div>
        </div>
      ) : (
        <div style={{ marginTop: 16, color: "#9ca3af" }}>
          No valid SMC entry (waiting for BOS/CHOCH + FVG pullback)
        </div>
      )}
    </div>
  );
}
