import test from "node:test";
import assert from "node:assert/strict";
import { createMarketSeriesCache } from "../services/market-cache-core.js";
import { warmMarketCaches } from "../services/market-cache-warmup.js";

const candle = price => [{ t: 1_600_000_000_000, c: price, marketCap: price * 10 }];
const pause = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const calls = [];
  const cache = createMarketSeriesCache({
    symbols: ["BTC", "ETH", "XMR"], currencies: ["USD", "EUR", "GBP"],
    label: "test-cache", ttlSeconds: 900,
    fetchCandles: async (symbol, currency) => {
      calls.push(`${symbol}/${currency}`);
      return candle(calls.length);
    }, ...options,
  });
  return { cache, calls };
}

test("startup loads USD series first, then EUR and GBP, without undefined results", async () => {
  const { cache, calls } = harness();
  const metals = createMarketSeriesCache({
    symbols: ["XAU", "XAG"], currencies: ["USD"], label: "metals",
    fetchCandles: async () => candle(5),
  });
  const log = { info() {}, warn() {} };
  const fxRates = [];
  const results = await warmMarketCaches({
    preloadCrypto: cache.preloadMarketData,
    preloadMetals: metals.preloadMarketData,
    getRate: async currency => { fxRates.push(currency); return 1.2; }, logger: log,
  });
  assert.equal(results.usd.length, 5);
  assert.equal(results.fiat.length, 6);
  assert.equal(results.usd.filter(x => x.status === "ready").length, 5);
  assert.equal(results.fiat.filter(x => x.status === "ready").length, 6);
  assert.deepEqual(calls.slice(0, 3).map(x => x.split("/")[1]), ["USD", "USD", "USD"]);
  assert.deepEqual(new Set(fxRates), new Set(["EUR", "GBP"]));
  assert.equal(cache.getMarketCacheStatus().filter(x => x.loaded).length, 9);
  assert.equal(metals.getMarketCacheStatus().filter(x => x.loaded).length, 2);
});

test("all concurrent cold requests share one Firestore load", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const { cache } = harness({ fetchCandles: async () => { reads++; await waiting; return candle(11); } });
  const promises = Array.from({ length: 30 }, () => cache.getMarketData("BTC", "USD"));
  await pause();
  assert.equal(reads, 1);
  release();
  const rows = await Promise.all(promises);
  assert.equal(reads, 1);
  assert.ok(rows.every(x => x.length === 1));
});

test("expired data responds immediately and refreshes in background without erasing old history", async () => {
  let time = 100_000;
  let refresh = null;
  let reads = 0;
  const { cache } = harness({
    now: () => time,
    ttlSeconds: 5,
    fetchCandles: async () => {
      reads++;
      if (reads === 1) return candle(100);
      return new Promise(resolve => { refresh = resolve; });
    },
  });
  await cache.getMarketData("BTC", "USD");
  time += 6_000;
  const stale = await cache.getMarketData("BTC", "USD");
  assert.equal(stale[0].c, 100);
  assert.equal(reads, 2);
  assert.equal(cache.getMarketCacheStatus()[0].loading, true);
  refresh([]);
  await pause();
  assert.equal((await cache.getMarketData("BTC", "USD"))[0].c, 100);
});

test("a failed Firestore load does not abort other pairs and retries after cooldown", async () => {
  let time = 100_000;
  const calls = new Map();
  const { cache } = harness({
    now: () => time,
    fetchCandles: async (symbol, currency) => {
      const key = `${symbol}/${currency}`;
      calls.set(key, (calls.get(key) || 0) + 1);
      if (key === "ETH/USD" && calls.get(key) === 1) throw new Error("simulated database outage");
      return candle(9);
    },
  });
  const first = await cache.preloadMarketData({ currencies: ["USD"] });
  assert.deepEqual(first.map(x => x.status), ["ready", "failed", "ready"]);
  await assert.rejects(() => cache.getMarketData("ETH", "USD"), /temporarily unavailable/);
  assert.equal(calls.get("ETH/USD"), 1);
  time += 10_001;
  assert.equal((await cache.getMarketData("ETH", "USD")).length, 1);
  assert.equal(calls.get("ETH/USD"), 2);
});

test("empty series is reported empty, retries later and does not mark as ready", async () => {
  let time = 100_000;
  let reads = 0;
  const { cache } = harness({
    now: () => time,
    fetchCandles: async () => ++reads === 1 ? [] : candle(88),
  });
  const result = await cache.preloadMarketData({ currencies: ["USD"], concurrency: 1 });
  assert.equal(result[0].status, "empty");
  assert.equal(cache.getMarketCacheStatus()[0].loaded, false);
  await cache.getMarketData("BTC", "USD");
  assert.equal(reads, 3); // The other two symbols also loaded during the preload.
  time += 30_001;
  assert.equal((await cache.getMarketData("BTC", "USD"))[0].c, 88);
});

test("startup handles a malformed or rejected preloader without crashing", async () => {
  const warnings = [];
  const result = await warmMarketCaches({
    preloadCrypto: async ({ currencies }) => currencies.includes("USD") ? undefined : [undefined],
    preloadMetals: async () => { throw new Error("offline"); },
    getRate: async () => { throw new Error("fx down"); },
    logger: { info() {}, warn: message => warnings.push(message) },
  });
  assert.equal(result.usd.filter(item => item.status === "failed").length, 2);
  assert.equal(result.fiat[0].status, "failed");
  assert.ok(warnings.length >= 4);
});
