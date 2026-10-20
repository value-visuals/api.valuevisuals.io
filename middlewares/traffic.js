import rateLimit from "express-rate-limit";

const makeLimiter = (windowMs, limit, message) => rateLimit({
  windowMs, limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: message, code: "RATE_LIMITED" },
});

// Independent limits prevent unauthenticated reads from blocking sign-in and vice versa.
export const marketLimiter = makeLimiter(60_000, 180, "Too many market data requests");
export const polymarketLimiter = makeLimiter(60_000, 30, "Too many prediction market requests");
export const authLimiter = makeLimiter(15 * 60_000, 20, "Too many authentication attempts");
export const subscribeLimiter = makeLimiter(60 * 60_000, 10, "Too many subscription attempts");
export const applyLimiter = makeLimiter(60 * 60_000, 5, "Too many application attempts");
export const privateLimiter = makeLimiter(60_000, 120, "Too many authenticated requests");
