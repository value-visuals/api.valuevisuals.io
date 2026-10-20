import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS, currencyFrom, rangeInDays, intervalInMs,
  downsampleCandles, getCandlesInRange, chartData, changePercent,
} from "../services/market-utils.js";
import { aggregateMarketCap } from "../services/market-cap.js";

test("supported currencies stay strict (no accidental USD fallback)", () => {
  assert.equal(currencyFrom("eur"), "EUR");
  assert.equal(currencyFrom(), "USD");
  assert.throws(() => currencyFrom("JPY"), /Unsupported currency/);
});

test("range and interval are bounded and support frontend presets", () => {
  assert.equal(rangeInDays("24h"), 1);
  assert.equal(rangeInDays("3m"), 90);
  assert.equal(rangeInDays("1y"), 365);
  assert.equal(intervalInMs("h1"), 3_600_000);
  assert.throws(() => rangeInDays("99999y"), /Range must be within/);
  assert.throws(() => rangeInDays("false"), /Invalid range/);
  assert.throws(() => intervalInMs("false"), /Invalid interval/);
});

test("range selection uses entire history without dropping most recent candles", () => {
  const candles = Array.from({ length: 15_001 }, (_, i) => ({ t: i * 60_000, o: i, h: i, l: i, c: i }));
  const selected = getCandlesInRange(candles, 0, Infinity);
  assert.equal(selected.length, 15_001);
  const chart = chartData(selected, 60_000, 2000);
  assert.ok(chart.candles.length <= 2000);
  assert.equal(chart.candles.at(-1).c, 15_000);
  assert.ok(chart.effectiveIntervalMs > 60_000);
});

test("OHLC buckets preserve first open, max high, min low, last close", () => {
  const values = [
    { t: 0, o: 3, h: 8, l: 2, c: 5, volume: 90, marketCap: 100 },
    { t: 10, o: 5, h: 9, l: 1, c: 6, volume: 95, marketCap: 120 },
    { t: 100, o: 6, h: 6, l: 3, c: 4, volume: 99, marketCap: 130 },
  ];
  const result = downsampleCandles(values, 50);
  assert.deepEqual(result[0], { t: 10, o: 3, h: 9, l: 1, c: 6, volume: 95, marketCap: 120 });
  assert.equal(result.length, 2);
});

test("price change checks reference before exact comparison timestamp", () => {
  const candles = [{ t: 0, c: 10 }, { t: DAY_MS, c: 12 }, { t: DAY_MS * 2, c: 15 }];
  assert.equal(changePercent(candles, DAY_MS), 25);
  assert.equal(changePercent(candles, DAY_MS * 5), null);
});

test("market cap aggregation never treats a partial series as total market cap", () => {
  const btc = [{ t: 0, marketCap: 100 }, { t: 1000, marketCap: 110 }];
  const eth = [{ t: 0, marketCap: 50 }, { t: 2000, marketCap: 70 }];
  const xmr = [{ t: 0, marketCap: 10 }, { t: 3000, marketCap: 20 }];
  const result = aggregateMarketCap([btc, eth, xmr]);
  assert.deepEqual(result.map(r => [r.t, r.c]), [[0, 160], [1000, 170], [2000, 190], [3000, 200]]);
  assert.deepEqual(aggregateMarketCap([btc, [], xmr]), []);
  assert.deepEqual(aggregateMarketCap([btc, [{ t: DAY_MS * 2, marketCap: 50 }], xmr]), []);
});
