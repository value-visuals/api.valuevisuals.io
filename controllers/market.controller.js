import { getMarketData as getCryptoData, getMarketDataWithMeta as getCryptoDataWithMeta, getMarketCacheStatus as getCryptoCacheStatus } from "../services/crypto-market-cache.js";
import { getMarketData as getMetalData, getMarketCacheStatus as getMetalCacheStatus } from "../services/metals-market-cache.js";
import { getUsdToFiatRate, convertCandles } from "../services/metals-fx.js";
import { buildSummaryRow as cryptoRow } from "./crypto.controller.js";
import { buildSummaryRow as metalRow } from "./metals.controller.js";
import { currencyFrom, DAY_MS, rangeInDays, intervalInMs, chartData, getCandlesInRange } from "../services/market-utils.js";
import { aggregateMarketCap } from "../services/market-cap.js";

const CRYPTO = ["BTC", "ETH", "XMR"];
const METALS = ["XAU", "XAG"];
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;

// GET /api/market/overview - ready for the public homepage tiles and top gainers.
export async function getOverview(req, res, next) {
  try {
    const currency = currencyFrom(req.query.currency);
    const [rate, ...histories] = await Promise.all([
      getUsdToFiatRate(currency),
      ...CRYPTO.map(symbol => getCryptoData(symbol, currency)),
      ...METALS.map(symbol => getMetalData(symbol)),
    ]);
    const assets = [...CRYPTO.map((symbol, i) => {
      const row = cryptoRow(symbol, currency, histories[i]);
      return { ...row, type: "crypto", name: { BTC: "Bitcoin", ETH: "Ethereum", XMR: "Monero" }[symbol] };
    }), ...METALS.map((symbol, i) => {
      const row = metalRow(symbol, currency, convertCandles(histories[i + CRYPTO.length], rate));
      return { ...row, symbol, type: "metal", name: symbol === "XAU" ? "Gold" : "Silver", marketCap: null, marketCapUsd: null, volume24h: null, volume24hUsd: null };
    })];
    const ranked = assets.filter(asset => Number.isFinite(asset.change24hPct)).sort((a, b) => b.change24hPct - a.change24hPct);
    const caps = assets.filter(asset => Number.isFinite(asset.marketCap));
    const marketCap = caps.length ? caps.reduce((total, asset) => total + asset.marketCap, 0) : null;
    const updated = assets.map(asset => asset.timestamp).filter(Number.isFinite);
    return res.json({
      currency, assets, gainers: ranked.slice(0, 5), losers: ranked.toReversed().slice(0, 5),
      marketCap, marketCapUsd: currency === "USD" ? marketCap : null,
      marketCapCoverage: { includedSymbols: caps.map(asset => asset.symbol), excludedSymbols: assets.filter(asset => !Number.isFinite(asset.marketCap)).map(asset => asset.symbol), note: "Only assets with a recorded circulating market capitalization are included; precious-metal spot prices are not market caps." },
      updatedAt: updated.length ? iso(Math.max(...updated)) : null,
    });
  } catch (error) { next(error); }
}

// GET /api/market/cap/chart - value-visuals crypto market-cap history (NOT global market cap).
export async function getMarketCapChart(req, res, next) {
  try {
    const currency = currencyFrom(req.query.currency);
    const rawRange = String(req.query.range ?? "30d").trim().toLowerCase();
    const rawInterval = String(req.query.interval ?? "auto").trim().toLowerCase();
    const days = rangeInDays(rawRange);
    const intervalMs = intervalInMs(rawInterval, days);
    const endMs = Date.now();
    // Include prior observation so the first aligned point has meaningful values.
    const resolved = await Promise.all(CRYPTO.map(symbol => getCryptoDataWithMeta(symbol, currency)));
    const histories = resolved.map(result => result.candles);
    const fxEstimatedSymbols = CRYPTO.filter((_, i) => resolved[i].estimated);
    const startMs = endMs - days * DAY_MS;
    const series = histories.map(candles => {
      const inRange = getCandlesInRange(candles, startMs, endMs);
      const prior = getCandlesInRange(candles, 0, startMs).at(-1);
      return prior ? [prior, ...inRange] : inRange;
    });
    const aggregated = aggregateMarketCap(series).filter(point => point.t >= startMs);
    const { candles, effectiveIntervalMs } = chartData(aggregated, intervalMs);
    return res.json({
      currency, interval: rawInterval, range: rawRange, days, candles,
      points: candles.map(candle => ({ t: candle.t, marketCap: candle.c })),
      count: candles.length, rawCount: aggregated.length, effectiveIntervalMs,
      symbols: CRYPTO, excludedSymbols: METALS, coverage: "BTC, ETH and XMR only; metals do not have market-cap records",
      provider: "firebase", source: "marketData",
      updatedAt: iso(aggregated.at(-1)?.t),
      ...(fxEstimatedSymbols.length ? { fxEstimate: { sourceCurrency: "USD", symbols: fxEstimatedSymbols, note: "USD market-cap history converted using current FX rate. These are estimates, not historically accurate FX values." } } : {}),
    });
  } catch (error) { next(error); }
}

// Restricted cache inspection for the operator: never publish internal cache details.
export function getCacheStatus(_req, res) {
  const crypto = getCryptoCacheStatus();
  const metals = getMetalCacheStatus();
  const all = [...crypto, ...metals];
  res.set("Cache-Control", "no-store");
  return res.json({
    instance: "process-local",
    checkedAt: new Date().toISOString(),
    entries: all.length,
    loaded: all.filter(item => item.loaded).length,
    refreshing: all.filter(item => item.loading).length,
    crypto, metals,
  });
}
