// index.js
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import cors from "cors";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import routes from "./routes/routes.js";
import { notFound, errorHandler } from "./middlewares/error.js";

const app = express();
const PORT = Number(process.env.PORT || 5015);
const NODE_ENV = process.env.NODE_ENV || "development";

// ----- Security & perf -----
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ----- CORS with allowlist -----
const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (
        !origin ||
        allowlist.length === 0 ||
        allowlist.includes(origin)
      ) {
        cb(null, true);
      } else {
        cb(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ----- Rate limiting (public API) -----
// DigitalOcean App Platform provides the actual client IP
// in the "do-connecting-ip" header.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => {
    const clientIp = req.get("do-connecting-ip");

    if (clientIp) {
      return ipKeyGenerator(clientIp);
    }

    // Fallback for local development or unexpected requests.
    return ipKeyGenerator(req.ip);
  },
});

app.use("/api", apiLimiter);

// ----- Routes -----
app.use("/api", routes);

// ----- 404 & Error handlers -----
app.use(notFound);
app.use(errorHandler);

// ----- Start -----
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});