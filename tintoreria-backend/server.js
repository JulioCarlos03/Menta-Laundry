require("dotenv").config();

if (process.env.USE_LEGACY_DEMO_SERVER !== "true") {
  require("./server.mongodb");
} else {
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ============================================================
   DATOS EN MEMORIA
============================================================ */

// Usuarios iniciales: gestor, repartidores, cajera
let users = [
  {
    id: 1,
    name: "Admin Gestor",
    email: "admin@tintoreria.com",
    password: "admin123",
    role: "gestor",
  },

  // Repartidores
  {
    id: 200,
    name: "Repartidor Sur",
    email: "repartidor.sur@demo.com",
    password: "123456",
    role: "repartidor",
    zone: "Sur",
  },
  {
    id: 201,
    name: "Repartidor DN",
    email: "repartidor.dn@demo.com",
    password: "123456",
    role: "repartidor",
    zone: "Distrito Nacional",
  },

  // Cajera local
  {
    id: 900,
    name: "Cajera Local",
    email: "cajera@tintoreria.com",
    password: "cajera123",
    role: "cajera",
  },

  // Cliente inicial
  {
    id: 10,
    name: "Cliente Menta",
    email: "cliente@demo.com",
    password: "cliente123",
    role: "cliente",
  },
];

// Pedidos iniciales
let orders = [
  // ejemplo domicilio
  {
    id: 1,
    userId: 10,
    userName: "Cliente Menta",
    userEmail: "cliente@demo.com",
    phone: "829-448-7876",
    zone: "Distrito Nacional",
    address: "Isabel Aguiar",
    serviceType: "Recogida a domicilio",
    date: "2026-01-10",
    time: "10:30",
    pack: "Lavado + Planchado",
    packs: ["Lavado + Planchado"],
    pricingMode: "por_libra",
    selectedGarments: [],
    location: {
      lat: 18.48606,
      lng: -69.93121,
      accuracy: 24,
      source: "gps_seed",
      inferredZone: "Distrito Nacional",
      capturedAt: new Date().toISOString(),
    },
    extras: ["Quitar manchas difíciles"],
    notes: "Llamar al llegar",
    status: "pendiente",
    repartidorId: null,
    repartidorName: null,
    lbs: 0,
    channel: "domicilio",
    createdAt: new Date().toISOString(),
    history: [
      { status: "pendiente", by: "cliente", at: new Date().toISOString() },
    ],
  },
];

/* ============================================================
   INFO NEGOCIO
============================================================ */
const BUSINESS_INFO = {
  name: "Menta Laundry",
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
const DELIVERY_PROOF_METHODS = new Set(["cliente", "porteria", "recepcion", "familiar", "otro"]);
const DELIVERY_CODE_LENGTH = 6;
const LOCAL_ORDER_STATUSES = new Set([
  "recibido en local",
  "en tratamiento",
  "listo para entrega",
]);
const LOCAL_STATUS_TRANSITIONS = {
  "de camino al local": ["recibido en local"],
  "recibido en local": ["en tratamiento"],
  "en tratamiento": ["listo para entrega"],
};

/* ============================================================
   HELPERS
============================================================ */
function findUserByEmail(email) {
  return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
}

function publicUser(user) {
  const { password, ...safe } = user;
  return safe;
}

function nowISO() {
  return new Date().toISOString();
}

function addHistory(order, status, by) {
  if (!order.history) order.history = [];
  order.history.push({ status, by, at: nowISO() });
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

  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    source,
    inferredZone: inferredZone || null,
    capturedAt: String(location.capturedAt || nowISO()),
  };
}

function asText(value) {
  return String(value ?? "").trim();
}

function isValidTextField(value, { min = 1, max = 240, required = true } = {}) {
  const text = asText(value);
  if (!text) return !required;
  return text.length >= min && text.length <= max;
}

function normalizeRequestedStatus(value) {
  const status = asText(value).toLowerCase();
  if (status === "camino" || status === "en camino") return "en camino a entregar";
  if (status === "recibido") return "recogido al cliente";
  if (status === "entregado") return "entregado al cliente";
  return status;
}

function normalizeLocalWorkflowStatus(value, channel = "") {
  const status = asText(value).toLowerCase();
  if (!status) return "";
  if (status === "recibido") return "recibido en local";
  const normalized = normalizeRequestedStatus(status);
  if (channel === "local" && normalized === "recogido al cliente") return "recibido en local";
  return normalized;
}

function canTransitionLocalStatus(order, nextStatus) {
  const current = normalizeLocalWorkflowStatus(order?.status, order?.channel);
  const next = normalizeLocalWorkflowStatus(nextStatus, order?.channel);
  if (!current || !next) return false;
  if (current === next) return true;
  return (LOCAL_STATUS_TRANSITIONS[current] || []).includes(next);
}

function normalizeDeliveryCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, DELIVERY_CODE_LENGTH);
}

function buildDeliveryCode(order) {
  const createdAt = order?.createdAt ? new Date(order.createdAt) : null;
  const source = [
    order?.id || "",
    order?.userId || "",
    createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : "",
  ].join(":");
  const secret = process.env.DELIVERY_CODE_SECRET || process.env.JWT_SECRET || "legacy-demo-delivery-code";
  const digest = crypto.createHmac("sha256", secret).update(source).digest("hex");
  const codeNumber = Number.parseInt(digest.slice(0, 12), 16) % 10 ** DELIVERY_CODE_LENGTH;
  return String(codeNumber).padStart(DELIVERY_CODE_LENGTH, "0");
}

function buildPickupCode(order) {
  const createdAt = order?.createdAt ? new Date(order.createdAt) : null;
  const source = [
    "pickup",
    order?.id || "",
    order?.userId || "",
    createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : "",
  ].join(":");
  const secret = process.env.DELIVERY_CODE_SECRET || process.env.JWT_SECRET || "legacy-demo-delivery-code";
  const digest = crypto.createHmac("sha256", secret).update(source).digest("hex");
  const codeNumber = Number.parseInt(digest.slice(0, 12), 16) % 10 ** DELIVERY_CODE_LENGTH;
  return String(codeNumber).padStart(DELIVERY_CODE_LENGTH, "0");
}

function withDeliveryCode(order) {
  if (!order || order.channel !== "domicilio") return order;
  const status = normalizeRequestedStatus(order.status);
  if (["entregado al cliente", "cancelado"].includes(status)) {
    const { deliveryCode, pickupCode, ...safe } = order;
    return safe;
  }

  return {
    ...order,
    ...(["pendiente", "asignado", "en camino a recoger"].includes(status)
      ? { pickupCode: buildPickupCode(order) }
      : {}),
    deliveryCode: buildDeliveryCode(order),
  };
}

function normalizeDeliveryProofInput(input, order) {
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

  const verifiedAt = nowISO();

  return {
    value: {
      receiverName,
      deliveryMethod,
      note,
      deliveredAt: verifiedAt,
      byUserId: null,
      byName: "Repartidor",
      deliveryCodeVerified: true,
      deliveryCodeVerifiedAt: verifiedAt,
    },
  };
}

function normalizePickupProofInput(input, order) {
  const proof = input && typeof input === "object" ? input : {};
  const pickupCode = normalizeDeliveryCode(proof.pickupCode || proof.deliveryCode || proof.code);

  if (pickupCode.length !== DELIVERY_CODE_LENGTH) {
    return { error: "Indica el codigo de recogida de 6 digitos." };
  }

  if (pickupCode !== buildPickupCode(order)) {
    return { error: "El codigo de recogida no coincide con la cuenta del cliente." };
  }

  const verifiedAt = nowISO();

  return {
    value: {
      pickedUpAt: verifiedAt,
      byUserId: null,
      byName: "Repartidor",
      pickupCodeVerified: true,
      pickupCodeVerifiedAt: verifiedAt,
    },
  };
}

/* ============================================================
   AUTH
============================================================ */
app.post("/api/register", (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ message: "Faltan datos." });
  }

  if (findUserByEmail(email)) {
    return res.status(400).json({ message: "Ese correo ya está registrado." });
  }

  const newUser = {
    id: users.length ? Math.max(...users.map((u) => u.id)) + 1 : 1,
    name,
    email,
    password,
    role: "cliente",
  };

  users.push(newUser);
  res.json({ message: "Cuenta creada", user: publicUser(newUser) });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};

  const user = findUserByEmail(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ message: "Credenciales incorrectas." });
  }

  res.json({ message: "Login ok", user: publicUser(user) });
});

/* ============================================================
   REPARTIDORES
============================================================ */
app.get("/api/repartidores", (req, res) => {
  const reps = users
    .filter((u) => u.role === "repartidor")
    .map((u) => publicUser(u));
  res.json(reps);
});

/* ============================================================
   PEDIDOS (DOMICILIO)
============================================================ */

// Listar pedidos
app.get("/api/orders", (req, res) => {
  res.json(orders.map(withDeliveryCode));
});

// Crear pedido domicilio (cliente)
app.post("/api/orders", (req, res) => {
  const body = req.body || {};

  const {
    userId,
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

  if (!userId || !address || !zone || !date || !time || !normalizedPacks.length) {
    return res.status(400).json({ message: "Faltan datos obligatorios." });
  }

  if (
    (normalizedPricingMode === "por_prendas" || normalizedPricingMode === "mixto") &&
    !normalizedGarments.length
  ) {
    return res.status(400).json({
      message: "Debes seleccionar al menos una prenda para ese tipo de servicio.",
    });
  }

  const user = users.find((u) => u.id === userId);
  if (!user) return res.status(400).json({ message: "Usuario no válido." });

  const newOrder = {
    id: orders.length ? Math.max(...orders.map((o) => o.id)) + 1 : 1,
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    phone: phone || "",
    zone,
    address,
    serviceType: serviceType || "Recogida a domicilio",
    date,
    time,
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
    createdAt: nowISO(),
    history: [{ status: "pendiente", by: "cliente", at: nowISO() }],
  };

  orders.push(newOrder);
  res.json({ message: "Pedido creado", order: withDeliveryCode(newOrder) });
});

// Asignar pedido a repartidor (gestor)
app.put("/api/orders/:id/assign", (req, res) => {
  const orderId = Number(req.params.id);
  const { repartidorId } = req.body || {};

  const order = orders.find((o) => o.id === orderId);
  if (!order) return res.status(404).json({ message: "Pedido no encontrado" });

  const rep = users.find((u) => u.id === Number(repartidorId) && u.role === "repartidor");
  if (!rep) return res.status(400).json({ message: "Repartidor no válido" });

  order.repartidorId = rep.id;
  order.repartidorName = rep.name;
  order.status = "asignado";
  addHistory(order, "asignado", "gestor");

  res.json({ message: "Pedido asignado", order: withDeliveryCode(order) });
});

// Cambiar estado + lbs (repartidor)
app.put("/api/orders/:id/status", (req, res) => {
  const orderId = Number(req.params.id);
  const { status, lbs, deliveryProof, pickupProof } = req.body || {};
  const normalizedStatus = normalizeRequestedStatus(status);

  const order = orders.find((o) => o.id === orderId);
  if (!order) return res.status(404).json({ message: "Pedido no encontrado" });

  if (!status) return res.status(400).json({ message: "Falta el estado" });

  let normalizedPickupProof = null;
  if (normalizedStatus === "recogido al cliente") {
    const proofResult = normalizePickupProofInput(pickupProof, order);
    if (proofResult.error) {
      return res.status(400).json({ message: proofResult.error });
    }
    normalizedPickupProof = proofResult.value;
  }

  let normalizedDeliveryProof = null;
  if (normalizedStatus === "entregado al cliente") {
    const proofResult = normalizeDeliveryProofInput(deliveryProof, order);
    if (proofResult.error) {
      return res.status(400).json({ message: proofResult.error });
    }
    normalizedDeliveryProof = proofResult.value;
  }

  order.status = normalizedStatus;

  // si rep pone lbs (para factura), guardarlo
  if (lbs !== undefined) {
    order.lbs = Number(lbs) || 0;
  }
  if (normalizedDeliveryProof) {
    order.deliveryProof = normalizedDeliveryProof;
  }
  if (normalizedPickupProof) {
    order.pickupProof = normalizedPickupProof;
  }

  addHistory(order, normalizedStatus, "repartidor");

  res.json({ message: "Estado actualizado", order: withDeliveryCode(order) });
});

// Cancelar pedido (cliente) SOLO 5 min
app.put("/api/orders/:id/cancel", (req, res) => {
  const orderId = Number(req.params.id);

  const order = orders.find((o) => o.id === orderId);
  if (!order) return res.status(404).json({ message: "Pedido no encontrado" });

  if (normalizeRequestedStatus(order.status) === "entregado al cliente" || normalizeRequestedStatus(order.status) === "cancelado") {
    return res.status(400).json({ message: "No se puede cancelar este pedido." });
  }

  const createdAt = new Date(order.createdAt).getTime();
  const diffMs = Date.now() - createdAt;

  if (diffMs > 5 * 60 * 1000) {
    return res.status(400).json({
      message: "Ya pasaron más de 5 minutos, el pedido no se puede cancelar.",
    });
  }

  order.status = "cancelado";
  addHistory(order, "cancelado", "cliente");

  res.json({ message: "Pedido cancelado", order: withDeliveryCode(order) });
});

/* ============================================================
   PEDIDOS EN LOCAL (CAJERA)
============================================================ */

// Crear pedido en local
app.post("/api/local-orders", (req, res) => {
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

  if (!customerName || !customerPhone || !lbs || !pack) {
    return res.status(400).json({
      message: "Faltan datos obligatorios (nombre, teléfono, libras, paquete).",
    });
  }

  const newOrder = {
    id: orders.length ? Math.max(...orders.map((o) => o.id)) + 1 : 1,
    userId: null,
    userName: customerName,
    userEmail: customerEmail || "",
    phone: customerPhone,
    zone: zone || "Distrito Nacional",
    address: address || "Entrega en local",
    serviceType: "Entrega en local",
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" }),
    pack,
    packs: [pack],
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
    createdAt: nowISO(),
    history: [{ status: "recibido en local", by: "cajera", at: nowISO() }],
  };

  orders.push(newOrder);

  res.json({ message: "Pedido local creado", order: newOrder });
});

// Listar pedidos del local (para gestor)
app.get("/api/local-orders", (req, res) => {
  const localOrders = orders.filter((o) => o.channel === "local");
  res.json(localOrders);
});

app.put("/api/local-orders/:id/status", (req, res) => {
  const orderId = Number(req.params.id);
  const { status, lbs, notes } = req.body || {};
  const order = orders.find((o) => Number(o.id) === orderId);

  if (!order) return res.status(404).json({ message: "Pedido no encontrado" });

  const currentStatus = normalizeLocalWorkflowStatus(order.status, order.channel);
  const targetStatus = status ? normalizeLocalWorkflowStatus(status, order.channel) : currentStatus;
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
    return res.status(400).json({ message: `No puedes pasar de ${order.status} a ${targetStatus}.` });
  }

  if (lbs !== undefined && (!Number.isFinite(Number(lbs)) || Number(lbs) < 0 || Number(lbs) > 500)) {
    return res.status(400).json({ message: "Las libras indicadas no son validas." });
  }

  if (notes !== undefined && !isValidTextField(notes, { min: 0, max: 500, required: false })) {
    return res.status(400).json({ message: "Las observaciones superan el limite permitido." });
  }

  const statusChanged = currentStatus !== targetStatus;
  order.status = targetStatus;
  if (lbs !== undefined) order.lbs = Number(lbs) || 0;
  if (notes !== undefined) order.notes = asText(notes);
  if (statusChanged) addHistory(order, targetStatus, "cajera");

  res.json({ message: "Pedido actualizado en local", order });
});

/* ============================================================
   FACTURA INFO
============================================================ */
app.get("/api/business-info", (req, res) => {
  res.json(BUSINESS_INFO);
});

/* ============================================================
   HEALTH
============================================================ */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "API running", port: PORT });
});

/* ============================================================
   START
============================================================ */
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
}
