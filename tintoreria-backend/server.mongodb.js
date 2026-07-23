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
const Notification = require("./models/Notification");
const CashClose = require("./models/CashClose");
const { sendEmail, getEmailMode } = require("./services/emailService");
const createEmailCampaignService = require("./services/emailCampaignService");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/tintoreria_express";
const JWT_SECRET = process.env.JWT_SECRET || "jwt_secret_change_me";
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
  "https://menta-laundry.vercel.app",
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
  name: "Menta Laundry",
  legalName: "Menta Laundry SRL",
  rnc: "",
  address: "Isabel Aguiar",
  phone: "829-448-7876",
  email: "admin@mentalaundry.com",
  itbisRate: 0.18,
  banks: [
    { name: "BHD", account: "33008190011" },
    { name: "Popular", account: "831576806" },
  ],
  footerMessage:
    "Gracias por confiar en Menta Laundry. Frescura, cuidado y seguimiento en cada prenda.",
};
const emailCampaigns = createEmailCampaignService({
  User,
  Order,
  sendEmail,
  businessInfo: BUSINESS_INFO,
});

const ALLOWED_ZONES = ["Distrito Nacional", "Sur", "Este", "Oeste"];
const ALLOWED_PRICING_MODES = ["por_libra", "por_prendas", "mixto"];
const ASSIGNABLE_ORDER_STATUSES = new Set(["pendiente", "asignado"]);
const CLIENT_CANCELLABLE_STATUSES = new Set(["pendiente", "asignado"]);
const ORDER_STATUS_TRANSITIONS = {
  asignado: ["en camino a recoger"],
  "en camino a recoger": ["recogido al cliente"],
  "recogido al cliente": ["de camino al local"],
  "de camino al local": ["recibido en local"],
  "recibido en local": ["en tratamiento"],
  "en tratamiento": ["listo para entrega"],
  "listo para entrega": ["en camino a entregar"],
  "en camino a entregar": ["entregado al cliente"],
};
const ORDER_STATUS_FLOW = [
  "pendiente",
  "asignado",
  "en camino a recoger",
  "recogido al cliente",
  "de camino al local",
  "recibido en local",
  "en tratamiento",
  "listo para entrega",
  "en camino a entregar",
  "entregado al cliente",
];
const LOCAL_ORDER_STATUSES = new Set([
  "recibido en local",
  "en tratamiento",
  "listo para entrega",
]);
const LOCAL_OPERATION_STATUSES = [
  "de camino al local",
  ...LOCAL_ORDER_STATUSES,
];
const LOCAL_STATUS_TRANSITIONS = {
  "de camino al local": ["recibido en local"],
  "recibido en local": ["en tratamiento"],
  "en tratamiento": ["listo para entrega"],
};
const PHONE_REGEX = /^[0-9+\-\s()]{7,20}$/;
const DELIVERY_PROOF_METHODS = new Set(["cliente", "porteria", "recepcion", "familiar", "otro"]);
const DELIVERY_CODE_LENGTH = 6;
const PAYMENT_METHODS = new Set(["efectivo", "transferencia", "deposito", "tarjeta", "mixto", "credito", "otro"]);
const PAYMENT_STATUS_HISTORY = new Set(["pago registrado", "pago actualizado", "pago reportado"]);
const GARMENT_PRICES = {
  camisas: 120,
  "pantalones finos": 190,
  blusas: 115,
  vestidos: 320,
  sacos: 360,
};

function publicUser(user) {
  const safe = user?.toObject ? user.toObject() : { ...user };
  delete safe.password;
  delete safe.emailVerificationToken;
  delete safe.emailVerificationExpiresAt;
  delete safe.passwordResetToken;
  delete safe.passwordResetExpiresAt;
  delete safe.marketingCampaign;
  return safe;
}

function normalizeOrderForPublic(order) {
  if (!order) return null;
  return order?.toObject ? order.toObject() : { ...order };
}

function normalizeHistoryActorRole(item) {
  return asText(item?.byRole || item?.by || "sistema").toLowerCase() || "sistema";
}

function sanitizeOrderHistoryForUser(history, user) {
  const items = Array.isArray(history) ? history : [];
  const role = user?.role || "cliente";
  const localAuditStatuses = new Set([...LOCAL_OPERATION_STATUSES, ...PAYMENT_STATUS_HISTORY]);

  return items
    .filter((item) => {
      if (role !== "cajera") return true;
      return localAuditStatuses.has(normalizeRequestedStatus(item?.status));
    })
    .map((item) => {
      const status = asText(item?.status);
      const actorRole = normalizeHistoryActorRole(item);
      const base = {
        status,
        by: actorRole,
        at: item?.at || new Date(),
      };

      if (role === "gestor") {
        return {
          ...base,
          byRole: actorRole,
          byUserId: item?.byUserId ?? null,
          byName: asText(item?.byName),
          note: asText(item?.note),
        };
      }

      if (role === "cajera") {
        return {
          ...base,
          byRole: actorRole,
          byName: ["gestor", "cajera", "repartidor"].includes(actorRole) ? asText(item?.byName) : "",
          note: asText(item?.note),
        };
      }

      if (role === "repartidor") {
        return {
          ...base,
          by: actorRole === "repartidor" ? "repartidor" : "operacion",
          byRole: actorRole === "repartidor" ? "repartidor" : "operacion",
        };
      }

      return {
        status,
        by: "Menta Laundry",
        byRole: "Menta Laundry",
        at: item?.at || new Date(),
      };
    });
}

function sanitizeOrderPaymentForUser(payment, user) {
  const safePayment = payment && typeof payment === "object" ? { ...payment } : { status: "pendiente" };
  if (!["gestor", "cajera"].includes(user?.role)) {
    delete safePayment.registeredByUserId;
    delete safePayment.registeredByName;
    delete safePayment.notes;

    if (user?.role !== "cliente") {
      delete safePayment.clientReportedAmount;
      delete safePayment.clientReportedMethod;
      delete safePayment.clientReportedReference;
      delete safePayment.clientReportedNote;
      delete safePayment.clientReportedAt;
      delete safePayment.clientReportedByUserId;
      delete safePayment.clientReportedByName;
    }
  }
  return safePayment;
}

function buildDeliveryCode(order) {
  const safeOrder = normalizeOrderForPublic(order) || {};
  const createdAt = safeOrder.createdAt ? new Date(safeOrder.createdAt) : null;
  const source = [
    safeOrder.id || "",
    safeOrder.userId || "",
    createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : "",
  ].join(":");
  const secret = process.env.DELIVERY_CODE_SECRET || JWT_SECRET;
  const digest = crypto.createHmac("sha256", secret).update(source).digest("hex");
  const codeNumber = Number.parseInt(digest.slice(0, 12), 16) % 10 ** DELIVERY_CODE_LENGTH;
  return String(codeNumber).padStart(DELIVERY_CODE_LENGTH, "0");
}

function buildPickupCode(order) {
  const safeOrder = normalizeOrderForPublic(order) || {};
  const createdAt = safeOrder.createdAt ? new Date(safeOrder.createdAt) : null;
  const source = [
    "pickup",
    safeOrder.id || "",
    safeOrder.userId || "",
    createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : "",
  ].join(":");
  const secret = process.env.DELIVERY_CODE_SECRET || JWT_SECRET;
  const digest = crypto.createHmac("sha256", secret).update(source).digest("hex");
  const codeNumber = Number.parseInt(digest.slice(0, 12), 16) % 10 ** DELIVERY_CODE_LENGTH;
  return String(codeNumber).padStart(DELIVERY_CODE_LENGTH, "0");
}

function normalizeDeliveryCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, DELIVERY_CODE_LENGTH);
}

function canExposeDeliveryCode(order, user) {
  const safeOrder = normalizeOrderForPublic(order) || {};
  const status = normalizeRequestedStatus(safeOrder.status);
  return (
    user?.role === "cliente" &&
    Number(safeOrder.userId) === Number(user.id) &&
    safeOrder.channel === "domicilio" &&
    !["entregado al cliente", "cancelado"].includes(status)
  );
}

function canExposePickupCode(order, user) {
  const safeOrder = normalizeOrderForPublic(order) || {};
  const status = normalizeRequestedStatus(safeOrder.status);
  return (
    canExposeDeliveryCode(safeOrder, user) &&
    ["pendiente", "asignado", "en camino a recoger"].includes(status)
  );
}

function publicOrder(order, user) {
  const safeOrder = normalizeOrderForPublic(order);
  if (!safeOrder) return safeOrder;

  safeOrder.history = sanitizeOrderHistoryForUser(safeOrder.history, user);
  safeOrder.payment = sanitizeOrderPaymentForUser(safeOrder.payment, user);

  if (canExposePickupCode(safeOrder, user)) {
    safeOrder.pickupCode = buildPickupCode(safeOrder);
  } else {
    delete safeOrder.pickupCode;
  }

  if (canExposeDeliveryCode(safeOrder, user)) {
    safeOrder.deliveryCode = buildDeliveryCode(safeOrder);
  } else {
    delete safeOrder.deliveryCode;
  }

  delete safeOrder.emailNotifications;

  return safeOrder;
}

function publicNotification(notification, user) {
  const safeNotification = notification?.toObject ? notification.toObject() : { ...notification };
  const readReceipt = (safeNotification.readReceipts || []).find(
    (receipt) => Number(receipt.userId) === Number(user?.id)
  );

  return {
    id: safeNotification.key,
    key: safeNotification.key,
    title: safeNotification.title,
    copy: safeNotification.copy,
    meta: safeNotification.meta || "",
    tone: safeNotification.tone || "info",
    screen: safeNotification.screen || "screenHome",
    actionLabel: safeNotification.actionLabel || "Abrir",
    priority: Number(safeNotification.priority || 0),
    orderId: safeNotification.orderId || null,
    orderChannel: safeNotification.orderChannel || "",
    recipientRole: safeNotification.recipientRole,
    recipientUserId: safeNotification.recipientUserId || null,
    createdAt: safeNotification.createdAt,
    read: Boolean(readReceipt),
    readAt: readReceipt?.readAt || null,
  };
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
      <div style="font-family:Segoe UI,Arial,sans-serif;background:#eef8f5;padding:32px;color:#173442;">
        <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:26px;padding:32px;border:1px solid #cfe9df;box-shadow:0 18px 50px rgba(23,52,66,.12);">
          <div style="display:inline-block;padding:8px 12px;border-radius:999px;background:#e4f5ee;color:#26765d;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">
            ${eyebrow}
          </div>
          <h1 style="margin:18px 0 10px;font-size:30px;line-height:1.1;color:#173442;">${title}</h1>
          <p style="margin:0 0 22px;font-size:16px;line-height:1.7;color:#55707b;">${intro}</p>
          <a href="${safeActionUrl}" style="display:inline-block;padding:14px 20px;border-radius:16px;background:linear-gradient(135deg,#82cdb0,#2f82b2);color:#ffffff;text-decoration:none;font-weight:900;">
            ${actionLabel}
          </a>
          <p style="margin:22px 0 10px;font-size:14px;line-height:1.7;color:#6b838c;">
            Si el boton no abre, copia y pega este enlace en tu navegador:
          </p>
          <p style="margin:0;font-size:13px;line-height:1.6;word-break:break-all;color:#6b838c;">
            ${safeActionUrl}
          </p>
          <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#7d949c;">
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
    intro: `Hola ${user.name}, ya casi estas dentro de ${BUSINESS_INFO.name}. Verifica tu correo para activar el acceso y gestionar tus pedidos con seguridad.`,
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatOrderDateTime(order) {
  const date = asText(order?.date) || "Fecha por confirmar";
  const time = asText(order?.time);
  return [date, time].filter(Boolean).join(" | ");
}

function getOrderPrimaryService(order) {
  const packs = Array.isArray(order?.packs) && order.packs.length
    ? order.packs
    : asText(order?.pack)
      ? [asText(order.pack)]
      : [];
  return packs.join(", ") || "Servicio textil";
}

function buildOrderTrackingUrl(order) {
  return buildAppUrl({
    order: order?.id || "",
  });
}

function buildOrderStatusEmailShell({ eyebrow, title, intro, order, actionLabel = "Ver mi pedido", note = "" }) {
  const actionUrl = buildOrderTrackingUrl(order);
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeActionUrl = escapeHtml(actionUrl);
  const safeCustomer = escapeHtml(order?.userName || "Cliente");
  const safeOrderId = escapeHtml(order?.id || "");
  const safeService = escapeHtml(getOrderPrimaryService(order));
  const safeSchedule = escapeHtml(formatOrderDateTime(order));
  const safeAddress = escapeHtml(order?.address || "Direccion pendiente");
  const safeRider = escapeHtml(order?.repartidorName || "Equipo Menta Laundry");
  const safeNote = escapeHtml(note || "Gracias por confiar en Menta Laundry. Te mantendremos informado solo en los momentos importantes.");

  return {
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;background:#eef8f5;padding:32px;color:#173442;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:28px;padding:32px;border:1px solid #cfe9df;box-shadow:0 18px 50px rgba(23,52,66,.12);">
          <div style="display:inline-block;padding:8px 12px;border-radius:999px;background:#e4f5ee;color:#26765d;font-size:12px;font-weight:900;letter-spacing:.10em;text-transform:uppercase;">
            ${escapeHtml(eyebrow)}
          </div>
          <h1 style="margin:18px 0 10px;font-size:30px;line-height:1.1;color:#173442;">${safeTitle}</h1>
          <p style="margin:0 0 22px;font-size:16px;line-height:1.7;color:#55707b;">${safeIntro}</p>
          <div style="border:1px solid #d8eee7;border-radius:22px;padding:18px;background:linear-gradient(135deg,#f7fffc,#ffffff);">
            <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:12px;">
              <div>
                <div style="font-size:12px;font-weight:900;letter-spacing:.10em;text-transform:uppercase;color:#6b838c;">Pedido</div>
                <div style="font-size:22px;font-weight:900;color:#173442;">#${safeOrderId}</div>
              </div>
              <div style="padding:8px 12px;border-radius:999px;background:#dff6ef;color:#26765d;font-size:12px;font-weight:900;">Menta Laundry</div>
            </div>
            <p style="margin:8px 0;color:#55707b;"><strong style="color:#173442;">Cliente:</strong> ${safeCustomer}</p>
            <p style="margin:8px 0;color:#55707b;"><strong style="color:#173442;">Servicio:</strong> ${safeService}</p>
            <p style="margin:8px 0;color:#55707b;"><strong style="color:#173442;">Agenda:</strong> ${safeSchedule}</p>
            <p style="margin:8px 0;color:#55707b;"><strong style="color:#173442;">Direccion:</strong> ${safeAddress}</p>
            <p style="margin:8px 0 0;color:#55707b;"><strong style="color:#173442;">Atendido por:</strong> ${safeRider}</p>
          </div>
          <a href="${safeActionUrl}" style="display:inline-block;margin-top:22px;padding:14px 20px;border-radius:16px;background:linear-gradient(135deg,#82cdb0,#2f82b2);color:#ffffff;text-decoration:none;font-weight:900;">
            ${escapeHtml(actionLabel)}
          </a>
          <p style="margin:22px 0 0;font-size:13px;line-height:1.7;color:#7d949c;">${safeNote}</p>
        </div>
      </div>
    `,
    text: [
      title,
      "",
      intro,
      "",
      `Pedido #${order?.id || ""}`,
      `Cliente: ${order?.userName || "Cliente"}`,
      `Servicio: ${getOrderPrimaryService(order)}`,
      `Agenda: ${formatOrderDateTime(order)}`,
      `Direccion: ${order?.address || "Direccion pendiente"}`,
      `Atendido por: ${order?.repartidorName || "Equipo Menta Laundry"}`,
      "",
      `${actionLabel}: ${actionUrl}`,
      "",
      note,
    ].join("\n"),
  };
}

function getOrderLifecycleEmailMeta(status) {
  const normalized = normalizeRequestedStatus(status);
  const metaByStatus = {
    "en camino a recoger": {
      event: "rider_to_pickup",
      subject: `Tu repartidor va en camino | ${BUSINESS_INFO.name}`,
      eyebrow: "Recogida en camino",
      title: "Tu repartidor va en camino",
      intro: "Estamos saliendo hacia tu ubicacion para recoger tus prendas. Ten tu pedido listo y revisa el codigo de recogida desde tu cuenta si se solicita.",
      actionLabel: "Ver seguimiento",
    },
    "recibido en local": {
      event: "local_received",
      subject: `Recibimos tus prendas en ${BUSINESS_INFO.name}`,
      eyebrow: "Recibido en local",
      title: "Tus prendas llegaron al local",
      intro: "Ya recibimos tu pedido en Menta Laundry. Ahora pasa a revision, pesaje y preparacion para el tratamiento correspondiente.",
      actionLabel: "Ver estado",
    },
    "entregado al cliente": {
      event: "delivered_to_client",
      subject: `Pedido entregado | ${BUSINESS_INFO.name}`,
      eyebrow: "Entrega completada",
      title: "Tu pedido fue entregado correctamente",
      intro: "Tu servicio fue cerrado como entregado. Gracias por permitirnos cuidar tus prendas con seguimiento y atencion profesional.",
      actionLabel: "Ver factura",
      note: "Si algo no quedo como esperabas, responde este correo o contacta soporte para ayudarte de inmediato.",
    },
  };

  return metaByStatus[normalized] || null;
}

function hasSentOrderLifecycleNotification(order, event) {
  return Array.isArray(order?.emailNotifications) &&
    order.emailNotifications.some((item) => item?.event === event && item?.ok === true);
}

async function sendOrderLifecycleNotification(order, status) {
  const meta = getOrderLifecycleEmailMeta(status);
  if (!meta || !order) return null;

  const to = asText(order.userEmail).toLowerCase();
  if (!isValidEmail(to)) return null;
  if (hasSentOrderLifecycleNotification(order, meta.event)) return null;

  const content = buildOrderStatusEmailShell({
    eyebrow: meta.eyebrow,
    title: meta.title,
    intro: meta.intro,
    order,
    actionLabel: meta.actionLabel,
    note: meta.note,
  });

  const logEntry = {
    event: meta.event,
    status: normalizeRequestedStatus(status),
    to,
    ok: false,
    delivered: false,
    mode: getEmailMode(),
    messageId: null,
    error: "",
    sentAt: new Date(),
  };

  try {
    const delivery = await sendEmail({
      to,
      subject: meta.subject,
      html: content.html,
      text: content.text,
      debugActionUrl: buildOrderTrackingUrl(order),
    });
    logEntry.ok = Boolean(delivery?.ok);
    logEntry.delivered = Boolean(delivery?.delivered);
    logEntry.mode = delivery?.mode || getEmailMode();
    logEntry.messageId = delivery?.messageId || null;
  } catch (error) {
    logEntry.error = String(error?.message || "email_delivery_failed").slice(0, 240);
    console.warn(`No se pudo enviar notificacion ${meta.event} para pedido #${order.id}:`, logEntry.error);
  }

  try {
    if (!Array.isArray(order.emailNotifications)) order.emailNotifications = [];
    order.emailNotifications.push(logEntry);
    await order.save();
  } catch (error) {
    console.warn(`No se pudo registrar notificacion ${meta.event} para pedido #${order.id}:`, error?.message || error);
  }

  return logEntry;
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
    text.includes("smtp") ||
    text.includes("brevo") ||
    text.includes("api key") ||
    text.includes("unauthorized") ||
    text.includes("forbidden")
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
    subject: `Verifica tu cuenta de ${BUSINESS_INFO.name}`,
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
    subject: `Restablece tu contrasena de ${BUSINESS_INFO.name}`,
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

function createHistoryEntry(status, by, actor = null, note = "") {
  const actorId = actor?.id === undefined || actor?.id === null ? null : Number(actor.id);
  const byRole = asText(actor?.role || by || "sistema").toLowerCase() || "sistema";

  return {
    status: normalizeRequestedStatus(status),
    by: asText(by || byRole || "sistema"),
    byRole,
    byUserId: Number.isFinite(actorId) ? actorId : null,
    byName: asText(actor?.name),
    note: asText(note).slice(0, 240),
    at: new Date(),
  };
}

function addHistory(order, status, by, actor = null, note = "") {
  if (!Array.isArray(order.history)) order.history = [];
  order.history.push(createHistoryEntry(status, by, actor, note));
}

function getGarmentPrice(name) {
  return GARMENT_PRICES[asText(name).toLowerCase()] || 0;
}

function buildOrderChargeBreakdown(order) {
  const pricingMode = ALLOWED_PRICING_MODES.includes(asText(order?.pricingMode))
    ? asText(order.pricingMode)
    : "por_libra";
  const lbs = Math.max(Number(order?.lbs || 0), 0);
  const extras = Array.isArray(order?.extras) ? order.extras : [];
  const garments = Array.isArray(order?.selectedGarments) ? order.selectedGarments : [];
  const lines = [];

  if (pricingMode === "por_libra" || pricingMode === "mixto") {
    lines.push({
      label: "Ropa por libra",
      qty: lbs,
      price: 30,
      total: lbs * 30,
    });
  }

  if (pricingMode === "por_prendas" || pricingMode === "mixto") {
    garments.forEach((item) => {
      const qty = Math.max(Number(item?.qty || 0), 0);
      const price = getGarmentPrice(item?.name);
      if (!qty || !price) return;
      lines.push({
        label: asText(item.name),
        qty,
        price,
        total: qty * price,
      });
    });
  }

  if (extras.length) {
    lines.push({
      label: "Extras",
      qty: extras.length,
      price: 75,
      total: extras.length * 75,
    });
  }

  const subtotal = lines.reduce((sum, line) => sum + Number(line.total || 0), 0);
  const itbis = subtotal * BUSINESS_INFO.itbisRate;
  const total = subtotal + itbis;

  return {
    subtotal,
    itbis,
    total,
    weightPending: (pricingMode === "por_libra" || pricingMode === "mixto") && lbs <= 0,
  };
}

function resolvePaymentStatus(amountPaid, total) {
  const paid = Number(amountPaid || 0);
  const expectedTotal = Number(total || 0);
  if (paid <= 0) return "pendiente";
  if (expectedTotal > 0 && paid + 0.001 < expectedTotal) return "parcial";
  return "pagado";
}

function normalizePaymentPayload(body, order) {
  const breakdown = buildOrderChargeBreakdown(order);
  const total = Number(breakdown.total || 0);
  const amountPaid = Number(body?.amountPaid ?? order?.payment?.amountPaid ?? 0);
  const method = asText(body?.method || order?.payment?.method || "").toLowerCase();
  const status = resolvePaymentStatus(amountPaid, total);

  if (!Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > 10000000) {
    return { error: "El monto pagado no es valido." };
  }

  if (amountPaid > 0 && !PAYMENT_METHODS.has(method)) {
    return { error: "Selecciona un metodo de pago valido." };
  }

  if (!isValidTextField(body?.reference || "", { min: 0, max: 120, required: false })) {
    return { error: "La referencia de pago es demasiado larga." };
  }

  if (!isValidTextField(body?.notes || "", { min: 0, max: 240, required: false })) {
    return { error: "Las notas de pago son demasiado largas." };
  }

  return {
    value: {
      status,
      method: PAYMENT_METHODS.has(method) ? method : "",
      amountPaid,
      totalSnapshot: total,
      balance: Math.max(total - amountPaid, 0),
      reference: asText(body?.reference).slice(0, 120),
      notes: asText(body?.notes).slice(0, 240),
      registeredAt: new Date(),
    },
  };
}

function normalizeClientPaymentReportPayload(body, order) {
  const breakdown = buildOrderChargeBreakdown(order);
  const total = Number(breakdown.total || order?.payment?.totalSnapshot || 0);
  const amount = Number(body?.amount ?? body?.amountPaid ?? 0);
  const method = asText(body?.method || "").toLowerCase();
  const reference = asText(body?.reference).slice(0, 120);
  const note = asText(body?.note || body?.notes).slice(0, 240);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    return { error: "El monto reportado no es valido." };
  }

  if (!PAYMENT_METHODS.has(method) || ["credito"].includes(method)) {
    return { error: "Selecciona un metodo de pago valido." };
  }

  if (!isValidTextField(reference, { min: 3, max: 120, required: true })) {
    return { error: "Agrega la referencia o numero de comprobante." };
  }

  if (!isValidTextField(note, { min: 0, max: 240, required: false })) {
    return { error: "El comentario de pago es demasiado largo." };
  }

  const confirmedAmount = Number(order?.payment?.amountPaid || 0);

  return {
    value: {
      status: "por_verificar",
      method,
      amountPaid: confirmedAmount,
      totalSnapshot: total,
      balance: Math.max(total - confirmedAmount, 0),
      reference,
      clientReportedAmount: amount,
      clientReportedMethod: method,
      clientReportedReference: reference,
      clientReportedNote: note,
      clientReportedAt: new Date(),
      clientReportedByUserId: Number(order.userId || 0),
      clientReportedByName: asText(order.userName),
    },
  };
}

function getCashCloseDate(value = "") {
  const raw = asText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

function getCashCloseDateRange(date) {
  const normalizedDate = getCashCloseDate(date);
  // Menta opera en RD/Caracas time (UTC-04); this keeps late-night closes in the intended local day.
  const start = new Date(`${normalizedDate}T04:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { normalizedDate, start, end };
}

function buildCashCloseSummary(orders) {
  return (Array.isArray(orders) ? orders : []).reduce(
    (summary, order) => {
      const payment = order?.payment || {};
      const total = Number(payment.totalSnapshot || buildOrderChargeBreakdown(order).total || 0);
      const amountPaid = Number(payment.amountPaid || 0);
      const balance = Math.max(Number(payment.balance ?? (total - amountPaid)), 0);
      const status = asText(payment.status || resolvePaymentStatus(amountPaid, total));
      const method = asText(payment.method || "sin_metodo") || "sin_metodo";

      summary.orderCount += 1;
      summary.expectedTotal += total;
      summary.paidTotal += amountPaid;
      summary.pendingTotal += balance;
      summary.orderIds.push(Number(order.id));
      if (status === "pagado") summary.paidOrderCount += 1;
      if (status === "parcial") summary.partialOrderCount += 1;
      if (status === "pendiente" || status === "por_verificar") summary.pendingOrderCount += 1;
      summary.byMethod[method] = Number(summary.byMethod[method] || 0) + amountPaid;
      return summary;
    },
    {
      orderCount: 0,
      paidOrderCount: 0,
      partialOrderCount: 0,
      pendingOrderCount: 0,
      expectedTotal: 0,
      paidTotal: 0,
      pendingTotal: 0,
      byMethod: {},
      orderIds: [],
    }
  );
}

function getOrderStatusRank(status) {
  const index = ORDER_STATUS_FLOW.indexOf(normalizeRequestedStatus(status));
  return index >= 0 ? index : 0;
}

function isOrderClosed(status) {
  const normalized = normalizeRequestedStatus(status);
  return normalized === "entregado al cliente" || normalized === "cancelado";
}

function hasOrderGps(order) {
  const location = order?.location || null;
  return Number.isFinite(Number(location?.lat)) && Number.isFinite(Number(location?.lng));
}

function getOrderServiceTimestamp(order) {
  const rawDate = asText(order?.date);
  if (!rawDate) return null;
  const rawTime = asText(order?.time) || "00:00";
  const timestamp = new Date(`${rawDate}T${rawTime}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isOrderDelayedForNotification(order) {
  if (!order || isOrderClosed(order.status)) return false;
  const timestamp = getOrderServiceTimestamp(order);
  return Number.isFinite(timestamp) && timestamp < Date.now();
}

function buildNotificationVisibilityQuery(user) {
  return {
    $or: [
      { recipientUserId: Number(user.id) },
      {
        recipientRole: user.role,
        $or: [{ recipientUserId: null }, { recipientUserId: { $exists: false } }],
      },
    ],
  };
}

function buildOrderNotificationKey(order, topic, extra = "") {
  return [
    "order",
    topic,
    order?.channel || "domicilio",
    order?.id || "sin-id",
    extra || normalizeRequestedStatus(order?.status),
  ].join(":");
}

function getOrderNotificationMeta(order) {
  const parts = [
    order?.id ? `Pedido #${order.id}` : "",
    order?.zone || "",
    normalizeRequestedStatus(order?.status) || "",
  ].filter(Boolean);
  return parts.join(" | ");
}

async function createInternalNotification(input = {}) {
  const key = asText(input.key);
  const recipientRole = asText(input.recipientRole);
  const title = asText(input.title);
  const copy = asText(input.copy);
  if (!key || !recipientRole || !title || !copy) return null;

  const doc = {
    key,
    recipientRole,
    recipientUserId: Number.isFinite(Number(input.recipientUserId)) ? Number(input.recipientUserId) : null,
    orderId: Number.isFinite(Number(input.orderId)) ? Number(input.orderId) : null,
    orderChannel: asText(input.orderChannel) || "domicilio",
    title,
    copy,
    meta: asText(input.meta),
    tone: ["info", "success", "warning", "danger"].includes(asText(input.tone)) ? asText(input.tone) : "info",
    screen: asText(input.screen) || "screenHome",
    actionLabel: asText(input.actionLabel) || "Abrir",
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50,
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date(),
  };

  try {
    await Notification.updateOne({ key }, { $setOnInsert: doc }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) {
      console.warn("No se pudo crear notificacion interna:", error?.message || error);
    }
  }
  return doc;
}

async function createOrderCreatedNotifications(order) {
  if (!order) return;
  await Promise.all([
    createInternalNotification({
      key: buildOrderNotificationKey(order, "created", "gestor"),
      recipientRole: "gestor",
      orderId: order.id,
      orderChannel: order.channel,
      title: "Nuevo pedido pendiente",
      copy: `${order.userName || "Cliente"} creo una recogida en ${order.zone || "zona pendiente"}.`,
      meta: getOrderNotificationMeta(order),
      tone: "warning",
      screen: "screenHome",
      actionLabel: "Asignar",
      priority: 100,
    }),
    order.userId
      ? createInternalNotification({
          key: buildOrderNotificationKey(order, "client-created", order.userId),
          recipientRole: "cliente",
          recipientUserId: order.userId,
          orderId: order.id,
          orderChannel: order.channel,
          title: "Solicitud recibida",
          copy: "Tu pedido fue creado y ya esta en la bandeja de Menta Laundry.",
          meta: getOrderNotificationMeta(order),
          tone: "success",
          screen: "screenHome",
          actionLabel: "Ver pedido",
          priority: 70,
        })
      : Promise.resolve(),
  ]);
}

async function createOrderAssignedNotifications(order, rider) {
  if (!order || !rider) return;
  const assignmentStamp = order.history?.[order.history.length - 1]?.at
    ? new Date(order.history[order.history.length - 1].at).getTime()
    : Date.now();

  await Promise.all([
    createInternalNotification({
      key: buildOrderNotificationKey(order, "assigned-rider", `${rider.id}:${assignmentStamp}`),
      recipientRole: "repartidor",
      recipientUserId: rider.id,
      orderId: order.id,
      orderChannel: order.channel,
      title: "Nuevo pedido asignado",
      copy: `${order.userName || "Cliente"} ya esta en tu ruta activa.`,
      meta: getOrderNotificationMeta(order),
      tone: "info",
      screen: "screenHome",
      actionLabel: "Ver ruta",
      priority: 95,
    }),
    order.userId
      ? createInternalNotification({
          key: buildOrderNotificationKey(order, "assigned-client", `${order.userId}:${assignmentStamp}`),
          recipientRole: "cliente",
          recipientUserId: order.userId,
          orderId: order.id,
          orderChannel: order.channel,
          title: "Repartidor asignado",
          copy: `${rider.name || "Tu repartidor"} fue asignado a tu servicio.`,
          meta: getOrderNotificationMeta(order),
          tone: "info",
          screen: "screenHome",
          actionLabel: "Ver pedido",
          priority: 78,
        })
      : Promise.resolve(),
  ]);
}

async function createOrderCancelledNotifications(order) {
  if (!order) return;
  await Promise.all([
    createInternalNotification({
      key: buildOrderNotificationKey(order, "cancelled-gestor", "gestor"),
      recipientRole: "gestor",
      orderId: order.id,
      orderChannel: order.channel,
      title: "Pedido cancelado",
      copy: `${order.userName || "Cliente"} cancelo un pedido que estaba en seguimiento.`,
      meta: getOrderNotificationMeta(order),
      tone: "danger",
      screen: "screenControl",
      actionLabel: "Revisar",
      priority: 88,
    }),
    order.userId
      ? createInternalNotification({
          key: buildOrderNotificationKey(order, "cancelled-client", order.userId),
          recipientRole: "cliente",
          recipientUserId: order.userId,
          orderId: order.id,
          orderChannel: order.channel,
          title: "Pedido cancelado",
          copy: "Tu solicitud fue cancelada y quedo registrada en tu actividad.",
          meta: getOrderNotificationMeta(order),
          tone: "info",
          screen: "screenActivity",
          actionLabel: "Ver actividad",
          priority: 60,
        })
      : Promise.resolve(),
  ]);
}

async function createOrderStatusNotifications(order, status) {
  if (!order) return;
  const normalizedStatus = normalizeRequestedStatus(status || order.status);
  const tasks = [];
  const clientScreens = {
    "en camino a recoger": {
      title: "Repartidor en camino",
      copy: "Ten listo el PIN de recogida y las prendas para entregarlas con seguridad.",
      tone: "warning",
      priority: 92,
      screen: "screenHome",
    },
    "recogido al cliente": {
      title: "Prendas recogidas",
      copy: "Tu pedido fue recibido por el equipo de ruta y va camino al local.",
      tone: "info",
      priority: 80,
      screen: "screenActivity",
    },
    "de camino al local": {
      title: "Camino al local",
      copy: "Tus prendas van hacia el local para iniciar el flujo de recepcion.",
      tone: "info",
      priority: 76,
      screen: "screenActivity",
    },
    "recibido en local": {
      title: "Pedido en el local",
      copy: "Tus prendas ya estan dentro del flujo de recepcion y cuidado textil.",
      tone: "info",
      priority: 78,
      screen: "screenActivity",
    },
    "en tratamiento": {
      title: "Tratamiento activo",
      copy: "Tu pedido esta en lavado, planchado o cuidado textil.",
      tone: "info",
      priority: 72,
      screen: "screenActivity",
    },
    "listo para entrega": {
      title: "Pedido listo",
      copy: "Tus prendas estan listas para coordinar la entrega final.",
      tone: "success",
      priority: 88,
      screen: "screenActivity",
    },
    "en camino a entregar": {
      title: "Entrega en camino",
      copy: "El pedido va hacia tu direccion. Ten el PIN de entrega disponible.",
      tone: "warning",
      priority: 94,
      screen: "screenHome",
    },
    "entregado al cliente": {
      title: "Entrega cerrada",
      copy: "Tu servicio fue marcado como entregado. Puedes revisar factura y detalle en tu actividad.",
      tone: "success",
      priority: 82,
      screen: "screenActivity",
    },
  };

  const clientMeta = clientScreens[normalizedStatus];
  if (order.userId && clientMeta) {
    tasks.push(createInternalNotification({
      key: buildOrderNotificationKey(order, `client-status-${normalizedStatus}`, order.userId),
      recipientRole: "cliente",
      recipientUserId: order.userId,
      orderId: order.id,
      orderChannel: order.channel,
      title: clientMeta.title,
      copy: clientMeta.copy,
      meta: getOrderNotificationMeta(order),
      tone: clientMeta.tone,
      screen: clientMeta.screen,
      actionLabel: "Ver pedido",
      priority: clientMeta.priority,
    }));
  }

  if (normalizedStatus === "de camino al local") {
    tasks.push(createInternalNotification({
      key: buildOrderNotificationKey(order, "cajera-camino-local", "cajera"),
      recipientRole: "cajera",
      orderId: order.id,
      orderChannel: order.channel,
      title: "Pedido camino al local",
      copy: `${order.userName || "Cliente"} viene desde ruta para recepcion.`,
      meta: getOrderNotificationMeta(order),
      tone: "warning",
      screen: "screenProduction",
      actionLabel: "Ver produccion",
      priority: 96,
    }));
  }

  if (["recibido en local", "en tratamiento", "listo para entrega"].includes(normalizedStatus)) {
    const localCopyByStatus = {
      "recibido en local": "Este pedido necesita pesaje, observaciones o paso a tratamiento.",
      "en tratamiento": "El pedido esta en lavado, planchado o cuidado textil.",
      "listo para entrega": "El pedido puede coordinar entrega final.",
    };
    tasks.push(createInternalNotification({
      key: buildOrderNotificationKey(order, `cajera-local-${normalizedStatus}`, "cajera"),
      recipientRole: "cajera",
      orderId: order.id,
      orderChannel: order.channel,
      title: formatStatusTitle(normalizedStatus),
      copy: localCopyByStatus[normalizedStatus],
      meta: getOrderNotificationMeta(order),
      tone: normalizedStatus === "listo para entrega" ? "success" : "info",
      screen: "screenProduction",
      actionLabel: "Ver mesa",
      priority: normalizedStatus === "listo para entrega" ? 90 : 82,
    }));
  }

  if (normalizedStatus === "listo para entrega" && order.repartidorId) {
    tasks.push(createInternalNotification({
      key: buildOrderNotificationKey(order, "rider-ready", order.repartidorId),
      recipientRole: "repartidor",
      recipientUserId: order.repartidorId,
      orderId: order.id,
      orderChannel: order.channel,
      title: "Pedido listo para entrega",
      copy: `${order.userName || "Cliente"} puede pasar a ruta final.`,
      meta: getOrderNotificationMeta(order),
      tone: "success",
      screen: "screenHome",
      actionLabel: "Ver ruta",
      priority: 88,
    }));
  }

  if (normalizedStatus === "entregado al cliente") {
    tasks.push(createInternalNotification({
      key: buildOrderNotificationKey(order, "gestor-delivered", "gestor"),
      recipientRole: "gestor",
      orderId: order.id,
      orderChannel: order.channel,
      title: "Entrega completada",
      copy: `${order.userName || "Cliente"} fue marcado como entregado.`,
      meta: getOrderNotificationMeta(order),
      tone: "success",
      screen: "screenHistory",
      actionLabel: "Ver historial",
      priority: 66,
    }));
  }

  await Promise.all(tasks);
}

function formatStatusTitle(status) {
  const normalized = normalizeRequestedStatus(status);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

async function syncOperationalNotificationsForUser(user) {
  if (!user) return;
  const tasks = [];

  if (user.role === "cliente") {
    if (!user.emailVerified) {
      tasks.push(createInternalNotification({
        key: `user:email-pending:${user.id}`,
        recipientRole: "cliente",
        recipientUserId: user.id,
        title: "Correo pendiente",
        copy: "Verifica tu correo para recibir avisos automaticos de ruta, local y entrega.",
        meta: "Cuenta",
        tone: "warning",
        screen: "screenAccount",
        actionLabel: "Ver cuenta",
        priority: 95,
      }));
    }

    const orders = await Order.find({ userId: user.id }).sort({ id: -1 }).limit(30).lean();
    orders.filter((order) => !isOrderClosed(order.status)).forEach((order) => {
      tasks.push(createOrderStatusNotifications(order, order.status));
    });
  }

  if (user.role === "gestor") {
    const orders = await Order.find({ channel: { $ne: "local" } }).sort({ id: -1 }).limit(80).lean();
    orders.filter((order) => !isOrderClosed(order.status)).forEach((order) => {
      if (!order.repartidorId || normalizeRequestedStatus(order.status) === "pendiente") {
        tasks.push(createInternalNotification({
          key: buildOrderNotificationKey(order, "gestor-unassigned", "gestor"),
          recipientRole: "gestor",
          orderId: order.id,
          orderChannel: order.channel,
          title: "Pedido sin asignar",
          copy: `${order.userName || "Cliente"} espera repartidor en ${order.zone || "zona pendiente"}.`,
          meta: getOrderNotificationMeta(order),
          tone: "warning",
          screen: "screenHome",
          actionLabel: "Asignar",
          priority: 100,
        }));
      }

      if (isOrderDelayedForNotification(order)) {
        tasks.push(createInternalNotification({
          key: buildOrderNotificationKey(order, "gestor-delayed", "gestor"),
          recipientRole: "gestor",
          orderId: order.id,
          orderChannel: order.channel,
          title: "Pedido atrasado",
          copy: `${order.userName || "Cliente"} requiere seguimiento por horario o estado.`,
          meta: `${order.zone || "--"} | ${order.date || ""} ${order.time || ""}`,
          tone: "danger",
          screen: "screenControl",
          actionLabel: "Revisar",
          priority: 96,
        }));
      }

      if (!hasOrderGps(order)) {
        tasks.push(createInternalNotification({
          key: buildOrderNotificationKey(order, "gestor-no-gps", "gestor"),
          recipientRole: "gestor",
          orderId: order.id,
          orderChannel: order.channel,
          title: "Pedido sin GPS",
          copy: "La ruta puede operar con direccion manual, pero conviene validar el punto real.",
          meta: getOrderNotificationMeta(order),
          tone: "info",
          screen: "screenControl",
          actionLabel: "Ver control",
          priority: 70,
        }));
      }
    });
  }

  if (user.role === "repartidor") {
    const orders = await Order.find({ repartidorId: user.id }).sort({ id: -1 }).limit(60).lean();
    orders.filter((order) => !isOrderClosed(order.status)).forEach((order) => {
      const status = normalizeRequestedStatus(order.status);
      if (status === "asignado") {
        tasks.push(createInternalNotification({
          key: buildOrderNotificationKey(order, "rider-assigned", user.id),
          recipientRole: "repartidor",
          recipientUserId: user.id,
          orderId: order.id,
          orderChannel: order.channel,
          title: "Nuevo pedido asignado",
          copy: `${order.userName || "Cliente"} ya esta en tu ruta activa.`,
          meta: getOrderNotificationMeta(order),
          tone: "info",
          screen: "screenHome",
          actionLabel: "Ver ruta",
          priority: 86,
        }));
      }

      if (status === "en camino a recoger" || status === "en camino a entregar") {
        tasks.push(createInternalNotification({
          key: buildOrderNotificationKey(order, `rider-pin-${status}`, user.id),
          recipientRole: "repartidor",
          recipientUserId: user.id,
          orderId: order.id,
          orderChannel: order.channel,
          title: status === "en camino a recoger" ? "Recogida con PIN" : "Entrega con PIN",
          copy: status === "en camino a recoger"
            ? "Antes de avanzar, pide el PIN de recogida al cliente."
            : "Para cerrar el pedido necesitas el PIN de entrega del cliente.",
          meta: getOrderNotificationMeta(order),
          tone: "warning",
          screen: "screenHome",
          actionLabel: "Ver pedido",
          priority: 94,
        }));
      }
    });
  }

  if (user.role === "cajera") {
    const orders = await Order.find({
      $or: [{ channel: "local" }, { status: { $in: LOCAL_OPERATION_STATUSES } }],
    }).sort({ id: -1 }).limit(80).lean();

    orders.filter((order) => !isOrderClosed(order.status)).forEach((order) => {
      const status = normalizeRequestedStatus(order.status);
      if (["de camino al local", "recibido en local", "en tratamiento", "listo para entrega"].includes(status)) {
        tasks.push(createOrderStatusNotifications(order, status));
      }
    });
  }

  await Promise.all(tasks);
}

async function getVisibleNotificationsForUser(user) {
  await syncOperationalNotificationsForUser(user);
  const notifications = await Notification.find(buildNotificationVisibilityQuery(user))
    .sort({ priority: -1, createdAt: -1 })
    .limit(60)
    .lean();
  return notifications
    .filter((item) => !(user.emailVerified && item.key === `user:email-pending:${user.id}`))
    .map((item) => publicNotification(item, user));
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

function normalizeDeliveryProofInput(input, user, order) {
  const proof = input && typeof input === "object" ? input : {};
  const receiverName = asText(proof.receiverName);
  const deliveryMethod = asText(proof.deliveryMethod).toLowerCase();
  const note = asText(proof.note);
  const deliveryCode = normalizeDeliveryCode(proof.deliveryCode);

  if (!isValidTextField(receiverName, { min: 2, max: 80, required: true })) {
    return { error: "Indica quien recibio el pedido." };
  }

  if (!DELIVERY_PROOF_METHODS.has(deliveryMethod)) {
    return { error: "Selecciona como fue recibida la entrega." };
  }

  if (!isValidTextField(note, { max: 240, required: false })) {
    return { error: "La nota de entrega no puede superar 240 caracteres." };
  }

  if (deliveryCode.length !== DELIVERY_CODE_LENGTH) {
    return { error: "Indica el codigo de entrega de 6 digitos." };
  }

  if (deliveryCode !== buildDeliveryCode(order)) {
    return { error: "El codigo de entrega no coincide con la cuenta del cliente." };
  }

  const verifiedAt = new Date();

  return {
    value: {
      receiverName,
      deliveryMethod,
      note,
      deliveredAt: verifiedAt,
      byUserId: Number.isFinite(Number(user?.id)) ? Number(user.id) : null,
      byName: asText(user?.name) || "Repartidor",
      deliveryCodeVerified: true,
      deliveryCodeVerifiedAt: verifiedAt,
    },
  };
}

function normalizePickupProofInput(input, user, order) {
  const proof = input && typeof input === "object" ? input : {};
  const pickupCode = normalizeDeliveryCode(proof.pickupCode || proof.deliveryCode || proof.code);

  if (pickupCode.length !== DELIVERY_CODE_LENGTH) {
    return { error: "Indica el codigo de recogida de 6 digitos." };
  }

  if (pickupCode !== buildPickupCode(order)) {
    return { error: "El codigo de recogida no coincide con la cuenta del cliente." };
  }

  const verifiedAt = new Date();

  return {
    value: {
      pickedUpAt: verifiedAt,
      byUserId: Number.isFinite(Number(user?.id)) ? Number(user.id) : null,
      byName: asText(user?.name) || "Repartidor",
      pickupCodeVerified: true,
      pickupCodeVerifiedAt: verifiedAt,
    },
  };
}

function areValidStringItems(items, { max = 80 } = {}) {
  if (!Array.isArray(items)) return false;
  return items.every((item) => isValidTextField(item, { min: 1, max }));
}

function normalizeRequestedStatus(value) {
  const status = asText(value).toLowerCase();
  if (status === "camino" || status === "en camino") return "en camino a entregar";
  if (status === "recibido") return "recogido al cliente";
  if (status === "entregado") return "entregado al cliente";
  return status;
}

function canTransitionOrderStatus(currentStatus, nextStatus) {
  const current = normalizeRequestedStatus(currentStatus);
  const next = normalizeRequestedStatus(nextStatus);
  return (ORDER_STATUS_TRANSITIONS[current] || []).includes(next);
}

function normalizeLocalWorkflowStatus(value, channel = "") {
  const status = asText(value).toLowerCase();
  if (!status) return "";
  if (status === "recibido") return "recibido en local";

  const normalized = normalizeRequestedStatus(status);
  if (channel === "local" && normalized === "recogido al cliente") {
    return "recibido en local";
  }
  return normalized;
}

function canTransitionLocalStatus(order, nextStatus) {
  const current = normalizeLocalWorkflowStatus(order?.status, order?.channel);
  const next = normalizeLocalWorkflowStatus(nextStatus, order?.channel);
  if (!current || !next) return false;
  if (current === next) return true;
  return (LOCAL_STATUS_TRANSITIONS[current] || []).includes(next);
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
    const marketingOptIn = req.body?.marketingOptIn === true;

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
      createdAt: new Date(),
      marketingCampaign: {
        capturedAt: marketingOptIn ? new Date() : null,
        unsubscribedAt: null,
      },
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
    emailCampaigns.queueUser(user.id, "launch");

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
      query = {
        $or: [
          { channel: "local" },
          { status: { $in: LOCAL_OPERATION_STATUSES } },
        ],
      };
    }

    const orders = await Order.find(query).sort({ id: 1 }).lean();
    res.json(orders.map((order) => publicOrder(order, req.user)));
  })
);

app.get(
  "/api/bootstrap",
  requireAuth,
  asyncHandler(async (req, res) => {
    const requestedScreen = String(req.query.screen || "screenHome").trim() || "screenHome";
    let ordersQuery = {};

    if (req.user.role === "cliente") {
      ordersQuery = { userId: req.user.id };
    } else if (req.user.role === "repartidor") {
      ordersQuery = { repartidorId: req.user.id };
    } else if (req.user.role === "cajera") {
      ordersQuery = {
        $or: [
          { channel: "local" },
          { status: { $in: LOCAL_OPERATION_STATUSES } },
        ],
      };
    }

    const canReviewLocalOrders = ["gestor", "cajera"].includes(req.user.role);
    const canReviewRiders = req.user.role === "gestor";
    const includeLocalOrders =
      req.user.role === "cajera" ||
      (req.user.role === "gestor" && ["screenLocal", "screenHistory"].includes(requestedScreen));

    const [orders, reps, localOrders] = await Promise.all([
      Order.find(ordersQuery).sort({ id: 1 }).lean(),
      canReviewRiders
        ? User.find({ role: "repartidor" }).sort({ name: 1 }).lean()
        : Promise.resolve([]),
      canReviewLocalOrders && includeLocalOrders
        ? Order.find({ channel: "local" }).sort({ id: -1 }).lean()
        : Promise.resolve([]),
    ]);
    const notifications = await getVisibleNotificationsForUser(req.user);

    res.json({
      user: publicUser(req.user),
      orders: orders.map((order) => publicOrder(order, req.user)),
      repartidores: reps.map(publicUser),
      localOrders: localOrders.map((order) => publicOrder(order, req.user)),
      localOrdersLoaded: includeLocalOrders,
      notifications,
    });
  })
);

app.get(
  "/api/notifications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const notifications = await getVisibleNotificationsForUser(req.user);
    res.json({ notifications });
  })
);

app.put(
  "/api/notifications/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = rawIds.map(asText).filter(Boolean);
    const query = buildNotificationVisibilityQuery(req.user);
    if (!req.body?.all) {
      if (!ids.length) {
        return res.status(400).json({ message: "Debes indicar notificaciones para marcar como vistas." });
      }
      query.key = { $in: ids };
    }

    const notifications = await Notification.find(query).limit(100);
    const now = new Date();
    await Promise.all(
      notifications.map(async (notification) => {
        const alreadyRead = (notification.readReceipts || []).some(
          (receipt) => Number(receipt.userId) === Number(req.user.id)
        );
        if (!alreadyRead) {
          notification.readReceipts.push({ userId: req.user.id, readAt: now });
          await notification.save();
        }
      })
    );

    res.json({ notifications: await getVisibleNotificationsForUser(req.user) });
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

    if (!normalizedLocation) {
      return res.status(400).json({ message: "La ubicacion GPS es obligatoria para crear una recogida a domicilio." });
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
      history: [createHistoryEntry("pendiente", "cliente", user, "Pedido creado por cliente")],
    });

    await createOrderCreatedNotifications(order);
    res.json({ message: "Pedido creado", order: publicOrder(order, req.user) });
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
    addHistory(order, "asignado", "gestor", req.user, `Asignado a ${rep.name}`);
    await order.save();
    await createOrderAssignedNotifications(order, rep);

    res.json({ message: "Pedido asignado", order: publicOrder(order, req.user) });
  })
);

app.put(
  "/api/orders/:id/status",
  requireAuth,
  requireRole("repartidor"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const { status, lbs, deliveryProof, pickupProof } = req.body || {};
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

    if (!Object.values(ORDER_STATUS_TRANSITIONS).flat().includes(normalizedStatus)) {
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

    let normalizedPickupProof = null;
    if (normalizedStatus === "recogido al cliente") {
      const proofResult = normalizePickupProofInput(pickupProof, req.user, order);
      if (proofResult.error) {
        return res.status(400).json({ message: proofResult.error });
      }
      normalizedPickupProof = proofResult.value;
    }

    let normalizedDeliveryProof = null;
    if (normalizedStatus === "entregado al cliente") {
      const proofResult = normalizeDeliveryProofInput(deliveryProof, req.user, order);
      if (proofResult.error) {
        return res.status(400).json({ message: proofResult.error });
      }
      normalizedDeliveryProof = proofResult.value;
    }

    order.status = normalizedStatus;
    if (lbs !== undefined) {
      order.lbs = Number(lbs) || 0;
    }
    if (normalizedDeliveryProof) {
      order.deliveryProof = normalizedDeliveryProof;
    }
    if (normalizedPickupProof) {
      order.pickupProof = normalizedPickupProof;
    }

    addHistory(order, normalizedStatus, "repartidor", req.user, formatStatusTitle(normalizedStatus));
    await order.save();
    await sendOrderLifecycleNotification(order, normalizedStatus);
    await createOrderStatusNotifications(order, normalizedStatus);
    if (normalizedStatus === "entregado al cliente") {
      emailCampaigns.queueUser(order.userId, "referral");
    }

    res.json({ message: "Estado actualizado", order: publicOrder(order, req.user) });
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

    if (normalizeRequestedStatus(order.status) === "entregado al cliente" || normalizeRequestedStatus(order.status) === "cancelado") {
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
    addHistory(order, "cancelado", "cliente", req.user, "Cancelacion solicitada por cliente");
    await order.save();
    await createOrderCancelledNotifications(order);

    res.json({ message: "Pedido cancelado", order: publicOrder(order, req.user) });
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
      status: "recibido en local",
      repartidorId: null,
      repartidorName: null,
      lbs: Number(lbs) || 0,
      channel: "local",
      createdAt: now,
      history: [createHistoryEntry("recibido en local", req.user.role === "gestor" ? "gestor" : "cajera", req.user, "Pedido recibido directamente en el local")],
    });

    await sendOrderLifecycleNotification(order, "recibido en local");
    await createInternalNotification({
      key: buildOrderNotificationKey(order, "local-created", "gestor"),
      recipientRole: "gestor",
      orderId: order.id,
      orderChannel: order.channel,
      title: "Pedido local registrado",
      copy: `${order.userName || "Cliente"} fue recibido directamente en el local.`,
      meta: getOrderNotificationMeta(order),
      tone: "info",
      screen: "screenLocal",
      actionLabel: "Ver local",
      priority: 72,
    });
    await createOrderStatusNotifications(order, "recibido en local");

    res.json({ message: "Pedido local creado", order: publicOrder(order, req.user) });
  })
);

app.get(
  "/api/local-orders",
  requireAuth,
  requireRole("cajera", "gestor"),
  asyncHandler(async (req, res) => {
    const localOrders = await Order.find({ channel: "local" }).sort({ id: -1 }).lean();
    res.json(localOrders.map((order) => publicOrder(order, req.user)));
  })
);

app.put(
  "/api/local-orders/:id/status",
  requireAuth,
  requireRole("cajera", "gestor"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const { status, lbs, notes } = req.body || {};

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "El id del pedido no es valido." });
    }

    const order = await Order.findOne({ id: orderId });
    if (!order) return res.status(404).json({ message: "Pedido no encontrado" });

    const currentStatus = normalizeLocalWorkflowStatus(order.status, order.channel);
    const targetStatus = status
      ? normalizeLocalWorkflowStatus(status, order.channel)
      : currentStatus;

    const canOperateInLocal =
      order.channel === "local" ||
      currentStatus === "de camino al local" ||
      LOCAL_ORDER_STATUSES.has(currentStatus);

    if (!canOperateInLocal) {
      return res.status(400).json({ message: "Este pedido aun no esta disponible para operacion de local." });
    }

    if (!LOCAL_ORDER_STATUSES.has(targetStatus)) {
      return res.status(400).json({ message: "El estado solicitado no pertenece al flujo de local." });
    }

    if (!canTransitionLocalStatus(order, targetStatus)) {
      return res.status(400).json({
        message: `No puedes pasar de ${order.status} a ${targetStatus}.`,
      });
    }

    if (lbs !== undefined && (!Number.isFinite(Number(lbs)) || Number(lbs) < 0 || Number(lbs) > 500)) {
      return res.status(400).json({ message: "Las libras indicadas no son validas." });
    }

    if (notes !== undefined && !isValidTextField(notes, { min: 0, max: 500, required: false })) {
      return res.status(400).json({ message: "Las observaciones superan el limite permitido." });
    }

    const statusChanged = currentStatus !== targetStatus;
    order.status = targetStatus;
    if (lbs !== undefined) {
      order.lbs = Number(lbs) || 0;
    }
    if (notes !== undefined) {
      order.notes = asText(notes);
    }
    if (statusChanged) {
      addHistory(
        order,
        targetStatus,
        req.user.role === "gestor" ? "gestor" : "cajera",
        req.user,
        notes ? asText(notes).slice(0, 160) : "Movimiento actualizado en el local"
      );
    }

    await order.save();
    if (statusChanged) {
      await sendOrderLifecycleNotification(order, targetStatus);
      await createOrderStatusNotifications(order, targetStatus);
    }
    res.json({ message: "Pedido actualizado en local", order: publicOrder(order, req.user) });
  })
);

app.post(
  "/api/orders/:id/payment-report",
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
      return res.status(403).json({ message: "Solo puedes reportar pagos de tus propios pedidos." });
    }

    const currentStatus = normalizeRequestedStatus(order.status);
    if (currentStatus === "cancelado") {
      return res.status(400).json({ message: "No se puede reportar pago de un pedido cancelado." });
    }

    const currentPayment = order.payment?.toObject ? order.payment.toObject() : order.payment || {};
    const currentPaymentStatus = asText(currentPayment.status || "pendiente");
    if (currentPaymentStatus === "pagado" && Number(currentPayment.balance || 0) <= 0) {
      return res.status(400).json({ message: "Este pedido ya figura como pagado." });
    }

    const result = normalizeClientPaymentReportPayload(req.body || {}, order);
    if (result.error) return res.status(400).json({ message: result.error });

    order.payment = {
      ...currentPayment,
      ...result.value,
    };

    addHistory(
      order,
      "pago reportado",
      "cliente",
      req.user,
      `Pago reportado para verificacion: RD$ ${result.value.clientReportedAmount.toFixed(2)} por ${result.value.clientReportedMethod}`
    );

    await order.save();

    const notificationKeySuffix = Date.now();
    await Promise.all([
      createInternalNotification({
        key: buildOrderNotificationKey(order, `payment-report-${notificationKeySuffix}`, "cajera"),
        recipientRole: "cajera",
        orderId: order.id,
        orderChannel: order.channel,
        title: "Pago reportado por cliente",
        copy: `${order.userName || "Cliente"} envio una referencia para validar en caja.`,
        meta: getOrderNotificationMeta(order),
        tone: "warning",
        screen: "screenProduction",
        actionLabel: "Ver caja",
        priority: 97,
      }),
      createInternalNotification({
        key: buildOrderNotificationKey(order, `payment-report-${notificationKeySuffix}`, "gestor"),
        recipientRole: "gestor",
        orderId: order.id,
        orderChannel: order.channel,
        title: "Pago pendiente de validacion",
        copy: `${order.userName || "Cliente"} reporto un pago para el pedido #${order.id}.`,
        meta: getOrderNotificationMeta(order),
        tone: "warning",
        screen: order.channel === "local" ? "screenLocal" : "screenHome",
        actionLabel: "Revisar",
        priority: 95,
      }),
    ]);

    res.json({ message: "Pago enviado a verificacion", order: publicOrder(order, req.user) });
  })
);

app.put(
  "/api/orders/:id/payment",
  requireAuth,
  requireRole("cajera", "gestor"),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "El id del pedido no es valido." });
    }

    const order = await Order.findOne({ id: orderId });
    if (!order) return res.status(404).json({ message: "Pedido no encontrado" });

    if (req.user.role === "cajera") {
      const status = normalizeRequestedStatus(order.status);
      const canCashierCharge =
        order.channel === "local" ||
        LOCAL_OPERATION_STATUSES.includes(status) ||
        status === "entregado al cliente";
      if (!canCashierCharge) {
        return res.status(403).json({ message: "Caja solo puede registrar cobros de pedidos operables en local." });
      }
    }

    const result = normalizePaymentPayload(req.body || {}, order);
    if (result.error) return res.status(400).json({ message: result.error });

    const previousStatus = asText(order.payment?.status || "pendiente");
    order.payment = {
      ...(order.payment?.toObject ? order.payment.toObject() : order.payment || {}),
      ...result.value,
      registeredByUserId: Number(req.user.id),
      registeredByName: asText(req.user.name),
    };

    const paymentLabel = result.value.status === "pagado"
      ? "Pago completo"
      : result.value.status === "parcial"
        ? "Pago parcial"
        : "Pago pendiente";
    addHistory(
      order,
      previousStatus === "pendiente" ? "pago registrado" : "pago actualizado",
      req.user.role === "gestor" ? "gestor" : "cajera",
      req.user,
      `${paymentLabel}: RD$ ${result.value.amountPaid.toFixed(2)}${result.value.method ? ` por ${result.value.method}` : ""}`
    );

    await order.save();

    res.json({ message: "Pago registrado", order: publicOrder(order, req.user) });
  })
);

app.get(
  "/api/cash/summary",
  requireAuth,
  requireRole("cajera", "gestor"),
  asyncHandler(async (req, res) => {
    const { normalizedDate, start, end } = getCashCloseDateRange(req.query.date);
    const [orders, closes] = await Promise.all([
      Order.find({
        "payment.registeredAt": { $gte: start, $lt: end },
      }).sort({ id: -1 }).lean(),
      CashClose.find({ date: normalizedDate }).sort({ createdAt: -1 }).lean(),
    ]);

    res.json({
      date: normalizedDate,
      summary: buildCashCloseSummary(orders),
      orders: orders.map((order) => publicOrder(order, req.user)),
      closes,
    });
  })
);

app.post(
  "/api/cash/close",
  requireAuth,
  requireRole("cajera", "gestor"),
  asyncHandler(async (req, res) => {
    const { normalizedDate, start, end } = getCashCloseDateRange(req.body?.date);
    const notes = asText(req.body?.notes).slice(0, 240);

    if (!isValidTextField(notes, { min: 0, max: 240, required: false })) {
      return res.status(400).json({ message: "La nota del cierre es demasiado larga." });
    }

    const orders = await Order.find({
      "payment.registeredAt": { $gte: start, $lt: end },
    }).sort({ id: -1 }).lean();
    const summary = buildCashCloseSummary(orders);

    const close = await CashClose.create({
      date: normalizedDate,
      ...summary,
      notes,
      createdByUserId: Number(req.user.id),
      createdByName: asText(req.user.name),
    });

    res.json({
      message: "Cierre de caja registrado",
      date: normalizedDate,
      summary,
      close,
    });
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
    emailCampaigns: emailCampaigns.getStatus(),
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
  emailCampaigns.startScheduler();

  app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("No se pudo iniciar el backend con MongoDB:", error.message);
  process.exit(1);
});
