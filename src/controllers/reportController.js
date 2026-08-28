/*
 * Report controller — public submission/tracking plus admin management.
 */
const path = require("path");
const fs = require("fs");
const config = require("../config/config");
const reportModel = require("../models/reportModel");
const userModel = require("../models/userModel");
const activityModel = require("../models/activityModel");
const notificationModel = require("../models/notificationModel");
const mailService = require("../services/mailService");
const analytics = require("../services/analyticsService");
const auth = require("../middleware/auth");
const authController = require("./authController");
const { verifyTurnstile } = require("../services/turnstileService");

const DUPLICATE_RADIUS_M = 150;
const DUPLICATE_WINDOW_DAYS = 90;
const NEARBY_ALERT_RADIUS_M = 1000;

function toFloat(v) {
  const f = parseFloat(v);
  return Number.isNaN(f) ? null : f;
}

function toInt(v, fallback = 0) {
  const f = parseFloat(v);
  return Number.isNaN(f) ? fallback : Math.trunc(f);
}

/** multer stores the file's absolute path; convert to a URL-safe path
 * relative to the uploads root (e.g. "2026-08/abc123.jpg" for a new,
 * dated-subfolder upload, or just "abc123.jpg" for an older flat one) —
 * forward slashes on every platform, including Windows. */
function relativeUploadPath(file) {
  return path.relative(config.UPLOAD_DIR, file.path).replace(/\\/g, "/");
}

/**
 * Per the manuscript's Data Privacy Act (RA 10173) commitment, public report
 * responses must not expose a resident's name/contact. Full reporter info is
 * only included for an authenticated admin, or for the resident who owns
 * the report being viewed.
 */
function shapeReporterInfo(report, session) {
  const isAdmin = session && session.role === "admin";
  const isOwner = session && session.role === "resident" && session.userId === report.user_id;
  if (!isAdmin && !isOwner) {
    delete report.reporter_name;
    delete report.reporter_contact;
  }
  return report;
}

/** Score every report's Community Impact Index against the full dataset
 * (not a filtered subset), so Frequency/Recurrence Score stay correct
 * regardless of which filter is applied in the UI. */
function scoreAll(reports, allReports) {
  for (const r of reports) r.impact = analytics.impactScore(r, allReports);
  return reports;
}

/** Server-authoritative urgency from affected-resident count
 * (config.URGENCY_THRESHOLDS) — any client-supplied urgency on submission
 * is ignored. Admins may still override urgency afterward via patch(). */
function computeUrgency(affectedCount) {
  const n = Math.max(0, affectedCount);
  for (const t of config.URGENCY_THRESHOLDS) {
    if (n <= t.max) return t.level;
  }
  return config.URGENCY_THRESHOLDS[config.URGENCY_THRESHOLDS.length - 1].level;
}

/** Resident endpoint — signed-in residents (or staff reporting on-behalf,
 * via reporter_type) submit issues (multipart form, 1-5 photos). */
async function create(req, res) {
  const form = req.body || {};
  const title = (form.title || "").trim();
  if (!title) return res.status(400).json({ error: "Title is required" });

  // Reporter identity comes from the signed-in resident account (staff
  // reporting reuses the same resident login — no separate staff account —
  // and is distinguished only by the reporter_type/staff_office fields).
  const session = req.session;
  const account = await userModel.getUser(session.userId);
  if (!account || account.blocked) {
    return res.status(403).json({
      error: "This account has been blocked. Please contact the LGU office to appeal.",
    });
  }
  if (account.id_verification_status === "rejected") {
    return res.status(403).json({
      error: "Your uploaded ID was rejected, so new reports are on hold until you " +
             "upload a new ID photo from your profile for re-review.",
    });
  }
  if (account.suspended_until && new Date(account.suspended_until) > new Date()) {
    const until = new Date(account.suspended_until)
      .toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
    return res.status(403).json({
      error: `Your account is temporarily suspended from submitting new reports until ` +
             `${until}, following a fake-report offense.`,
    });
  }
  if (account.admin_action_required) {
    return res.status(403).json({
      error: "Your account has been referred for administrative action following repeated " +
             "fake reports. New report submissions are on hold; please contact the LGU office.",
    });
  }

  // CAPTCHA — verified BEFORE any report is created. Fails closed if
  // Turnstile is unconfigured, unless the explicit dev bypass is on.
  const captchaOk = await verifyTurnstile(form.turnstile_token, req.ip);
  if (!captchaOk) {
    return res.status(400).json({ error: "CAPTCHA verification failed. Please try again." });
  }

  // Geofence: the RESIDENT'S CURRENT DEVICE location must be within Balatan
  // to submit — not the report's pin location (form.latitude/longitude),
  // which legitimately marks the facility/problem and may be elsewhere.
  // Reuses the exact same algorithm/config as registration/login.
  const geo = authController.checkGeofence(form.device_latitude, form.device_longitude,
    form.device_accuracy, { action: "submit a report", label: "Reporting" });
  if (geo) return res.status(geo.status).json({ error: geo.error });

  // Reporter type + staff-conditional validation. reporter_type=staff is
  // self-declared on the form, but only honored when the account has been
  // marked staff-eligible by an admin (Residents -> Manage Accounts) — an
  // ordinary resident cannot grant themselves staff standing just by
  // toggling the form.
  const reporterType = form.reporter_type === "staff" ? "staff" : "resident";
  const staffOffice = (form.staff_office || "").trim();
  if (reporterType === "staff") {
    if (!account.is_staff) {
      return res.status(403).json({
        error: "Your account is not authorized to submit staff reports. Contact the LGU office to request staff access.",
      });
    }
    if (!staffOffice) {
      return res.status(400).json({ error: "Staff office is required when reporting as staff" });
    }
  }

  // Required-field + enum validation.
  const description = (form.description || "").trim();
  if (!description) return res.status(400).json({ error: "Description is required" });
  if (!config.CATEGORIES.includes(form.category)) {
    return res.status(400).json({ error: `Category must be one of: ${config.CATEGORIES.join(", ")}` });
  }
  const facilityKeys = config.FACILITY_TYPES.map((f) => f.key);
  if (!facilityKeys.includes(form.facility_type)) {
    return res.status(400).json({ error: `Facility type must be one of: ${facilityKeys.join(", ")}` });
  }
  const barangay = (form.barangay || "").trim();
  if (!barangay || !config.BARANGAYS.includes(barangay)) {
    return res.status(400).json({ error: "A valid barangay is required" });
  }

  // Photos — at least one required; multer (upload.array("photos", 5)) caps
  // the count at 5, rejected upstream by the error handler in server.js.
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: "At least one photo is required" });
  }
  const photoPaths = files.map(relativeUploadPath);

  // Urgency is always server-computed from affected_residents — any
  // client-supplied urgency value is ignored.
  const affectedResidents = toInt(form.affected_residents, 0);
  const urgency = computeUrgency(affectedResidents);

  const report = await reportModel.createReport({
    title,
    description,
    category: form.category,
    facility_type: form.facility_type,
    latitude: toFloat(form.latitude),
    longitude: toFloat(form.longitude),
    address: (form.address || "").trim(),
    barangay,
    photo_path: photoPaths[0],
    reporter_name: session.name,
    reporter_contact: (form.reporter_contact || "").trim() || session.email,
    user_id: session.userId,
    affected_residents: affectedResidents,
    urgency,
    reporter_type: reporterType,
    staff_office: reporterType === "staff" ? staffOffice : "",
  });
  await reportModel.addReportPhotos(report.id, photoPaths);
  report.photos = photoPaths.map((p) => ({ photo_path: p }));
  const all = await reportModel.allReports();
  report.impact = analytics.impactScore(report, all);
  await activityModel.log(session.email, "resident", "report submitted",
    `${report.reference}: ${report.title}`);

  // Alert the LGU about the new report.
  await notificationModel.notifyAdmin("new_report",
    `New report ${report.reference}: ${report.title}`, report.id);

  // Alert residents who reported nearby issues ("something new near you").
  if (report.latitude !== null && report.longitude !== null) {
    const nearbyOwners = new Set();
    for (const r of all) {
      if (!r.user_id || r.user_id === session.userId || r.id === report.id) continue;
      const d = analytics.haversineM(report.latitude, report.longitude,
        r.latitude, r.longitude);
      if (d <= NEARBY_ALERT_RADIUS_M) nearbyOwners.add(r.user_id);
    }
    for (const uid of nearbyOwners) {
      await notificationModel.notify(uid, "nearby",
        `A new issue was reported near you: ${report.title} (${report.reference})`,
        report.id);
    }
  }

  res.status(201).json(report);
}

/**
 * Duplicate detection — open reports of the same category near a position,
 * so the portal can warn the resident before they submit a copy.
 */
async function nearby(req, res) {
  const lat = parseFloat(req.query.latitude);
  const lng = parseFloat(req.query.longitude);
  const category = req.query.category || "";
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.json([]);

  const cutoff = Date.now() - DUPLICATE_WINDOW_DAYS * 86400000;
  const matches = (await reportModel.allReports())
    .filter((r) =>
      r.category === category &&
      !["resolved", "fake"].includes(r.status) &&
      r.created_at && new Date(r.created_at).getTime() >= cutoff)
    .map((r) => ({ ...r,
      distance_m: Math.round(analytics.haversineM(lat, lng, r.latitude, r.longitude)) }))
    .filter((r) => r.distance_m <= DUPLICATE_RADIUS_M)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, 5)
    .map((r) => ({ id: r.id, reference: r.reference, title: r.title,
      status: r.status, barangay: r.barangay, distance_m: r.distance_m }));
  res.json(matches);
}

async function list(req, res) {
  const filters = {};
  for (const key of ["status", "urgency", "facility_type", "category", "q"]) {
    if (req.query[key]) filters[key] = req.query[key];
  }
  const reports = await reportModel.listReports(filters);
  const all = await reportModel.allReports();
  scoreAll(reports, all);
  const session = auth.sessionFromRequest(req);
  for (const r of reports) shapeReporterInfo(r, session);
  res.json(reports);
}

async function get(req, res) {
  const report = await reportModel.getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Not found" });
  report.impact = analytics.impactScore(report, await reportModel.allReports());
  report.history = await reportModel.getHistory(report.id);
  // Tell a signed-in resident whether they already pressed "I am affected".
  const session = auth.sessionFromRequest(req);
  if (session && session.role === "resident") {
    report.i_am_affected = await reportModel.isAffected(report.id, session.userId);
  }
  shapeReporterInfo(report, session);
  res.json(report);
}

async function history(req, res) {
  const report = await reportModel.getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Not found" });
  res.json(await reportModel.getHistory(report.id));
}

/** Admin endpoint — update status/urgency/priority/assignment, add notes. */
async function patch(req, res) {
  const data = req.body || {};
  const allowed = {};
  for (const key of ["status", "urgency", "priority", "affected_residents",
                     "facility_type", "category", "address", "barangay",
                     "assigned_to", "assigned_team", "note"]) {
    if (key in data) allowed[key] = data[key];
  }
  const before = await reportModel.getReport(req.params.id);
  if (!before) return res.status(404).json({ error: "Not found" });

  // Enforce the confirmed MEO-revision workflow graph (config.STATUS_TRANSITIONS).
  // Non-status fields are always editable.
  if (allowed.status && allowed.status !== before.status) {
    const validNext = config.STATUS_TRANSITIONS[before.status] || [];
    if (!validNext.includes(allowed.status)) {
      return res.status(400).json({
        error: validNext.length
          ? `Cannot move a report from "${before.status}" to "${allowed.status}". ` +
            `Valid next status: ${validNext.join(", ")}.`
          : `"${before.status}" is a final status and cannot be changed.`,
      });
    }
  }

  // Team assignment is only meaningful once a report is in active repair
  // work — reject assigning a team to a report still pending/validation/
  // verified/fake/not_in_scope.
  if (allowed.assigned_team) {
    const effectiveStatus = allowed.status || before.status;
    if (!["ongoing", "resolved", "unresolved"].includes(effectiveStatus)) {
      return res.status(400).json({
        error: 'A team can only be assigned once a report is "ongoing".',
      });
    }
  }

  // "Not in Scope" is a hard deletion, not a normal status update: the
  // issue is outside the MEO's mandate entirely, so per the client's
  // requirement the report is permanently removed from active records
  // rather than just re-labeled. Handled as its own branch (not
  // reportModel.updateReport()) because the row will not exist afterward —
  // the resident is notified and the audit trail is written first, using
  // the report's data from *before* deletion.
  if (allowed.status === "not_in_scope") {
    if (before.user_id) {
      await notificationModel.notify(before.user_id, "not_in_scope",
        `We regret to inform you that the reported issue (${before.reference}) is not ` +
        "within the scope of the Municipal Engineering Office (MEO). Your report has " +
        "therefore been classified as Not in Scope." +
        (allowed.note ? ` ${allowed.note}` : ""), before.id);
      const owner = await userModel.getUser(before.user_id);
      if (owner) {
        mailService.sendNotice(owner.email,
          `Update on your report ${before.reference}`,
          `Hello ${owner.name},\n\nYour report "${before.title}" (${before.reference}) has ` +
          "been reviewed and classified as Not in Scope — it does not fall within the " +
          "Municipal Engineering Office's mandate." +
          (allowed.note ? `\n\nLGU note: ${allowed.note}` : "") +
          "\n\n— Municipality of Balatan");
      }
    }
    // Permanent audit trail: activity_log has no foreign key to reports, so
    // this entry survives the report row's deletion below — unlike
    // status_history, which cascades away with the row (see db.js SCHEMA).
    await activityModel.log(req.session.name || "admin", "admin",
      "report removed (not in scope)",
      `${before.reference}: ${before.title} — barangay ${before.barangay || "—"}` +
      (allowed.note ? ` — ${allowed.note}` : ""));

    const result = await reportModel.deleteReport(before.id);
    const uploadRoot = path.resolve(config.UPLOAD_DIR);
    for (const p of (result ? result.photoPaths : [])) {
      const abs = path.resolve(config.UPLOAD_DIR, p);
      // Resolve first, then require the result to actually be inside
      // uploadRoot (exact match or a real child path via the separator) —
      // path.resolve() collapses any ".." segments before this check runs,
      // so a traversal attempt can't slip past a plain startsWith(prefix).
      if (abs === uploadRoot || abs.startsWith(uploadRoot + path.sep)) {
        fs.unlink(abs, () => {}); // best-effort; missing files/errors are ignored
      }
    }
    return res.json({ deleted: true, id: before.id, reference: before.reference });
  }

  const updated = await reportModel.updateReport(req.params.id, allowed);
  const what = allowed.status ? `status set to ${allowed.status}`
    : allowed.note ? "note added" : "details updated";
  await activityModel.log(req.session.name || "admin", "admin", "report updated",
    `${updated.reference}: ${what}`);

  const statusChanged = allowed.status && allowed.status !== before.status;
  if (statusChanged && updated.user_id) {
    // Notify the reporting resident of the status change (in-app + email).
    const owner = await userModel.getUser(updated.user_id);
    await notificationModel.notify(updated.user_id, "status",
      `Your report ${updated.reference} is now "${updated.status}"` +
      (allowed.note ? ` — ${String(allowed.note).slice(0, 120)}` : ""),
      updated.id);
    if (owner) {
      mailService.sendNotice(owner.email,
        `Update on your report ${updated.reference}`,
        `Hello ${owner.name},\n\nYour report "${updated.title}" ` +
        `(${updated.reference}) is now marked "${updated.status}".` +
        (allowed.note ? `\n\nLGU note: ${allowed.note}` : "") +
        "\n\n— Municipality of Balatan");
    }

    // Three-attempt offense policy (client-confirmed revision): 1st fake
    // report -> Warning only; 2nd -> temporary suspension; 3rd (or later)
    // -> flagged for Administrative Action (never an automatic permanent
    // block or criminal/legal penalty — that determination is the LGU/MEO's
    // to make). "fake" moving back to "validation" reverses the most recent
    // offense tied to this specific report (correcting a mistake).
    const toFake = updated.status === "fake";
    const fromFake = before.status === "fake";
    if (toFake) {
      const { user, offenseNumber } = await userModel.recordOffense(updated.user_id, {
        reportId: updated.id,
        reason: allowed.note || "Report marked fake",
        actor: req.session.name || "admin",
      });
      if (user) {
        if (offenseNumber === 1) {
          await activityModel.log(req.session.name || "admin", "admin", "offense recorded",
            `${user.email}: 1st offense — warning issued`);
          await notificationModel.notify(user.id, "offense",
            `Your report ${updated.reference} was marked as fake. This is a formal ` +
            "Warning (1st fake-report offense). A second fake report will result in a " +
            `${config.OFFENSE_SUSPENSION_DAYS}-day suspension from submitting new reports.`,
            updated.id);
          mailService.sendNotice(user.email,
            "Warning: fake report on your Balatan LGU account",
            `Hello ${user.name},\n\nYour report "${updated.title}" (${updated.reference}) ` +
            "was marked as fake. This is a formal Warning — your first fake-report " +
            `offense. A second fake report will result in a ${config.OFFENSE_SUSPENSION_DAYS}-` +
            "day suspension from submitting new reports.\n\n— Municipality of Balatan");
        } else if (offenseNumber === 2) {
          const until = new Date(user.suspended_until)
            .toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
          await activityModel.log(req.session.name || "admin", "admin", "offense recorded",
            `${user.email}: 2nd offense — suspended until ${user.suspended_until}`);
          await notificationModel.notify(user.id, "offense",
            `Your report ${updated.reference} was marked as fake. This is your 2nd fake-` +
            `report offense — your account is suspended from submitting new reports until ` +
            `${until}. A third fake report will refer your account for administrative action.`,
            updated.id);
          mailService.sendNotice(user.email,
            "Your Balatan LGU account has been temporarily suspended",
            `Hello ${user.name},\n\nYour report "${updated.title}" (${updated.reference}) ` +
            "was marked as fake. This is your 2nd fake-report offense — your account is " +
            `suspended from submitting new reports until ${until}. A third fake report will ` +
            "refer your account for administrative action.\n\n— Municipality of Balatan");
        } else {
          await activityModel.log(req.session.name || "admin", "admin", "offense recorded",
            `${user.email}: offense #${offenseNumber} — flagged for Administrative Action`);
          await notificationModel.notify(user.id, "offense",
            `Your report ${updated.reference} was marked as fake. This is your ` +
            `${offenseNumber}${offenseNumber === 3 ? "rd" : "th"} fake-report offense — your ` +
            "account has been referred for Administrative Action. New report submissions " +
            "are on hold pending review by the LGU/MEO.",
            updated.id);
          await notificationModel.notifyAdmin("admin_action",
            `Account flagged for Administrative Action after offense #${offenseNumber}: ${user.email}`);
          mailService.sendNotice(user.email,
            "Your Balatan LGU account requires administrative review",
            `Hello ${user.name},\n\nYour report "${updated.title}" (${updated.reference}) ` +
            `was marked as fake. This is your ${offenseNumber}${offenseNumber === 3 ? "rd" : "th"} ` +
            "fake-report offense, and your account has been referred for Administrative " +
            "Action. New report submissions are on hold pending review by the LGU/MEO." +
            "\n\n— Municipality of Balatan");
        }
      }
    } else if (fromFake) {
      const user = await userModel.reverseOffense(updated.user_id, updated.id);
      if (user) {
        await activityModel.log(req.session.name || "admin", "admin", "offense reversed",
          `${user.email}: fake flag corrected on ${updated.reference}`);
        await notificationModel.notify(user.id, "offense",
          `A fake-report flag on ${updated.reference} was corrected by the LGU. Any ` +
          "related suspension/restriction from it has been lifted.", updated.id);
      }
    }
  }

  updated.impact = analytics.impactScore(updated, await reportModel.allReports());
  updated.history = await reportModel.getHistory(updated.id);
  res.json(updated);
}

/**
 * Admin endpoint — progress update with optional photo (repair evidence),
 * and optionally tagging a concerned office + reason for inter-office
 * coordination (e.g. Treasury / Budget approval) — separate from the
 * report's primary assigned_to office, which is unchanged by this.
 */
async function progress(req, res) {
  const note = (req.body && req.body.note || "").trim();
  const office = (req.body && req.body.office || "").trim();
  const reason = (req.body && req.body.reason || "").trim();
  const photoPath = req.file ? relativeUploadPath(req.file) : "";
  if (!note && !photoPath && !office) {
    return res.status(400).json({ error: "Add a note, a photo, or a concerned office" });
  }
  const updated = await reportModel.addProgress(req.params.id,
    { note, photoPath, office, reason, actor: req.session.name || "admin" });
  if (!updated) return res.status(404).json({ error: "Not found" });

  const what = office
    ? `${photoPath ? "photo" : "note"} added, involving ${office}${reason ? ` (${reason})` : ""}`
    : `${photoPath ? "photo" : "note"} added`;
  await activityModel.log(req.session.name || "admin", "admin", "progress update",
    `${updated.reference}: ${what}`);

  if (updated.user_id) {
    await notificationModel.notify(updated.user_id, "progress",
      `Progress on your report ${updated.reference}` +
      (note ? `: ${note.slice(0, 120)}` : " — a photo was added"), updated.id);
  }

  // Inter-office coordination: an admin-visible record always, plus a
  // best-effort email to the office's configured contact if one exists.
  // A missing/unconfigured contact never fails this request.
  if (office) {
    await notificationModel.notifyAdmin("coordination",
      `${office} tagged on ${updated.reference}` + (reason ? ` — ${reason}` : ""),
      updated.id);
    const contact = config.OFFICE_CONTACTS[office];
    if (contact) {
      mailService.sendNotice(contact,
        `Action requested: ${updated.reference} (${reason || "coordination"})`,
        `Hello ${office},\n\nYour office has been tagged on report ${updated.reference} ` +
        `("${updated.title}") for: ${reason || "coordination"}.\n\n` +
        (note ? `Note from Balatan LGU: ${note}\n\n` : "") +
        "— Municipality of Balatan");
    }
  }

  updated.history = await reportModel.getHistory(updated.id);
  res.json(updated);
}

/** Resident endpoint — toggle "I am affected" on a report. */
async function toggleAffected(req, res) {
  const report = await reportModel.getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "Not found" });
  const result = await reportModel.toggleAffected(report.id, req.session.userId);
  if (result.affected) {
    await notificationModel.notifyAdmin("affected",
      `A resident marked "I am affected" on ${report.reference} ` +
      `(now ${result.count} affected)`, report.id);
    if (report.user_id && report.user_id !== req.session.userId) {
      await notificationModel.notify(report.user_id, "affected",
        `Another resident is also affected by your report ${report.reference} ` +
        `(${result.count} affected so far)`, report.id);
    }
  }
  await activityModel.log(req.session.email, "resident",
    result.affected ? "marked affected" : "unmarked affected", report.reference);
  res.json(result);
}

/** Resident endpoint — the signed-in resident's own reports. */
async function myReports(req, res) {
  const reports = await reportModel.listReports({ user_id: req.session.userId });
  const all = await reportModel.allReports();
  scoreAll(reports, all);
  // No reporter-info shaping needed here — every report already belongs
  // to the requesting resident.
  res.json(reports);
}

/** Admin endpoint — download every report as CSV. */
async function exportCsv(req, res) {
  const reports = await reportModel.allReports();
  analytics.enrichReports(reports);

  const fields = ["reference", "title", "category", "facility_type", "status",
    "urgency", "priority", "barangay", "address", "latitude", "longitude",
    "affected_residents", "reporter_name", "reporter_contact", "created_at",
    "acknowledged_at", "resolved_at", "impact_score", "impact_label"];

  const cell = (v) => {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString();
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const lines = [fields.join(",")];
  for (const r of reports) {
    lines.push([
      r.reference, r.title, r.category, r.facility_type, r.status, r.urgency,
      r.priority, r.barangay, r.address, r.latitude, r.longitude,
      r.affected_residents, r.reporter_name, r.reporter_contact, r.created_at,
      r.acknowledged_at, r.resolved_at, r.impact.score, r.impact.label,
    ].map(cell).join(","));
  }

  res.set({
    "Content-Type": "text/csv",
    "Content-Disposition": "attachment; filename=balatan_reports.csv",
  });
  res.send(lines.join("\r\n"));
}

module.exports = { create, nearby, list, get, history, patch, progress,
  toggleAffected, myReports, exportCsv };
