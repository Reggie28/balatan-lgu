/*
 * OCR-based name check for uploaded valid-ID photos (registration).
 * Best-effort only: flags a possible mismatch for admin review, it never
 * blocks registration outright — phone-camera ID photos misread often
 * enough (glare, blur, angle) that a hard block would lock out legitimate
 * residents. Final verification is still the admin's manual ID review.
 */
const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");

// Keep the downloaded OCR language data out of the project root (tesseract.js
// defaults to caching in the current working directory).
const CACHE_DIR = path.join(__dirname, "../../data/ocr-cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

/** Uppercase, strip accents/punctuation, collapse whitespace — for loose
 * comparison between OCR output and the name typed on the form. */
function normalize(text) {
  return String(text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Runs OCR on the ID image and checks whether the registrant's declared
 * name appears in the extracted text.
 * Returns:
 *   true  - most of the name's tokens were found in the ID text
 *   false - OCR ran cleanly but the name doesn't reasonably appear (mismatch)
 *   null  - OCR couldn't be evaluated (unreadable image, engine error, no
 *           usable name) — not held against the applicant, just unflagged
 */
async function checkNameOnId(imagePath, fullName) {
  const nameTokens = normalize(fullName).split(" ").filter((t) => t.length > 1);
  if (!nameTokens.length) return null;

  let text;
  try {
    const result = await Tesseract.recognize(imagePath, "eng", { cachePath: CACHE_DIR });
    text = normalize(result.data.text);
  } catch {
    return null;
  }
  if (!text) return null;

  const matchedTokens = nameTokens.filter((t) => text.includes(t));
  // Most (not all) tokens must appear — tolerates OCR noise and PH IDs that
  // print "LASTNAME, FIRSTNAME MIDDLENAME" in a different order than the form.
  return matchedTokens.length >= Math.ceil(nameTokens.length * 0.6);
}

module.exports = { checkNameOnId };
