const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("dotenv").config();

const connectDB = require("./config/db");
const seedDemoData = require("./config/seed");
const User = require("./models/User");
const Order = require("./models/Order");
const { sendEmail, getEmailMode } = require("./services/emailService");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/tintoreria_express";
const JWT_SECRET = process.env.JWT_SECRET || "jwt_demo_secret_change_me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const DEFAULT_APP_BASE_URL = "http://127.0.0.1:5500/TINTORERIA-FRONTEND/";
const APP_BASE_URL = (() => {
  const raw = String(process.env.APP_BASE_URL || DEFAULT_APP_BASE_URL).trim();
  try {
    return new URL(raw).toString();
  } catch (_error) {
    return DEFAULT_APP_BASE_URL;
  }
})();
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const EMAIL_VERIFICATION_REQUIRED_ROLES = new Set(["cliente"]);
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "https://mentalaundry.com",
  "https://www.mentalaundry.com",
  "https://demo.mentalaundry.com",
];
const DEFAULT_ALLOWED_ORIGIN_SUFFIXES = [
  ".netlify.app",
  ".onrender.com",
  ".vercel.app",
];

function parseAllowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = [
  ...new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
  ]),
];
const ALLOWED_ORIGIN_SUFFIXES = [
  ...new Set([
    ...DEFAULT_ALLOWED_ORIGIN_SUFFIXES,
    ...parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGIN_SUFFIXES),
  ]),
];

function isAllowedOrigin(origin) {
  if (!origin) return true;

  if (ALLOWED_ORIGINS.includes(origin)) return true;

  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => hostname.endsWith(String(suffix).toLowerCase()));
  } catch (_error) {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (!ALLOWED_ORIGINS.length && !ALLOWED_ORIGIN_SUFFIXES.length) {
        return callback(null, true);
      }
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error("Origen no permitido por CORS."));
    },
  })
);
app.use(express.json());

const BUSINESS_INFO = {
  name: "Tintoreria Express",
  rnc: "X",
  address: "Direccion X",
  phone: "829-448-7876",
  email: "facturacion@tintoreria.com",
  itbisRate: 0.18,
  banks: [
    { name: "BHD", account: "33008190011" },
    { name: "Popular", account: "831576806" },
  ],
  footerMessage:
    "Gracias por confiar en nosotros. Tu ropa queda en manos expertas.",
};

const ALLOWED_ZONES = ["Distrito Nacional", "Sur", "Este", "Oeste"];
const ALLOWED_PRICING_MODES = ["por_libra", "por_prendas", "mixto"];
const ASSIGNABLE_ORDER_STATUSES = new Set(["pendiente", "asignado"]);
const CLIENT_CANCELLABLE_STATUSES = new Set(["pendiente", "asignado"]);
const ORDER_STATUS_TRANSITIONS = {
  asignado: ["recibido"],
  recibido: ["en camino"],
  "en camino": ["entregado"],
};
const PHONE_REGEX = /^[0-9+\-\s()]{7,20}$/;

function publicUser(user) {
  const safe = user?.toObject ? user.toObject() : { ...user };
  delete safe.password;
  delete safe.emailVerificationToken;
  delete safe.emailVerificationExpiresAt;
  delete safe.passwordResetToken;
  delete safe.passwordResetExpiresAt;
  return safe;
}

function issueAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function buildAppUrl(params = {}) {
  const url = new URL(APP_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function generateTokenValue(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function buildExpiringToken(ttlMs) {
  const raw = generateTokenValue();
  return {
    raw,
    hash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

function shouldRequireVerifiedEmail(user) {
  return EMAIL_VERIFICATION_REQUIRED_ROLES.has(String(user?.role || "").toLowerCase());
}

function buildAuthEmailShell({ eyebrow, title, intro, actionUrl, actionLabel, note }) {
  const safeActionUrl = String(actionUrl || "").trim();
  return {
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;background:#f8f4ee;padding:32px;color:#1f2937;">
        <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid #eadfce;box-shadow:0 18px 50px rgba(31,41,55,.10);">
          <div style="display:inline-block;padding:8px 12px;border-radius:999px;background:#f4ead8;color:#8a6b47;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
            ${eyebrow}
          </div>
          <h1 style="margin:18px 0 10px;font-size:30px;line-height:1.1;color:#2f2418;">${title}</h1>
          <p style="margin:0 0 22px;font-size:16px;line-height:1.7;color:#5e5244;">${intro}</p>
          <a href="${safeActionUrl}" style="display:inline-block;padding:14px 20px;border-radius:16px;background:linear-gradient(135deg,#d8b26a,#ba8a3f);color:#1f2937;text-decoration:none;font-weight:800;">
            ${actionLabel}
          </a>
          <p style="margin:22px 0 10px;font-size:14px;line-height:1.7;color:#7c6f61;">
            Si el boton no abre, copia y pega este enlace en tu navegador:
          </p>
          <p style="margin:0;font-size:13px;line-height:1.6;word-break:break-all;color:#7c6f61;">
            ${safeActionUrl}
          </p>
          <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#9b8c7a;">
            ${note}
          </p>
        </div>
      </div>
    `,
    text: [
      title,
      "",
      intro,
      "",
      `${actionLabel}: ${safeActionUrl}`,
      "",
      note,
    ].join("\n"),
  };
}

function buildVerificationEmailContent(user, verificationUrl) {
  return buildAuthEmailShell({
    eyebrow: "Verificacion",
    title: "Confirma tu correo para activar tu cuenta",
    intro: `Hola ${user.name}, ya casi estas dentro de Tintoreria Express. Verifica tu correo para activar el acceso y gestionar tus pedidos con seguridad.`,
    actionUrl: verificationUrl,
    actionLabel: "Verificar mi correo",
    note: "Si no creaste esta cuenta, puedes ignorar este mensaje.",
  });
}

function buildPasswordResetEmailContent(user, resetUrl) {
  return buildAuthEmailShell({
    eyebrow: "Recuperacion",
    title: "Crea una nueva contrasena",
    intro: `Hola ${user.name}, recibimos una solicitud para restablecer la contrasena de tu cuenta. Usa el siguiente enlace para crear una nueva.`,
    actionUrl: resetUrl,
    actionLabel: "Restablecer contrasena",
    note: "Este enlace vence pronto. Si no solicitaste el cambio, puedes ignorar este mensaje.",
  });
}

function buildDeliveryResponse(deliveryResult) {
  return {
    deliveryMode: deliveryResult.mode,
    debugActionUrl: deliveryResult.debugActionUrl || null,
  };
}

function buildEmailDeliveryFallback() {
  return {
    mode: getEmailMode(),
    debugActionUrl: null,
  };
}

function isEmailDeliveryError(error) {
  const text = [
    error?.code,
    error?.responseCode,
    error?.response,
    error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("535") ||
    text.includes("invalid login") ||
    text.includes("authentication failed") ||
    text.includes("eauth") ||
    text.includes("smtp")
  );
}

function buildEmailDeliveryFailureMessage(kind = "generic", { accountCreated = false } = {}) {
  if (kind === "verification" && accountCreated) {
    return "La cuenta fue creada, pero ahora mismo no pudimos enviar el correo de verificacion. Usa 'Reenviar verificacion' en unos minutos o contacta soporte.";
  }

  if (kind === "verification") {
    return "No pudimos enviar el correo de verificacion ahora mismo. Intenta de nuevo en unos minutos o contacta soporte.";
  }

  if (kind === "reset") {
    return "No pudimos enviar el correo de recuperacion ahora mismo. Intenta de nuevo en unos minutos o contacta soporte.";
  }

  return "No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos o contacta soporte.";
}

async function issueEmailVerification(user) {
  const verification = buildExpiringToken(VERIFICATION_TOKEN_TTL_MS);
  user.emailVerificationToken = verification.hash;
  user.emailVerificationExpiresAt = verification.expiresAt;
  await user.save();

  const verificationUrl = buildAppUrl({
    verify: "1",
    token: verification.raw,
    email: user.email,
  });
  const emailContent = buildVerificationEmailContent(user, verificationUrl);
  const delivery = await sendEmail({
    to: user.email,
    subject: "Verifica tu cuenta de Tintoreria Express",
    html: emailContent.html,
    text: emailContent.text,
    debugActionUrl: verificationUrl,
  });

  return {
    verificationUrl,
    delivery,
  };
}

async function issuePasswordReset(user) {
  const reset = buildExpiringToken(PASSWORD_RESET_TOKEN_TTL_MS);
  user.passwordResetToken = reset.hash;
  user.passwordResetExpiresAt = reset.expiresAt;
  await user.save();

  const resetUrl = buildAppUrl({
    reset: "1",
    token: reset.raw,
    email: user.email,
  });
  const emailContent = buildPasswordResetEmailContent(user, resetUrl);
  const delivery = await sendEmail({
    to: user.email,
    subject: "Restablece tu contrasena de Tintoreria Express",
    html: emailContent.html,
    text: emailContent.text,
    debugActionUrl: resetUrl,
  });

  return {
    resetUrl,
    delivery,
  };
}

function normalizePacks(pack, packs) {
  if (Array.isArray(packs) && packs.length) {
    return packs
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  if (pack) return [String(pack).trim()];
  return [];
}

function normalizeSelectedGarments(selectedGarments) {
  if (!Array.isArray(selectedGarments)) return [];

  return selectedGarments
    .map((item) => ({
      name: String(item?.name || "").trim(),
      qty: Number(item?.qty || 0),
    }))
    .filter((item) => item.name && item.qty > 0);
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") return null;

  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const accuracy = Number(location.accuracy);
  const inferredZone = String(location.inferredZone || "").trim();
  const source = String(location.source || "browser").trim() || "browser";
  const capturedAt = location.capturedAt ? new Date(location.capturedAt) : new Date();

  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    source,
    inferredZone: inferredZone || null,
    capturedAt,
  };
}

function addHistory(order, status, by) {
  if (!Array.isArray(order.history)) order.history = [];
  order.history.push({ status, by, at: new Date() });
}

function asText(value) {
  return String(value ?? "").trim();
}

function isValidEmail(value) {
  const email = asText(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(value, { required = false } = {}) {
  const phone = asText(value);
  if (!phone) return !required;
  return PHONE_REGEX.test(phone);
}

function isValidDateInput(value) {
  const raw = asText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;

  const parsed = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === raw;
}

function isValidTimeInput(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(asText(value));
}

function isTodayOrFutureDate(value) {
  if (!isValidDateInput(value)) return false;

  const today = new Date();
  const currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const selectedDate = new Date(`${value}T00:00:00`);
  return selectedDate.getTime() >= currentDate.getTime();
}

function isKnownZone(value) {
  return ALLOWED_ZONES.includes(asText(value));
}

function isValidTextField(value, { min = 1, max = 240, required = true } = {}) {
  const text = asText(value);
  if (!text) return !required;
  return text.length >= min && text.length <= max;
}

function areValidStringItems(items, { max = 80 } = {}) {
  if (!Array.isArray(items)) return false;
  return items.every((item) => isValidTextField(item, { min: 1, max }));
}

function normalizeRequestedStatus(value) {
  const status = asText(value).toLowerCase();
  if (status === "camino") return "en camino";
  return status;
}

function canTransitionOrderStatus(currentStatus, nextStatus) {
  const current = normalizeRequestedStatus(currentStatus);
  const next = normalizeRequestedStatus(nextStatus);
  return (ORDER_STATUS_TRANSITIONS[current] || []).includes(next);
}

function getTokenFromRequest(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}

async function findUserByEmail(email) {
  return User.findOne({ email: String(email || "").trim().toLowerCase() });
}

async function getNextNumericId(Model, minimum = 1) {
  const latest = await Model.findOne().sort({ id: -1 }).select({ id: 1 }).lean();
  return latest?.id ? Math.max(latest.id + 1, minimum) : minimum;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ message: "Token requerido." });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = payload;
    return User.findOne({ id: Number(payload.sub) })
      .then((user) => {
        if (!user) {
          return res.status(401).json({ message: "Sesion invalida." });
        }

        req.user = user;
        next();
      })
      .catch(next);
  } catch (_error) {
    return res.status(401).json({ message: "Token invalido o expirado." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Sesion requerida." });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "No tienes permisos para esta accion." });
    }

    next();
  };
}

app.post(
  "/api/register",
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Faltan datos." });
    }

    if (!isValidTextField(name, { min: 2, max: 80 })) {
      return res.status(400).json({ message: "El nombre debe tener entre 2 y 80 caracteres." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Debes indicar un correo valido." });
    }

    if (String(password).length < 6 || String(password).length > 72) {
      return res.status(400).json({ message: "La contrasena debe tener entre 6 y 72 caracteres." });
    }

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: "Ese correo ya esta registrado." });
    }

    const newUser = await User.create({
      id: await getNextNumericId(User),
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password: await bcrypt.hash(String(password), 10),
      role: "cliente",
      emailVerified: false,
      emailVerifiedAt: null,
      emailVerificationToken: null,
      emailVerificationExpiresAt: null,
      passwordResetToken: null,
      passwordResetExpiresAt: null,
    });

    let verification = null;
    try {
      verification = await issueEmailVerification(newUser);
    } catch (error) {
      console.error("No se pudo enviar el correo de verificacion:", error);
      return res.status(201).json({
        code: "EMAIL_DELIVERY_FAILED",
        message: buildEmailDeliveryFailureMessage("verification", { accountCreated: true }),
        user: publicUser(newUser),
        requiresEmailVerification: true,
        emailDeliveryFailed: true,
        emailAction: "resend_verification",
        ...buildDeliveryResponse(buildEmailDeliveryFallback()),
      });
    }

    res.json({
      message: "Cuenta creada. Revisa tu correo para verificarla.",
      user: publicUser(newUser),
      requiresEmailVerification: true,
      ...buildDeliveryResponse(verification.delivery),
    });
  })
);

app.post(
  "/api/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: "Debes indicar correo y contrasena." });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ message: "Credenciales incorrectas." });
    }

    const isValid = await bcrypt.compare(String(password || ""), user.password);
    if (!isValid) {
      return res.status(401).json({ message: "Credenciales incorrectas." });
    }

    if (shouldRequireVerifiedEmail(user) && !user.emailVerified) {
      return res.status(403).json({
        code: "EMAIL_NOT_VERIFIED",
        message: "Debes verificar tu correo antes de iniciar sesion.",
        email: user.email,
      });
    }

    const safeUser = publicUser(user);
    const token = issueAccessToken(safeUser);
    res.json({ message: "Login ok", user: safeUser, token });
  })
);

app.get(
  "/api/auth/verify-email",
  asyncHandler(async (req, res) => {
    const token = asText(req.query.token);
    if (!token) {
      return res.status(400).json({ message: "El token de verificacion es obligatorio." });
    }

    const user = await User.findOne({
      emailVerificationToken: hashToken(token),
      emailVerificationExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: "El enlace de verificacion no es valido o ya vencio." });
    }

    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    user.emailVerificationToken = null;
    user.emailVerificationExpiresAt = null;
    await user.save();

    res.json({
      message: "Correo verificado correctamente. Ya puedes iniciar sesion.",
      user: publicUser(user),
    });
  })
);

app.post(
  "/api/auth/resend-verification",
  asyncHandler(async (req, res) => {
    const email = asText(req.body?.email).toLowerCase();

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Debes indicar un correo valido." });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.json({
        message: "Si la cuenta existe y aun no esta verificada, te enviamos un nuevo correo.",
      });
    }

    if (user.emailVerified) {
      return res.json({
        message: "Esta cuenta ya esta verificada. Puedes iniciar sesion directamente.",
      });
    }

    let verification = null;
    try {
      verification = await issueEmailVerification(user);
    } catch (error) {
      console.error("No se pudo reenviar el correo de verificacion:", error);
      return res.status(503).json({
        code: "EMAIL_DELIVERY_FAILED",
        message: buildEmailDeliveryFailureMessage("verification"),
        emailDeliveryFailed: true,
        emailAction: "resend_verification",
        ...buildDeliveryResponse(buildEmailDeliveryFallback()),
      });
    }

    res.json({
      message: "Te enviamos un nuevo correo de verificacion.",
      ...buildDeliveryResponse(verification.delivery),
    });
  })
);

app.post(
  "/api/auth/forgot-password",
  asyncHandler(async (req, res) => {
    const email = asText(req.body?.email).toLowerCase();

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Debes indicar un correo valido." });
    }

    const genericMessage =
      "Si el correo existe, te enviamos un enlace para restablecer la contrasena.";
    const user = await findUserByEmail(email);
    if (!user) {
      return res.json({ message: genericMessage });
    }

    let reset = null;
    try {
      reset = await issuePasswordReset(user);
    } catch (error) {
      console.error("No se pudo enviar el correo de recuperacion:", error);
      return res.status(503).json({
        code: "EMAIL_DELIVERY_FAILED",
        message: buildEmailDeliveryFailureMessage("reset"),
        emailDeliveryFailed: true,
        emailAction: "forgot_password",
        ...buildDeliveryResponse(buildEmailDeliveryFallback()),
      });
    }

    res.json({
      message: genericMessage,
      ...buildDeliveryResponse(reset.delivery),
    });
  })
);

app.post(
  "/api/auth/reset-password",
  asyncHandler(async (req, res) => {
    const token = asText(req.body?.token);
    const password = String(req.body?.password || "");

    if (!token) {
      return res.status(400).json({ message: "El token de recuperacion es obligatorio." });
    }

    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({ message: "La contrasena debe tener entre 6 y 72 caracteres." });
    }

    const user = await User.findOne({
      passwordResetToken: hashToken(token),
      passwordResetExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: "El enlace para restablecer la contrasena ya vencio o no es valido." });
    }

    user.password = await bcrypt.hash(password, 10);
    user.passwordResetToken = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    res.json({
      message: "Contrasena actualizada correctamente. Ya puedes iniciar sesion.",
      user: publicUser(user),
    });
  })
);

app.get(
  "/api/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  })
);

app.get(
  "/api/repartidores",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const reps = await User.find({ role: "repartidor" }).sort({ name: 1 }).lean();
    res.json(reps.map(publicUser));
  })
);

app.get(
  "/api/orders",
  requireAuth,
  asyncHandler(async (req, res) => {
    let query = {};

    if (req.user.role === "cliente") {
      query = { userId: req.user.id };
    } else if (req.user.role === "repartidor") {
      query = { repartidorId: req.user.id };
    } else if (req.user.role === "cajera") {
      query = { channel: "local" };
    }

    const orders = await Order.find(query).sort({ id: 1 }).lean();
    res.json(orders);
  })
);

app.get(
  "/api/bootstrap",
  requireAuth,
  asyncHandler(async (req, res) => {
    let ordersQuery = {};

    if (req.user.role === "cliente") {
      ordersQuery = { userId: req.user.id };
    } else if (req.user.role === "repartidor") {
      ordersQuery = { repartidorId: req.user.id };
    } else if (req.user.role === "cajera") {
      ordersQuery = { channel: "local" };
    }

    const canReviewLocalOrders = ["gestor", "cajera"].includes(req.user.role);
    const canReviewRiders = req.user.role === "gestor";

    const [orders, reps, localOrders] = await Promise.all([
      Order.find(ordersQuery).sort({ id: 1 }).lean(),
      canReviewRiders
        ? User.find({ role: "repartidor" }).sort({ name: 1 }).lean()
        : Promise.resolve([]),
      canReviewLocalOrders
        ? Order.find({ channel: "local" }).sort({ id: -1 }).lean()
        : Promise.resolve([]),
    ]);

    res.json({
      user: publicUser(req.user),
      orders,
      repartidores: reps.map(publicUser),
      localOrders,
    });
  })
);

app.post(
  "/api/orders",
  requireAuth,
  requireRole("cliente"),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const {
      address,
      phone,
      zone,
      serviceType,
      date,
      time,
      pack,
      packs,
      pricingMode,
      selectedGarments,
      location,
      lbs,
      extras,
      notes,
    } = body;

    const normalizedPacks = normalizePacks(pack, packs);
    const normalizedGarments = normalizeSelectedGarments(selectedGarments);
    const normalizedPricingMode = pricingMode || "por_libra";
    const normalizedLocation = normalizeLocation(location);

    if (!address || !zone || !date || !time || !normalizedPacks.length) {
      return res.status(400).json({ message: "Faltan datos obligatorios." });
    }

    if (!isValidTextField(address, { min: 6, max: 240 })) {
      return res.status(400).json({ message: "La direccion debe tener entre 6 y 240 caracteres." });
    }

    if (!isKnownZone(zone)) {
      return res.status(400).json({ message: "La zona indicada no es valida." });
    }

    if (!isTodayOrFutureDate(date)) {
      return res.status(400).json({ message: "La fecha del pedido debe ser de hoy en adelante." });
    }

    if (!isValidTimeInput(time)) {
      return res.status(400).json({ message: "La hora del pedido no es valida." });
    }

    if (!ALLOWED_PRICING_MODES.includes(normalizedPricingMode)) {
      return res.status(400).json({ message: "El modo de precio no es valido." });
    }

    if (!normalizedPacks.every((item) => isValidTextField(item, { min: 2, max: 80 }))) {
      return res.status(400).json({ message: "Los paquetes seleccionados no son validos." });
    }

    if (
      (normalizedPricingMode === "por_prendas" || normalizedPricingMode === "mixto") &&
      !normalizedGarments.length
    ) {
      return res.status(400).json({
        message: "Debes seleccionar al menos una prenda para ese tipo de servicio.",
      });
    }

    if (
      normalizedGarments.length &&
      !normalizedGarments.every(
        (item) =>
          isValidTextField(item.name, { min: 2, max: 100 }) &&
          Number.isFinite(item.qty) &&
          item.qty > 0 &&
          item.qty <= 100
      )
    ) {
      return res.status(400).json({ message: "Las prendas seleccionadas no son validas." });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ message: "El telefono indicado no es valido." });
    }

    if (!Array.isArray(extras) || !areValidStringItems(extras, { max: 80 })) {
      return res.status(400).json({ message: "Los extras enviados no son validos." });
    }

    if (!isValidTextField(notes, { min: 0, max: 500, required: false })) {
      return res.status(400).json({ message: "Las notas superan el limite permitido." });
    }

    if (!isValidTextField(serviceType, { min: 3, max: 80, required: false })) {
      return res.status(400).json({ message: "El tipo de servicio no es valido." });
    }

    if (lbs !== undefined && (!Number.isFinite(Number(lbs)) || Number(lbs) < 0 || Number(lbs) > 500)) {
      return res.status(400).json({ message: "Las libras indicadas no son validas." });
    }

    if (location && !normalizedLocation) {
      return res.status(400).json({ message: "La ubicacion enviada no es valida." });
    }

    const user = req.user;

    const order = await Order.create({
      id: await getNextNumericId(Order),
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      phone: phone || "",
      zone: String(zone).trim(),
      address: String(address).trim(),
      serviceType: serviceType || "Recogida a domicilio",
      date: String(date).trim(),
      time: String(time).trim(),
      pack: normalizedPacks.join(", "),
      packs: normalizedPacks,
      pricingMode: normalizedPricingMode,
      selectedGarments: normalizedGarments,
      location: normalizedLocation,
      extras: Array.isArray(extras) ? extras : [],
      notes: notes || "",
      status: "pendiente",
      repartidorId: null,
      repartidorName: null,
      lbs: Number(lbs) || 0,
      channel: "domicilio",
      createdAt: new Date(),
      history: [{ status: "pendiente", by: "cliente", at: new Date() }],
    });

    res.json({ message: "Pedido creado", order });
  })
);

app.put(
  "/api/orders/:id/assign",
  requireAuth,
  requireRole("gestor"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const { repartidorId } = req.body || {};

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "El id del pedido no es valido." });
    }

    if (!Number.isInteger(Number(repartidorId)) || Number(repartidorId) <= 0) {
      return res.status(400).json({ message: "Debes indicar un repartidor valido." });
    }

    const order = await Order.findOne({ id: orderId });
    if (!order) return res.status(404).json({ message: "Pedido no encontrado" });

    if (order.channel !== "domicilio") {
      return res.status(400).json({ message: "Solo se pueden asignar pedidos a domicilio." });
    }

    if (!ASSIGNABLE_ORDER_STATUSES.has(String(order.status || "").toLowerCase())) {
      return res.status(400).json({ message: "Este pedido ya no admite asignacion operativa." });
    }

    const rep = await User.findOne({
      id: Number(repartidorId),
      role: "repartidor",
    });
    if (!rep) return res.status(400).json({ message: "Repartidor no valido" });

    if (Number(order.repartidorId) === Number(rep.id)) {
      return res.status(400).json({ message: "Ese pedido ya esta asignado a ese repartidor." });
    }

    order.repartidorId = rep.id;
    order.repartidorName = rep.name;
    order.status = "asignado";
    addHistory(order, "asignado", "gestor");
    await order.save();

    res.json({ message: "Pedido asignado", order });
  })
);

app.put(
  "/api/orders/:id/status",
  requireAuth,
  requireRole("repartidor"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const { status, lbs } = req.body || {};
    const normalizedStatus = normalizeRequestedStatus(status);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "El id del pedido no es valido." });
    }

    const order = await Order.findOne({ id: orderId });
    if (!order) return res.status(404).json({ message: "Pedido no encontrado" });
    if (!status) return res.status(400).json({ message: "Falta el estado" });
    if (Number(order.repartidorId) !== Number(req.user.id)) {
      return res.status(403).json({ message: "Solo puedes actualizar pedidos asignados a tu ruta." });
    }

    if (order.channel !== "domicilio") {
      return res.status(400).json({ message: "Solo los pedidos a domicilio admiten este flujo." });
    }

    if (!["recibido", "en camino", "entregado"].includes(normalizedStatus)) {
      return res.status(400).json({ message: "El estado solicitado no esta permitido para repartidor." });
    }

    if (!canTransitionOrderStatus(order.status, normalizedStatus)) {
      return res.status(400).json({
        message: `No puedes pasar de ${order.status} a ${normalizedStatus}.`,
      });
    }

    if (lbs !== undefined && (!Number.isFinite(Number(lbs)) || Number(lbs) < 0 || Number(lbs) > 500)) {
      return res.status(400).json({ message: "Las libras indicadas no son validas." });
    }

    order.status = normalizedStatus;
    if (lbs !== undefined) {
      order.lbs = Number(lbs) || 0;
    }

    addHistory(order, normalizedStatus, "repartidor");
    await order.save();

    res.json({ message: "Estado actualizado", order });
  })
);

app.put(
  "/api/orders/:id/cancel",
  requireAuth,
  requireRole("cliente"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "El id del pedido no es valido." });
    }

    const order = await Order.findOne({ id: orderId });

    if (!order) return res.status(404).json({ message: "Pedido no encontrado" });
    if (Number(order.userId) !== Number(req.user.id)) {
      return res.status(403).json({ message: "Solo puedes cancelar tus propios pedidos." });
    }

    if (order.channel !== "domicilio") {
      return res.status(400).json({ message: "Solo puedes cancelar pedidos a domicilio." });
    }

    if (order.status === "entregado" || order.status === "cancelado") {
      return res.status(400).json({ message: "No se puede cancelar este pedido." });
    }

    if (!CLIENT_CANCELLABLE_STATUSES.has(String(order.status || "").toLowerCase())) {
      return res.status(400).json({
        message: "El pedido ya entro en una etapa donde no puede cancelarse por cliente.",
      });
    }

    const createdAt = new Date(order.createdAt).getTime();
    const diffMs = Date.now() - createdAt;
    if (diffMs > 5 * 60 * 1000) {
      return res.status(400).json({
        message: "Ya pasaron mas de 5 minutos, el pedido no se puede cancelar.",
      });
    }

    order.status = "cancelado";
    addHistory(order, "cancelado", "cliente");
    await order.save();

    res.json({ message: "Pedido cancelado", order });
  })
);

app.post(
  "/api/local-orders",
  requireAuth,
  requireRole("cajera", "gestor"),
  asyncHandler(async (req, res) => {
    const {
      customerName,
      customerPhone,
      customerEmail,
      zone,
      address,
      lbs,
      pack,
      extras,
      notes,
    } = req.body || {};

    if (!customerName || !customerPhone || lbs === undefined || !pack) {
      return res.status(400).json({
        message: "Faltan datos obligatorios (nombre, telefono, libras, paquete).",
      });
    }

    if (!isValidTextField(customerName, { min: 2, max: 80 })) {
      return res.status(400).json({ message: "El nombre del cliente no es valido." });
    }

    if (!isValidPhone(customerPhone, { required: true })) {
      return res.status(400).json({ message: "El telefono del cliente no es valido." });
    }

    if (customerEmail && !isValidEmail(customerEmail)) {
      return res.status(400).json({ message: "El correo del cliente no es valido." });
    }

    if (!isKnownZone(zone || "Distrito Nacional")) {
      return res.status(400).json({ message: "La zona indicada no es valida." });
    }

    if (address && !isValidTextField(address, { min: 4, max: 240, required: false })) {
      return res.status(400).json({ message: "La direccion de referencia no es valida." });
    }

    if (!isValidTextField(pack, { min: 2, max: 80 })) {
      return res.status(400).json({ message: "El paquete indicado no es valido." });
    }

    if (!Array.isArray(extras) || !areValidStringItems(extras, { max: 80 })) {
      return res.status(400).json({ message: "Los extras enviados no son validos." });
    }

    if (!isValidTextField(notes, { min: 0, max: 500, required: false })) {
      return res.status(400).json({ message: "Las notas superan el limite permitido." });
    }

    if (!Number.isFinite(Number(lbs)) || Number(lbs) <= 0 || Number(lbs) > 500) {
      return res.status(400).json({ message: "Las libras indicadas no son validas." });
    }

    const now = new Date();
    const order = await Order.create({
      id: await getNextNumericId(Order),
      userId: null,
      userName: String(customerName).trim(),
      userEmail: customerEmail || "",
      phone: String(customerPhone).trim(),
      zone: zone || "Distrito Nacional",
      address: address || "Entrega en local",
      serviceType: "Entrega en local",
      date: now.toISOString().slice(0, 10),
      time: now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      pack: String(pack).trim(),
      packs: [String(pack).trim()],
      pricingMode: "por_libra",
      selectedGarments: [],
      location: null,
      extras: Array.isArray(extras) ? extras : [],
      notes: notes || "",
      status: "recibido",
      repartidorId: null,
      repartidorName: null,
      lbs: Number(lbs) || 0,
      channel: "local",
      createdAt: now,
      history: [{ status: "recibido", by: "cajera", at: now }],
    });

    res.json({ message: "Pedido local creado", order });
  })
);

app.get(
  "/api/local-orders",
  requireAuth,
  requireRole("cajera", "gestor"),
  asyncHandler(async (_req, res) => {
    const localOrders = await Order.find({ channel: "local" }).sort({ id: -1 }).lean();
    res.json(localOrders);
  })
);

app.get("/api/business-info", (_req, res) => {
  res.json(BUSINESS_INFO);
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "mentalaundry-api",
    message: "Menta Laundry API online",
    health: "/api/health",
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    message: "API running",
    port: PORT,
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    dbName: mongoose.connection.name || null,
    emailMode: getEmailMode(),
    appBaseUrl: APP_BASE_URL,
    corsOrigins: ALLOWED_ORIGINS,
    corsOriginSuffixes: ALLOWED_ORIGIN_SUFFIXES,
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (isEmailDeliveryError(err)) {
    return res.status(503).json({
      code: "EMAIL_DELIVERY_FAILED",
      message: buildEmailDeliveryFailureMessage("generic"),
      emailDeliveryFailed: true,
      ...buildDeliveryResponse(buildEmailDeliveryFallback()),
    });
  }
  res.status(500).json({ message: err.message || "Error interno del servidor." });
});

async function startServer() {
  await connectDB(MONGODB_URI);
  await seedDemoData({ User, Order });

  app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("No se pudo iniciar el backend con MongoDB:", error.message);
  process.exit(1);
});
