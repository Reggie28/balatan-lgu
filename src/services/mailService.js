/*
 * Outgoing email (nodemailer) — used for sign-up verification codes (OTP).
 *
 * With SMTP configured (BALATAN_SMTP_* env vars) codes are emailed for real.
 * Without SMTP the service falls back to "console delivery": the code is
 * printed in the server window, so the flow remains fully demonstrable on a
 * machine with no mail account configured.
 */
const nodemailer = require("nodemailer");
const config = require("../config/config");

let transporter = null;
if (config.SMTP.host && config.SMTP.user) {
  transporter = nodemailer.createTransport({
    host: config.SMTP.host,
    port: config.SMTP.port,
    secure: config.SMTP.port === 465,
    auth: { user: config.SMTP.user, pass: config.SMTP.pass },
  });
}

/**
 * Send a one-time code (sign-up verification or password reset). Resolves to
 * the delivery channel used: "email" (real SMTP) or "console" (demo mode).
 */
async function sendOtp(email, code, purpose = "verification") {
  const what = purpose === "reset" ? "password reset code" : "verification code";
  if (!transporter) {
    console.log("");
    console.log("  +--------------------------------------------------+");
    console.log(`  |  Email ${what} for ${email}`);
    console.log(`  |  CODE:  ${code}   (valid for 10 minutes)`);
    console.log("  |  (No SMTP configured - demo delivery via console) |");
    console.log("  +--------------------------------------------------+");
    console.log("");
    return "console";
  }
  const action = purpose === "reset"
    ? "reset your Balatan LGU account password"
    : "finish creating your resident account";
  await transporter.sendMail({
    from: `"Balatan LGU Reporting" <${config.SMTP.from}>`,
    to: email,
    subject: `${code} is your Balatan LGU ${what}`,
    text: `Your Balatan LGU ${what} is: ${code}\n\n` +
      `Enter this code in the app to ${action}. It is valid for 10 minutes.\n\n` +
      "If you did not request this, you can safely ignore this email.",
    html: `<p>Your Balatan LGU ${what} is:</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:6px;">${code}</p>
      <p>Enter this code in the app to ${action}. It is valid for <b>10 minutes</b>.</p>
      <p style="color:#888;">If you did not request this, you can safely ignore this email.</p>`,
  });
  return "email";
}

/**
 * Best-effort informational email (status updates, account notices).
 * Silently skipped in demo mode (a one-line console trace is kept).
 */
async function sendNotice(email, subject, text) {
  if (!transporter) {
    console.log(`  [mail demo] to ${email}: ${subject}`);
    return "console";
  }
  try {
    await transporter.sendMail({
      from: `"Balatan LGU Reporting" <${config.SMTP.from}>`,
      to: email,
      subject,
      text,
    });
    return "email";
  } catch (err) {
    console.error("sendNotice failed:", err.message);
    return "failed";
  }
}

module.exports = { sendOtp, sendNotice };
