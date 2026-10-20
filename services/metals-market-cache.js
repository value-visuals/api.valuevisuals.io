import { createFirebaseCandleCache, getCandlesInRange, downsampleCandles } from "./firebase-candle-cache.js";

// Preserve the canonical USD path and the historic lowercase `usd` fallback.
const cache = createFirebaseCandleCache({
  symbols: ["XAU", "XAG"],
  legacyUsd: true,
  ttlSeconds: process.env.METALS_MARKET_CACHE_TTL_SECONDS,
  label: "metals-market-cache",
});

export const { getMarketData, refreshMarketData, getMarketCacheStatus } = cache;
export const preloadMetalsMarketData = cache.preloadMarketData;
export { getCandlesInRange, downsampleCandles };
