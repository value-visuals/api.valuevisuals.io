// controllers/metals.controller.js
import axios from "axios";
import {
  getMarketData,
  getCandlesInRange,
  downsampleCandles,
} from "../services/metals-market-cache.js";

const SUPPORTED_SYMBOLS = new Set(["XAU", "XAG"]);
const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP"]);
const MAX_POINTS = 10000;
const DAY_MS = 86400000;

const norm = (v) => String(v ?? "").trim().toUpperCase();

function normCurrency(v) {
  const c = norm(v || "USD");
  return SUPPORTED_CURRENCIES.has(c) ? c : "USD";
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseSymbol(v) {
  const raw = norm(v || "XAU/USD");
  return { symbol: raw.includes("/") ? raw.split("/")[0] : raw };
}

function parseRangeToDays(range) {
  const m = String(range || "30d").trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([dwmy])$/);

  if (!m) return 30;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 30;

  return n * ({ d: 1, w: 7, m: 30, y: 365 }[m[2]] || 1);
}

function intervalToMilliseconds(interval, days) {
  const v = String(interval || "auto").trim().toLowerCase();

  if (v === "auto") {
    if (days <= 2) return 15 * 60 * 1000;
    if (days <= 7) return 30 * 60 * 1000;
    if (days <= 30) return 60 * 60 * 1000;
    if (days <= 90) return 4 * 60 * 60 * 1000;
    if (days <= 180) return 12 * 60 * 60 * 1000;
    return DAY_MS;
  }

  return ({
    m1: 60000,
    m5: 300000,
    m15: 900000,
    m30: 1800000,
    h1: 3600000,
    h2: 7200000,
    h4: 14400000,
    h6: 21600000,
    h12: 43200000,
    d1: DAY_MS,
  }[v] || 3600000);
}

// FX
const fxCache = new Map();
const FX_TTL_MS =
  Number(process.env.METALS_FX_CACHE_TTL_SECONDS || 300) * 1000;

const FX_URLS = [
  "https://api.coinbase.com/v2/exchange-rates?currency=USD",
  "https://open.er-api.com/v6/latest/USD",
];

function getFxCache(key) {
  const cached = fxCache.get(key);
  if (!cached || Date.now() > cached.expiresAt) {
    fxCache.delete(key);
    return null;
  }
  return cached.value;
}

function setFxCache(key, value) {
  fxCache.set(key, {
    value,
    expiresAt: Date.now() + FX_TTL_MS,
  });
}

async function getUsdToFiatRate(target) {
  const currency = normCurrency(target);
  if (currency === "USD") return 1;

  const key = `USD:${currency}`;
  const cached = getFxCache(key);
  if (Number.isFinite(cached)) return cached;

  for (const url of FX_URLS) {
    try {
      const { data } = await axios.get(url, { timeout: 8000 });
      const rate = Number(
        data?.data?.rates?.[currency] ?? data?.rates?.[currency]
      );

      if (Number.isFinite(rate) && rate > 0) {
        setFxCache(key, rate);
        return rate;
      }
    } catch (error) {
      console.warn(
        `[metals.controller] FX failed for ${currency}:`,
        error?.message || error
      );
    }
  }

  throw new Error(`FX rate not available for ${currency}`);
}

// Conversion
function convertCandle(candle, rate) {
  if (!candle) return null;

  return {
    ...candle,
    o: toNum(candle.o) !== null ? candle.o * rate : null,
    h: toNum(candle.h) !== null ? candle.h * rate : null,
    l: toNum(candle.l) !== null ? candle.l * rate : null,
    c: toNum(candle.c) !== null ? candle.c * rate : null,
    volume: candle.volume ?? null,
  };
}

function convertCandles(candles, rate) {
  if (!Array.isArray(candles)) return [];
  if (rate === 1) return candles;

  return candles.map(c => convertCandle(c, rate)).filter(Boolean);
}

// 24h change
function find24hReferenceCandle(candles, latestTimestamp) {
  if (
    !Array.isArray(candles) ||
    candles.length < 2 ||
    !Number.isFinite(latestTimestamp)
  ) return null;

  const target = latestTimestamp - DAY_MS;
  let reference = null;

  for (const candle of candles) {
    if (!Number.isFinite(candle?.t)) continue;
    if (candle.t > target) break;
    reference = candle;
  }

  return reference;
}

function calculate24hChange(latest, candles) {
  const current = Number(latest?.c);
  if (!latest || !Number.isFinite(current) || current <= 0) {
    return { change24hPct: null, change24h: null };
  }

  const previous = Number(
    find24hReferenceCandle(candles, latest.t)?.c
  );

  if (!Number.isFinite(previous) || previous <= 0) {
    return { change24hPct: null, change24h: null };
  }

  const pct = ((current - previous) / previous) * 100;
  return { change24hPct: pct, change24h: pct / 100 };
}

function buildSummaryRow(symbol, currency, candles) {
  const latest = candles?.length ? candles[candles.length - 1] : null;

  if (!latest) {
    return {
      symbol: `${symbol}/${currency}`,
      base: symbol,
      currency,
      price: null,
      priceUsd: null,
      change: null,
      percentChange: null,
      change24h: null,
      change24hPct: null,
      open: null,
      high: null,
      low: null,
      previousClose: null,
      datetime: null,
      timestamp: null,
      updatedAt: null,
      provider: "firebase",
      source: "marketData",
    };
  }

  const price = toNum(latest.c);
  const timestamp = Number.isFinite(latest.t) ? latest.t : null;
  const { change24hPct, change24h } =
    calculate24hChange(latest, candles);

  const iso = timestamp !== null
    ? new Date(timestamp).toISOString()
    : null;

  return {
    symbol: `${symbol}/${currency}`,
    base: symbol,
    currency,
    price,
    priceUsd: currency === "USD" ? price : null,
    change: change24hPct,
    percentChange: change24hPct,
    change24hPct,
    change24h,
    open: toNum(latest.o),
    high: toNum(latest.h),
    low: toNum(latest.l),
    previousClose: null,
    datetime: iso,
    timestamp,
    updatedAt: iso,
    provider: "firebase",
    source: "marketData",
  };
}

// GET /metals/summary
export async function getSummary(req, res, next) {
  try {
    const rawBase = norm(req.query.base);
    const base = {
      GOLD: "XAU",
      SILVER: "XAG",
    }[rawBase] || rawBase || null;

    if (base && !SUPPORTED_SYMBOLS.has(base)) {
      return res.status(400).json({
        error: `Unsupported metal symbol: ${base}. Supported symbols: XAU, XAG.`,
        supportedSymbols: [...SUPPORTED_SYMBOLS],
      });
    }

    const currency = normCurrency(req.query.currency);
    const symbols = base ? [base] : [...SUPPORTED_SYMBOLS];

    const usdData = await Promise.all(
      symbols.map(async symbol => ({
        symbol,
        candles: await getMarketData(symbol),
      }))
    );

    const rate = await getUsdToFiatRate(currency);

    const items = usdData.map(({ symbol, candles }) =>
      buildSummaryRow(
        symbol,
        currency,
        convertCandles(candles, rate)
      )
    );

    const latestTimestamp = items.reduce(
      (latest, item) =>
        Number.isFinite(item.timestamp) &&
        (latest === null || item.timestamp > latest)
          ? item.timestamp
          : latest,
      null
    );

    return res.json({
      updatedAt: latestTimestamp !== null
        ? new Date(latestTimestamp).toISOString()
        : new Date().toISOString(),
      currency,
      provider: "firebase",
      source: "marketData",
      symbols,
      items,
    });
  } catch (error) {
    console.error("[/metals/summary] Firebase error:", error);
    next(error);
  }
}

// GET /metals/chart
export async function getChart(req, res, next) {
  try {
    const requestedSymbol = req.query.symbol || "XAU/USD";
    const { symbol } = parseSymbol(requestedSymbol);

    const requestedCurrency = norm(
      req.query.currency ||
      String(requestedSymbol).split("/")[1] ||
      "USD"
    );

    const rawRange = String(req.query.range || "30d")
      .trim().toLowerCase();

    const rawInterval = String(req.query.interval || "auto")
      .trim().toLowerCase();

    if (!SUPPORTED_SYMBOLS.has(symbol)) {
      return res.status(400).json({
        error: `Unsupported metal symbol: ${symbol}. Supported symbols: XAU, XAG.`,
        symbol,
        supportedSymbols: [...SUPPORTED_SYMBOLS],
      });
    }

    if (!SUPPORTED_CURRENCIES.has(requestedCurrency)) {
      return res.status(400).json({
        error:
          `Unsupported currency: ${requestedCurrency}. ` +
          `Supported currencies: USD, EUR, GBP.`,
        currency: requestedCurrency,
        supportedCurrencies: [...SUPPORTED_CURRENCIES],
      });
    }

    const days = parseRangeToDays(rawRange);
    const endMs = Date.now();
    const startMs = endMs - days * DAY_MS;
    const intervalMs = intervalToMilliseconds(rawInterval, days);

    const usdCandles = await getMarketData(symbol);
    const rawUsdCandles = getCandlesInRange(
      usdCandles,
      startMs,
      endMs
    );

    const baseResponse = {
      symbol: `${symbol}/${requestedCurrency}`,
      base: symbol,
      currency: requestedCurrency,
      interval: rawInterval,
      range: rawRange,
      days,
      provider: "firebase",
      source: "marketData",
    };

    if (!rawUsdCandles.length) {
      return res.json({
        ...baseResponse,
        candles: [],
        count: 0,
        rawCount: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    const rate = await getUsdToFiatRate(requestedCurrency);

    const candles = downsampleCandles(
      convertCandles(rawUsdCandles, rate),
      intervalMs
    ).slice(-MAX_POINTS);

    const latest = candles.at(-1);

    return res.json({
      ...baseResponse,
      candles,
      count: candles.length,
      rawCount: rawUsdCandles.length,
      updatedAt: Number.isFinite(latest?.t)
        ? new Date(latest.t).toISOString()
        : new Date().toISOString(),
    });
  } catch (error) {
    console.error("[/metals/chart] Firebase error:", error);
    next(error);
  }
}
