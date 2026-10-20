/**
 * Warm all five USD markets first, then the six fiat crypto series and FX rates.
 * Every provider returns explicit per-pair results. Errors are logged and never
 * take down Express; the underlying cache retries failed reads on later access.
 * Dependencies are injectable so startup can be exercised without credentials.
 */
export async function warmMarketCaches({ preloadCrypto, preloadMetals, getRate, logger = console }) {
  async function settle(label, tasks) {
    const settled = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
    const outcomes = settled.flatMap((result, index) => {
      if (result.status === "rejected") {
        return [{ pair: `${label}:${index}`, status: "failed", error: result.reason?.message ?? String(result.reason) }];
      }
      if (!Array.isArray(result.value)) {
        return [{ pair: `${label}:${index}`, status: "failed", error: "Preloader did not return outcomes" }];
      }
      return result.value.map(item => item && typeof item === "object" && typeof item.status === "string"
        ? item : { pair: `${label}:${index}`, status: "failed", error: "Invalid preload outcome" });
    });
    const ready = outcomes.filter(item => item.status === "ready").length;
    logger.info(`[market-cache] ${label}: ${ready}/${outcomes.length} series ready.`);
    for (const item of outcomes.filter(item => item.status !== "ready")) {
      logger.warn(`[market-cache] ${label} ${item.symbol || item.pair || "unknown"}/${item.currency || ""}: ${item.status}${item.error ? ` (${item.error})` : ""}`);
    }
    return outcomes;
  }

  const usd = await settle("USD", [
    () => preloadCrypto({ currencies: ["USD"], concurrency: 3 }),
    () => preloadMetals({ currencies: ["USD"], concurrency: 2 }),
  ]);
  // Warm each stored crypto currency like the original API did. Cache FX rates
  // as well, so fallback USD conversions do not block first EUR/GBP requests.
  const [fiat, fx] = await Promise.all([
    settle("EUR/GBP", [() => preloadCrypto({ currencies: ["EUR", "GBP"], concurrency: 3 })]),
    Promise.allSettled([getRate("EUR"), getRate("GBP")]),
  ]);
  for (let i = 0; i < fx.length; i++) {
    if (fx[i].status === "rejected") {
      logger.warn(`[market-cache] ${i === 0 ? "EUR" : "GBP"} FX warmup failed: ${fx[i].reason?.message || "provider unavailable"}`);
    }
  }
  return { usd, fiat, fx };
}
