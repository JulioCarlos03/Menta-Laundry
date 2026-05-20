const nodemailer = require("nodemailer");

let cachedTransporter = null;
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

function readEnv(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function getEmailMode() {
  const provider = readEnv("EMAIL_PROVIDER").toLowerCase();
  const hasBrevoApiKey = Boolean(readEnv("BREVO_API_KEY"));
  const hasSmtpConfig = Boolean(readEnv("SMTP_HOST") && readEnv("SMTP_USER") && readEnv("SMTP_PASS"));

  if ((provider === "brevo-api" || provider === "api") && hasBrevoApiKey) return "brevo-api";
  if (provider === "smtp" && hasSmtpConfig) return "smtp";
  if (hasBrevoApiKey) return "brevo-api";
  if (hasSmtpConfig) return "smtp";
  return "log";
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

function parseEmailIdentity(value, fallbackEmail = "") {
  const input = readEnv(value, fallbackEmail);
  const match = input.match(/^(.*?)<([^>]+)>$/);

  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    const email = match[2].trim();
    return name ? { name, email } : { email };
  }

  return { email: input };
}

function normalizeRecipients(to) {
  return String(to || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (_error) {
    return { message: text };
  }
}

async function sendBrevoApiEmail({ to, subject, html, text }) {
  const apiKey = readEnv("BREVO_API_KEY");
  const sender = parseEmailIdentity("EMAIL_FROM", "Menta Laundry <admin@mentalaundry.com>");
  const replyToValue = readEnv("EMAIL_REPLY_TO");
  const recipients = normalizeRecipients(to);

  if (!apiKey) {
    throw new Error("BREVO_API_KEY no configurada.");
  }

  if (!sender.email || !recipients.length) {
    throw new Error("Remitente o destinatario de correo invalido.");
  }

  const body = {
    sender,
    to: recipients,
    subject,
    htmlContent: html || undefined,
    textContent: text || undefined,
  };

  if (replyToValue) {
    body.replyTo = parseEmailIdentity("EMAIL_REPLY_TO");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(readEnv("BREVO_API_TIMEOUT_MS", "15000")));

  try {
    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await readResponseBody(response);

    if (!response.ok) {
      const error = new Error(payload?.message || `Brevo API error ${response.status}`);
      error.code = payload?.code || "BREVO_API_ERROR";
      error.responseCode = response.status;
      error.response = JSON.stringify(payload);
      throw error;
    }

    return {
      ok: true,
      delivered: true,
      mode: "brevo-api",
      messageId: payload?.messageId || null,
      debugActionUrl: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendEmail({ to, subject, html, text, debugActionUrl = null }) {
  const mode = getEmailMode();

  if (mode === "brevo-api") {
    return sendBrevoApiEmail({ to, subject, html, text });
  }

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
