// Shared market-series validation and bounded server-side aggregation.
export const DAY_MS = 86_400_000;
export const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP"]);
export const MAX_CHART_POINTS = 2000;
export const MAX_RANGE_DAYS = 3650;

export function normalize(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function httpError(status, message, code = "BAD_REQUEST") {
  return Object.assign(new Error(message), { status, code });
}

export function currencyFrom(value, fallback = "USD") {
  const currency = normalize(value ?? fallback);
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw httpError(400, `Unsupported currency: ${currency}. Supported: USD, EUR, GBP.`, "INVALID_CURRENCY");
  }
  return currency;
}

export function rangeInDays(value = "30d") {
  const raw = String(value).trim().toLowerCase();
  if (raw === "all") return MAX_RANGE_DAYS;
  const match = /^(\d+(?:\.\d+)?)(m|h|d|w|mo|y)$/.exec(raw);
  if (!match) throw httpError(400, "Invalid range. Examples: 1d, 7d, 30d, 3m, 1y, all.", "INVALID_RANGE");
  // Historic `m` means months. `mo` is an alias; minutes use explicit intervals.
  const multipliers = { h: 1 / 24, d: 1, w: 7, m: 30, mo: 30, y: 365 };
  const days = Number(match[1]) * multipliers[match[2]];
  if (!Number.isFinite(days) || days <= 0 || days > MAX_RANGE_DAYS) {
    throw httpError(400, `Range must be within ${MAX_RANGE_DAYS} days.`, "INVALID_RANGE");
  }
  return days;
}

const INTERVALS = {
  m1: 60_000, m5: 300_000, m15: 900_000, m30: 1_800_000,
  h1: 3_600_000, h2: 7_200_000, h4: 14_400_000,
  h6: 21_600_000, h12: 43_200_000, d1: DAY_MS,
};

export function intervalInMs(value = "auto", days = 30, metal = false) {
  const interval = String(value).trim().toLowerCase();
  if (interval !== "auto") {
    if (!(interval in INTERVALS)) {
      throw httpError(400, "Invalid interval. Use auto, m1, m5, m15, m30, h1, h2, h4, h6, h12 or d1.", "INVALID_INTERVAL");
    }
    return INTERVALS[interval];
  }
  if (days <= 2) return (metal ? 15 : 5) * 60_000;
  if (days <= 7) return (metal ? 30 : 15) * 60_000;
  if (days <= 30) return 3_600_000;
  if (days <= 90) return (metal ? 4 : 6) * 3_600_000;
  if (metal && days <= 180) return 12 * 3_600_000;
  return DAY_MS;
}

// Search a sorted series. IMPORTANT: never truncate history before aggregation.
export function getCandlesInRange(candles, startMs, endMs) {
  if (!Array.isArray(candles) || !candles.length) return [];
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].t < startMs) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].t <= endMs) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(start, lo);
}

// OHLC aggregation: first open, high/low extrema, last close and latest snapshot metrics.
// Volume is a rolling value in the existing Firebase schema, NOT per-candle traded volume.
export function downsampleCandles(candles, intervalMs) {
  if (!Array.isArray(candles) || !candles.length) return [];
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) return candles;
  const buckets = [];
  let lastBucket;
  for (const candle of candles) {
    const bucket = Math.floor(candle.t / intervalMs);
    if (bucket !== lastBucket) {
      buckets.push({ ...candle });
      lastBucket = bucket;
      continue;
    }
    const first = buckets[buckets.length - 1];
    first.h = Math.max(first.h, candle.h);
    first.l = Math.min(first.l, candle.l);
    first.c = candle.c;
    first.t = candle.t;
    if (Object.hasOwn(candle, "marketCap")) first.marketCap = candle.marketCap;
    if (Object.hasOwn(candle, "volume")) first.volume = candle.volume;
  }
  return buckets;
}

// Guarantee bounded responses even when a client requests m1 over years of data.
export function chartData(candles, requestedMs, maxPoints = MAX_CHART_POINTS) {
  if (!candles.length) return { candles: [], effectiveIntervalMs: requestedMs };
  const span = candles[candles.length - 1].t - candles[0].t;
  let effectiveIntervalMs = Math.max(requestedMs, Math.ceil((span + 1) / maxPoints));
  let aggregated = downsampleCandles(candles, effectiveIntervalMs);
  while (aggregated.length > maxPoints) {
    effectiveIntervalMs *= 2;
    aggregated = downsampleCandles(candles, effectiveIntervalMs);
  }
  return { candles: aggregated, effectiveIntervalMs };
}

export function changePercent(candles, periodMs) {
  if (!candles?.length) return null;
  const last = candles[candles.length - 1];
  if (!Number.isFinite(last.t) || !(last.c > 0)) return null;
  const before = last.t - periodMs;
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].t <= before) lo = mid + 1;
    else hi = mid;
  }
  const reference = candles[lo - 1];
  return reference?.c > 0 ? (last.c / reference.c - 1) * 100 : null;
}

export function finiteOrNull(value) {
  return value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
}
