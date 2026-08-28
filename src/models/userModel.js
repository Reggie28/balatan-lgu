/*
 * User model — resident accounts (email + password).
 * Passwords are hashed with bcrypt (per the approved manuscript's security
 * design). Hashes created by earlier builds used scrypt ("scrypt$salt$hash")
 * and are still verifiable so existing accounts keep working.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");
const config = require("../config/config");

const BCRYPT_ROUNDS = 10;

function hashPassword(password) {
  return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

function verifyPassword(password, stored) {
  const s = String(stored || "");
  if (s.startsWith("scrypt$")) {
    // Legacy scrypt hash from earlier builds.
    const [, salt, hash] = s.split("$");
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length &&
      crypto.timingSafeEqual(candidate, expected);
  }
  return bcrypt.compareSync(String(password), s);
}

async function createUser({ name, email, password, contact = "", barangay = "", valid_id_path = "", id_name_match = null }) {
  const now = new Date();
  now.setMilliseconds(0);
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash, contact, barangay, valid_id_path, id_name_match, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, email.toLowerCase(), hashPassword(password), contact, barangay, valid_id_path, id_name_match, now]
  );
  return getUser(result.insertId);
}

async function getUser(id) {
  const rows = await db.query(
    `SELECT id, name, email, contact, barangay, strikes, blocked,
            id_verification_status, id_name_match, suspended_until, permanently_flagged,
            admin_action_required, is_staff, created_at
     FROM users WHERE id=?`,
    [id]
  );
  return rows[0] || null;
}

/** Admin-only: grant or revoke a resident's eligibility to submit reports as
 * staff (reportController.create() enforces this — the reporter_type=staff
 * toggle is self-declared on the form, but the server rejects it unless the
 * account has actually been marked eligible here). */
async function setStaffEligibility(id, isStaff) {
  await db.query("UPDATE users SET is_staff=? WHERE id=?", [isStaff ? 1 : 0, id]);
  return getUser(id);
}

/** Internal use only (streaming route) — never returned via a JSON list/get. */
async function getValidIdPath(id) {
  const rows = await db.query("SELECT valid_id_path FROM users WHERE id=?", [id]);
  return rows[0] ? rows[0].valid_id_path : "";
}

async function setIdVerificationStatus(id, status) {
  await db.query("UPDATE users SET id_verification_status=? WHERE id=?", [status, id]);
  return getUser(id);
}

/** Resident self-service: replaces the uploaded ID and puts the account back
 * into "pending" review — a rejected/mismatched ID doesn't stay rejected
 * forever once the resident fixes it. */
async function updateValidId(id, { valid_id_path, id_name_match }) {
  await db.query(
    `UPDATE users SET valid_id_path=?, id_name_match=?, id_verification_status='pending' WHERE id=?`,
    [valid_id_path, id_name_match, id]
  );
  return getUser(id);
}

async function findByEmail(email) {
  const rows = await db.query("SELECT * FROM users WHERE email=?",
    [String(email || "").toLowerCase()]);
  return rows[0] || null;
}

async function countUsers() {
  const rows = await db.query("SELECT COUNT(*) AS c FROM users");
  return rows[0].c;
}

async function updateProfile(id, { name, contact, barangay }) {
  await db.query("UPDATE users SET name=?, contact=?, barangay=? WHERE id=?",
    [name, contact, barangay, id]);
  return getUser(id);
}

async function updatePassword(id, password) {
  await db.query("UPDATE users SET password_hash=? WHERE id=?",
    [hashPassword(password), id]);
}

/** Adjust the fake-report strike count; returns the updated user. */
async function addStrikes(id, delta, strikeLimit) {
  await db.query("UPDATE users SET strikes = GREATEST(strikes + ?, 0) WHERE id=?",
    [delta, id]);
  const user = await getUser(id);
  const shouldBlock = user.strikes >= strikeLimit ? 1 : 0;
  if (shouldBlock !== user.blocked) {
    await db.query("UPDATE users SET blocked=? WHERE id=?", [shouldBlock, id]);
    user.blocked = shouldBlock;
  }
  return user;
}

async function setBlocked(id, blocked) {
  await db.query("UPDATE users SET blocked=? WHERE id=?", [blocked ? 1 : 0, id]);
  return getUser(id);
}

/**
 * Three-attempt offense policy for confirmed fake reports (client-confirmed
 * revision, replaces the previous 1st-suspend/2nd-permanent-block policy):
 *   1st offense -> Warning (no account-level side effect)
 *   2nd offense -> suspended_until = now + config.OFFENSE_SUSPENSION_DAYS
 *   3rd (or later) offense -> admin_action_required = 1 (flagged for the
 *     LGU/MEO to handle administratively; the system does not impose an
 *     automatic block or any criminal/legal penalty on its own)
 * Writes a row to the `offenses` table on every call so the escalation and
 * its cause stay auditable, and the offense count is derived by counting
 * those rows — it never resets on its own (e.g. when a suspension expires).
 * Returns { user, offenseNumber } so callers can branch on the tier without
 * re-deriving it from raw account fields.
 */
async function recordOffense(userId, { reportId = null, reason = "", actor = "admin" }) {
  const countRow = await db.query(
    "SELECT COUNT(*) AS c FROM offenses WHERE user_id=?", [userId]);
  const offenseNumber = countRow[0].c + 1;
  const now = new Date();
  now.setMilliseconds(0);
  let suspendedUntil = null;
  let actionTaken;
  if (offenseNumber === 1) {
    actionTaken = "Warning issued";
  } else if (offenseNumber === 2) {
    suspendedUntil = new Date(now.getTime() + config.OFFENSE_SUSPENSION_DAYS * 86400000);
    actionTaken = `Suspended ${config.OFFENSE_SUSPENSION_DAYS} day(s)`;
    await db.query("UPDATE users SET suspended_until=? WHERE id=?", [suspendedUntil, userId]);
  } else {
    actionTaken = "Flagged for Administrative Action";
    await db.query("UPDATE users SET admin_action_required=1 WHERE id=?", [userId]);
  }
  await db.query(
    `INSERT INTO offenses (user_id, report_id, offense_number, reason, action_taken,
        suspended_until, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, reportId, offenseNumber, reason, actionTaken, suspendedUntil, actor, now]
  );
  return { user: await getUser(userId), offenseNumber };
}

/**
 * Reverses the most recent offense tied to a specific report (an admin
 * correcting a mistaken "fake" flag). Lifts exactly the side effect that
 * offense tier applied: nothing for a 1st-offense warning, the suspension
 * for a 2nd offense, or — if no other 3rd+ offense remains — the
 * Administrative Action flag for a 3rd+ offense.
 */
async function reverseOffense(userId, reportId) {
  const rows = await db.query(
    `SELECT * FROM offenses WHERE user_id=? AND report_id=?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId, reportId]
  );
  const offense = rows[0];
  if (!offense) return getUser(userId);
  await db.query("DELETE FROM offenses WHERE id=?", [offense.id]);
  if (offense.offense_number === 2) {
    await db.query("UPDATE users SET suspended_until=NULL WHERE id=?", [userId]);
  } else if (offense.offense_number >= 3) {
    const remaining = await db.query(
      "SELECT COUNT(*) AS c FROM offenses WHERE user_id=? AND offense_number>=3", [userId]);
    if (remaining[0].c === 0) {
      await db.query("UPDATE users SET admin_action_required=0 WHERE id=?", [userId]);
    }
  }
  return getUser(userId);
}

async function listOffenses(userId) {
  return db.query(
    "SELECT * FROM offenses WHERE user_id=? ORDER BY created_at DESC, id DESC", [userId]);
}

/** Admin view: all residents with their report counts and fake-report offense count. */
async function listUsers() {
  return db.query(
    `SELECT u.id, u.name, u.email, u.contact, u.barangay, u.strikes, u.blocked,
            u.id_verification_status, u.id_name_match, u.suspended_until, u.permanently_flagged,
            u.admin_action_required, u.is_staff, u.created_at,
            (SELECT COUNT(*) FROM reports r WHERE r.user_id = u.id) AS report_count,
            (SELECT COUNT(*) FROM offenses o WHERE o.user_id = u.id) AS offense_count
     FROM users u ORDER BY u.created_at DESC`);
}

module.exports = { hashPassword, verifyPassword, createUser, getUser,
  getValidIdPath, setIdVerificationStatus, updateValidId, setStaffEligibility, findByEmail,
  countUsers, updateProfile, updatePassword, addStrikes, recordOffense,
  reverseOffense, listOffenses, setBlocked, listUsers };
