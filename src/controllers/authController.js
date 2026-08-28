/*
 * Authentication:
 *   - Admin sign-in (LGU staff, username + password).
 *   - Resident registration and sign-in (email + password), protected by a
 *     geofence: residents can only sign in while physically inside the
 *     Municipality of Balatan (verified with the Haversine formula against
 *     the device's GPS position).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const config = require("../config/config");
const auth = require("../middleware/auth");
const userModel = require("../models/userModel");
const activityModel = require("../models/activityModel");
const notificationModel = require("../models/notificationModel");
const mailService = require("../services/mailService");
const idVerificationService = require("../services/idVerificationService");
const { haversineM } = require("../services/analyticsService");

/** multer stores the file's absolute path; convert to a URL-safe path
 * relative to the private ID uploads root. */
function relativeIdPath(file) {
  return path.relative(config.PRIVATE_UPLOAD_DIR, file.path).replace(/\\/g, "/");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Pending sign-ups awaiting email verification: email -> { payload, codeHash,
// expiresAt, attempts, lastSentAt }. In-memory, like sessions: a restart just
// means the resident restarts the (one-minute) sign-up.
const pendingSignups = new Map();
// Pending password resets: email -> { codeHash, expiresAt, attempts, lastSentAt }.
const pendingResets = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

/**
 * Returns null when the position is acceptable, otherwise an
 * { status, error } object describing why the action is refused.
 *
 * `accuracy` is the device's self-reported GPS accuracy in metres (optional
 * — older/unpatched clients simply won't send it). It never changes whether
 * a request is accepted: the boundary check below is untouched either way.
 * It only changes the wording of a rejection — when the reported accuracy
 * is large enough that the true position could plausibly be within the
 * radius despite the computed distance, the resident is told their reading
 * may be unreliable and to retry, instead of being flatly told they're
 * outside Balatan when that isn't actually certain.
 *
 * `opts.action`/`opts.label` let a second caller (report submission) reuse
 * this exact algorithm/config with contextually correct wording, without
 * duplicating the geofence logic. Defaults reproduce the original sign-in
 * text byte-for-byte, so register()/residentLogin() are unaffected.
 */
function checkGeofence(latitude, longitude, accuracy, opts = {}) {
  const { action = "sign in", label = "Sign-in" } = opts;
  // TEMPORARY presentation/demo bypass (BALATAN_DEMO_MODE=1). Does not touch
  // the geofence logic below — just short-circuits to "allowed" while active.
  // Unset the flag (or set it to 0/false) to restore normal enforcement.
  if (config.DEMO_MODE) return null;
  if (!config.GEOFENCE.enabled) return null;
  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return {
      status: 400,
      error: `Your location is required to ${action}. Please allow location access and try again.`,
    };
  }
  const distance = haversineM(config.DEFAULT_CENTER.lat, config.DEFAULT_CENTER.lng, lat, lng);
  if (distance > config.GEOFENCE.radiusKm * 1000) {
    const acc = parseFloat(accuracy);
    const excess = distance - config.GEOFENCE.radiusKm * 1000;
    if (!Number.isNaN(acc) && acc > 0 && excess < acc) {
      return {
        status: 403,
        error: `${label} could not be confirmed — your device's location reading was low-` +
               `confidence (accuracy ±${Math.round(acc)}m), so it may be inaccurate rather than ` +
               "genuinely outside Balatan. Please try again with GPS/location services on high " +
               "accuracy, ideally outdoors or near a window.",
      };
    }
    return {
      status: 403,
      error: `${label} is only available within the Municipality of Balatan. ` +
             "Your current location appears to be outside the municipality.",
    };
  }
  return null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email,
    contact: user.contact, barangay: user.barangay,
    id_verification_status: user.id_verification_status,
    suspended_until: user.suspended_until,
    permanently_flagged: !!user.permanently_flagged,
    admin_action_required: !!user.admin_action_required,
    is_staff: !!user.is_staff };
}

// --- Admin ------------------------------------------------------------------
async function login(req, res) {
  const { username = "", password = "" } = req.body || {};
  const okUser = auth.safeEqual(username, config.ADMIN_USERNAME);
  const okPass = auth.safeEqual(password, config.ADMIN_PASSWORD);
  if (okUser && okPass) {
    const token = auth.makeToken({ role: "admin", name: username });
    await activityModel.log(username, "admin", "signed in", "administrator sign-in");
    return res.json({ token, username });
  }
  res.status(401).json({ error: "Invalid username or password" });
}

// --- Residents ---------------------------------------------------------------
/**
 * Step 1 of sign-up: validate everything, then email a one-time passcode
 * (OTP) to the address. The account is only created after the code is
 * confirmed via verifyOtp() — proving the resident owns the email.
 */
async function register(req, res) {
  const { name = "", email = "", password = "", contact = "", barangay = "",
    latitude, longitude, accuracy } = req.body || {};

  const geo = checkGeofence(latitude, longitude, accuracy);
  if (geo) return res.status(geo.status).json({ error: geo.error });

  if (!name.trim()) return res.status(400).json({ error: "Name is required" });
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "A valid ID photo is required to register" });
  }
  if (await userModel.findByEmail(email)) {
    return res.status(409).json({ error: "An account with this email already exists — sign in instead" });
  }

  const key = email.trim().toLowerCase();
  const existing = pendingSignups.get(key);
  if (existing && Date.now() - existing.lastSentAt < OTP_RESEND_MS) {
    return res.status(429).json({
      error: "A code was just sent — please wait a minute before requesting another",
    });
  }

  // Best-effort OCR name check against the uploaded ID — never blocks
  // registration, just flags a possible mismatch for the admin's manual
  // review (see idVerificationService for why).
  const idNameMatch = await idVerificationService.checkNameOnId(req.file.path, name);

  const code = crypto.randomInt(100000, 1000000).toString();
  pendingSignups.set(key, {
    payload: { name: name.trim(), email: email.trim(), password,
      contact: contact.trim(), barangay: barangay.trim(),
      valid_id_path: relativeIdPath(req.file), id_name_match: idNameMatch },
    codeHash: hashCode(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: Date.now(),
  });

  const delivery = await mailService.sendOtp(email.trim(), code);
  res.json({ otp_required: true, email: email.trim(), delivery });
}

/** Step 2 of sign-up: confirm the emailed code, then create the account. */
async function verifyOtp(req, res) {
  const { email = "", code = "" } = req.body || {};
  const key = String(email).trim().toLowerCase();
  const pending = pendingSignups.get(key);

  if (!pending) {
    return res.status(400).json({ error: "No pending sign-up for this email — please register again" });
  }
  if (Date.now() > pending.expiresAt) {
    pendingSignups.delete(key);
    return res.status(400).json({ error: "That code has expired — please register again" });
  }
  pending.attempts += 1;
  if (pending.attempts > OTP_MAX_ATTEMPTS) {
    pendingSignups.delete(key);
    return res.status(400).json({ error: "Too many wrong attempts — please register again" });
  }
  if (!auth.safeEqual(hashCode(String(code).trim()), pending.codeHash)) {
    return res.status(400).json({ error: "Incorrect code — please check your email and try again" });
  }

  pendingSignups.delete(key);
  if (await userModel.findByEmail(pending.payload.email)) {
    return res.status(409).json({ error: "An account with this email already exists — sign in instead" });
  }
  const user = await userModel.createUser(pending.payload);
  const token = auth.makeToken({ role: "resident", userId: user.id,
    name: user.name, email: user.email });
  await activityModel.log(user.email, "resident", "account created",
    `email verified for ${user.name}`);
  if (pending.payload.id_name_match === false) {
    await notificationModel.notifyAdmin("id_mismatch",
      `${user.name} registered but the OCR name check didn't match their uploaded ID — review it in Manage Accounts.`);
  }
  res.status(201).json({ token, user: publicUser(user) });
}

async function residentLogin(req, res) {
  const { email = "", password = "", latitude, longitude, accuracy } = req.body || {};

  const geo = checkGeofence(latitude, longitude, accuracy);
  if (geo) return res.status(geo.status).json({ error: geo.error });

  const user = await userModel.findByEmail(email);
  if (!user || !userModel.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (user.blocked) {
    return res.status(403).json({
      error: "This account has been blocked after repeated fake reports. " +
             "Please contact the LGU office to appeal.",
    });
  }
  const token = auth.makeToken({ role: "resident", userId: user.id,
    name: user.name, email: user.email });
  await activityModel.log(user.email, "resident", "signed in", "resident sign-in");
  res.json({ token, user: publicUser(user) });
}

// --- Password reset (forgot password) -------------------------------------------
async function forgotPassword(req, res) {
  const { email = "" } = req.body || {};
  const user = await userModel.findByEmail(email);
  if (!user) {
    return res.status(404).json({ error: "No account with this email address" });
  }
  const key = user.email;
  const existing = pendingResets.get(key);
  if (existing && Date.now() - existing.lastSentAt < OTP_RESEND_MS) {
    return res.status(429).json({
      error: "A code was just sent — please wait a minute before requesting another",
    });
  }
  const code = crypto.randomInt(100000, 1000000).toString();
  pendingResets.set(key, {
    codeHash: hashCode(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: Date.now(),
  });
  const delivery = await mailService.sendOtp(user.email, code, "reset");
  await activityModel.log(user.email, "resident", "password reset requested", "");
  res.json({ ok: true, email: user.email, delivery });
}

async function resetPassword(req, res) {
  const { email = "", code = "", new_password = "" } = req.body || {};
  const key = String(email).trim().toLowerCase();
  const pending = pendingResets.get(key);
  if (!pending) {
    return res.status(400).json({ error: "No pending reset for this email — request a code first" });
  }
  if (Date.now() > pending.expiresAt) {
    pendingResets.delete(key);
    return res.status(400).json({ error: "That code has expired — request a new one" });
  }
  pending.attempts += 1;
  if (pending.attempts > OTP_MAX_ATTEMPTS) {
    pendingResets.delete(key);
    return res.status(400).json({ error: "Too many wrong attempts — request a new code" });
  }
  if (!auth.safeEqual(hashCode(String(code).trim()), pending.codeHash)) {
    return res.status(400).json({ error: "Incorrect code — please check your email and try again" });
  }
  if (String(new_password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  pendingResets.delete(key);
  const user = await userModel.findByEmail(key);
  if (!user) return res.status(404).json({ error: "Account no longer exists" });
  await userModel.updatePassword(user.id, new_password);
  await activityModel.log(user.email, "resident", "password reset", "via emailed code");
  res.json({ ok: true });
}

// --- Profile management -----------------------------------------------------------
async function getProfile(req, res) {
  const user = await userModel.getUser(req.session.userId);
  if (!user) return res.status(404).json({ error: "Account not found" });
  res.json(publicUser(user));
}

async function updateProfile(req, res) {
  const { name = "", contact = "", barangay = "" } = req.body || {};
  if (!name.trim()) return res.status(400).json({ error: "Name is required" });
  const user = await userModel.updateProfile(req.session.userId,
    { name: name.trim(), contact: contact.trim(), barangay: barangay.trim() });
  req.session.name = user.name; // keep the live session in step
  await activityModel.log(user.email, "resident", "profile updated", "");
  res.json(publicUser(user));
}

/** Resident self-service: replace the uploaded valid ID (e.g. after a
 * rejection or an OCR name-mismatch flag) and go back into the admin's
 * review queue. Never auto-verifies — a human still makes the final call. */
async function reuploadValidId(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "Please choose an ID photo to upload" });
  }
  const user = await userModel.getUser(req.session.userId);
  if (!user) return res.status(404).json({ error: "Account not found" });
  const oldRelPath = await userModel.getValidIdPath(user.id);

  const idNameMatch = await idVerificationService.checkNameOnId(req.file.path, user.name);
  const updated = await userModel.updateValidId(user.id, {
    valid_id_path: relativeIdPath(req.file), id_name_match: idNameMatch,
  });
  await activityModel.log(user.email, "resident", "valid ID re-uploaded",
    idNameMatch === false ? "OCR name check did not match" : "");
  // Best-effort cleanup of the superseded photo — a personal document, so it
  // shouldn't linger on disk once replaced. Never let this fail the request.
  if (oldRelPath) {
    const oldAbs = path.join(config.PRIVATE_UPLOAD_DIR, oldRelPath);
    if (oldAbs.startsWith(config.PRIVATE_UPLOAD_DIR)) {
      fs.unlink(oldAbs, () => {});
    }
  }
  await notificationModel.notifyAdmin("id_reupload",
    `${user.name} uploaded a new ID for review` +
    (idNameMatch === false ? " (OCR name check didn't match)." : "."));
  res.json(publicUser(updated));
}

async function changePassword(req, res) {
  const { current_password = "", new_password = "" } = req.body || {};
  const user = await userModel.findByEmail(req.session.email);
  if (!user || !userModel.verifyPassword(current_password, user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  if (String(new_password).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  await userModel.updatePassword(user.id, new_password);
  await activityModel.log(user.email, "resident", "password changed", "");
  res.json({ ok: true });
}

// --- Admin: valid ID review & offense history -----------------------------------
/** Streams a resident's uploaded valid-ID image. The path itself is never
 * returned in any JSON response — only reachable through this authenticated,
 * admin-only route. */
async function adminGetValidId(req, res) {
  const relPath = await userModel.getValidIdPath(req.params.id);
  if (!relPath) return res.status(404).json({ error: "No ID on file for this account" });
  const abs = path.join(config.PRIVATE_UPLOAD_DIR, relPath);
  if (!abs.startsWith(config.PRIVATE_UPLOAD_DIR) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.sendFile(abs);
}

async function adminListOffenses(req, res) {
  res.json(await userModel.listOffenses(req.params.id));
}

// --- Shared -------------------------------------------------------------------
async function me(req, res) {
  const session = auth.sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: "Not signed in" });
  res.json({ role: session.role, name: session.name, email: session.email || null });
}

async function logout(req, res) {
  auth.revokeToken(auth.tokenFromRequest(req));
  res.json({ ok: true });
}

module.exports = { login, register, verifyOtp, residentLogin, forgotPassword,
  resetPassword, getProfile, updateProfile, reuploadValidId, changePassword, me, logout,
  checkGeofence, adminGetValidId, adminListOffenses };
