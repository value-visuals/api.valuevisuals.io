// Public, bounded, read-only proxy for the five existing Polymarket asset routes.
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const ASSETS = {
  bitcoin: { search: "bitcoin", pattern: /bitcoin|btc/i },
  ethereum: { search: "ethereum", pattern: /ethereum|eth/i },
  monero: { search: "monero", pattern: /monero|xmr/i },
  gold: { search: "gold", pattern: /gold|xau/i },
  silver: { search: "silver", pattern: /silver|xag/i },
};
const cache = new Map();
const MAX_EVENT_LOOKUPS = 50;
const MAX_MARKETS = 100;
const MAX_CLOB_TOKENS = 100;

async function fetchJson(url, options = {}) {
  const { timeoutMs = 9000, ...request } = options;
  const response = await fetch(url, {
    ...request,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", ...(request.headers || {}) },
  });
  if (!response.ok) throw Object.assign(new Error(`Upstream returned ${response.status}`), { status: 502, code: "UPSTREAM_UNAVAILABLE" });
  return response.json();
}

function getTokenIds(value) {
  if (Array.isArray(value)) return value.filter(token => typeof token === "string" && /^\d+$/.test(token)).slice(0, 10);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return getTokenIds(parsed);
  } catch { /* Comma separated legacy values */ }
  return getTokenIds(value.split(",").map(v => v.trim()));
}

async function mapLimit(values, concurrency, callback) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try { results[index] = await callback(values[index]); }
      catch { results[index] = null; }
    }
  }));
  return results;
}

async function queryMarket(asset, { limit, includeClosed, livePrices }) {
  const { search, pattern } = ASSETS[asset];
  const searchUrl = new URL(`${GAMMA}/public-search`);
  searchUrl.searchParams.set("q", search);
  searchUrl.searchParams.set("keep_closed_markets", includeClosed ? "1" : "0");
  searchUrl.searchParams.set("limit_per_type", String(limit));
  searchUrl.searchParams.set("search_tags", "0");
  searchUrl.searchParams.set("search_profiles", "0");
  searchUrl.searchParams.set("optimized", "1");
  const result = await fetchJson(searchUrl);
  const events = (Array.isArray(result?.events) ? result.events : []).filter(e => typeof e?.slug === "string" && e.slug.length <= 200).slice(0, Math.min(limit, MAX_EVENT_LOOKUPS));
  const hydrated = await mapLimit(events, 5, async e => fetchJson(`${GAMMA}/events/slug/${encodeURIComponent(e.slug)}`));
  const markets = [];
  for (const event of hydrated) {
    if (!Array.isArray(event?.markets)) continue;
    for (const market of event.markets) {
      if (!includeClosed && (market.closed || market.active === false)) continue;
      if (!pattern.test(String(market.question ?? "")) && !pattern.test(String(market.slug ?? ""))) continue;
      if (typeof market.slug !== "string" || market.slug.length > 200) continue;
      markets.push({
        eventSlug: event.slug,
        marketSlug: market.slug,
        question: market.question ?? null,
        outcomes: market.outcomes ?? null,
        gammaOutcomePrices: market.outcomePrices ?? null,
        clobTokenIds: getTokenIds(market.clobTokenIds),
        livePrices: null,
        volume24hr: market.volume24hr ?? null,
        liquidity: market.liquidity ?? null,
        endDate: market.endDate ?? null,
        url: `https://polymarket.com/market/${encodeURIComponent(market.slug)}`,
      });
      if (markets.length >= MAX_MARKETS) break;
    }
    if (markets.length >= MAX_MARKETS) break;
  }
  if (livePrices) {
    const tokenIds = [...new Set(markets.flatMap(m => m.clobTokenIds))].slice(0, MAX_CLOB_TOKENS);
    if (tokenIds.length) {
      try {
        const params = tokenIds.flatMap(token_id => [{ token_id, side: "BUY" }, { token_id, side: "SELL" }]);
        const live = await fetchJson(`${CLOB}/prices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params }) });
        for (const market of markets) {
          const prices = {};
          for (const token of market.clobTokenIds) {
            if (live?.[token]) prices[token] = { buy: live[token].BUY ?? null, sell: live[token].SELL ?? null };
          }
          market.livePrices = Object.keys(prices).length ? prices : null;
        }
      } catch (error) {
        console.warn(`[polymarket] Live prices unavailable for ${asset}:`, error?.message);
      }
    }
  }
  return { count: markets.length, data: markets };
}

async function serve(asset, req, res) {
  const input = req.query.limit ?? "10";
  if (typeof input !== "string" || !/^\d{1,2}$/.test(input) || Number(input) < 1 || Number(input) > 50) {
    return res.status(400).json({ error: "limit must be between 1 and 50", code: "INVALID_LIMIT" });
  }
  const limit = Number(input);
  const includeClosed = req.query.includeClosed === "1";
  const livePrices = req.query.livePrices === "1";
  const key = `${asset}:${limit}:${includeClosed}:${livePrices}`;
  const entry = cache.get(key);
  const now = Date.now();
  // Live prices are also cached briefly, protecting third-party API quotas.
  if (entry?.value && entry.expiresAt > now) {
    res.set("Cache-Control", `public, max-age=${livePrices ? 5 : 30}`);
    return res.json(entry.value);
  }
  try {
    const request = entry?.loading || queryMarket(asset, { limit, includeClosed, livePrices });
    cache.set(key, { ...entry, loading: request, expiresAt: entry?.expiresAt ?? 0 });
    const value = await request;
    cache.set(key, { value, expiresAt: Date.now() + (livePrices ? 5000 : 30000), loading: null });
    // Keep memory bounded even under many query combinations.
    if (cache.size > 200) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    res.set("Cache-Control", `public, max-age=${livePrices ? 5 : 30}`);
    return res.json(value);
  } catch (error) {
    if (entry?.value) return res.json(entry.value); // Last good result on upstream outage
    console.error(`[polymarket] ${asset} unavailable:`, error?.message);
    return res.status(502).json({ error: "Polymarket data temporarily unavailable", code: "UPSTREAM_UNAVAILABLE" });
  } finally {
    const current = cache.get(key);
    if (current?.loading && current.loading === entry?.loading) current.loading = null;
  }
}

export const getPolymarketBitcoin = (req, res) => serve("bitcoin", req, res);
export const getPolymarketEthereum = (req, res) => serve("ethereum", req, res);
export const getPolymarketMonero = (req, res) => serve("monero", req, res);
export const getPolymarketGold = (req, res) => serve("gold", req, res);
export const getPolymarketSilver = (req, res) => serve("silver", req, res);
