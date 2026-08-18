// middlewares/auth.js
import { admin } from "../config/firebase.js";

export async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const [, token] = hdr.split(" ");

    if (!token) {
      return res.status(401).json({
        error: "Missing bearer token",
        code: "AUTH_REQUIRED",
      });
    }

    const decoded = await admin.auth().verifyIdToken(token, true);

    req.user = decoded;
    next();
  } catch (err) {
    console.error("Auth error:", err?.code, err?.message);

    return res.status(401).json({
      error: "Authentication required",
      code:
        err?.code === "auth/id-token-expired"
          ? "TOKEN_EXPIRED"
          : err?.code === "auth/id-token-revoked"
            ? "TOKEN_REVOKED"
            : "AUTH_INVALID",
    });
  }
}
