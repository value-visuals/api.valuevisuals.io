// services/crypto-market-cache.js

import { db } from "../config/firebase.js";

const SUPPORTED_SYMBOLS = new Set(["BTC", "ETH", "XMR"]);
const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP"]);
const MAX_POINTS = 10000;
const CACHE_TTL_MS =
  Number(process.env.CRYPTO_MARKET_CACHE_TTL_SECONDS || 30) * 1000;

const marketCache = new Map();

function norm(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normCurrency(value) {
  const currency = norm(value || "USD");
  return SUPPORTED_CURRENCIES.has(currency) ? currency : "USD";
}

function cacheKey(symbol, currency) {
  return `${symbol}:${currency}`;
}

function normalizeTimestamp(value) {
  if (value == null) return null;

  if (typeof value === "object" && Number.isFinite(value.seconds)) {
    return Number(value.seconds) * 1000 +
      Math.floor(Number(value.nanoseconds || 0) / 1_000_000);
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  return numeric < 100000000000 ? numeric * 1000 : numeric;
}

function timestampFromDocumentId(docId, symbol, currency) {
  if (!docId) return null;

  const id = String(docId);
  const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(`^${esc(symbol)}_${esc(currency)}_(\\d+(?:\\.\\d+)?)$`, "i"),
    new RegExp(`^${esc(symbol)}_(\\d+(?:\\.\\d+)?)$`, "i"),
    new RegExp(`^${esc(symbol)}[-:](\\d+(?:\\.\\d+)?)$`, "i"),
  ];

  for (const pattern of patterns) {
    const match = id.match(pattern);
    if (match) return normalizeTimestamp(Number(match[1]));
  }

  return null;
}

function normalizeCandle(doc, symbol, currency) {
  const data = doc.data() || {};

  let timestamp = normalizeTimestamp(data.timestamp);

  if (!Number.isFinite(timestamp)) {
    timestamp = timestampFromDocumentId(
      doc.id,
      symbol,
      currency
    );
  }

  const price = Number(
    data.close ??
    data.price ??
    data.currentPrice
  );

  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(price)
  ) {
    return null;
  }

  const open = Number(data.open);
  const high = Number(data.high);
  const low = Number(data.low);
  const volume = data.volume != null
    ? Number(data.volume)
    : null;

  const marketCap =
    data.marketCap != null
      ? Number(data.marketCap)
      : null;

  return {
    t: timestamp,

    o: Number.isFinite(open)
      ? open
      : price,

    h: Number.isFinite(high)
      ? high
      : price,

    l: Number.isFinite(low)
      ? low
      : price,

    c: price,

    volume: Number.isFinite(volume)
      ? volume
      : null,

    marketCap: Number.isFinite(marketCap)
      ? marketCap
      : null,
  };
}

function candlesCollection(symbol, currency) {
  return db
    .collection("marketData")
    .doc(symbol)
    .collection("candles")
    .doc(currency)
    .collection("data");
}

async function loadMarketData(symbol, currency) {
  const path = `marketData/${symbol}/candles/${currency}/data`;
  console.log(`[crypto-market-cache] Loading Firebase data: ${path}`);

  const snapshot = await candlesCollection(symbol, currency).get();
  console.log(
    `[crypto-market-cache] Firebase returned ${snapshot.size} documents for ${symbol}/${currency}`
  );

  const candles = snapshot.docs
    .map((doc) => normalizeCandle(doc, symbol, currency))
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  const unique = [];
  for (const candle of candles) {
    if (unique.length && candle.t === unique[unique.length - 1].t) {
      unique[unique.length - 1] = candle;
    } else {
      unique.push(candle);
    }
  }

  const now = Date.now();
  const entry = {
    symbol,
    currency,
    candles: unique,
    loadedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    loading: null,
  };

  marketCache.set(cacheKey(symbol, currency), entry);

  console.log(
    `[crypto-market-cache] Cached ${unique.length} candles for ${symbol}/${currency}`
  );

  return entry;
}

function getOrCreateEntry(symbol, currency) {
  const key = cacheKey(symbol, currency);

  let entry = marketCache.get(key);

  if (!entry) {
    entry = {
      symbol,
      currency,
      candles: [],
      loadedAt: 0,
      expiresAt: 0,
      loading: null,
    };
    marketCache.set(key, entry);
  }

  return { key, entry };
}

function loadOnce(key, entry, symbol, currency, onError) {
  if (entry.loading) return entry.loading;

  entry.loading = loadMarketData(symbol, currency)
    .catch((error) => {
      if (onError) onError(error);

      return null;
    })
    .finally(() => {
      const current = marketCache.get(key);
      if (current) current.loading = null;
    });

  return entry.loading;
}

export async function getMarketData(symbol, currency) {
  const normalizedSymbol = norm(symbol);
  const normalizedCurrency = normCurrency(currency);
  const { key, entry } = getOrCreateEntry(
    normalizedSymbol,
    normalizedCurrency
  );

  if (entry.candles.length === 0) {
    const loaded = await loadOnce(
      key,
      entry,
      normalizedSymbol,
      normalizedCurrency
    );

    return loaded?.candles ?? [];
  }

  if (Date.now() < entry.expiresAt) {
    return entry.candles;
  }

  loadOnce(
    key,
    entry,
    normalizedSymbol,
    normalizedCurrency,
    (error) => {
      console.error(
        `[crypto-market-cache] Background refresh failed for ` +
        `${normalizedSymbol}/${normalizedCurrency}:`,
        error
      );

      const current = marketCache.get(key);
      if (current) current.expiresAt = Date.now() + CACHE_TTL_MS;
    }
  );

  return entry.candles;
}

export async function refreshMarketData(symbol, currency) {
  const normalizedSymbol = norm(symbol);
  const normalizedCurrency = normCurrency(currency);
  const { key, entry } = getOrCreateEntry(
    normalizedSymbol,
    normalizedCurrency
  );

  return loadOnce(
    key,
    entry,
    normalizedSymbol,
    normalizedCurrency
  );
}

export function getMarketCacheStatus() {
  const now = Date.now();

  return Array.from(marketCache.values()).map((entry) => ({
    symbol: entry.symbol,
    currency: entry.currency,
    candles: entry.candles.length,
    loadedAt: entry.loadedAt
      ? new Date(entry.loadedAt).toISOString()
      : null,
    expiresAt: entry.expiresAt
      ? new Date(entry.expiresAt).toISOString()
      : null,
    fresh: entry.candles.length > 0 && now < entry.expiresAt,
    loading: !!entry.loading,
  }));
}

export async function preloadMarketData() {
  for (const symbol of SUPPORTED_SYMBOLS) {
    for (const currency of SUPPORTED_CURRENCIES) {
      try {
        await getMarketData(symbol, currency);
      } catch (error) {
        console.error(
          `[crypto-market-cache] Failed to preload ${symbol}/${currency}:`,
          error
        );
      }
    }
  }
}

export function getCandlesInRange(candles, startMs, endMs) {
  if (!Array.isArray(candles) || !candles.length) return [];

  const result = [];

  for (const candle of candles) {
    if (candle.t < startMs) continue;
    if (candle.t > endMs) break;
    result.push(candle);
  }

  return result.slice(0, MAX_POINTS);
}

export function downsampleCandles(candles, intervalMs) {
  if (!Array.isArray(candles) || !candles.length) return [];

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return candles;
  }

  const buckets = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.t / intervalMs) * intervalMs;
    buckets.set(bucket, candle);
  }

  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}
