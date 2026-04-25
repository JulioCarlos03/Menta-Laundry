const nodemailer = require("nodemailer");

let cachedTransporter = null;

function readEnv(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function getEmailMode() {
  return readEnv("SMTP_HOST") && readEnv("SMTP_USER") && readEnv("SMTP_PASS") ? "smtp" : "log";
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  const secure = readEnv("SMTP_SECURE", "false").toLowerCase() === "true";
  cachedTransporter = nodemailer.createTransport({
    host: readEnv("SMTP_HOST"),
    port: Number(readEnv("SMTP_PORT", secure ? "465" : "587")),
    secure,
    auth: {
      user: readEnv("SMTP_USER"),
      pass: readEnv("SMTP_PASS"),
    },
  });

  return cachedTransporter;
}

async function sendEmail({ to, subject, html, text, debugActionUrl = null }) {
  const mode = getEmailMode();

  if (mode === "smtp") {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from: readEnv("EMAIL_FROM", "Menta Laundry <admin@mentalaundry.com>"),
      replyTo: readEnv("EMAIL_REPLY_TO") || undefined,
      to,
      subject,
      html,
      text,
    });

    return {
      ok: true,
      delivered: true,
      mode,
      messageId: info.messageId || null,
      debugActionUrl: null,
    };
  }

  console.log("=== EMAIL LOG MODE ===");
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  if (debugActionUrl) {
    console.log(`Action URL: ${debugActionUrl}`);
  }
  console.log(text || html || "(sin contenido)");
  console.log("======================");

  return {
    ok: true,
    delivered: false,
    mode,
    messageId: null,
    debugActionUrl: debugActionUrl || null,
  };
}

module.exports = {
  sendEmail,
  getEmailMode,
};
