/*
 * Report model — all persistence for reports and their status history.
 * (The "M" in MVC: controllers never touch SQL directly.)
 */
const db = require("./db");

/** ISO-second precision "now" (DATETIME has no milliseconds anyway). */
function utcnow() {
  const d = new Date();
  d.setMilliseconds(0);
  return d;
}

async function createReport(data) {
  const now = utcnow();
  const result = await db.query(
    `INSERT INTO reports (title, description, category, facility_type,
        latitude, longitude, address, barangay, photo_path,
        reporter_name, reporter_contact, user_id, affected_residents,
        status, urgency, reporter_type, staff_office, created_at, updated_at)
     VALUES (:title, :description, :category, :facility_type,
        :latitude, :longitude, :address, :barangay, :photo_path,
        :reporter_name, :reporter_contact, :user_id, :affected_residents,
        'pending', :urgency, :reporter_type, :staff_office, :now, :now)`,
    { user_id: null, reporter_type: "resident", staff_office: "", ...data, now }
  );
  const id = result.insertId;
  const reference = `BAL-${now.getFullYear()}-${String(id).padStart(5, "0")}`;
  await db.query("UPDATE reports SET reference=? WHERE id=?", [reference, id]);
  await db.query(
    `INSERT INTO status_history (report_id, status, note, actor, created_at)
     VALUES (?, 'pending', 'Report submitted by resident', ?, ?)`,
    [id, data.reporter_name || "Resident", now]
  );
  return getReport(id);
}

/** Insert the full ordered photo set for a report (report_photos table). */
async function addReportPhotos(reportId, photoPaths) {
  const now = utcnow();
  for (const p of photoPaths) {
    await db.query(
      "INSERT INTO report_photos (report_id, photo_path, created_at) VALUES (?, ?, ?)",
      [reportId, p, now]
    );
  }
}

// Every report row carries how many residents pressed "I am affected".
const AFFECTED_COL =
  "(SELECT COUNT(*) FROM affected a WHERE a.report_id = reports.id) AS affected_count";

async function getReport(id) {
  const rows = await db.query(
    `SELECT reports.*, ${AFFECTED_COL} FROM reports WHERE id=?`, [id]);
  const report = rows[0] || null;
  if (report) {
    report.photos = await db.query(
      "SELECT id, photo_path, created_at FROM report_photos WHERE report_id=? ORDER BY id ASC",
      [id]
    );
  }
  return report;
}

async function listReports(filters = {}) {
  const clauses = [];
  const params = [];
  for (const key of ["status", "urgency", "facility_type", "category"]) {
    if (filters[key]) {
      clauses.push(`${key}=?`);
      params.push(filters[key]);
    }
  }
  if (filters.q) {
    clauses.push("(title LIKE ? OR description LIKE ? OR address LIKE ? OR barangay LIKE ?)");
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  if (filters.user_id) {
    clauses.push("user_id=?");
    params.push(filters.user_id);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  return db.query(
    `SELECT reports.*, ${AFFECTED_COL} FROM reports ${where}
     ORDER BY priority DESC, created_at DESC`,
    params
  );
}

async function updateReport(id, changes, actor = "admin") {
  const report = await getReport(id);
  if (!report) return null;

  const now = utcnow();
  const fields = [];
  const params = [];
  for (const key of ["urgency", "priority", "affected_residents", "facility_type",
                     "category", "address", "barangay", "assigned_to", "assigned_team"]) {
    if (key in changes && changes[key] !== null && changes[key] !== undefined) {
      fields.push(`${key}=?`);
      params.push(changes[key]);
    }
  }

  const newStatus = changes.status;
  const statusChanged = Boolean(newStatus && newStatus !== report.status);
  if (statusChanged) {
    fields.push("status=?");
    params.push(newStatus);
    // First movement away from 'pending' is the LGU's first response.
    if (report.status === "pending" && !report.acknowledged_at) {
      fields.push("acknowledged_at=?");
      params.push(now);
    }
    if (newStatus === "resolved") {
      fields.push("resolved_at=?");
      params.push(now);
    }
  }

  fields.push("updated_at=?");
  params.push(now, id);
  await db.query(`UPDATE reports SET ${fields.join(", ")} WHERE id=?`, params);

  const note = changes.note || "";
  if (statusChanged) {
    await db.query(
      `INSERT INTO status_history (report_id, status, note, actor, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, newStatus, note, actor, now]
    );
  } else if (note) {
    await db.query(
      `INSERT INTO status_history (report_id, status, note, actor, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, report.status, note, actor, now]
    );
  }
  return getReport(id);
}

async function getHistory(reportId) {
  return db.query(
    "SELECT * FROM status_history WHERE report_id=? ORDER BY created_at DESC, id DESC",
    [reportId]
  );
}

/**
 * Progress update: a history entry with an optional photo (repair evidence),
 * and optionally a concerned office + reason (inter-office coordination —
 * e.g. Treasury / Budget approval) separate from the report's primary
 * assigned_to office.
 */
async function addProgress(reportId, { note = "", photoPath = "", actor = "admin",
  office = "", reason = "" }) {
  const report = await getReport(reportId);
  if (!report) return null;
  const now = utcnow();
  await db.query(
    `INSERT INTO status_history (report_id, status, note, actor, photo_path, office, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [reportId, report.status, note, actor, photoPath, office, reason, now]
  );
  await db.query("UPDATE reports SET updated_at=? WHERE id=?", [now, reportId]);
  return getReport(reportId);
}

/** "I am affected" toggle. Returns { affected, count }. */
async function toggleAffected(reportId, userId) {
  const existing = await db.query(
    "SELECT id FROM affected WHERE report_id=? AND user_id=?", [reportId, userId]);
  if (existing.length) {
    await db.query("DELETE FROM affected WHERE id=?", [existing[0].id]);
  } else {
    await db.query(
      "INSERT INTO affected (report_id, user_id, created_at) VALUES (?, ?, ?)",
      [reportId, userId, utcnow()]);
  }
  const count = (await db.query(
    "SELECT COUNT(*) AS c FROM affected WHERE report_id=?", [reportId]))[0].c;
  return { affected: !existing.length, count };
}

async function isAffected(reportId, userId) {
  const rows = await db.query(
    "SELECT id FROM affected WHERE report_id=? AND user_id=?", [reportId, userId]);
  return rows.length > 0;
}

async function allReports() {
  return listReports({});
}

async function countReports() {
  const rows = await db.query("SELECT COUNT(*) AS c FROM reports");
  return rows[0].c;
}

module.exports = { utcnow, createReport, addReportPhotos, getReport, listReports,
  updateReport, getHistory, addProgress, toggleAffected, isAffected, allReports,
  countReports };
