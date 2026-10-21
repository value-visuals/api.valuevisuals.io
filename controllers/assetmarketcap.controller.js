import { getCachedAssetMarketCaps } from "../services/assetmarketcap-market-cache.js";

export async function getAssetMarketCaps(req, res) {
  const currency = String(req.query.currency ?? "USD").toUpperCase();
  const limit = String(req.query.limit ?? "100");
  if (!["USD", "EUR", "GBP"].includes(currency) || !["10", "100"].includes(limit)) {
    return res.status(400).json({ error: "Unsupported currency or limit" });
  }

  try {
    const ranking = await getCachedAssetMarketCaps({ currency, limit: Number(limit) });
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res.json(ranking);
  } catch (error) {
    console.error("[assetmarketcap] Unable to serve cached ranking:", error.message);
    res.set("Cache-Control", "no-store");
    return res.status(503).json({ error: "Market capitalization snapshot unavailable" });
  }
}
