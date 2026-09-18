import { db } from "../config/firebase.js";

const SUPPORTED_SYMBOLS = new Set([
  "XAU",
  "XAG",
]);

/*
 * Metals are stored in Firebase as USD candles.
 *
 * IMPORTANT:
 *
 * Use uppercase USD to match the canonical Firebase
 * structure used by the crypto market cache:
 *
 *   marketData/BTC/candles/USD/data
 *   marketData/ETH/candles/USD/data
 *   marketData/XMR/candles/USD/data
 *
 * Metals:
 *
 *   marketData/XAU/candles/USD/data
 *   marketData/XAG/candles/USD/data
 */
const STORAGE_CURRENCY = "USD";

const MAX_POINTS = 10000;

const CACHE_TTL_MS =
  Number(
    process.env.METALS_MARKET_CACHE_TTL_SECONDS ||
      900
  ) * 1000;

const marketCache = new Map();

/* ============================================================================
   HELPERS
   ========================================================================== */

function norm(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function cacheKey(symbol) {
  return `${symbol}:${STORAGE_CURRENCY}`;
}

function normalizeTimestamp(value) {
  if (value == null) {
    return null;
  }

  /*
   * Firestore Timestamp / Timestamp-like object.
   */
  if (
    typeof value === "object" &&
    Number.isFinite(value.seconds)
  ) {
    return (
      Number(value.seconds) * 1000 +
      Math.floor(
        Number(value.nanoseconds || 0) /
          1_000_000
      )
    );
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  /*
   * Support either seconds or milliseconds.
   */
  return numeric < 100000000000
    ? numeric * 1000
    : numeric;
}

/**
 * Metal document IDs may look like:
 *
 *   XAG_USD_1234567890
 *   XAU_USD_1234567890
 *
 * Also support legacy variants.
 */
function timestampFromDocumentId(
  docId,
  symbol,
  currency = STORAGE_CURRENCY
) {
  if (!docId) {
    return null;
  }

  const id = String(docId);

  const esc = (value) =>
    String(value).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const patterns = [
    /*
     * XAU_USD_TIMESTAMP
     */
    new RegExp(
      `^${esc(symbol)}_${esc(
        currency
      )}_(\\d+(?:\\.\\d+)?)$`,
      "i"
    ),

    /*
     * XAU_TIMESTAMP
     */
    new RegExp(
      `^${esc(
        symbol
      )}_(\\d+(?:\\.\\d+)?)$`,
      "i"
    ),

    /*
     * XAU-USD-TIMESTAMP
     * XAU:USD:TIMESTAMP
     */
    new RegExp(
      `^${esc(symbol)}[-:]${esc(
        currency
      )}[-:](\\d+(?:\\.\\d+)?)$`,
      "i"
    ),

    /*
     * XAU-TIMESTAMP
     * XAU:TIMESTAMP
     */
    new RegExp(
      `^${esc(
        symbol
      )}[-:](\\d+(?:\\.\\d+)?)$`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = id.match(pattern);

    if (match) {
      return normalizeTimestamp(
        Number(match[1])
      );
    }
  }

  return null;
}

/**
 * Normalize one Firestore candle.
 *
 * Expected ingestion shape:
 *
 * {
 *   symbol,
 *   timestamp,
 *   open,
 *   high,
 *   low,
 *   close,
 *   price,
 *   volume
 * }
 */
function normalizeCandle(
  doc,
  symbol
) {
  const data =
    doc.data() || {};

  let timestamp =
    normalizeTimestamp(
      data.timestamp
    );

  /*
   * Some older documents may not have a timestamp
   * field but may encode it in the document ID.
   */
  if (
    !Number.isFinite(timestamp)
  ) {
    timestamp =
      timestampFromDocumentId(
        doc.id,
        symbol,
        STORAGE_CURRENCY
      );
  }

  const close =
    Number(
      data.close ??
        data.price ??
        data.currentPrice
    );

  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  const open =
    Number(data.open);

  const high =
    Number(data.high);

  const low =
    Number(data.low);

  const volume =
    data.volume != null
      ? Number(data.volume)
      : null;

  return {
    t: timestamp,

    o: Number.isFinite(open)
      ? open
      : close,

    h: Number.isFinite(high)
      ? high
      : close,

    l: Number.isFinite(low)
      ? low
      : close,

    c: close,

    volume:
      Number.isFinite(volume)
        ? volume
        : null,
  };
}

/* ============================================================================
   FIREBASE COLLECTIONS
   ========================================================================== */

/**
 * Canonical Firebase location.
 *
 * IMPORTANT:
 *
 * Firestore paths are case-sensitive.
 *
 * Canonical:
 *
 *   marketData/XAU/candles/USD/data
 *   marketData/XAG/candles/USD/data
 */
function candlesCollection(
  symbol,
  currency = STORAGE_CURRENCY
) {
  return db
    .collection("marketData")
    .doc(symbol)
    .collection("candles")
    .doc(currency)
    .collection("data");
}

/**
 * Legacy lowercase location.
 *
 * This is intentionally retained as a fallback so that
 * existing data written under "usd" can still be read.
 */
function legacyCandlesCollection(
  symbol
) {
  return db
    .collection("marketData")
    .doc(symbol)
    .collection("candles")
    .doc(
      STORAGE_CURRENCY.toLowerCase()
    )
    .collection("data");
}

/* ============================================================================
   FIREBASE LOADING
   ========================================================================== */

/**
 * Load the USD metal series from Firebase.
 *
 * Primary:
 *
 *   marketData/XAU/candles/USD/data
 *   marketData/XAG/candles/USD/data
 *
 * Fallback:
 *
 *   marketData/XAU/candles/usd/data
 *   marketData/XAG/candles/usd/data
 *
 * The fallback is useful if older ingestion created
 * lowercase currency documents.
 */
async function loadMarketData(
  symbol
) {
  const canonicalPath =
    `marketData/${symbol}/candles/${STORAGE_CURRENCY}/data`;

  console.log(
    `[metals-market-cache] Loading Firebase data: ${canonicalPath}`
  );

  /*
   * First use the canonical uppercase USD path.
   */
  let snapshot =
    await candlesCollection(
      symbol,
      STORAGE_CURRENCY
    ).get();

  console.log(
    `[metals-market-cache] Firebase returned ` +
      `${snapshot.size} documents for ` +
      `${symbol}/${STORAGE_CURRENCY}`
  );

  /*
   * If the canonical path is empty, check the legacy
   * lowercase path.
   *
   * This makes the cache resilient to the casing problem
   * that currently appears in your logs.
   */
  if (snapshot.empty) {
    const legacyPath =
      `marketData/${symbol}/candles/${STORAGE_CURRENCY.toLowerCase()}/data`;

    console.log(
      `[metals-market-cache] Canonical path empty; checking legacy path: ${legacyPath}`
    );

    const legacySnapshot =
      await legacyCandlesCollection(
        symbol
      ).get();

    console.log(
      `[metals-market-cache] Legacy Firebase path returned ` +
        `${legacySnapshot.size} documents for ` +
        `${symbol}/${STORAGE_CURRENCY.toLowerCase()}`
    );

    if (!legacySnapshot.empty) {
      snapshot =
        legacySnapshot;

      console.log(
        `[metals-market-cache] Using legacy lowercase ` +
          `${symbol}/${STORAGE_CURRENCY.toLowerCase()} ` +
          `data`
      );
    }
  }

  const candles =
    snapshot.docs
      .map((doc) =>
        normalizeCandle(
          doc,
          symbol
        )
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.t - b.t
      );

  /*
   * Remove duplicate timestamps.
   *
   * If duplicates exist, the later candle wins.
   */
  const unique = [];

  for (
    const candle of candles
  ) {
    if (
      unique.length &&
      candle.t ===
        unique[
          unique.length - 1
        ].t
    ) {
      unique[
        unique.length - 1
      ] = candle;
    } else {
      unique.push(candle);
    }
  }

  const now =
    Date.now();

  const entry = {
    symbol,

    currency:
      STORAGE_CURRENCY,

    candles:
      unique,

    loadedAt:
      now,

    expiresAt:
      now + CACHE_TTL_MS,

    loading:
      null,

    /*
     * Important:
     *
     * An empty Firebase result is still a completed load.
     * This prevents the cache from continuously treating
     * the request as an initial load.
     */
    loaded:
      true,
  };

  marketCache.set(
    cacheKey(symbol),
    entry
  );

  console.log(
    `[metals-market-cache] Cached ` +
      `${unique.length} candles for ` +
      `${symbol}/${STORAGE_CURRENCY}`
  );

  return entry;
}

/* ============================================================================
   CACHE
   ========================================================================== */

function getOrCreateEntry(
  symbol
) {
  const key =
    cacheKey(symbol);

  let entry =
    marketCache.get(key);

  if (!entry) {
    entry = {
      symbol,

      currency:
        STORAGE_CURRENCY,

      candles: [],

      loadedAt: 0,

      expiresAt: 0,

      loading: null,

      loaded: false,
    };

    marketCache.set(
      key,
      entry
    );
  }

  return {
    key,
    entry,
  };
}

function loadOnce(
  key,
  entry,
  symbol,
  onError
) {
  if (entry.loading) {
    return entry.loading;
  }

  entry.loading =
    loadMarketData(symbol)
      .catch((error) => {
        if (onError) {
          onError(error);
        }

        return null;
      })
      .finally(() => {
        const current =
          marketCache.get(key);

        if (current) {
          current.loading =
            null;
        }
      });

  return entry.loading;
}

/* ============================================================================
   PUBLIC API
   ========================================================================== */

/**
 * Get cached USD metal candles.
 *
 * EUR/GBP conversion is intentionally NOT performed here.
 *
 * The controller handles FX conversion so that Firebase
 * remains the canonical USD historical data source.
 */
export async function getMarketData(
  symbol
) {
  const normalizedSymbol =
    norm(symbol);

  if (
    !SUPPORTED_SYMBOLS.has(
      normalizedSymbol
    )
  ) {
    return [];
  }

  const {
    key,
    entry,
  } =
    getOrCreateEntry(
      normalizedSymbol
    );

  /*
   * First request:
   *
   * Wait for Firebase.
   *
   * Use "loaded" rather than candles.length because
   * zero candles is a valid completed Firebase response.
   */
  if (!entry.loaded) {
    const loaded =
      await loadOnce(
        key,
        entry,
        normalizedSymbol
      );

    return (
      loaded?.candles ??
      entry.candles ??
      []
    );
  }

  /*
   * Fresh cache.
   */
  if (
    Date.now() <
    entry.expiresAt
  ) {
    return entry.candles;
  }

  /*
   * Stale cache:
   *
   * Return existing data immediately and refresh Firebase
   * in the background.
   */
  loadOnce(
    key,
    entry,
    normalizedSymbol,
    (error) => {
      console.error(
        `[metals-market-cache] Background refresh failed for ` +
          `${normalizedSymbol}/${STORAGE_CURRENCY}:`,
        error
      );

      /*
       * Avoid hammering Firebase if temporarily unavailable.
       */
      const current =
        marketCache.get(key);

      if (current) {
        current.expiresAt =
          Date.now() +
          CACHE_TTL_MS;
      }
    }
  );

  return entry.candles;
}

/**
 * Force-refresh one metal.
 */
export async function refreshMarketData(
  symbol
) {
  const normalizedSymbol =
    norm(symbol);

  if (
    !SUPPORTED_SYMBOLS.has(
      normalizedSymbol
    )
  ) {
    return [];
  }

  const {
    key,
    entry,
  } =
    getOrCreateEntry(
      normalizedSymbol
    );

  /*
   * Mark as unloaded so a refresh is treated as a
   * fresh Firebase read.
   */
  entry.loaded = false;

  const loaded =
    await loadOnce(
      key,
      entry,
      normalizedSymbol
    );

  return (
    loaded?.candles ??
    entry.candles ??
    []
  );
}

/* ============================================================================
   CACHE DIAGNOSTICS
   ========================================================================== */

export function getMarketCacheStatus() {
  const now =
    Date.now();

  return Array.from(
    marketCache.values()
  ).map((entry) => ({
    symbol:
      entry.symbol,

    currency:
      entry.currency,

    candles:
      entry.candles.length,

    loaded:
      !!entry.loaded,

    loadedAt:
      entry.loadedAt
        ? new Date(
            entry.loadedAt
          ).toISOString()
        : null,

    expiresAt:
      entry.expiresAt
        ? new Date(
            entry.expiresAt
          ).toISOString()
        : null,

    fresh:
      entry.loaded &&
      now <
        entry.expiresAt,

    loading:
      !!entry.loading,
  }));
}

/**
 * Preload XAU and XAG.
 */
export async function preloadMetalsMarketData() {
  for (
    const symbol of SUPPORTED_SYMBOLS
  ) {
    try {
      await getMarketData(
        symbol
      );
    } catch (error) {
      console.error(
        `[metals-market-cache] Failed to preload ${symbol}:`,
        error
      );
    }
  }
}

/* ============================================================================
   RANGE
   ========================================================================== */

export function getCandlesInRange(
  candles,
  startMs,
  endMs
) {
  if (
    !Array.isArray(candles) ||
    !candles.length
  ) {
    return [];
  }

  const result = [];

  for (
    const candle of candles
  ) {
    if (
      candle.t <
      startMs
    ) {
      continue;
    }

    if (
      candle.t >
      endMs
    ) {
      break;
    }

    result.push(
      candle
    );
  }

  return result.slice(
    0,
    MAX_POINTS
  );
}

/* ============================================================================
   DOWNSAMPLING
   ========================================================================== */

/**
 * Downsample by keeping the latest candle
 * in each interval bucket.
 */
export function downsampleCandles(
  candles,
  intervalMs
) {
  if (
    !Array.isArray(candles) ||
    !candles.length
  ) {
    return [];
  }

  if (
    !Number.isFinite(
      intervalMs
    ) ||
    intervalMs <= 0
  ) {
    return candles;
  }

  const buckets =
    new Map();

  for (
    const candle of candles
  ) {
    const bucket =
      Math.floor(
        candle.t /
          intervalMs
      ) *
      intervalMs;

    buckets.set(
      bucket,
      candle
    );
  }

  return Array.from(
    buckets.values()
  ).sort(
    (a, b) =>
      a.t - b.t
  );
}
