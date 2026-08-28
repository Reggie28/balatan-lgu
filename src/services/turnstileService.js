/*
 * Cloudflare Turnstile CAPTCHA verification (server-side).
 *
 * Fails closed: with no secret key configured, verification is rejected
 * unless the explicit dev bypass (BALATAN_TURNSTILE_DEV_BYPASS=1) is on —
 * there is no silent bypass path.
 */
const config = require("../config/config");

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Resolves to true only when Cloudflare confirms the token is valid. */
async function verifyTurnstile(token, remoteIp) {
  if (!config.TURNSTILE.secretKey) {
    return config.TURNSTILE.devBypass;
  }
  if (!token) return false;
  try {
    const params = new URLSearchParams();
    params.set("secret", config.TURNSTILE.secretKey);
    params.set("response", token);
    if (remoteIp) params.set("remoteip", remoteIp);
    const resp = await fetch(VERIFY_URL, { method: "POST", body: params });
    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    console.error("Turnstile verification failed:", err.message);
    return false;
  }
}

module.exports = { verifyTurnstile };
