/*
 * MySQL connection layer (mysql2). One shared pool for the whole app.
 *
 * All DATETIME values are stored and read as UTC (timezone: "Z"), so JSON
 * responses serialize them as ISO-8601 strings the frontend already expects.
 */
const mysql = require("mysql2/promise");
const config = require("../config/config");

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.DB,
      timezone: "Z",
      waitForConnections: true,
      connectionLimit: 10,
      namedPlaceholders: true,
    });
  }
  return pool;
}

/** Run a query and return the rows (or the result header for writes). */
async function query(sql, params) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id                     INT AUTO_INCREMENT PRIMARY KEY,
    name                   VARCHAR(128) NOT NULL,
    email                  VARCHAR(190) NOT NULL UNIQUE,
    password_hash          VARCHAR(255) NOT NULL,
    contact                VARCHAR(128) DEFAULT '',
    barangay               VARCHAR(128) DEFAULT '',
    strikes                INT NOT NULL DEFAULT 0,
    blocked                TINYINT NOT NULL DEFAULT 0,
    valid_id_path          VARCHAR(255) DEFAULT '',
    id_verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    id_name_match          TINYINT NULL DEFAULT NULL,
    suspended_until        DATETIME NULL,
    permanently_flagged    TINYINT NOT NULL DEFAULT 0,
    admin_action_required  TINYINT NOT NULL DEFAULT 0,
    is_staff               TINYINT NOT NULL DEFAULT 0,
    created_at             DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NULL,
    type       VARCHAR(32) NOT NULL,
    message    VARCHAR(255) NOT NULL,
    report_id  INT NULL,
    is_read    TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    INDEX idx_notif_user (user_id, is_read),
    INDEX idx_notif_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS affected (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    report_id  INT NOT NULL,
    user_id    INT NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_affected (report_id, user_id),
    INDEX idx_affected_report (report_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS reports (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    reference          VARCHAR(20) UNIQUE,
    title              VARCHAR(255) NOT NULL,
    description        TEXT,
    category           VARCHAR(64) NOT NULL DEFAULT 'Other',
    facility_type      VARCHAR(32) NOT NULL DEFAULT 'other',
    latitude           DOUBLE NULL,
    longitude          DOUBLE NULL,
    address            VARCHAR(255) DEFAULT '',
    barangay           VARCHAR(128) DEFAULT '',
    photo_path         VARCHAR(128) DEFAULT '',
    reporter_name      VARCHAR(128) DEFAULT '',
    reporter_contact   VARCHAR(128) DEFAULT '',
    user_id            INT NULL,
    affected_residents INT DEFAULT 0,
    status             VARCHAR(20) NOT NULL DEFAULT 'pending',
    urgency            VARCHAR(20) NOT NULL DEFAULT 'medium',
    priority           TINYINT NOT NULL DEFAULT 0,
    assigned_to        VARCHAR(128) DEFAULT '',
    reporter_type      VARCHAR(20) NOT NULL DEFAULT 'resident',
    staff_office       VARCHAR(128) DEFAULT '',
    assigned_team      VARCHAR(128) DEFAULT '',
    created_at         DATETIME NOT NULL,
    updated_at         DATETIME NOT NULL,
    acknowledged_at    DATETIME NULL,
    resolved_at        DATETIME NULL,
    INDEX idx_reports_status (status),
    INDEX idx_reports_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS report_photos (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    report_id  INT NOT NULL,
    photo_path VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_report_photos_report (report_id),
    CONSTRAINT fk_report_photos_report FOREIGN KEY (report_id)
      REFERENCES reports(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS offenses (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    report_id        INT NULL,
    offense_number   INT NOT NULL,
    reason           VARCHAR(255) DEFAULT '',
    action_taken     VARCHAR(255) DEFAULT '',
    suspended_until  DATETIME NULL,
    actor            VARCHAR(128) DEFAULT '',
    created_at       DATETIME NOT NULL,
    INDEX idx_offenses_user (user_id),
    CONSTRAINT fk_offenses_report FOREIGN KEY (report_id)
      REFERENCES reports(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS activity_log (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    actor      VARCHAR(190) NOT NULL,
    role       VARCHAR(20) NOT NULL,
    action     VARCHAR(64) NOT NULL,
    detail     VARCHAR(255) DEFAULT '',
    created_at DATETIME NOT NULL,
    INDEX idx_activity_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS status_history (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    report_id  INT NOT NULL,
    status     VARCHAR(20) NOT NULL,
    note       TEXT,
    actor      VARCHAR(128) DEFAULT '',
    photo_path VARCHAR(128) DEFAULT '',
    office     VARCHAR(128) DEFAULT '',
    reason     VARCHAR(64) DEFAULT '',
    created_at DATETIME NOT NULL,
    INDEX idx_history_report (report_id),
    CONSTRAINT fk_history_report FOREIGN KEY (report_id)
      REFERENCES reports(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/** Create the database (if missing) and all tables. Called once at startup. */
async function initDb() {
  const { database, ...server } = config.DB;
  const conn = await mysql.createConnection({ ...server, timezone: "Z" });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();
  for (const stmt of SCHEMA) await query(stmt);
  // Migrations for databases created by earlier builds.
  const ALTERS = [
    "ALTER TABLE reports ADD COLUMN user_id INT NULL",
    "ALTER TABLE reports ADD COLUMN assigned_to VARCHAR(128) DEFAULT ''",
    "ALTER TABLE status_history ADD COLUMN photo_path VARCHAR(128) DEFAULT ''",
    "ALTER TABLE status_history ADD COLUMN office VARCHAR(128) DEFAULT ''",
    "ALTER TABLE status_history ADD COLUMN reason VARCHAR(64) DEFAULT ''",
    "ALTER TABLE users ADD COLUMN strikes INT NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN blocked TINYINT NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN valid_id_path VARCHAR(255) DEFAULT ''",
    "ALTER TABLE users ADD COLUMN id_verification_status VARCHAR(20) NOT NULL DEFAULT 'pending'",
    "ALTER TABLE users ADD COLUMN suspended_until DATETIME NULL",
    "ALTER TABLE users ADD COLUMN permanently_flagged TINYINT NOT NULL DEFAULT 0",
    "ALTER TABLE reports ADD COLUMN reporter_type VARCHAR(20) NOT NULL DEFAULT 'resident'",
    "ALTER TABLE reports ADD COLUMN staff_office VARCHAR(128) DEFAULT ''",
    "ALTER TABLE reports ADD COLUMN assigned_team VARCHAR(128) DEFAULT ''",
    "ALTER TABLE users ADD COLUMN is_staff TINYINT NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN id_name_match TINYINT NULL DEFAULT NULL",
    // Fake-report policy revision (three-attempt): 1st = warning (no account
    // side effect), 2nd = suspended_until (existing column, unchanged
    // meaning), 3rd+ = admin_action_required. Added as a NEW column rather
    // than reusing `permanently_flagged` because existing rows already carry
    // that field's OLD meaning ("2nd offense -> permanent block" under the
    // policy this replaces) — reusing it would silently reinterpret
    // historical data. Old permanently_flagged/blocked rows are left exactly
    // as they are; only new offenses use the new column.
    "ALTER TABLE users ADD COLUMN admin_action_required TINYINT NOT NULL DEFAULT 0",
  ];
  for (const stmt of ALTERS) {
    try {
      await query(stmt);
    } catch (err) {
      if (err.code !== "ER_DUP_FIELDNAME") throw err;
    }
  }
  // Migration: rename pre-manuscript workflow statuses to the approved ones.
  const RENAMES = [["submitted", "pending"], ["acknowledged", "verified"],
    ["in_progress", "ongoing"], ["rejected", "fake"]];
  for (const [oldS, newS] of RENAMES) {
    await query("UPDATE reports SET status=? WHERE status=?", [newS, oldS]);
    await query("UPDATE status_history SET status=? WHERE status=?", [newS, oldS]);
  }
}

/** Drop and recreate the database (used by the seeder's --reset). */
async function resetDb() {
  const { database, ...server } = config.DB;
  const conn = await mysql.createConnection({ ...server, timezone: "Z" });
  await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await conn.end();
  if (pool) {
    await pool.end();
    pool = null;
  }
  await initDb();
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, initDb, resetDb, closeDb };
