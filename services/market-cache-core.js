import { normalize, httpError } from "./market-utils.js";

const EMPTY_RETRY_MS = 30_000;
const ERROR_RETRY_MS = 10_000;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 3600;

function cacheTtlMs(value) {
  const seconds = Number(value);
  return (Number.isFinite(seconds) && seconds >= MIN_TTL_SECONDS && seconds <= MAX_TTL_SECONDS
    ? seconds : 900) * 1000;
}

/**
 * Process-local, single-flight candle cache. The caller supplies the Firestore
 * reader so cache correctness and startup behavior can be tested without Firebase.
 */
export function createMarketSeriesCache({ symbols, currencies = ["USD"], ttlSeconds, label, fetchCandles, now = Date.now }) {
  const allowedSymbols = new Set(symbols);
  const allowedCurrencies = new Set(currencies);
  const ttlMs = cacheTtlMs(ttlSeconds);
  const entries = new Map();

  function entryFor(symbol, currency = "USD") {
    const s = normalize(symbol);
    const c = normalize(currency);
    if (!allowedSymbols.has(s) || !allowedCurrencies.has(c)) {
      throw httpError(400, `Unsupported market pair: ${s}/${c}`, "INVALID_PAIR");
    }
    const key = `${s}:${c}`;
    if (!entries.has(key)) {
      entries.set(key, {
        symbol: s, currency: c, candles: [], loaded: false,
        loadedAt: 0, expiresAt: 0, loading: null, lastError: null,
      });
    }
    return entries.get(key);
  }

  function load(entry) {
    if (entry.loading) return entry.loading;
    const task = (async () => {
      try {
        const candles = await fetchCandles(entry.symbol, entry.currency);
        if (!Array.isArray(candles)) throw new Error("Candle provider returned invalid data");
        // A transient empty read must not evict valid historical data.
        if (candles.length || !entry.loaded) {
          entry.candles = candles;
          entry.loaded = true;
          entry.loadedAt = now();
        }
        entry.lastError = null;
        entry.expiresAt = now() + (candles.length ? ttlMs : EMPTY_RETRY_MS);
        return entry.candles;
      } catch (error) {
        entry.lastError = error?.message || "Unknown Firestore error";
        entry.expiresAt = now() + ERROR_RETRY_MS;
        console.error(`[${label}] ${entry.symbol}/${entry.currency} refresh failed:`, entry.lastError);
        // Keep the last successful snapshot for existing clients.
        if (entry.loaded) return entry.candles;
        throw error;
      }
    })();
    entry.loading = task;
    // Clear the *exact* promise, even on rejection, without creating an
    // unhandled rejected promise via an unobserved .finally() chain.
    void task.then(
      () => { if (entry.loading === task) entry.loading = null; },
      () => { if (entry.loading === task) entry.loading = null; },
    );
    return task;
  }

  async function getMarketData(symbol, currency = "USD") {
    const entry = entryFor(symbol, currency);
    if (!entry.loaded) {
      if (entry.loading) return entry.loading;
      if (entry.lastError && now() < entry.expiresAt) {
        throw httpError(503, "Market history temporarily unavailable", "MARKET_CACHE_UNAVAILABLE");
      }
      return load(entry);
    }
    if (now() >= entry.expiresAt) {
      if (entry.candles.length === 0) return load(entry);
      // Serve a warm snapshot immediately; one refresh runs in the background.
      if (!entry.loading) void load(entry).catch(() => {});
    }
    return entry.candles;
  }

  async function refreshMarketData(symbol, currency = "USD") {
    return load(entryFor(symbol, currency));
  }

  function getMarketCacheStatus() {
    const time = now();
    return [...entries.values()].map(entry => ({
      symbol: entry.symbol, currency: entry.currency, candles: entry.candles.length,
      loaded: entry.loaded && entry.candles.length > 0,
      loadedAt: entry.loadedAt ? new Date(entry.loadedAt).toISOString() : null,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      fresh: entry.loaded && entry.candles.length > 0 && entry.expiresAt > time,
      loading: Boolean(entry.loading),
      lastError: entry.lastError,
    }));
  }

  /** Return exactly one explicit outcome per market pair (never `undefined`). */
  async function preloadMarketData({ currencies: targets = currencies, concurrency = 3 } = {}) {
    const pairs = [];
    for (const currency of targets) {
      for (const symbol of symbols) {
        entryFor(symbol, currency); // validate pairs before launching requests
        pairs.push({ symbol, currency });
      }
    }
    const outcomes = Array(pairs.length);
    let next = 0;
    const parallel = Math.max(1, Math.min(5, Math.floor(Number(concurrency) || 3), pairs.length));
    await Promise.all(Array.from({ length: parallel }, async () => {
      while (next < pairs.length) {
        const index = next++;
        const { symbol, currency } = pairs[index];
        try {
          const candles = await getMarketData(symbol, currency);
          outcomes[index] = { symbol, currency, status: candles.length ? "ready" : "empty", candles: candles.length };
        } catch (error) {
          outcomes[index] = { symbol, currency, status: "failed", candles: 0, error: error?.message || "Cache load failed" };
        }
      }
    }));
    return outcomes;
  }

  return { getMarketData, refreshMarketData, getMarketCacheStatus, preloadMarketData };
}
