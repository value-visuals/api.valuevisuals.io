import { getMarketData, getCandlesInRange, downsampleCandles } from "../services/crypto-market-cache.js";

const SUPPORTED_SYMBOLS = new Set(["BTC", "ETH", "XMR"]);
const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP"]);
const MAX_POINTS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

const norm = value => String(value ?? "").trim().toUpperCase();

function normCurrency(value) {
  const currency = norm(value || "USD");
  return SUPPORTED_CURRENCIES.has(currency) ? currency : "USD";
}

function parseRangeToDays(range) {
  const match = String(range || "30d").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([dwmy])$/);
  if (!match) return 30;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 30;
  return amount * ({ d: 1, w: 7, m: 30, y: 365 }[match[2]] || 1);
}

function intervalToMilliseconds(interval, days) {
  const value = String(interval || "auto").trim().toLowerCase();
  if (value === "auto") {
    if (days <= 2) return 5 * 60 * 1000;
    if (days <= 7) return 15 * 60 * 1000;
    if (days <= 30) return 60 * 60 * 1000;
    if (days <= 90) return 6 * 60 * 60 * 1000;
    return DAY_MS;
  }

  return ({
    m1: 60 * 1000,
    m5: 5 * 60 * 1000,
    m15: 15 * 60 * 1000,
    m30: 30 * 60 * 1000,
    h1: 60 * 60 * 1000,
    h2: 2 * 60 * 60 * 1000,
    h4: 4 * 60 * 60 * 1000,
    h6: 6 * 60 * 60 * 1000,
    h12: 12 * 60 * 60 * 1000,
    d1: DAY_MS,
  }[value] || 60 * 60 * 1000);
}

function find24hReferenceCandle(candles, latestTimestamp) {
  if (!Array.isArray(candles) || candles.length < 2 || !Number.isFinite(latestTimestamp)) return null;

  const target = latestTimestamp - DAY_MS;
  let reference = null;

  for (const candle of candles) {
    if (!Number.isFinite(candle?.t)) continue;
    if (candle.t > target) break;
    reference = candle;
  }

  return reference;
}

function calculate24hChange(latestCandle, candles) {
  const currentPrice = Number(latestCandle?.c);

  if (!latestCandle || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { change24hPct: null, change24h: null };
  }

  const previousPrice = Number(find24hReferenceCandle(candles, latestCandle.t)?.c);

  if (!Number.isFinite(previousPrice) || previousPrice <= 0) {
    return { change24hPct: null, change24h: null };
  }

  const change24hPct = ((currentPrice - previousPrice) / previousPrice) * 100;
  return { change24hPct, change24h: change24hPct / 100 };
}

/**
 * Calculate the percentage price change over the previous 7 days.
 *
 * This intentionally remains separate from the existing 24h calculation.
 * The reference candle is the latest candle at or before the timestamp
 * exactly 7 days before the latest available candle.
 */
function calculate7dChange(latestCandle, candles) {
  if (!latestCandle || !Array.isArray(candles) || candles.length < 2) return null;

  const currentPrice = Number(latestCandle?.c);
  const latestTimestamp = Number(latestCandle?.t);

  if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(latestTimestamp)) return null;

  const targetTimestamp = latestTimestamp - (7 * DAY_MS);
  let referenceCandle = null;

  for (const candle of candles) {
    const timestamp = Number(candle?.t);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp > targetTimestamp) break;
    referenceCandle = candle;
  }

  const referencePrice = Number(referenceCandle?.c);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;

  return ((currentPrice - referencePrice) / referencePrice) * 100;
}

function buildSummaryRow(symbol, currency, candles) {
  const latestCandle = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;

  if (!latestCandle) {
    return {
      symbol,
      price: null,
      priceUsd: null,
      marketCap: null,
      marketCapUsd: null,
      volume24h: null,
      volume24hUsd: null,
      change24hPct: null,
      change24h: null,
      change7dPct: null,
      provider: "firebase",
      source: "marketData",
      currency,
      timestamp: null,
      updatedAt: null,
    };
  }

  const price = Number(latestCandle.c);
  const marketCapValue = Number(latestCandle.marketCap);
  const volumeValue = Number(latestCandle.volume);
  const marketCap = Number.isFinite(marketCapValue) ? marketCapValue : null;
  const volume24h = Number.isFinite(volumeValue) ? volumeValue : null;
  const { change24hPct, change24h } = calculate24hChange(latestCandle, candles);
  const change7dPct = calculate7dChange(latestCandle, candles);
  const timestamp = Number.isFinite(latestCandle.t) ? latestCandle.t : null;

  return {
    symbol,
    price: Number.isFinite(price) ? price : null,
    priceUsd: currency === "USD" && Number.isFinite(price) ? price : null,
    marketCap,
    marketCapUsd: currency === "USD" ? marketCap : null,
    volume24h,
    volume24hUsd: currency === "USD" ? volume24h : null,
    change24hPct,
    change24h,
    change7dPct,
    provider: "firebase",
    source: "marketData",
    currency,
    timestamp,
    updatedAt: timestamp ? new Date(timestamp).toISOString() : null,
  };
}

export async function getFirebaseGlobal(req, res, next) {
  try {
    const currency = normCurrency(req.query.currency || "USD");
    const symbols = [...SUPPORTED_SYMBOLS];

    const results = await Promise.all(symbols.map(async symbol => {
      const candles = await getMarketData(symbol, currency);
      const latest = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;

      return {
        symbol,
        marketCap: Number.isFinite(Number(latest?.marketCap)) ? Number(latest.marketCap) : null,
        volume24h: Number.isFinite(Number(latest?.volume)) ? Number(latest.volume) : null,
        timestamp: Number.isFinite(latest?.t) ? latest.t : null,
      };
    }));

    let marketCap = 0;
    let volume24h = 0;
    let hasMarketCap = false;
    let hasVolume = false;
    let latestTimestamp = null;

    for (const asset of results) {
      if (Number.isFinite(asset.marketCap)) {
        marketCap += asset.marketCap;
        hasMarketCap = true;
      }

      if (Number.isFinite(asset.volume24h)) {
        volume24h += asset.volume24h;
        hasVolume = true;
      }

      if (Number.isFinite(asset.timestamp) && (latestTimestamp === null || asset.timestamp > latestTimestamp)) {
        latestTimestamp = asset.timestamp;
      }
    }

    const btc = results.find(asset => asset.symbol === "BTC");
    const btcDominancePct = Number.isFinite(btc?.marketCap) && btc.marketCap > 0 && marketCap > 0
      ? (btc.marketCap / marketCap) * 100
      : null;

    return res.json({
      marketCap: hasMarketCap ? marketCap : null,
      marketCapUsd: currency === "USD" && hasMarketCap ? marketCap : null,
      volume24h: hasVolume ? volume24h : null,
      volume24hUsd: currency === "USD" && hasVolume ? volume24h : null,
      btcDominancePct,
      currency,
      provider: "firebase",
      source: "marketData",
      symbols,
      assets: results,
      updatedAt: latestTimestamp !== null ? new Date(latestTimestamp).toISOString() : new Date().toISOString(),
    });
  } catch (error) {
    console.error("[crypto-fb] Failed to load Firebase crypto global data:", error);
    next(error);
  }
}

export async function getFirebaseSummary(req, res, next) {
  try {
    const currency = normCurrency(req.query.currency || "USD");
    const symbols = (req.query.symbols || "BTC,ETH,XMR").toString().split(",").map(norm).filter(Boolean);
    const unsupported = symbols.filter(symbol => !SUPPORTED_SYMBOLS.has(symbol));

    if (unsupported.length) {
      return res.status(400).json({
        error:
          `Unsupported Firebase crypto symbol(s): ${unsupported.join(", ")}. ` +
          `Supported symbols: ${[...SUPPORTED_SYMBOLS].join(", ")}.`,
        symbols,
        supportedSymbols: [...SUPPORTED_SYMBOLS],
      });
    }

    const data = await Promise.all(symbols.map(async symbol =>
      buildSummaryRow(symbol, currency, await getMarketData(symbol, currency))
    ));

    return res.json({
      symbols,
      currency,
      data,
      provider: "firebase",
      source: "marketData",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[crypto-fb] Failed to load cached Firebase crypto summary:", error);
    next(error);
  }
}

export async function getFirebaseChart(req, res, next) {
  try {
    const symbol = norm(req.query.symbol || "BTC");
    const currency = normCurrency(req.query.currency || "USD");
    const rawRange = String(req.query.range || "30d").trim().toLowerCase();
    const rawInterval = String(req.query.interval || "auto").trim().toLowerCase();

    if (!SUPPORTED_SYMBOLS.has(symbol)) {
      return res.status(400).json({
        error:
          `Unsupported Firebase crypto symbol: ${symbol}. ` +
          `Supported symbols: BTC, ETH, XMR.`,
        symbol,
        supportedSymbols: [...SUPPORTED_SYMBOLS],
      });
    }

    if (!SUPPORTED_CURRENCIES.has(currency)) {
      return res.status(400).json({
        error:
          `Unsupported crypto currency: ${currency}. ` +
          `Supported currencies: USD, EUR, GBP.`,
        currency,
        supportedCurrencies: [...SUPPORTED_CURRENCIES],
      });
    }

    const days = parseRangeToDays(rawRange);
    const endMs = Date.now();
    const startMs = endMs - days * DAY_MS;
    const intervalMs = intervalToMilliseconds(rawInterval, days);
    const marketData = await getMarketData(symbol, currency);
    const rawCandles = getCandlesInRange(marketData, startMs, endMs);

    if (!rawCandles.length) {
      return res.json({
        symbol,
        currency,
        interval: rawInterval,
        range: rawRange,
        days,
        candles: [],
        provider: "firebase",
        source: "marketData",
        count: 0,
        rawCount: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    const candles = downsampleCandles(rawCandles, intervalMs).slice(-MAX_POINTS);

    return res.json({
      symbol,
      currency,
      interval: rawInterval,
      range: rawRange,
      days,
      candles,
      count: candles.length,
      rawCount: rawCandles.length,
      provider: "firebase",
      source: "marketData",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[crypto-fb] Failed to load cached Firebase crypto chart:", error);
    next(error);
  }
}
