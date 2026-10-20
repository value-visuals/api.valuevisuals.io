import multer from "multer";

export function notFound(_req, res) {
  return res.status(404).json({ error: "Not Found", code: "NOT_FOUND" });
}

export function errorHandler(error, _req, res, _next) {
  if (res.headersSent) return;
  let status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  if (error instanceof multer.MulterError) status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  if (error?.type === "entity.parse.failed") status = 400;
  if (error?.message === "Unsupported file type") status = 415;
  if (status >= 500) console.error("[api] Request failed:", error);
  const message = status >= 500 ? "Internal Server Error" : error?.message || "Bad Request";
  return res.status(status).json({ error: message, code: status >= 500 ? "INTERNAL_ERROR" : error?.code || "BAD_REQUEST" });
}
