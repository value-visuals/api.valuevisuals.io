import test from "node:test";
import assert from "node:assert/strict";
import { resolveCryptoCurrency } from "../services/crypto-currency-fallback.js";

const now = Date.UTC(2026, 9, 19);
const usd = [{ t: now - 3_600_000, o: 100, h: 120, l: 90, c: 110, marketCap: 1000, volume: 500 }];
const native = [{ t: now - 3_600_000, o: 80, h: 95, l: 70, c: 88, marketCap: 800, volume: 400 }];
const rate = async () => 0.8;

test("uses native GBP candles when current and with caps", async () => {
  const result = await resolveCryptoCurrency({ symbol: "BTC", currency: "GBP", now, getNative: async (_, c) => c === "GBP" ? native : usd, getRate: () => { throw Error("Should not fetch FX"); } });
  assert.equal(result.estimated, false);
  assert.equal(result.candles, native);
});

test("converts all price, cap and volume fields when GBP history is absent", async () => {
  const result = await resolveCryptoCurrency({ symbol: "BTC", currency: "GBP", now, getNative: async (_, c) => c === "GBP" ? [] : usd, getRate: rate });
  assert.equal(result.estimated, true);
  assert.deepEqual(result.candles, [{ t: now - 3_600_000, o: 80, h: 96, l: 72, c: 88, marketCap: 800, volume: 400 }]);
  assert.equal(usd[0].c, 110);
});

test("uses USD when native GBP is stale", async () => {
  const old = [{ ...native[0], t: now - 7 * 86_400_000 }];
  const result = await resolveCryptoCurrency({ symbol: "BTC", currency: "GBP", now, getNative: async (_, c) => c === "GBP" ? old : usd, getRate: rate });
  assert.equal(result.estimated, true);
});

test("uses USD if GBP lacks market-cap values", async () => {
  const noCap = [{ ...native[0], marketCap: null }];
  const result = await resolveCryptoCurrency({ symbol: "BTC", currency: "GBP", now, getNative: async (_, c) => c === "GBP" ? noCap : usd, getRate: rate });
  assert.equal(result.estimated, true);
  assert.equal(result.candles[0].marketCap, 800);
});

test("keeps native GBP without estimating if USD has no history", async () => {
  const result = await resolveCryptoCurrency({ symbol: "BTC", currency: "GBP", now, getNative: async (_, c) => c === "GBP" ? native : [], getRate: rate });
  assert.equal(result.estimated, false);
  assert.equal(result.candles, native);
});

test("uses cached USD fallback if the native GBP Firestore read fails", async () => {
  const result = await resolveCryptoCurrency({
    symbol: "BTC", currency: "GBP", now,
    getNative: async (_, c) => { if (c === "GBP") throw new Error("GBP Firestore temporarily down"); return usd; },
    getRate: rate,
  });
  assert.equal(result.estimated, true);
  assert.equal(result.candles[0].c, 88);
});
