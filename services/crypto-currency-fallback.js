import { DAY_MS } from "./market-utils.js";

const RECHECK_WINDOW_MS = 36 * 3_600_000;

/**
 * Prefer real currency-specific candles. When the stored currency collection
 * is missing, stale or lacks market caps, provide estimated candles derived
 * from USD using today's FX rate. Do not present those as historical FX quotes.
 */
export async function resolveCryptoCurrency({
  symbol, currency, getNative, getRate,
  convert = convertUsdCandles, now = Date.now(),
}) {
  let native;
  try {
    native = await getNative(symbol, currency);
  } catch (error) {
    if (currency === "USD") throw error;
    // If a native EUR/GBP read fails, serve the already cached USD series
    // through the existing explicitly labeled spot-FX fallback.
    native = [];
  }
  if (currency === "USD") return { candles: native, estimated: false };

  const nativeLast = native.at(-1);
  if (nativeLast && nativeLast.t >= now - RECHECK_WINDOW_MS && Number.isFinite(nativeLast.marketCap)) {
    return { candles: native, estimated: false };
  }

  const usd = await getNative(symbol, "USD");
  const usdLast = usd.at(-1);
  if (!usdLast) return { candles: native, estimated: false };

  // Only switch to USD where it materially improves coverage. During periods
  // where all market ingestion is delayed, keep available native candles.
  if (nativeLast && nativeLast.t >= usdLast.t - DAY_MS && Number.isFinite(nativeLast.marketCap)) {
    return { candles: native, estimated: false };
  }
  if (nativeLast && usdLast.t < nativeLast.t) return { candles: native, estimated: false };

  const rate = await getRate(currency);
  return {
    candles: convert(usd, rate),
    estimated: true,
    sourceCurrency: "USD",
    fxRate: rate,
  };
}

export function convertUsdCandles(candles, rate) {
  return candles.map(candle => ({
    ...candle,
    o: candle.o == null ? null : candle.o * rate,
    h: candle.h == null ? null : candle.h * rate,
    l: candle.l == null ? null : candle.l * rate,
    c: candle.c == null ? null : candle.c * rate,
    marketCap: candle.marketCap == null ? null : candle.marketCap * rate,
    volume: candle.volume == null ? null : candle.volume * rate,
  }));
}
