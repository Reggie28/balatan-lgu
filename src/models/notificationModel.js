/*
 * In-app notifications. user_id = a specific resident's notification;
 * user_id NULL = a notification for LGU administrators.
 */
const db = require("./db");

function utcnow() {
  const d = new Date();
  d.setMilliseconds(0);
  return d;
}

async function notify(userId, type, message, reportId = null) {
  await db.query(
    `INSERT INTO notifications (user_id, type, message, report_id, is_read, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [userId, type, String(message).slice(0, 255), reportId, utcnow()]
  );
}

const notifyAdmin = (type, message, reportId = null) =>
  notify(null, type, message, reportId);

async function listFor(userId, limit = 30) {
  const where = userId === null ? "user_id IS NULL" : "user_id = ?";
  const params = userId === null ? [limit] : [userId, limit];
  const rows = await db.query(
    `SELECT * FROM notifications WHERE ${where}
     ORDER BY created_at DESC, id DESC LIMIT ?`, params);
  const unread = await db.query(
    `SELECT COUNT(*) AS c FROM notifications WHERE ${where.replace("?", "?")} AND is_read = 0`,
    userId === null ? [] : [userId]);
  return { notifications: rows, unread: unread[0].c };
}

async function markAllRead(userId) {
  const where = userId === null ? "user_id IS NULL" : "user_id = ?";
  await db.query(
    `UPDATE notifications SET is_read = 1 WHERE ${where} AND is_read = 0`,
    userId === null ? [] : [userId]);
}

module.exports = { notify, notifyAdmin, listFor, markAllRead };
