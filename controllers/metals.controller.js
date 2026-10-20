import { getMarketData, getCandlesInRange } from "../services/metals-market-cache.js";
import { getUsdToFiatRate, convertCandles } from "../services/metals-fx.js";
import {
  DAY_MS, normalize, currencyFrom, rangeInDays, intervalInMs,
  chartData, changePercent, finiteOrNull,
} from "../services/market-utils.js";

const SYMBOLS = ["XAU", "XAG"];
const allowed = new Set(SYMBOLS);
const aliases = { GOLD: "XAU", SILVER: "XAG" };
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;

export function buildSummaryRow(symbol, currency, candles) {
  const candle = candles.at(-1) || null;
  const price = finiteOrNull(candle?.c);
  const timestamp = candle?.t ?? null;
  const change24hPct = changePercent(candles, DAY_MS);
  return {
    symbol: `${symbol}/${currency}`, base: symbol, currency,
    price, priceUsd: currency === "USD" ? price : null,
    change: change24hPct, percentChange: change24hPct,
    change24hPct, change24h: change24hPct == null ? null : change24hPct / 100,
    change7dPct: changePercent(candles, 7 * DAY_MS),
    open: finiteOrNull(candle?.o), high: finiteOrNull(candle?.h), low: finiteOrNull(candle?.l),
    previousClose: null, datetime: iso(timestamp), timestamp, updatedAt: iso(timestamp),
    provider: "firebase", source: "marketData",
  };
}

export async function getSummary(req, res, next) {
  try {
    const requested = normalize(req.query.base);
    const base = aliases[requested] || requested;
    if (base && !allowed.has(base)) {
      return res.status(400).json({ error: `Unsupported metal symbol: ${base}`, supportedSymbols: SYMBOLS });
    }
    const currency = currencyFrom(req.query.currency);
    const symbols = base ? [base] : SYMBOLS;
    const [rate, ...histories] = await Promise.all([
      getUsdToFiatRate(currency), ...symbols.map(symbol => getMarketData(symbol)),
    ]);
    const items = symbols.map((symbol, i) => buildSummaryRow(symbol, currency, convertCandles(histories[i], rate)));
    const updated = items.map(item => item.timestamp).filter(Number.isFinite);
    return res.json({
      updatedAt: updated.length ? iso(Math.max(...updated)) : null,
      currency, provider: "firebase", source: "marketData", symbols, items,
    });
  } catch (error) { next(error); }
}

export async function getChart(req, res, next) {
  try {
    const requestedSymbol = String(req.query.symbol ?? "XAU/USD");
    const normalized = normalize(requestedSymbol);
    const symbol = aliases[normalized.split("/")[0]] || normalized.split("/")[0];
    const requestedCurrency = currencyFrom(req.query.currency ?? normalized.split("/")[1]);
    const rawRange = String(req.query.range ?? "30d").trim().toLowerCase();
    const rawInterval = String(req.query.interval ?? "auto").trim().toLowerCase();
    if (!allowed.has(symbol)) {
      return res.status(400).json({ error: `Unsupported metal symbol: ${symbol}`, symbol, supportedSymbols: SYMBOLS });
    }
    const days = rangeInDays(rawRange);
    const intervalMs = intervalInMs(rawInterval, days, true);
    const endMs = Date.now();
    const usdCandles = await getMarketData(symbol);
    const rawUsdCandles = getCandlesInRange(usdCandles, endMs - days * DAY_MS, endMs);
    const rate = rawUsdCandles.length ? await getUsdToFiatRate(requestedCurrency) : 1;
    const { candles, effectiveIntervalMs } = chartData(convertCandles(rawUsdCandles, rate), intervalMs);
    const newest = usdCandles.at(-1);
    return res.json({
      symbol: `${symbol}/${requestedCurrency}`, base: symbol, currency: requestedCurrency,
      interval: rawInterval, range: rawRange, days, provider: "firebase", source: "marketData",
      candles, count: candles.length, rawCount: rawUsdCandles.length, effectiveIntervalMs,
      updatedAt: iso(newest?.t),
    });
  } catch (error) { next(error); }
}
