import { useEffect, useMemo, useRef, useState } from "react";

/* ================== UTILITIES ================== */
function notify(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission();
  }
}

/* ================== CORE SMC ================== */
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
  return swings;
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

function getBias(labeled) {
  const highs = labeled.filter(x => x.type === "H");
  const lows = labeled.filter(x => x.type === "L");
  if (highs.length < 2 || lows.length < 2) return "RANGE";

  const hh = highs.at(-1).price > highs.at(-2).price;
  const hl = lows.at(-1).price > lows.at(-2).price;
  const lh = highs.at(-1).price < highs.at(-2).price;
  const ll = lows.at(-1).price < lows.at(-2).price;

  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "RANGE";
}

function detectBOS(labeled, price) {
  const highs = labeled.filter(x => x.type === "H");
  const lows = labeled.filter(x => x.type === "L");
  if (!price || !highs.length || !lows.length) return null;

  if (price > highs.at(-1).price) return "BULLISH";
  if (price < lows.at(-1).price) return "BEARISH";
  return null;
}

function detectCHOCH(labeled, price) {
  if (labeled.length < 4) return null;
  const highs = labeled.filter(x => x.type === "H").slice(-2);
  const lows = labeled.filter(x => x.type === "L").slice(-2);

  if (highs[1].price > highs[0].price && price < lows[1].price) return "BEARISH";
  if (lows[1].price < lows[0].price && price > highs[1].price) return "BULLISH";
  return null;
}

function detectFVG(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const p = candles[i - 1];
    const n = candles[i + 1];
    if (p.high < n.low) fvgs.push({ dir: "BULLISH", from: p.high, to: n.low });
    if (p.low > n.high) fvgs.push({ dir: "BEARISH", from: n.high, to: p.low });
  }
  return fvgs;
}

/* ================== APP ================== */
export default function App() {
  const [htf, setHTF] = useState([]);
  const [ltf, setLTF] = useState([]);
  const [price, setPrice] = useState(null);
  const lastAlert = useRef(null);

  useEffect(() => {
    const fetchData = async () => {
      const htfRes = await fetch(
        "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=300&aggregate=15"
      );
      const ltfRes = await fetch(
        "https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=300"
      );
      const htfJson = await htfRes.json();
      const ltfJson = await ltfRes.json();

      setHTF(htfJson.Data.Data);
      setLTF(ltfJson.Data.Data);
      setPrice(ltfJson.Data.Data.at(-1).close);
    };

    fetchData();
    const i = setInterval(fetchData, 60000);
    return () => clearInterval(i);
  }, []);

  const result = useMemo(() => {
    if (!htf.length || !ltf.length || !price) return {};

    /* HTF BIAS */
    const htfStruct = labelStructure(detectSwings(htf));
    const htfBias = getBias(htfStruct);
    if (htfBias === "RANGE") return { htfBias };

    /* LTF LOGIC */
    const ltfStruct = labelStructure(detectSwings(ltf));
    const bos = detectBOS(ltfStruct, price);
    const choch = detectCHOCH(ltfStruct, price);
    const fvgs = detectFVG(ltf);
    const lastFVG = fvgs.at(-1);

    if (!lastFVG || lastFVG.dir !== htfBias) return { htfBias };

    const inFVG =
      price >= Math.min(lastFVG.from, lastFVG.to) &&
      price <= Math.max(lastFVG.from, lastFVG.to);

    if (!inFVG) return { htfBias };

    if (bos === htfBias || choch === htfBias) {
      return {
        htfBias,
        entry: {
          direction: htfBias,
          entry: price,
          sl: htfBias === "BULLISH" ? lastFVG.from - 200 : lastFVG.to + 200,
          tp: htfBias === "BULLISH" ? price + 1200 : price - 1200
        }
      };
    }

    return { htfBias };
  }, [htf, ltf, price]);

  useEffect(() => {
    if (!result.entry) return;
    const key = `${result.entry.direction}-${Math.round(result.entry.entry)}`;
    if (lastAlert.current === key) return;
    lastAlert.current = key;

    notify(
      "BTCUSD SMC ENTRY",
      `${result.entry.direction}\nEntry: ${result.entry.entry.toFixed(2)}`
    );
  }, [result]);

  return (
    <div style={{ background: "#0b0f1a", color: "white", minHeight: "100vh", padding: 24 }}>
      <h1>AI Trading Dashboard</h1>

      <div>BTCUSD: {price ? `$${price}` : "Loading…"}</div>
      <div>HTF Bias (15m): <strong>{result.htfBias || "Loading…"}</strong></div>

      {result.entry ? (
        <div style={{ marginTop: 16, background: "#111827", padding: 16, borderRadius: 10 }}>
          <div><strong>ENTRY:</strong> {result.entry.direction}</div>
          <div>Entry: {result.entry.entry.toFixed(2)}</div>
          <div>SL: {result.entry.sl.toFixed(2)}</div>
          <div>TP: {result.entry.tp.toFixed(2)}</div>
        </div>
      ) : (
        <div style={{ marginTop: 16, color: "#9ca3af" }}>
          Waiting for HTF-aligned SMC setup…
        </div>
      )}
    </div>
  );
}
