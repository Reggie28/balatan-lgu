/*
 * REST API routes. Mounted at /api by server.js.
 */
const express = require("express");
const { requireAdmin, requireResident, sessionFromRequest } = require("../middleware/auth");
const { upload, uploadId } = require("../middleware/upload");
const authController = require("../controllers/authController");
const reportController = require("../controllers/reportController");
const analyticsController = require("../controllers/analyticsController");
const userModel = require("../models/userModel");
const activityModel = require("../models/activityModel");
const notificationModel = require("../models/notificationModel");

const router = express.Router();

/** Wrap async handlers so rejections reach the Express error handler. */
const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Auth — admin (username/password) and residents (email + geofenced login)
router.post("/login", aw(authController.login));
router.post("/register", uploadId.single("valid_id"), aw(authController.register));
router.post("/verify-otp", aw(authController.verifyOtp));
router.post("/resident/login", aw(authController.residentLogin));
router.post("/forgot-password", aw(authController.forgotPassword));
router.post("/reset-password", aw(authController.resetPassword));
router.get("/me", aw(authController.me));
router.post("/logout", aw(authController.logout));

// Resident profile & password
router.get("/profile", requireResident, aw(authController.getProfile));
router.patch("/profile", requireResident, aw(authController.updateProfile));
router.post("/profile/valid-id", requireResident,
  uploadId.single("valid_id"), aw(authController.reuploadValidId));
router.post("/change-password", requireResident, aw(authController.changePassword));

// Reference data
router.get("/config", aw(analyticsController.getConfig));

// Reports (signed-in residents submit, everyone tracks, admin manages)
router.post("/reports", requireResident, upload.array("photos", 5), aw(reportController.create));
router.get("/reports/nearby", aw(reportController.nearby));
router.get("/reports/mine", requireResident, aw(reportController.myReports));
router.get("/reports", aw(reportController.list));
router.get("/reports/:id(\\d+)", aw(reportController.get));
router.get("/reports/:id(\\d+)/history", aw(reportController.history));
router.patch("/reports/:id(\\d+)", requireAdmin, aw(reportController.patch));
router.post("/reports/:id(\\d+)/progress", requireAdmin,
  upload.single("photo"), aw(reportController.progress));
router.post("/reports/:id(\\d+)/affected", requireResident,
  aw(reportController.toggleAffected));

// Notifications (residents get their own; the admin token gets LGU alerts)
router.get("/notifications", aw(async (req, res) => {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: "Authentication required" });
  const target = session.role === "admin" ? null : session.userId;
  res.json(await notificationModel.listFor(target));
}));
router.post("/notifications/read", aw(async (req, res) => {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: "Authentication required" });
  await notificationModel.markAllRead(session.role === "admin" ? null : session.userId);
  res.json({ ok: true });
}));

// Resident account monitoring (admin)
router.get("/users", requireAdmin, aw(async (req, res) => {
  res.json(await userModel.listUsers());
}));
router.patch("/users/:id(\\d+)", requireAdmin, aw(async (req, res) => {
  const { blocked, strikes, id_verification_status, is_staff } = req.body || {};
  let user = await userModel.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  if (typeof strikes === "number") {
    await require("../models/db").query(
      "UPDATE users SET strikes=? WHERE id=?", [Math.max(0, strikes), user.id]);
  }
  if (typeof blocked === "boolean") {
    user = await userModel.setBlocked(user.id, blocked);
    await activityModel.log(req.session.name || "admin", "admin",
      blocked ? "account blocked" : "account unblocked", user.email);
    await notificationModel.notify(user.id, "account",
      blocked ? "Your account has been blocked by the LGU."
              : "Your account has been unblocked — you can report issues again.");
  }
  if (id_verification_status !== undefined) {
    const allowedStatuses = ["pending", "verified", "rejected"];
    if (!allowedStatuses.includes(id_verification_status)) {
      return res.status(400).json({
        error: `id_verification_status must be one of: ${allowedStatuses.join(", ")}`,
      });
    }
    user = await userModel.setIdVerificationStatus(user.id, id_verification_status);
    await activityModel.log(req.session.name || "admin", "admin",
      "ID verification updated", `${user.email} -> ${id_verification_status}`);
    await notificationModel.notify(user.id, "id_verification",
      id_verification_status === "rejected"
        ? "Your valid ID was rejected — new reports are on hold until you upload a " +
          "new ID photo from your profile for re-review."
        : `Your valid ID review status is now: ${id_verification_status}.`);
  }
  if (typeof is_staff === "boolean") {
    user = await userModel.setStaffEligibility(user.id, is_staff);
    await activityModel.log(req.session.name || "admin", "admin",
      is_staff ? "staff access granted" : "staff access revoked", user.email);
    await notificationModel.notify(user.id, "account",
      is_staff
        ? "Your account can now submit reports as MEO/LGU staff."
        : "Your account's staff reporting access has been revoked.");
  }
  res.json(await userModel.getUser(req.params.id));
}));
router.get("/users/:id(\\d+)/valid-id", requireAdmin, aw(authController.adminGetValidId));
router.get("/users/:id(\\d+)/offenses", requireAdmin, aw(authController.adminListOffenses));

// Activity log (audit trail)
router.get("/activity", requireAdmin, aw(async (req, res) => {
  res.json(await activityModel.recent(50));
}));

// Analytics — LGU performance/aggregate stats, admin-only per the client's
// decision to remove the public transparency dashboard (residents never
// called these; only web/js/admin.js does — see /api/reports and
// /api/reports/nearby for the resident-facing report data that stays public).
router.get("/stats", requireAdmin, aw(analyticsController.stats));
router.get("/heatmap", requireAdmin, aw(analyticsController.heatmap));
router.get("/predictions", requireAdmin, aw(analyticsController.predictions));
router.get("/export.csv", requireAdmin, aw(reportController.exportCsv));

module.exports = router;
