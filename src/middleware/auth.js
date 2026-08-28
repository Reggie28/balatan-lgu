/*
 * Bearer-token authentication for admin and resident endpoints.
 *
 * Sessions live in an in-memory map (token -> identity). Fine for a
 * single-instance LGU deployment; resets on restart (people simply log
 * in again).
 */
const crypto = require("crypto");

const sessions = new Map(); // token -> { role, userId, name, email }

function makeToken(identity) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, identity);
  return token;
}

function tokenFromRequest(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return req.query.token;
}

function sessionFromRequest(req) {
  const token = tokenFromRequest(req);
  return token ? sessions.get(token) || null : null;
}

function revokeToken(token) {
  sessions.delete(token);
}

/** Constant-time string comparison (hash first so lengths always match). */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Express middleware guarding admin-only routes. */
function requireAdmin(req, res, next) {
  const session = sessionFromRequest(req);
  if (!session || session.role !== "admin") {
    return res.status(401).json({ error: "Authentication required" });
  }
  req.session = session;
  next();
}

/** Express middleware guarding resident routes (report submission). */
function requireResident(req, res, next) {
  const session = sessionFromRequest(req);
  if (!session || session.role !== "resident") {
    return res.status(401).json({ error: "Please sign in to submit a report" });
  }
  req.session = session;
  next();
}

module.exports = { makeToken, tokenFromRequest, sessionFromRequest,
  revokeToken, safeEqual, requireAdmin, requireResident };
