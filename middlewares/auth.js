import { admin } from "../config/firebase.js";

export async function requireAuth(req, res, next) {
  try {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
    if (!match) return res.status(401).json({ error: "Missing bearer token", code: "AUTH_REQUIRED" });
    // Check revocation on private requests. Public endpoints never incur an auth lookup.
    req.user = await admin.auth().verifyIdToken(match[1], true);
    return next();
  } catch (error) {
    const codes = {
      "auth/id-token-expired": "TOKEN_EXPIRED",
      "auth/id-token-revoked": "TOKEN_REVOKED",
      "auth/user-disabled": "USER_DISABLED",
    };
    return res.status(401).json({ error: "Authentication required", code: codes[error?.code] ?? "AUTH_INVALID" });
  }
}

// Uses trusted Firebase custom claims (NOT Firestore profile.role, which clients may write).
export function requireAdmin(req, res, next) {
  if (req.user?.admin === true || req.user?.role === "admin") return next();
  return res.status(403).json({ error: "Administrator access required", code: "FORBIDDEN" });
}
