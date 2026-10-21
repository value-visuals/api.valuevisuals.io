import "dotenv/config";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import cors from "cors";
import routes from "./routes/routes.js";
import { notFound, errorHandler } from "./middlewares/error.js";
import { preloadCryptoMarketData } from "./services/crypto-market-cache.js";
import { preloadMetalsMarketData } from "./services/metals-market-cache.js";
import { getUsdToFiatRate } from "./services/metals-fx.js";
import { warmMarketCaches } from "./services/market-cache-warmup.js";
import { preloadAssetMarketCap } from "./services/assetmarketcap-market-cache.js";

const app = express();
const PORT = Number(process.env.PORT || 5015);
const production = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
// Set explicitly to the known number of reverse proxies, never boolean true.
const trustedHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(trustedHops) && trustedHops > 0 && trustedHops <= 5) app.set("trust proxy", trustedHops);
app.use(helmet());
app.use(compression());
app.use(morgan(production ? "combined" : "dev"));

const allowedOrigins = new Set((process.env.CORS_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean));
if (production && !allowedOrigins.size) {
  console.warn("[security] CORS_ORIGINS is empty. Browser cross-origin requests will be denied until configured.");
}
app.use(cors({
  origin(origin, callback) {
    // Requests without Origin (mobile apps, server-to-server, curl) are allowed.
    if (!origin || allowedOrigins.has(origin) || (!production && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      return callback(null, true);
    }
    return callback(Object.assign(new Error("Origin not allowed"), { status: 403, code: "CORS_DENIED" }));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use("/api", routes);
app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`Value Visuals API listening on ${PORT}`);
  // Always preload on startup, as the original API did. USD takes priority;
  // EUR/GBP and FX follow. Cold requests join the same in-flight reads.
  void warmMarketCaches({
    preloadCrypto: preloadCryptoMarketData,
    preloadMetals: preloadMetalsMarketData,
    getRate: getUsdToFiatRate,
  }).catch(error => console.error("[market-cache] Unexpected warmup error:", error));

  // Preload AssetMarketCap rankings from Firestore into the backend cache.
  void preloadAssetMarketCap()
    .then(loaded => console.log(loaded
      ? "[assetmarketcap-cache] Initial ranking cache preload complete"
      : "[assetmarketcap-cache] Initial ranking cache preload unavailable; scheduled refresh will retry"))
    .catch(error => console.error("[assetmarketcap-cache] Initial ranking cache preload failed:", error));
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app };
