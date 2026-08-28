/*
 * Photo upload handling (multer). Files are stored inside the project's
 * data/uploads folder, organized into YYYY-MM subdirectories, with random
 * names; only image extensions are accepted. Files uploaded by earlier
 * builds directly into the flat data/uploads/ root are left exactly where
 * they are and still served correctly (see reportController.relativeUploadPath
 * and the static /uploads route in server.js, both path-agnostic).
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const config = require("../config/config");

/** "YYYY-MM" for the current date, e.g. "2026-08". */
function monthDir() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.UPLOAD_DIR, monthDir());
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, crypto.randomBytes(8).toString("hex") + ext);
  },
});

const imageFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!config.ALLOWED_IMAGE_EXT.includes(ext)) {
    const err = new Error("Unsupported image type");
    err.status = 400;
    return cb(err);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

// Valid-ID uploads (registration). Stored OUTSIDE data/uploads and never
// statically served — only reachable via the authenticated admin streaming
// route (routes/api.js GET /users/:id/valid-id).
const idStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(config.PRIVATE_UPLOAD_DIR, { recursive: true });
    cb(null, config.PRIVATE_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, crypto.randomBytes(8).toString("hex") + ext);
  },
});

const uploadId = multer({
  storage: idStorage,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

module.exports = { upload, uploadId };
