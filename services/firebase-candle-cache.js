import { db } from "../config/firebase.js";
import { getCandlesInRange, downsampleCandles } from "./market-utils.js";
import { createMarketSeriesCache } from "./market-cache-core.js";

function toMillis(value) {
  if (value == null) return null;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value === "object" && Number.isFinite(value.seconds)) {
    return Number(value.seconds) * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1_000_000);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric) : null;
}

function documentTimestamp(id, symbol, currency) {
  // No dynamic regular expressions: the symbol and currency have already been allowlisted.
  const prefix = new RegExp(`^${symbol}(?:[_:-]${currency})?[_:-](\\d+(?:\\.\\d+)?)$`, "i");
  const match = String(id).match(prefix);
  return match ? toMillis(match[1]) : null;
}

function toCandle(doc, symbol, currency, isMetal) {
  const data = doc.data() || {};
  const t = toMillis(data.timestamp) ?? documentTimestamp(doc.id, symbol, currency);
  const c = Number(data.close ?? data.price ?? data.currentPrice);
  if (!Number.isFinite(t) || !Number.isFinite(c) || c < 0) return null;
  const priceOr = key => data[key] == null || !Number.isFinite(Number(data[key])) ? c : Number(data[key]);
  const optional = key => data[key] != null && Number.isFinite(Number(data[key])) ? Number(data[key]) : null;
  return {
    t, o: priceOr("open"), h: priceOr("high"), l: priceOr("low"), c,
    volume: optional("volume"),
    ...(!isMetal ? { marketCap: optional("marketCap") } : {}),
  };
}

export function createFirebaseCandleCache({ symbols, currencies = ["USD"], legacyUsd = false, ttlSeconds, label = "market" }) {
  async function readData(symbol, currency) {
    const path = () => db.collection("marketData").doc(symbol).collection("candles");
    let snapshot = await path().doc(currency).collection("data").get();
    if (snapshot.empty && currency !== currency.toLowerCase()) {
      snapshot = await path().doc(currency.toLowerCase()).collection("data").get();
    }
    const candles = snapshot.docs.map(doc => toCandle(doc, symbol, currency, legacyUsd))
      .filter(Boolean).sort((a, b) => a.t - b.t);
    const unique = [];
    for (const candle of candles) {
      if (unique.length && unique[unique.length - 1].t === candle.t) unique[unique.length - 1] = candle;
      else unique.push(candle);
    }
    return unique;
  }

  return createMarketSeriesCache({ symbols, currencies, ttlSeconds, label, fetchCandles: readData });
}

export { getCandlesInRange, downsampleCandles };
