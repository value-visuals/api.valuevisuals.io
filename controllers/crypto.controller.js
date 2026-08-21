// controllers/crypto.controller.js
// Node 18+ has global fetch; no extra deps needed.

const P = {
  COINGECKO: "https://api.coingecko.com/api/v3",

  COINPAPRIKA: "https://api.coinpaprika.com/v1",
  COINCAP: "https://api.coincap.io/v2",
  COINBASE: "https://api.exchange.coinbase.com",

  FX_COINBASE:
    "https://api.coinbase.com/v2/exchange-rates?currency=USD",

  FX_OPEN_ER:
    "https://open.er-api.com/v6/latest/USD",
};


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const norm = (s) =>
  String(s || "")
    .trim()
    .toUpperCase();

const normSymbol = (s) => norm(s);

const normFiat = (s) => {
  const f = norm(s || "USD");

  // Guard against non-3-letter values
  return /^[A-Z]{3}$/.test(f) ? f : "USD";
};


// -----------------------------------------------------------------------------
// Tiny in-memory cache
// Swap for Redis later without changing route shapes.
// -----------------------------------------------------------------------------

const cache = new Map(); // key -> { data, exp }

function setCache(key, data, ttlSec) {
  cache.set(key, {
    data,
    exp: Date.now() + ttlSec * 1000,
  });
}

function getCache(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() > item.exp) {
    cache.delete(key);
    return null;
  }

  return item.data;
}


// -----------------------------------------------------------------------------
// Generic GET with minimal retry/backoff
// -----------------------------------------------------------------------------

async function httpGet(url, init = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
    });

    if (res.ok) {
      return res.json();
    }

    if (
      i < retries &&
      (res.status === 429 || res.status >= 500)
    ) {
      const delay =
        res.status === 429
          ? 1000 * Math.pow(2, i)
          : 500 * (i + 1);

      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    const text = await res.text().catch(() => "");

    throw new Error(
      `GET ${url} failed: ${res.status} ${text}`
    );
  }
}


// -----------------------------------------------------------------------------
// Cross-provider ids for core assets
// -----------------------------------------------------------------------------

const IDMAP = {
  BTC: {
    coingecko: "bitcoin",
    coincap: "bitcoin",
    paprika: "btc-bitcoin",

    coinbase: {
      USD: "BTC-USD",
      EUR: "BTC-EUR",
      GBP: "BTC-GBP",
    },
  },

  ETH: {
    coingecko: "ethereum",
    coincap: "ethereum",
    paprika: "eth-ethereum",

    coinbase: {
      USD: "ETH-USD",
      EUR: "ETH-EUR",
      GBP: "ETH-GBP",
    },
  },

  XMR: {
    coingecko: "monero",
    coincap: "monero",
    paprika: "xmr-monero",

    coinbase: null,
  },
};


// -----------------------------------------------------------------------------
// FX (USD -> target fiat)
// -----------------------------------------------------------------------------

async function getUsdToFiatRate(targetFiat) {
  const fiat = normFiat(targetFiat);

  if (fiat === "USD") return 1;

  const key = `fx:USD:${fiat}`;

  const hit = getCache(key);

  if (hit) return hit;


  // 1) Try Coinbase FX
  try {
    const cb = await httpGet(
      P.FX_COINBASE,
      {},
      1
    );

    const rateStr = cb?.data?.rates?.[fiat];

    const rate =
      rateStr != null
        ? Number(rateStr)
        : undefined;

    if (
      rate &&
      isFinite(rate) &&
      rate > 0
    ) {
      setCache(key, rate, 300);
      return rate;
    }
  } catch (_) {
    // Ignore and fall through.
  }


  // 2) Fallback: Open ER API
  try {
    const er = await httpGet(
      P.FX_OPEN_ER,
      {},
      1
    );

    const rate = er?.rates?.[fiat];

    if (
      rate &&
      isFinite(Number(rate)) &&
      Number(rate) > 0
    ) {
      setCache(
        key,
        Number(rate),
        300
      );

      return Number(rate);
    }
  } catch (_) {
    // Ignore and throw below.
  }

  throw new Error(
    `FX rate not available for ${fiat}`
  );
}


function convertVal(
  valUsd,
  usdToFiatRate
) {
  if (valUsd == null) return null;

  const n = Number(valUsd);

  if (!isFinite(n)) return null;

  return n * usdToFiatRate;
}


function convertOHLC(
  candles,
  usdToFiatRate
) {
  return (candles || []).map((c) => ({
    t: c.t,

    o:
      c.o != null
        ? c.o * usdToFiatRate
        : null,

    h:
      c.h != null
        ? c.h * usdToFiatRate
        : null,

    l:
      c.l != null
        ? c.l * usdToFiatRate
        : null,

    c:
      c.c != null
        ? c.c * usdToFiatRate
        : null,
  }));
}


/* ============================================================================
   PROVIDER HELPERS
   ========================================================================== */


/* -----------------------------------------------------------------------------
   CoinGecko
   -------------------------------------------------------------------------- */

/**
 * CoinGecko market_chart returns:
 *
 * {
 *   prices: [
 *     [timestamp, price],
 *     ...
 *   ],
 *   market_caps: [...],
 *   total_volumes: [...]
 * }
 *
 * Our frontend already knows how to consume `candles`, so normalize the
 * CoinGecko price series into our backend candle shape.
 *
 * CoinGecko prices are effectively close-only for our purposes here:
 *
 *   o = price
 *   h = price
 *   l = price
 *   c = price
 */
async function coingeckoChart({
  coinId,
  currency,
  days,
}) {
  const params = new URLSearchParams({
    vs_currency: normFiat(currency).toLowerCase(),
    days: String(days),
  });

  const url =
    `${P.COINGECKO}/coins/${encodeURIComponent(
      coinId
    )}/market_chart?${params.toString()}`;

  const headers = {
    Accept: "application/json",
  };

  // If you have a CoinGecko API key, use it.
  //
  // This supports the common environment-variable naming:
  //
  //   COINGECKO_API_KEY
  //
  // without requiring one.
  if (process.env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] =
      process.env.COINGECKO_API_KEY;
  }

  const data = await httpGet(
    url,
    { headers },
    1
  );

  const prices = Array.isArray(
    data?.prices
  )
    ? data.prices
    : [];

  const candles = prices
    .map((row) => {
      const t = Number(row?.[0]);
      const price = Number(row?.[1]);

      return {
        t,
        o: price,
        h: price,
        l: price,
        c: price,
      };
    })
    .filter(
      (c) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.c)
    )
    .sort((a, b) => a.t - b.t);

  // Remove duplicate timestamps.
  const unique = [];

  let lastT = null;

  for (const candle of candles) {
    if (candle.t === lastT) {
      unique[
        unique.length - 1
      ] = candle;
    } else {
      unique.push(candle);
      lastT = candle.t;
    }
  }

  return unique;
}


/* -----------------------------------------------------------------------------
   CoinPaprika
   -------------------------------------------------------------------------- */

async function paprikaGlobal() {
  const url =
    `${P.COINPAPRIKA}/global`;

  const data = await httpGet(
    url,
    {},
    1
  );

  return {
    marketCapUsd:
      data.market_cap_usd ?? null,

    volume24hUsd:
      data.volume_24h_usd ?? null,

    btcDominancePct:
      data.bitcoin_dominance_percentage ??
      null,

    updatedAt:
      data.last_updated ??
      new Date().toISOString(),

    provider: "coinpaprika",
  };
}


// Currency-aware tickers from Paprika where possible.
async function paprikaTickers(
  pairs,
  currency
) {
  const out = [];

  const cur = normFiat(currency);

  for (const p of pairs) {
    const url =
      `${P.COINPAPRIKA}/tickers/${p.paprikaId}`;

    const t = await httpGet(
      url,
      {},
      1
    );

    const qUSD =
      t.quotes?.USD;

    const qCUR =
      t.quotes?.[cur];

    out.push({
      symbol: p.symbol,

      price:
        qCUR?.price ?? null,

      marketCap:
        qCUR?.market_cap ?? null,

      volume24h:
        qCUR?.volume_24h ?? null,

      // Always include USD baselines
      priceUsd:
        qUSD?.price ?? null,

      marketCapUsd:
        qUSD?.market_cap ?? null,

      volume24hUsd:
        qUSD?.volume_24h ?? null,

      change24hPct:
        qUSD?.percent_change_24h ??
        null,

      provider:
        "coinpaprika",

      currency: cur,
    });
  }

  return out;
}


/* -----------------------------------------------------------------------------
   CoinCap
   -------------------------------------------------------------------------- */

async function coincapAssets(ids) {
  const url =
    `${P.COINCAP}/assets?ids=${ids.join(",")}`;

  const headers =
    process.env.COINCAP_API_KEY
      ? {
          Authorization:
            `Bearer ${process.env.COINCAP_API_KEY}`,
        }
      : undefined;

  const data = await httpGet(
    url,
    { headers },
    1
  );

  return (data.data || []).map(
    (a) => ({
      symbol:
        a.symbol?.toUpperCase(),

      priceUsd:
        a.priceUsd
          ? Number(a.priceUsd)
          : null,

      change24hPct:
        a.changePercent24Hr
          ? Number(
              a.changePercent24Hr
            )
          : null,

      marketCapUsd:
        a.marketCapUsd
          ? Number(
              a.marketCapUsd
            )
          : null,

      volume24hUsd:
        a.volumeUsd24Hr
          ? Number(
              a.volumeUsd24Hr
            )
          : null,

      provider: "coincap",
    })
  );
}


// CoinCap intraday/daily candles.
async function coincapCandles({
  baseId,
  interval,
  startMs,
  endMs,
}) {
  const headers =
    process.env.COINCAP_API_KEY
      ? {
          Authorization:
            `Bearer ${process.env.COINCAP_API_KEY}`,
        }
      : undefined;

  const url =
    `${P.COINCAP}/candles` +
    `?exchange=coinbase-pro` +
    `&interval=${interval}` +
    `&baseId=${baseId}` +
    `&quoteId=usd` +
    `&start=${startMs}` +
    `&end=${endMs}`;

  const d = await httpGet(
    url,
    { headers },
    1
  );

  const candles =
    (d.data || [])
      .map((c) => {
        let t = Number(
          c.period
        );

        if (
          Number.isFinite(t) &&
          t < 10_000_000_000
        ) {
          t *= 1000;
        }

        return {
          t,
          o: Number(c.open),
          h: Number(c.high),
          l: Number(c.low),
          c: Number(c.close),
        };
      })
      .filter(
        (c) =>
          Number.isFinite(c.t) &&
          Number.isFinite(c.o) &&
          Number.isFinite(c.h) &&
          Number.isFinite(c.l) &&
          Number.isFinite(c.c) &&
          c.t >= startMs &&
          c.t <= endMs
      )
      .sort(
        (a, b) => a.t - b.t
      );

  // Remove duplicate timestamps.
  const unique = [];

  let lastT = null;

  for (const candle of candles) {
    if (candle.t === lastT) {
      unique[
        unique.length - 1
      ] = candle;
    } else {
      unique.push(candle);
      lastT = candle.t;
    }
  }

  return unique;
}


// CoinCap history fallback.
async function coincapHistory({
  baseId,
  interval,
  startMs,
  endMs,
}) {
  const headers =
    process.env.COINCAP_API_KEY
      ? {
          Authorization:
            `Bearer ${process.env.COINCAP_API_KEY}`,
        }
      : undefined;

  const url =
    `${P.COINCAP}/assets/${baseId}/history` +
    `?interval=${interval}` +
    `&start=${startMs}` +
    `&end=${endMs}`;

  const d = await httpGet(
    url,
    { headers },
    1
  );

  return (d.data || [])
    .map((pt) => {
      let t = Number(
        pt.time ?? pt.period
      );

      if (
        !Number.isFinite(t) &&
        pt.date
      ) {
        t = new Date(
          pt.date
        ).getTime();
      }

      if (
        Number.isFinite(t) &&
        t < 10_000_000_000
      ) {
        t *= 1000;
      }

      const price =
        Number(pt.priceUsd);

      return {
        t,
        o: price,
        h: price,
        l: price,
        c: price,
      };
    })
    .filter(
      (c) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.c) &&
        c.t >= startMs &&
        c.t <= endMs
    )
    .sort(
      (a, b) => a.t - b.t
    );
}


/* -----------------------------------------------------------------------------
   Coinbase
   -------------------------------------------------------------------------- */

// Coinbase Exchange candles.
// Granularities:
// 60, 300, 900, 3600, 21600, 86400

function mapIntervalToCoinbaseGranularity(
  interval
) {
  const m = {
    m1: 60,
    m5: 300,
    m15: 900,
    m30: 1800,
    h1: 3600,
    h2: 7200,
    h6: 21600,
    h12: 43200,
    d1: 86400,
  };

  let g =
    m[interval] || 3600;

  const allowed = [
    60,
    300,
    900,
    3600,
    21600,
    86400,
  ];

  if (!allowed.includes(g)) {
    g = allowed.reduce(
      (prev, cur) =>
        Math.abs(cur - g) <
        Math.abs(prev - g)
          ? cur
          : prev,
      allowed[0]
    );
  }

  return g;
}


// Ensure <= 300 points.
function adjustGranularityForRange(
  initialGranularitySec,
  startMs,
  endMs
) {
  const allowed = [
    60,
    300,
    900,
    3600,
    21600,
    86400,
  ];

  let g =
    initialGranularitySec;

  const rangeMs =
    endMs - startMs;

  while (
    rangeMs / (g * 1000) >
    300
  ) {
    const i =
      allowed.indexOf(g);

    if (
      i === -1 ||
      i === allowed.length - 1
    ) {
      break;
    }

    g = allowed[i + 1];
  }

  return g;
}


async function coinbaseCandles({
  productId,
  interval,
  startMs,
  endMs,
}) {
  let gran = mapIntervalToCoinbaseGranularity(interval);

  gran = adjustGranularityForRange(
    gran,
    startMs,
    Math.min(
      endMs,
      startMs + 299 * gran * 1000
    )
  );

  const MAX_CANDLES_PER_REQUEST = 290;

  const chunkMs =
    MAX_CANDLES_PER_REQUEST * gran * 1000;

  const allCandles = [];

  let cursorStart = startMs;

  while (cursorStart < endMs) {
    /*
     * Coinbase allows a maximum of 300 aggregations.
     *
     * Stay slightly below that limit to avoid boundary/inclusive
     * counting issues.
     */
    const cursorEnd = Math.min(
      endMs,
      cursorStart + chunkMs
    );

    const startISO = new Date(cursorStart).toISOString();
    const endISO = new Date(cursorEnd).toISOString();

    const url =
      `${P.COINBASE}/products/${productId}/candles` +
      `?granularity=${gran}` +
      `&start=${startISO}` +
      `&end=${endISO}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "cachecloud-api",
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");

      throw new Error(
        `GET ${url} failed: ${res.status} ${txt}`
      );
    }

    const arr = await res.json();

    const candles = (arr || [])
      .map((row) => ({
        t: Number(row[0]) * 1000,
        l: Number(row[1]),
        h: Number(row[2]),
        o: Number(row[3]),
        c: Number(row[4]),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.t) &&
          Number.isFinite(c.o) &&
          Number.isFinite(c.h) &&
          Number.isFinite(c.l) &&
          Number.isFinite(c.c) &&
          c.t >= startMs &&
          c.t <= endMs
      );

    allCandles.push(...candles);

    /*
     * Move to the next chunk.
     *
     * Advance by one complete candle so that the next request
     * doesn't intentionally overlap the previous candle.
     */
    cursorStart = cursorEnd + gran * 1000;
  }

  /*
   * Sort and remove duplicate timestamps.
   */
  allCandles.sort((a, b) => a.t - b.t);

  const unique = [];
  let lastT = null;

  for (const candle of allCandles) {
    if (candle.t === lastT) {
      unique[unique.length - 1] = candle;
    } else {
      unique.push(candle);
      lastT = candle.t;
    }
  }

  return unique;
}


/* -----------------------------------------------------------------------------
   Range helpers
   -------------------------------------------------------------------------- */

// Human range parser: d/w/m/y
function parseRangeToDays(
  rangeStr
) {
  const s = String(
    rangeStr || ""
  )
    .trim()
    .toLowerCase();

  const m =
    s.match(
      /^(\d+)\s*([dwmy])$/
    );

  if (m) {
    const n =
      Number(m[1]);

    const unit =
      m[2];

    if (unit === "d")
      return n;

    if (unit === "w")
      return n * 7;

    if (unit === "m")
      return n * 30;

    if (unit === "y")
      return n * 365;
  }

  if (s.endsWith("d")) {
    return (
      Number(
        s.slice(0, -1)
      ) || 30
    );
  }

  if (s === "1y") {
    return 365;
  }

  return 30;
}


// Pick a sane OHLC interval.
function pickIntervalAuto(
  days
) {
  if (days <= 2)
    return "m5";

  if (days <= 3)
    return "m15";

  if (days <= 7)
    return "m30";

  if (days <= 14)
    return "h1";

  if (days <= 30)
    return "h2";

  if (days <= 90)
    return "h6";

  return "d1";
}


/* ============================================================================
   CONTROLLERS
   ========================================================================== */


/* -----------------------------------------------------------------------------
   GET /api/crypto/global?currency=EUR
   -------------------------------------------------------------------------- */

export async function getGlobal(
  req,
  res,
  next
) {
  try {
    const currency =
      normFiat(
        req.query.currency ||
          "USD"
      );

    const key =
      `global:${currency}`;

    const hit =
      getCache(key);

    if (hit) {
      return res.json(hit);
    }

    let base;

    try {
      base =
        await paprikaGlobal();
    } catch {
      // CoinCap approximation if Paprika unavailable.
      const headers =
        process.env.COINCAP_API_KEY
          ? {
              Authorization:
                `Bearer ${process.env.COINCAP_API_KEY}`,
            }
          : undefined;

      const top =
        await httpGet(
          `${P.COINCAP}/assets?limit=200`,
          { headers },
          1
        );

      const arr =
        top.data || [];

      const marketCapUsd =
        arr.reduce(
          (s, a) =>
            s +
            Number(
              a.marketCapUsd || 0
            ),
          0
        );

      const volume24hUsd =
        arr.reduce(
          (s, a) =>
            s +
            Number(
              a.volumeUsd24Hr ||
                0
            ),
          0
        );

      base = {
        marketCapUsd,
        volume24hUsd,
        btcDominancePct: null,
        updatedAt:
          new Date().toISOString(),
        provider:
          "coincap-approx",
      };
    }

    let out = {
      ...base,
      currency,
      marketCap: null,
      volume24h: null,
    };

    if (currency === "USD") {
      out.marketCap =
        base.marketCapUsd;

      out.volume24h =
        base.volume24hUsd;
    } else {
      const r =
        await getUsdToFiatRate(
          currency
        );

      out.marketCap =
        convertVal(
          base.marketCapUsd,
          r
        );

      out.volume24h =
        convertVal(
          base.volume24hUsd,
          r
        );
    }

    setCache(
      key,
      out,
      60
    );

    res.json(out);
  } catch (err) {
    next(err);
  }
}


/* -----------------------------------------------------------------------------
   GET /api/crypto/summary?symbols=BTC,ETH&currency=GBP
   -------------------------------------------------------------------------- */

export async function getSummary(
  req,
  res,
  next
) {
  try {
    const currency =
      normFiat(
        req.query.currency ||
          "USD"
      );

    const symbols =
      (req.query.symbols ||
        "BTC,ETH")
        .toString()
        .split(",")
        .map((s) =>
          normSymbol(s)
        )
        .filter(Boolean);

    const key =
      `summary:${symbols.join(",")}:${currency}`;

    const hit =
      getCache(key);

    if (hit) {
      return res.json(hit);
    }

    // 1) Paprika first.
    const paprikaPairs =
      symbols
        .filter(
          (s) =>
            IDMAP[s]?.paprika
        )
        .map((s) => ({
          symbol: s,
          paprikaId:
            IDMAP[s].paprika,
        }));

    let list = [];

    try {
      if (
        paprikaPairs.length
      ) {
        list =
          await paprikaTickers(
            paprikaPairs,
            currency
          );
      }
    } catch {
      list = [];
    }

    // 2) Fill missing symbols via CoinCap.
    const missingSyms =
      symbols.filter(
        (s) =>
          !list.find(
            (x) =>
              x.symbol === s
          ) &&
          IDMAP[s]?.coincap
      );

    if (
      missingSyms.length
    ) {
      const ids =
        missingSyms.map(
          (s) =>
            IDMAP[s].coincap
        );

      const cc =
        await coincapAssets(
          ids
        );

      const ccMapped =
        cc
          .filter((x) =>
            missingSyms.includes(
              x.symbol
            )
          )
          .map((x) => ({
            symbol: x.symbol,

            price: null,
            marketCap: null,
            volume24h: null,

            priceUsd:
              x.priceUsd,

            marketCapUsd:
              x.marketCapUsd,

            volume24hUsd:
              x.volume24hUsd,

            change24hPct:
              x.change24hPct,

            provider:
              x.provider,

            currency,
          }));

      list =
        list.concat(
          ccMapped
        );
    }

    // 3) Conversion pass.
    if (currency !== "USD") {
      const usdToFiat =
        await getUsdToFiatRate(
          currency
        );

      list =
        list.map((x) => ({
          ...x,

          price:
            x.price ??
            convertVal(
              x.priceUsd,
              usdToFiat
            ),

          marketCap:
            x.marketCap ??
            convertVal(
              x.marketCapUsd,
              usdToFiat
            ),

          volume24h:
            x.volume24h ??
            convertVal(
              x.volume24hUsd,
              usdToFiat
            ),

          currency,
        }));
    } else {
      list =
        list.map((x) => ({
          ...x,

          price:
            x.price ??
            x.priceUsd ??
            null,

          marketCap:
            x.marketCap ??
            x.marketCapUsd ??
            null,

          volume24h:
            x.volume24h ??
            x.volume24hUsd ??
            null,

          currency,
        }));
    }

    // 4) Guarantee order + shape.
    const normalized =
      symbols.map((s) => {
        const found =
          list.find(
            (x) =>
              x.symbol === s
          );

        return (
          found || {
            symbol: s,
            price: null,
            priceUsd: null,
            change24hPct: null,
            marketCap: null,
            marketCapUsd: null,
            volume24h: null,
            volume24hUsd: null,
            provider: null,
            currency,
          }
        );
      });

    const out = {
      symbols,
      currency,
      data: normalized,
      updatedAt:
        new Date().toISOString(),
    };

    setCache(
      key,
      out,
      20
    );

    res.json(out);
  } catch (err) {
    next(err);
  }
}


/* -----------------------------------------------------------------------------
   GET /api/crypto/chart?symbol=BTC&interval=auto&range=2w&currency=EUR
   -------------------------------------------------------------------------- */

export async function getChart(
  req,
  res,
  next
) {
  try {
    const symbol =
      norm(
        req.query.symbol ||
          "BTC"
      );

    const currency =
      normFiat(
        req.query.currency ||
          "USD"
      );

    const rawInterval =
      String(
        req.query.interval ||
          "auto"
      );

    const rawRange =
      String(
        req.query.range ||
          "30d"
      );

    const ids =
      IDMAP[symbol];

    if (!ids) {
      return res
        .status(400)
        .json({
          error:
            `Unsupported symbol: ${symbol}`,
        });
    }

    const now =
      Date.now();

    const days =
      parseRangeToDays(
        rawRange
      );

    const startMs =
      now -
      days *
        24 *
        60 *
        60 *
        1000;

    const interval =
      rawInterval === "auto"
        ? pickIntervalAuto(
            days
          )
        : rawInterval;


    // -------------------------------------------------------------------------
    // Backend cache
    //
    // This is checked BEFORE contacting CoinGecko.
    //
    // Therefore:
    //
    // frontend -> backend
    //          -> cache hit
    //          -> no provider request
    //
    // This substantially reduces provider traffic.
    // -------------------------------------------------------------------------

    const key =
      `chart:${symbol}:${interval}:${days}d:${currency}`;

    const hit =
      getCache(key);

    if (hit) {
      return res.json(hit);
    }


    let candles = [];
    let provider = null;
    let convertedFrom = null;


    /* =========================================================================
       1) COINGECKO — PRIMARY CHART PROVIDER
       ========================================================================= */

    if (
      !process.env.DISABLE_COINGECKO
    ) {
      try {
        candles =
          await coingeckoChart({
            coinId:
              ids.coingecko,
            currency,
            days,
          });

        if (
          candles &&
          candles.length > 0
        ) {
          provider =
            "coingecko";
        }
      } catch (err) {
        console.warn(
          `[crypto.chart] CoinGecko failed for ${symbol}/${days}d:`,
          err?.message ||
            err
        );

        // Intentionally continue to
        // existing providers.
      }
    }


    /* =========================================================================
       2) COINCAP CANDLES
       ========================================================================= */

    if (
      !candles ||
      candles.length === 0
    ) {
      if (
        !process.env.DISABLE_COINCAP
      ) {
        try {
          candles =
            await coincapCandles({
              baseId:
                ids.coincap,
              interval,
              startMs,
              endMs: now,
            });

          if (
            candles &&
            candles.length > 0
          ) {
            provider =
              "coincap";
          }
        } catch (err) {
          console.warn(
            `[crypto.chart] CoinCap candles failed for ${symbol}/${days}d:`,
            err?.message ||
              err
          );
        }
      }
    }


    /* =========================================================================
       3) COINCAP HISTORY
       ========================================================================= */

    if (
      !candles ||
      candles.length === 0
    ) {
      if (
        !process.env.DISABLE_COINCAP
      ) {
        try {
          candles =
            await coincapHistory({
              baseId:
                ids.coincap,
              interval,
              startMs,
              endMs: now,
            });

          if (
            candles &&
            candles.length > 0
          ) {
            provider =
              "coincap-history";
          }
        } catch (err) {
          console.warn(
            `[crypto.chart] CoinCap history failed for ${symbol}/${days}d:`,
            err?.message ||
              err
          );
        }
      }
    }


    /* =========================================================================
       4) COINBASE
       ========================================================================= */

    let coinbaseUsedDirectFiat =
      false;

    if (
      (!candles ||
        candles.length === 0) &&
      ids.coinbase
    ) {
      const productId =
        ids.coinbase[currency] ||
        ids.coinbase["USD"];

      try {
        candles =
          await coinbaseCandles({
            productId,
            interval,
            startMs,
            endMs: now,
          });

        if (
          candles &&
          candles.length > 0
        ) {
          provider =
            "coinbase";

          coinbaseUsedDirectFiat =
            !!ids.coinbase[
              currency
            ];
        }
      } catch (err) {
        console.warn(
          `[crypto.chart] Coinbase failed for ${symbol}/${days}d:`,
          err?.message ||
            err
        );
      }
    }


    /* =========================================================================
       No provider succeeded
       ========================================================================= */

    if (
      !candles ||
      candles.length === 0
    ) {
      return res
        .status(502)
        .json({
          error:
            "All providers unavailable for chart data",
        });
    }


    /* =========================================================================
       Currency conversion
       ========================================================================= */

    let convertedCandles =
      candles;

    if (
      currency !== "USD"
    ) {
      const sourcedInUsd =
        provider ===
          "coincap" ||
        provider ===
          "coincap-history" ||
        (
          provider ===
            "coinbase" &&
          !coinbaseUsedDirectFiat
        );

      // CoinGecko was requested directly
      // in the requested currency, so it
      // does NOT need FX conversion.
      //
      // Coinbase native EUR/GBP also does
      // not need conversion.

      if (sourcedInUsd) {
        const r =
          await getUsdToFiatRate(
            currency
          );

        convertedCandles =
          convertOHLC(
            candles,
            r
          );

        convertedFrom =
          "USD";
      }
    }


    /* =========================================================================
       Final response
       ========================================================================= */

    const out = {
      symbol,

      currency,

      interval,

      range:
        rawRange,

      days,

      candles:
        convertedCandles,

      provider,

      convertedFrom,

      updatedAt:
        new Date().toISOString(),
    };


    // Keep your existing 10-minute
    // backend chart cache.
    //
    // This is especially valuable now
    // that CoinGecko is first.
    setCache(
      key,
      out,
      600
    );


    res.json(out);
  } catch (err) {
    next(err);
  }
}