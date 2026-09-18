// index.js
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import cors from "cors";
import rateLimit from "express-rate-limit";
import routes from "./routes/routes.js";
import { notFound, errorHandler } from "./middlewares/error.js";
import { preloadCryptoMarketData } from "./services/crypto-market-cache.js";
import { preloadMetalsMarketData } from "./services/metals-market-cache.js";

const app = express();
const PORT = Number(process.env.PORT || 5015);
const NODE_ENV = process.env.NODE_ENV || "development";

app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || !allowlist.length || allowlist.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use("/api", routes);
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  preloadCryptoMarketData()
    .then(() => console.log("[crypto-market-cache] Initial market cache preload complete"))
    .catch((error) => console.error("[crypto-market-cache] Initial market cache preload failed:", error));

  preloadMetalsMarketData()
    .then(() => console.log("[metals-market-cache] Initial market cache preload complete"))
    .catch((error) => console.error("[metals-market-cache] Initial market cache preload failed:", error));
});
