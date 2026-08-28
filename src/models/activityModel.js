/*
 * Activity log (audit trail) — who did what, when. Recorded for sign-ins,
 * account creation, report submission and admin report actions.
 */
const db = require("./db");

async function log(actor, role, action, detail = "") {
  const now = new Date();
  now.setMilliseconds(0);
  await db.query(
    `INSERT INTO activity_log (actor, role, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [actor, role, action, String(detail).slice(0, 255), now]
  );
}

async function recent(limit = 50) {
  return db.query(
    "SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?",
    [limit]
  );
}

module.exports = { log, recent };
