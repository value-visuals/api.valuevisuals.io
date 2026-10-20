import { getMarketData, getMarketDataWithMeta, getCandlesInRange } from "../services/crypto-market-cache.js";
import {
  DAY_MS, normalize, currencyFrom, rangeInDays, intervalInMs,
  chartData, changePercent, finiteOrNull, httpError,
} from "../services/market-utils.js";

const SYMBOLS = ["BTC", "ETH", "XMR"];
const allowed = new Set(SYMBOLS);
const latest = candles => candles.at(-1) || null;
const iso = timestamp => Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;

// Retain the original shape for clients already using /crypto/summary.
export function buildSummaryRow(symbol, currency, candles) {
  const candle = latest(candles);
  const price = finiteOrNull(candle?.c);
  const marketCap = finiteOrNull(candle?.marketCap);
  const volume24h = finiteOrNull(candle?.volume);
  const change24hPct = changePercent(candles, DAY_MS);
  return {
    symbol, price, priceUsd: currency === "USD" ? price : null,
    marketCap, marketCapUsd: currency === "USD" ? marketCap : null,
    volume24h, volume24hUsd: currency === "USD" ? volume24h : null,
    change24hPct, change24h: change24hPct == null ? null : change24hPct / 100,
    change7dPct: changePercent(candles, 7 * DAY_MS),
    provider: "firebase", source: "marketData", currency,
    timestamp: candle?.t ?? null, updatedAt: iso(candle?.t),
  };
}

export async function getFirebaseGlobal(req, res, next) {
  try {
    const currency = currencyFrom(req.query.currency);
    const rows = await Promise.all(SYMBOLS.map(async symbol => buildSummaryRow(symbol, currency, await getMarketData(symbol, currency))));
    const assets = rows.map(row => ({ symbol: row.symbol, marketCap: row.marketCap, volume24h: row.volume24h, timestamp: row.timestamp }));
    const marketCapValues = rows.map(row => row.marketCap).filter(Number.isFinite);
    const volumeValues = rows.map(row => row.volume24h).filter(Number.isFinite);
    const marketCap = marketCapValues.length ? marketCapValues.reduce((a, b) => a + b, 0) : null;
    const volume24h = volumeValues.length ? volumeValues.reduce((a, b) => a + b, 0) : null;
    const btcMarketCap = rows.find(row => row.symbol === "BTC")?.marketCap;
    const newest = rows.map(row => row.timestamp).filter(Number.isFinite);
    return res.json({
      marketCap, marketCapUsd: currency === "USD" ? marketCap : null,
      volume24h, volume24hUsd: currency === "USD" ? volume24h : null,
      btcDominancePct: btcMarketCap > 0 && marketCap > 0 ? btcMarketCap / marketCap * 100 : null,
      currency, provider: "firebase", source: "marketData", symbols: SYMBOLS, assets,
      // Only crypto has market-cap candles in the existing schema.
      marketCapCoverage: { included: marketCapValues.length, expected: SYMBOLS.length, excludedAssets: ["XAU", "XAG"] },
      updatedAt: newest.length ? iso(Math.max(...newest)) : null,
    });
  } catch (error) { next(error); }
}

export async function getFirebaseSummary(req, res, next) {
  try {
    const currency = currencyFrom(req.query.currency);
    const raw = req.query.symbols ?? "BTC,ETH,XMR";
    if (typeof raw !== "string" || raw.length > 40) throw httpError(400, "Invalid symbols", "INVALID_SYMBOLS");
    const symbols = [...new Set(raw.split(",").map(normalize).filter(Boolean))];
    if (!symbols.length || symbols.some(symbol => !allowed.has(symbol))) {
      return res.status(400).json({ error: "Unsupported Firebase crypto symbol(s)", symbols, supportedSymbols: SYMBOLS });
    }
    const data = await Promise.all(symbols.map(async symbol => buildSummaryRow(symbol, currency, await getMarketData(symbol, currency))));
    const updated = data.map(row => row.timestamp).filter(Number.isFinite);
    return res.json({ symbols, currency, data, provider: "firebase", source: "marketData", updatedAt: updated.length ? iso(Math.max(...updated)) : null });
  } catch (error) { next(error); }
}

export async function getFirebaseChart(req, res, next) {
  try {
    const symbol = normalize(req.query.symbol ?? "BTC");
    const currency = currencyFrom(req.query.currency);
    const rawRange = String(req.query.range ?? "30d").trim().toLowerCase();
    const rawInterval = String(req.query.interval ?? "auto").trim().toLowerCase();
    if (!allowed.has(symbol)) return res.status(400).json({ error: `Unsupported Firebase crypto symbol: ${symbol}`, symbol, supportedSymbols: SYMBOLS });
    const days = rangeInDays(rawRange);
    const intervalMs = intervalInMs(rawInterval, days);
    const endMs = Date.now();
    const result = await getMarketDataWithMeta(symbol, currency);
    const fullSeries = result.candles;
    const rawCandles = getCandlesInRange(fullSeries, endMs - days * DAY_MS, endMs);
    const { candles, effectiveIntervalMs } = chartData(rawCandles, intervalMs);
    return res.json({
      symbol, currency, interval: rawInterval, range: rawRange, days, candles,
      effectiveIntervalMs, count: candles.length, rawCount: rawCandles.length,
      provider: "firebase", source: "marketData", updatedAt: iso(latest(fullSeries)?.t),
      ...(result.estimated ? { fxEstimate: { sourceCurrency: "USD", rate: result.fxRate, note: "USD history converted using current FX rate; historical GBP/EUR values are estimates." } } : {}),
    });
  } catch (error) { next(error); }
}
