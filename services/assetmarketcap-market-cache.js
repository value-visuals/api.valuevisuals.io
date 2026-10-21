// Cached, read-only AssetMarketCap rankings from market-data-engine's Firestore snapshot.
// No provider API key or AssetMarketCap HTTP requests are used by this service.
import { db } from "../config/firebase.js";
import axios from "axios";

const SNAPSHOT_REF = db.collection("marketCapSnapshots").doc("assetmarketcap");
const REFRESH_MS = 5 * 60_000;
const STALE_AFTER_MS = 10 * 60 * 60_000; // The engine normally refreshes every 8 hours.
const FX_TTL_MS = 12 * 60 * 60_000;
const FX_BACKOFF_MS = 5 * 60_000;
const FX_ENDPOINT = "https://api.frankfurter.dev/v2/rate/USD/";

let cachedSnapshot = null;
let lastRefreshFailed = false;
let refreshInFlight = null;
let refreshTimer = null;
const fxCache = new Map();
const fxInFlight = new Map();

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function trackedAsset(row) {
  const name = row.name.toLowerCase();
  const ticker = row.ticker.toUpperCase();
  const type = row.assetType.toLowerCase();
  if (/commodity|metal/.test(type)) {
    if (name === "gold") return "gold";
    if (name === "silver") return "silver";
  }
  if (/crypto/.test(type)) {
    if (name === "bitcoin" && ["BTC", "BTC-USD"].includes(ticker)) return "bitcoin";
    if (name === "ethereum" && ["ETH", "ETH-USD"].includes(ticker)) return "ethereum";
    if (name === "monero" && ["XMR", "XMR-USD"].includes(ticker)) return "monero";
  }
  return null;
}

function validateSnapshot(value) {
  if (!value || !Array.isArray(value.data) || value.data.length < 50 || value.data.length > 100) {
    throw new Error("AssetMarketCap Firestore snapshot is missing or incomplete");
  }

  const ranks = new Set();
  const data = value.data.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid AssetMarketCap row");
    const rank = Number(entry.rank);
    const ticker = typeof entry.ticker === "string" ? entry.ticker.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const assetType = typeof entry.assetType === "string" ? entry.assetType.trim() : "";
    const marketCapUsd = numberOrNull(entry.marketCapUsd);
    const priceUsd = numberOrNull(entry.priceUsd);
    const change24hPct = numberOrNull(entry.change24hPct);
    const circulatingSupply = numberOrNull(entry.circulatingSupply);

    if (!Number.isInteger(rank) || rank < 1 || rank > 100 || ranks.has(rank) ||
        !ticker || !name || !assetType || marketCapUsd === null || marketCapUsd <= 0 ||
        (priceUsd !== null && priceUsd < 0) ||
        (circulatingSupply !== null && circulatingSupply < 0)) {
      throw new Error("Invalid AssetMarketCap ranking fields");
    }
    ranks.add(rank);
    const row = {
      rank, ticker, name, assetType, marketCapUsd, priceUsd,
      change24hPct, circulatingSupply,
    };
    return { ...row, trackedAsset: trackedAsset(row) };
  }).sort((a, b) => a.rank - b.rank);

  const fetchedAt = dateOrNull(value.fetchedAt);
  if (!fetchedAt) throw new Error("AssetMarketCap snapshot has no valid fetch timestamp");
  return { data, asOf: dateOrNull(value.asOf), fetchedAt };
}

// All Firestore reads happen here, never inside a request handler.
async function refreshAssetMarketCap() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const document = await SNAPSHOT_REF.get();
      const next = validateSnapshot(document.exists ? document.data() : null);
      cachedSnapshot = next;
      lastRefreshFailed = false;
      console.log(`[assetmarketcap-cache] Loaded ${next.data.length} assets from Firestore (${next.fetchedAt})`);
      return true;
    } catch (error) {
      // Never discard a previous valid snapshot if Firestore is unavailable.
      lastRefreshFailed = true;
      console.warn(`[assetmarketcap-cache] Snapshot refresh failed: ${error.message}`);
      return false;
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Called once at backend startup, alongside the existing crypto/metals cache preloads.
export function preloadAssetMarketCap() {
  if (!refreshTimer) {
    refreshTimer = setInterval(() => { void refreshAssetMarketCap(); }, REFRESH_MS);
    refreshTimer.unref?.();
  }
  return refreshAssetMarketCap();
}

async function getUsdFxRate(currency) {
  if (currency === "USD") return 1;
  const existing = fxCache.get(currency);
  if (existing && Date.now() < existing.expiresAt) return existing.rate;
  if (fxInFlight.has(currency)) return fxInFlight.get(currency);
  const load = (async () => {
    try {
      const response = await axios.get(`${FX_ENDPOINT}${currency}`, { timeout: 7000 });
      const rate = numberOrNull(response.data?.rate);
      if (rate === null || rate <= 0) throw new Error("Invalid FX quote");
      fxCache.set(currency, { rate, expiresAt: Date.now() + FX_TTL_MS });
      return rate;
    } catch (error) {
      console.warn(`[assetmarketcap-cache] USD/${currency} FX unavailable: ${error.message}`);
      // Reuse a recent valid quote; never misrepresent an unconverted USD value.
      const rate = existing && Date.now() - (existing.expiresAt - FX_TTL_MS) < 24 * 60 * 60_000
        ? existing.rate : null;
      fxCache.set(currency, { rate, expiresAt: Date.now() + FX_BACKOFF_MS });
      return rate;
    }
  })().finally(() => fxInFlight.delete(currency));
  fxInFlight.set(currency, load);
  return load;
}

export async function getCachedAssetMarketCaps({ currency = "USD", limit = 100 } = {}) {
  const requestedCurrency = String(currency).toUpperCase();
  if (!["USD", "EUR", "GBP"].includes(requestedCurrency) || ![10, 100].includes(limit)) {
    const error = new Error("Unsupported currency or limit");
    error.status = 400;
    throw error;
  }
  if (!cachedSnapshot) {
    const error = new Error("Market capitalization snapshot is not loaded yet");
    error.status = 503;
    throw error;
  }

  // EUR/GBP conversion is separately cached; it never calls AssetMarketCap.
  const rate = await getUsdFxRate(requestedCurrency);

  const snapshot = cachedSnapshot;
  return {
    source: "AssetMarketCap",
    sourceUrl: "https://assetmarketcap.com/",
    currency: requestedCurrency,
    asOf: snapshot.asOf,
    fetchedAt: snapshot.fetchedAt,
    stale: lastRefreshFailed || Date.now() - Date.parse(snapshot.fetchedAt) > STALE_AFTER_MS,
    cacheSeconds: REFRESH_MS / 1000,
    fxRate: rate,
    fxAsOf: null,
    count: snapshot.data.length,
    data: snapshot.data.slice(0, limit).map((asset) => ({
      ...asset,
      marketCap: rate === null ? null : asset.marketCapUsd * rate,
      price: rate === null || asset.priceUsd === null ? null : asset.priceUsd * rate,
    })),
  };
}
