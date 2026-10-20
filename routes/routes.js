import { Router } from "express";
import { upload } from "../config/upload.js";
import { requireAuth, requireAdmin } from "../middlewares/auth.js";
import { marketLimiter, polymarketLimiter, authLimiter, subscribeLimiter, applyLimiter, privateLimiter } from "../middlewares/traffic.js";
import * as c from "../controllers/core.controller.js";
import * as crypto from "../controllers/crypto.controller.js";
import * as metals from "../controllers/metals.controller.js";
import * as market from "../controllers/market.controller.js";
import * as wallets from "../controllers/user.portfolio.controller.js";
import { getPortfolioSummary, getPortfolioChart } from "../controllers/portfolio.btc.data.controller.js";
import { getPortfolioSummary as getEthSummary, getPortfolioChart as getEthChart } from "../controllers/portfolio.eth.data.controller.js";
import { getPolymarketBitcoin, getPolymarketEthereum, getPolymarketMonero, getPolymarketGold, getPolymarketSilver } from "../controllers/polymarket.controller.js";

const router = Router();
const publicCache = (_req, res, next) => {
  res.set("Cache-Control", "public, max-age=20, stale-while-revalidate=40");
  next();
};
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
const privateApi = [privateLimiter, noStore, requireAuth];

router.get("/health", c.health);

// Sign-in remains optional for browsing. Sign-in/registration are rate-limited.
router.post("/auth/signup", authLimiter, noStore, c.signup);
router.post("/auth/signin", authLimiter, noStore, c.signin);
router.post("/auth/signout", ...privateApi, c.signout);
router.get("/me", ...privateApi, c.me);

router.post("/subscribe", subscribeLimiter, c.subscribe);
router.get("/subscribers/count", marketLimiter, publicCache, c.subscriberCount);
router.get("/get-careers", marketLimiter, c.getCareers);
router.get("/get-career/:id", marketLimiter, c.getCareer);
router.post("/add-careers", ...privateApi, requireAdmin, c.addCareers);

// Applicant records contain private information and must never be public.
router.get("/volunteers", ...privateApi, requireAdmin, c.listVolunteers);
router.post("/volunteers/apply", applyLimiter, upload.single("resume"), c.applyVolunteer);

// Public market reads: no bearer token required. Existing paths/shapes preserved.
router.get("/crypto/global", marketLimiter, publicCache, crypto.getFirebaseGlobal);
router.get("/crypto/summary", marketLimiter, publicCache, crypto.getFirebaseSummary);
router.get("/crypto/chart", marketLimiter, publicCache, crypto.getFirebaseChart);
router.get("/metals/summary", marketLimiter, publicCache, metals.getSummary);
router.get("/metals/chart", marketLimiter, publicCache, metals.getChart);

// Homepage: all five assets and 24h rankings; market-cap chart uses recorded caps only.
router.get("/market/overview", marketLimiter, publicCache, market.getOverview);
router.get("/market/cap/chart", marketLimiter, publicCache, market.getMarketCapChart);
// Admin-only: verify warmup, refresh and TTL on this exact API process.
router.get("/market/cache-status", ...privateApi, requireAdmin, market.getCacheStatus);

router.get("/polymarket/bitcoin", polymarketLimiter, getPolymarketBitcoin);
router.get("/polymarket/ethereum", polymarketLimiter, getPolymarketEthereum);
router.get("/polymarket/monero", polymarketLimiter, getPolymarketMonero);
router.get("/polymarket/gold", polymarketLimiter, getPolymarketGold);
router.get("/polymarket/silver", polymarketLimiter, getPolymarketSilver);

// Per-user holdings and portfolio summaries MUST always use a verified Firebase ID token.
router.get("/portfolio/btc/summary", ...privateApi, getPortfolioSummary);
router.get("/portfolio/btc/chart", ...privateApi, getPortfolioChart);
router.get("/portfolio/eth/summary", ...privateApi, getEthSummary);
router.get("/portfolio/eth/chart", ...privateApi, getEthChart);
router.get("/user/wallets", ...privateApi, wallets.getUserWallets);
router.put("/user/wallets", ...privateApi, wallets.updateUserWallet);
router.post("/user/wallets", ...privateApi, wallets.saveUserWallet);
router.delete("/user/wallets", ...privateApi, wallets.deleteUserWallet);
router.get("/user/metalswallet", ...privateApi, wallets.getPreciousHoldings);
router.put("/user/metalswallet", ...privateApi, wallets.updatePreciousHolding);
router.post("/user/metalswallet", ...privateApi, wallets.savePreciousHolding);
router.delete("/user/metalswallet", ...privateApi, wallets.deletePreciousHolding);
router.put("/user/email/mirror", ...privateApi, c.mirrorAuthedEmail);
router.put("/user/interests", ...privateApi, c.updateInterests);

export default router;
