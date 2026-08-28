/*
 * Express application: REST API + static PWA hosting for the Balatan LGU
 * Municipal Facility Reporting, Maintenance Tracking, and Community
 * Participation System.
 *
 * Run with:  node launcher.js   (boots the bundled MySQL first)
 *      or:   node server.js     (when MySQL is already running)
 */
const path = require("path");
const express = require("express");

const config = require("./src/config/config");
const db = require("./src/models/db");
const apiRoutes = require("./src/routes/api");

async function createApp() {

  const app = express();
  app.use(express.json());

  // REST API
  app.use("/api", apiRoutes);

  // Uploaded photos
  app.use("/uploads", express.static(config.UPLOAD_DIR));

  // Static PWA front-end: animated landing page at the root, the resident
  // portal at /portal, sign-in at /login, and the administrator dashboard at
  // a hidden, configurable path (never a guessable /admin).
  app.get("/", (req, res) => res.sendFile(path.join(config.WEB_DIR, "landing.html")));
  app.get("/portal", (req, res) => res.sendFile(path.join(config.WEB_DIR, "index.html")));
  app.get("/login", (req, res) => res.sendFile(path.join(config.WEB_DIR, "login.html")));
  app.get(`/${config.ADMIN_PATH}`, (req, res) =>
    res.sendFile(path.join(config.WEB_DIR, "admin.html")));
  // The old obvious paths give nothing away.
  app.use(["/admin", "/admin.html"], (req, res) => res.status(404).send("Not found"));
  app.use(express.static(config.WEB_DIR));

  // JSON errors (multer size/type errors, unexpected failures)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const isUploadLimit = err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_UNEXPECTED_FILE";
    const status = err.status || (isUploadLimit ? 400 : 500);
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `Photo exceeds the ${config.MAX_UPLOAD_MB} MB limit`
      : err.code === "LIMIT_UNEXPECTED_FILE"
      ? "Too many photos — up to 5 are allowed"
      // status<500 only ever comes from a deliberate, curated err.status set
      // by application code (e.g. upload.js's "Unsupported image type") —
      // safe to show as-is. A genuinely unexpected error (status 500, e.g. a
      // DB or filesystem failure) must never leak err.message to the client
      // (it can contain SQL text or absolute filesystem paths) — log it
      // server-side instead and return a generic message.
      : status < 500 ? (err.message || "Request could not be processed")
      : "Server error";
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return app;
}

async function start() {
  const app = await createApp();
  await new Promise((resolve) => app.listen(config.PORT, config.HOST, resolve));

  try {
    await db.initDb();
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("Database initialization failed:", err);
  }

  console.log("=".repeat(64));
  console.log(" Balatan LGU — Municipal Facility Reporting System");
  console.log("=".repeat(64));
  console.log(`  Landing page    : http://${config.HOST}:${config.PORT}/`);
  console.log(`  Resident portal : http://${config.HOST}:${config.PORT}/portal`);
  console.log(`  LGU dashboard   : http://${config.HOST}:${config.PORT}/${config.ADMIN_PATH}`);
  console.log(`  Admin login     : ${config.ADMIN_USERNAME} / ${config.ADMIN_PASSWORD}`);
  console.log("=".repeat(64));
  if (config.DEMO_MODE) {
    console.log("  *** BALATAN_DEMO_MODE IS ON — geofence checks are bypassed. ***");
    console.log("  *** Unset BALATAN_DEMO_MODE (or set it to 0) after the demo. ***");
    console.log("=".repeat(64));
  }
  if (!config.TURNSTILE.secretKey) {
    const bypassRequested = ["1", "true", "yes"].includes(
      String(process.env.BALATAN_TURNSTILE_DEV_BYPASS || "").trim().toLowerCase());
    if (config.TURNSTILE.devBypass) {
      console.log("  *** BALATAN_TURNSTILE_DEV_BYPASS IS ON — CAPTCHA is NOT verified. ***");
      console.log("  *** Development/demo use only — never enable in production.       ***");
    } else if (bypassRequested && config.IS_PRODUCTION) {
      console.log("  *** NODE_ENV=production: BALATAN_TURNSTILE_DEV_BYPASS was requested ***");
      console.log("  *** but has been IGNORED. Report submission will fail closed until  ***");
      console.log("  *** real Turnstile keys are configured.                             ***");
    } else {
      console.log("  *** No Turnstile secret key configured — report submission will   ***");
      console.log("  *** fail closed (rejected) until BALATAN_TURNSTILE_SECRET_KEY is   ***");
      console.log("  *** set, or BALATAN_TURNSTILE_DEV_BYPASS=1 for local testing only. ***");
    }
    console.log("=".repeat(64));
  }
}

module.exports = { createApp, start };

if (require.main === module) {
  start().catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
}
