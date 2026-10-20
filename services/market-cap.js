import { DAY_MS } from "./market-utils.js";

// Build time-aligned aggregate only when all three crypto market caps are known.
// Carry forward latest available observation, within 24h, to avoid summing partial data.
export function aggregateMarketCap(series, staleMs = DAY_MS) {
  const cursors = series.map(() => 0);
  const latest = series.map(() => null);
  const timestamps = [...new Set(series.flatMap(candles => candles.filter(c => c.marketCap != null && Number.isFinite(c.marketCap)).map(c => c.t)))].sort((a, b) => a - b);
  const points = [];
  for (const t of timestamps) {
    let complete = true;
    let total = 0;
    for (let i = 0; i < series.length; i++) {
      const candles = series[i];
      while (cursors[i] < candles.length && candles[cursors[i]].t <= t) {
        if (Number.isFinite(candles[cursors[i]].marketCap)) latest[i] = candles[cursors[i]];
        cursors[i]++;
      }
      if (!latest[i] || t - latest[i].t > staleMs) complete = false;
      else total += latest[i].marketCap;
    }
    if (complete) points.push({ t, o: total, h: total, l: total, c: total, marketCap: total });
  }
  return points;
}

