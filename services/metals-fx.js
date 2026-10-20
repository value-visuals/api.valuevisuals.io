import axios from "axios";
import { currencyFrom } from "./market-utils.js";

const urls = [
  "https://api.coinbase.com/v2/exchange-rates?currency=USD",
  "https://open.er-api.com/v6/latest/USD",
];
const parsedTtl = Number(process.env.METALS_FX_CACHE_TTL_SECONDS);
const ttlMs = (Number.isFinite(parsedTtl) && parsedTtl >= 30 && parsedTtl <= 86400 ? parsedTtl : 300) * 1000;
const cached = new Map();
const inflight = new Map();

export async function getUsdToFiatRate(target) {
  const currency = currencyFrom(target);
  if (currency === "USD") return 1;
  const previous = cached.get(currency);
  if (previous && previous.expiresAt > Date.now()) return previous.rate;
  if (inflight.has(currency)) return inflight.get(currency);
  const pending = (async () => {
    for (const url of urls) {
      try {
        const { data } = await axios.get(url, { timeout: 6000 });
        const rate = Number(data?.data?.rates?.[currency] ?? data?.rates?.[currency]);
        if (Number.isFinite(rate) && rate > 0) {
          cached.set(currency, { rate, expiresAt: Date.now() + ttlMs });
          return rate;
        }
      } catch (error) {
        console.warn(`[fx] Currency source unavailable: ${error?.code || error?.message}`);
      }
    }
    // A previously valid FX conversion is better than failing every public page on provider downtime.
    if (previous) return previous.rate;
    throw Object.assign(new Error("FX rate temporarily unavailable"), { status: 503, code: "FX_UNAVAILABLE" });
  })().finally(() => inflight.delete(currency));
  inflight.set(currency, pending);
  return pending;
}

export const convertCandle = (candle, rate) => ({
  ...candle,
  o: candle.o == null ? null : candle.o * rate,
  h: candle.h == null ? null : candle.h * rate,
  l: candle.l == null ? null : candle.l * rate,
  c: candle.c == null ? null : candle.c * rate,
});
export const convertCandles = (candles, rate) => rate === 1 ? candles : candles.map(c => convertCandle(c, rate));
