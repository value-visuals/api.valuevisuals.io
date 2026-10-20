import { createFirebaseCandleCache, getCandlesInRange, downsampleCandles } from "./firebase-candle-cache.js";
import { currencyFrom, normalize } from "./market-utils.js";
import { getUsdToFiatRate } from "./metals-fx.js";
import { convertUsdCandles, resolveCryptoCurrency } from "./crypto-currency-fallback.js";

const cache = createFirebaseCandleCache({
  symbols: ["BTC", "ETH", "XMR"],
  currencies: ["USD", "EUR", "GBP"],
  ttlSeconds: process.env.CRYPTO_MARKET_CACHE_TTL_SECONDS,
  label: "crypto-market-cache",
});

const conversionCache = new Map();

// Preserve the original candle-array API for existing callers. Estimates are
// only used when the requested currency's Firestore series is incomplete.
export async function getMarketDataWithMeta(symbol, currency = "USD") {
  const target = currencyFrom(currency);
  const key = `${normalize(symbol)}:${target}`;
  const result = await resolveCryptoCurrency({
    symbol, currency: target,
    getNative: (s, c) => cache.getMarketData(s, c),
    getRate: getUsdToFiatRate,
    convert: (usd, rate) => {
      const previous = conversionCache.get(key);
      if (previous?.source === usd && previous.rate === rate) return previous.candles;
      const candles = convertUsdCandles(usd, rate);
      conversionCache.set(key, { source: usd, rate, candles });
      console.warn(`[crypto-market-cache] ${key} native history unavailable/incomplete; using estimated USD spot-FX conversion`);
      return candles;
    },
  });
  return { ...result, currency: target };
}

export async function getMarketData(symbol, currency = "USD") {
  return (await getMarketDataWithMeta(symbol, currency)).candles;
}

export const { refreshMarketData, getMarketCacheStatus } = cache;
export const preloadCryptoMarketData = cache.preloadMarketData;
export { getCandlesInRange, downsampleCandles };
