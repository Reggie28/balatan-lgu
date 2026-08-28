/*
 * Central configuration for the Balatan LGU Municipal Facility Reporting
 * System.
 *
 * Everything is kept inside the project folder so the whole application is
 * portable: copy the folder, run the setup script, and it works. No values
 * here point outside the repository.
 */
const path = require("path");
const fs = require("fs");

// --- Paths -----------------------------------------------------------------
// Project root is the folder that contains this "src" package.
const BASE_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(BASE_DIR, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PRIVATE_UPLOAD_DIR = path.join(DATA_DIR, "private", "ids");
const WEB_DIR = path.join(BASE_DIR, "web");

// Bundled portable runtimes (used by launcher.js on Windows).
const RUNTIME_DIR = path.join(BASE_DIR, "runtime");
const MYSQL_DIR = path.join(RUNTIME_DIR, "mysql");
const MYSQL_DATA_DIR = path.join(DATA_DIR, "mysql");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Not under UPLOAD_DIR / not statically served — valid IDs are personal
// documents and must only be reachable through the authenticated admin
// streaming route (see routes/api.js GET /users/:id/valid-id).
fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true });

// --- Domain configuration ----------------------------------------------------
// Facility / infrastructure types and their impact weight (0-1). Higher weight
// means an issue there affects essential public services more severely.
// This is the MEO-scoped taxonomy adopted for the MEO revision (used to
// validate NEW report submissions and populate the facility dropdown).
const FACILITY_TYPES = [
  { key: "road", label: "Road", weight: 0.85 },
  { key: "bridge", label: "Bridge", weight: 0.9 },
  { key: "municipal_building", label: "Municipal Building", weight: 0.7 },
  { key: "public_facility", label: "Public Facility", weight: 0.6 },
  { key: "drainage_system", label: "Drainage System", weight: 0.75 },
  { key: "streetlight", label: "Streetlight", weight: 0.5 },
  { key: "water_facility", label: "Water Facility", weight: 0.8 },
  { key: "electrical_facility", label: "Electrical Facility", weight: 0.8 },
  { key: "government_structure", label: "Government Structure", weight: 0.6 },
  { key: "municipal_equipment", label: "Municipal Equipment", weight: 0.55 },
  { key: "other", label: "Other", weight: 0.5 },
];

// Pre-MEO-revision taxonomy. Kept ONLY so existing reports created under the
// old list keep resolving a correct label/weight (CII, heatmap, predictive
// maintenance) instead of silently falling back to a generic default.
// NOT used to validate new submissions and NOT shown in any new dropdown.
const LEGACY_FACILITY_TYPES = [
  { key: "health_center", label: "Health Center / Hospital", weight: 1.0 },
  { key: "school", label: "School", weight: 0.9 },
  { key: "water_supply", label: "Water Supply", weight: 0.8 },
  { key: "electricity", label: "Electric / Power Line", weight: 0.8 },
  { key: "drainage", label: "Drainage / Flood Control", weight: 0.75 },
  { key: "public_market", label: "Public Market", weight: 0.7 },
  { key: "waste", label: "Waste / Sanitation", weight: 0.65 },
  { key: "government_building", label: "Government Building", weight: 0.6 },
  { key: "park", label: "Park / Public Space", weight: 0.4 },
];

module.exports = {
  BASE_DIR,
  DATA_DIR,
  UPLOAD_DIR,
  PRIVATE_UPLOAD_DIR,
  WEB_DIR,
  RUNTIME_DIR,
  MYSQL_DIR,
  MYSQL_DATA_DIR,

  // --- Server ----------------------------------------------------------------
  HOST: process.env.BALATAN_HOST || "127.0.0.1",
  PORT: parseInt(process.env.BALATAN_PORT || "5000", 10),

  // Standard Node convention. Unset (the default) behaves exactly as before
  // this flag existed — only an explicit NODE_ENV=production changes
  // anything, see TURNSTILE.devBypass below.
  IS_PRODUCTION: process.env.NODE_ENV === "production",

  // --- Admin credentials -------------------------------------------------------
  // Change these in production via environment variables. Defaults are provided
  // so the recipient can log in immediately after setup.
  ADMIN_USERNAME: process.env.BALATAN_ADMIN_USER || "admin",
  ADMIN_PASSWORD: process.env.BALATAN_ADMIN_PASS || "balatan2026",

  // Hidden administrator login URL: the dashboard is NOT served at a
  // guessable /admin — only at this configurable secret path.
  ADMIN_PATH: process.env.BALATAN_ADMIN_PATH || "lgu-admin-2417",

  // --- Fake-report enforcement ---------------------------------------------------
  // Legacy generic strike counter, kept for any code that still reads it.
  // Not used by the offense/suspension logic below, which uses fixed
  // 1st/2nd-offense semantics instead of a configurable N-strike limit.
  STRIKE_LIMIT: parseInt(process.env.BALATAN_STRIKE_LIMIT || "3", 10),

  // Three-attempt offense policy for reports an admin marks "fake"
  // (client-confirmed revision — see userModel.recordOffense()):
  //   1st offense -> Warning (no suspension, no block)
  //   2nd offense -> suspended for this many days
  //   3rd offense -> flagged for Administrative Action (users.admin_action_required);
  //                  NOT an automatic permanent block — the LGU/MEO decides
  //                  the actual administrative/legal handling.
  OFFENSE_SUSPENSION_DAYS: parseInt(process.env.BALATAN_OFFENSE_SUSPENSION_DAYS || "30", 10),

  // --- CAPTCHA (Cloudflare Turnstile) ---------------------------------------------
  // Server-side verification is mandatory before a report is created. If no
  // secret key is configured, submission fails closed (rejected) UNLESS the
  // dev bypass below is explicitly turned on — never a silent bypass.
  TURNSTILE: {
    siteKey: process.env.BALATAN_TURNSTILE_SITE_KEY || "",
    secretKey: process.env.BALATAN_TURNSTILE_SECRET_KEY || "",
    // Production safety guard: the dev bypass can never be active when
    // NODE_ENV=production, even if BALATAN_TURNSTILE_DEV_BYPASS was left
    // set from an earlier local/demo configuration.
    devBypass: process.env.NODE_ENV !== "production" && ["1", "true", "yes"].includes(
      String(process.env.BALATAN_TURNSTILE_DEV_BYPASS || "").trim().toLowerCase()
    ),
  },

  // Legacy/external office list. Superseded by MEO_TEAMS + team coordination
  // below (the system's scope is MEO-only — see the RSC's team-coordination
  // revision) — kept only so historical reports/status_history rows created
  // under the old office-assignment and office-coordination workflows keep
  // their original values intact. Not used to populate any current dropdown.
  OFFICES: [
    "Municipal Engineering Office",
    "MENRO (Environment & Natural Resources)",
    "Municipal Health Office",
    "General Services Office",
    "Water District",
    "Barangay Maintenance Crew",
    "MDRRMO (Disaster Risk Reduction)",
  ],

  // --- Inter-team coordination (RSC: "coordination records involving
  // concerned MEO teams for monitoring and approval purposes") ---------------
  // A report's primary assignment (MEO_TEAMS below) is unchanged. This is for
  // tagging an ADDITIONAL MEO team as involved on a progress/history entry
  // (e.g. Electrical Team for a wiring assessment), separate from who owns it.
  // (Originally an inter-OFFICE coordination concept; revised to inter-TEAM
  // since the system is MEO-only, not a generic all-office system.)
  INVOLVEMENT_REASONS: [
    "Budget approval",
    "Permit or clearance",
    "Materials or equipment",
    "Technical review",
    "Disaster response coordination",
    "Other",
  ],

  // Team -> contact email, used only to send a best-effort notice via the
  // existing mailService when a team is tagged on a coordination entry.
  // Env var name kept as BALATAN_OFFICE_CONTACTS for backward compatibility;
  // keys are now MEO team names (see MEO_TEAMS below) rather than office
  // names. Left unset here on purpose — no email is sent for a team with no
  // configured contact (see reportController.progress()). Example:
  //   BALATAN_OFFICE_CONTACTS={"Electrical Team":"realaddress@example.gov.ph"}
  OFFICE_CONTACTS: (() => {
    try {
      return JSON.parse(process.env.BALATAN_OFFICE_CONTACTS || "{}");
    } catch {
      return {}; // malformed env value — fail safe to "no contacts configured"
    }
  })(),

  // --- MySQL connection --------------------------------------------------------
  // Port 3307 by default so the bundled server never collides with an existing
  // MySQL/XAMPP installation on the standard 3306.
  DB: {
    host: process.env.BALATAN_DB_HOST || "127.0.0.1",
    port: parseInt(process.env.BALATAN_DB_PORT || "3307", 10),
    user: process.env.BALATAN_DB_USER || "root",
    password: process.env.BALATAN_DB_PASS || "",
    database: process.env.BALATAN_DB_NAME || "balatan_lgu",
  },

  // --- Email (OTP verification codes) ----------------------------------------------
  // When SMTP is configured, sign-up verification codes are emailed to the
  // resident. Without SMTP (e.g. local demos) the app runs in "demo delivery"
  // mode: the code is printed in the server window instead.
  SMTP: {
    host: process.env.BALATAN_SMTP_HOST || "",
    port: parseInt(process.env.BALATAN_SMTP_PORT || "587", 10),
    user: process.env.BALATAN_SMTP_USER || "",
    pass: process.env.BALATAN_SMTP_PASS || "",
    from: process.env.BALATAN_SMTP_FROM || process.env.BALATAN_SMTP_USER || "",
  },

  // --- Resident geofence ---------------------------------------------------------
  // Residents may only sign in while physically inside the Municipality of
  // Balatan. The check compares the device's GPS position with the municipal
  // center using the Haversine formula. Disable with BALATAN_GEOFENCE=0
  // (e.g. when demonstrating the system outside Balatan).
  GEOFENCE: {
    enabled: process.env.BALATAN_GEOFENCE !== "0",
    radiusKm: parseFloat(process.env.BALATAN_GEOFENCE_KM || "15"),
  },

  // --- Temporary presentation/demo mode -------------------------------------------
  // TEMPORARY BYPASS ONLY — does not remove or alter the geofence/GEO-1 logic
  // itself (src/controllers/authController.js checkGeofence()); it only short-
  // circuits that function to "allowed" while active. Turn OFF after any demo
  // by unsetting BALATAN_DEMO_MODE (or setting it to "0"/"false") — real
  // geofence enforcement resumes immediately, with no other change needed.
  DEMO_MODE: ["1", "true", "yes"].includes(
    String(process.env.BALATAN_DEMO_MODE || "").trim().toLowerCase()
  ),

  // --- Uploads -------------------------------------------------------------------
  MAX_UPLOAD_MB: 8,
  ALLOWED_IMAGE_EXT: [".jpg", ".jpeg", ".png", ".webp", ".gif"],

  // --- Municipality defaults (Balatan, Camarines Sur, Philippines) ---------------
  // Used to centre the maps when the browser has no better location, and as
  // the geofence anchor (see GEOFENCE above). Poblacion/town-center
  // coordinate per Wikipedia's Balatan infobox (13°19'01"N 123°14'25"E,
  // sourced independently of this codebase) — corrected 2026-08 from an
  // earlier value that was off by ~1.7km. That earlier error alone was too
  // small to explain a false "outside Balatan" rejection at the town center
  // given the 15km radius; see GEOFENCE's accuracy handling for the actual
  // cause (unreliable device location readings, not this coordinate).
  MUNICIPALITY_NAME: "Balatan",
  DEFAULT_CENTER: { lat: 13.3169, lng: 123.2404 },
  DEFAULT_ZOOM: 13,

  FACILITY_TYPES,
  LEGACY_FACILITY_TYPES,
  // MEO-scoped taxonomy adopted for the MEO revision. Used to validate NEW
  // report submissions and populate the category dropdown.
  CATEGORIES: [
    "Structural Damage",
    "Road / Pavement",
    "Electrical",
    "Water / Utility",
    "Drainage / Flooding",
    "Lighting",
    "Facility Damage",
    "Equipment Damage",
    "Other MEO-related Issue",
  ],
  // Pre-MEO-revision category strings. Kept ONLY so existing reports keep
  // displaying their original category as-is (never rewritten). Not used to
  // validate new submissions.
  LEGACY_CATEGORIES: [
    "Structural Damage",
    "Road / Pothole",
    "Flooding / Drainage",
    "Water Supply",
    "Power / Electrical",
    "Sanitation / Waste",
    "Lighting",
    "Vandalism",
    "Safety Hazard",
    "Other",
  ],
  // Maintenance workflow per the approved manuscript, extended with
  // "not_in_scope" (validation-stage rejection: outside MEO's mandate) and
  // "unresolved" (an "ongoing" report that could not be completed) per the
  // MEO revision's confirmed status graph.
  STATUSES: ["pending", "validation", "verified", "ongoing", "resolved", "fake", "not_in_scope", "unresolved"],
  URGENCY_LEVELS: ["low", "medium", "high", "critical"],

  // Confirmed MEO-revision status graph. Any appropriate status may be
  // selected directly from "pending" when the actual situation justifies an
  // immediate call — an obviously fake or clearly out-of-scope report does
  // not need to sit through a separate "validation" step first — while every
  // other transition still follows the normal review sequence:
  //   pending -> validation | resolved | fake | not_in_scope (shortcuts)
  //   validation -> verified | fake | not_in_scope
  //   verified -> ongoing
  //   ongoing -> resolved | unresolved
  //   unresolved -> ongoing | resolved
  //   fake -> validation (reversible; also reverses the offense count, see
  //           userModel.recordOffense())
  //   resolved, not_in_scope = terminal
  // Any status may stay unchanged (a no-op "transition" is always
  // implicitly allowed elsewhere).
  STATUS_TRANSITIONS: {
    pending: ["validation", "resolved", "fake", "not_in_scope"],
    validation: ["verified", "fake", "not_in_scope"],
    verified: ["ongoing"],
    ongoing: ["resolved", "unresolved"],
    unresolved: ["ongoing", "resolved"],
    fake: ["validation"],
    resolved: [],
    not_in_scope: [],
  },

  // Merge legacy + current so lookups for OLD reports (still using retired
  // keys like "health_center" or "water_supply") keep resolving their real
  // weight/label instead of silently degrading to a generic default.
  FACILITY_WEIGHT: Object.fromEntries(
    [...LEGACY_FACILITY_TYPES, ...FACILITY_TYPES].map((f) => [f.key, f.weight])
  ),
  FACILITY_LABEL: Object.fromEntries(
    [...LEGACY_FACILITY_TYPES, ...FACILITY_TYPES].map((f) => [f.key, f.label])
  ),

  // --- MEO revision (Phase 2 setup) -----------------------------------------------
  // Reference data only — not yet wired into any request-handling logic.
  // Backend/frontend logic that reads these arrives in Phase 3/4 of the MEO
  // revision; defining them now keeps the schema/config groundwork in one
  // reviewable step, per the phase plan.

  // Internal MEO teams a report can be assigned to once it's "ongoing" —
  // replaces the old external-office assignment concept (config.OFFICES,
  // still kept below for legacy/COORD-1 historical data, not for new use).
  MEO_TEAMS: [
    "Road Team",
    "Structural/Building Team",
    "Electrical Team",
    "Water/Utilities Team",
    "General Facilities Team",
  ],

  // Official Balatan barangays, for the searchable barangay dropdown.
  BARANGAYS: [
    "Cabanbanan", "Cabungan", "Camangahan", "Cayogcog", "Coguit", "Duran",
    "Laganac", "Luluasan", "Montenegro", "Pararao", "Poblacion (Siramag)",
    "Pulang Daga", "Sagrada Nacacale", "San Francisco", "Santiago Nacacale",
    "Tapayas", "Tomatarayo",
  ],

  // Automatic urgency thresholds by affected-resident count — a rule-based
  // classification, not AI. Adjust these constants if the adviser/client
  // validates different cutoffs; nothing else needs to change.
  URGENCY_THRESHOLDS: [
    { max: 10, level: "low" },
    { max: 50, level: "medium" },
    { max: 100, level: "high" },
    { max: Infinity, level: "critical" },
  ],

  // --- Community Impact Index (CII) ----------------------------------------------
  // Exact formula per the approved manuscript's Project Dictionary (Ch.1 §1.6):
  //   CII = (Frequency x 1.5) + (Affected Count x 2.0) + (Recurrence Score x 1.0)
  // The manuscript defines the formula but not display bands — the label
  // thresholds below are a presentation-layer choice (badges, map/heatmap
  // color), not part of the manuscript formula itself, and can be retuned
  // here without touching the calculation logic.
  CII: {
    FREQUENCY_WEIGHT: 1.5,
    AFFECTED_COUNT_WEIGHT: 2.0,
    RECURRENCE_WEIGHT: 1.0,
    FREQUENCY_WINDOW_DAYS: 30,   // "...within the last 30 days"
    FREQUENCY_RADIUS_M: 150,     // "...similar reports in the same location"
    RECURRENCE_WINDOW_DAYS: 180, // "...during the past 6 months"
    RECURRENCE_GRID_PRECISION: 3, // same-asset proxy: ~110m grid cell + facility_type
    LABEL_THRESHOLDS: { critical: 20, high: 10, moderate: 4 }, // else "Low"
  },
};
