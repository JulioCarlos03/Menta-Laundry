/* ============================================================
   CONFIG
============================================================ */
const DEFAULT_LOCAL_API_BASE = "http://localhost:3000/api";
const DEFAULT_DEPLOYED_API_BASE = "https://api.mentalaundry.com/api";

function normalizeApiBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function resolveApiBase() {
  const url = new URL(window.location.href);
  const urlOverride = normalizeApiBase(url.searchParams.get("apiBase"));
  const configOverride = normalizeApiBase(window.__MENTA_CONFIG__?.apiBase);
  const metaOverride = normalizeApiBase(
    document.querySelector('meta[name="menta-api-base"]')?.getAttribute("content")
  );
  const storedOverride = normalizeApiBase(localStorage.getItem("menta_api_base"));
  const hostname = String(window.location.hostname || "").toLowerCase();
  const isLocalHost = ["localhost", "127.0.0.1"].includes(hostname);

  if (urlOverride) {
    localStorage.setItem("menta_api_base", urlOverride);
    return urlOverride;
  }

  if (configOverride) return configOverride;
  if (metaOverride) return metaOverride;
  if (storedOverride) return storedOverride;
  return isLocalHost ? DEFAULT_LOCAL_API_BASE : DEFAULT_DEPLOYED_API_BASE;
}

const API_BASE = resolveApiBase();

let currentUser = null;
let ordersCache = [];
let repartidoresCache = [];
let localOrdersCache = [];
let homeLocation = null;
let homePickupLeafletMap = null;
let homePickupLeafletMarker = null;
let homePickupLeafletAccuracy = null;
let riderLocation = null;
let gestorZoneFilter = "all";
let clientActivityFilter = "all";
const operationalHistoryFilters = {
  query: "",
  status: "all",
  source: "all",
  zone: "all",
  rider: "all",
  date: "all",
};
let backendWarmPromise = null;
let backendWarmAt = 0;
let autoRefreshTimer = null;
let autoRefreshInFlight = false;
let lastAutoRefreshAt = 0;
let dashboardDataVersion = 0;
let appEntryVisibleAt = 0;
const screenRenderVersions = new Map();
const dashboardResourceState = {
  localOrdersLoaded: false,
};
const AUTO_REFRESH_INTERVAL_MS = 10000;
const AUTO_REFRESH_FOCUS_THROTTLE_MS = 7000;
const ORDER_WIZARD_STEPS = [
  {
    key: "service",
    kicker: "Paso 1",
    label: "Servicio y prendas",
    copy: "Elige el tipo de servicio, los paquetes principales y como se calculara el pedido.",
  },
  {
    key: "location",
    kicker: "Paso 2",
    label: "Ubicacion y horario",
    copy: "Define la direccion, confirma el GPS obligatorio y deja la agenda lista para la recogida.",
  },
  {
    key: "review",
    kicker: "Paso 3",
    label: "Resumen y confirmacion",
    copy: "Revisa el estimado, agrega notas utiles y confirma la solicitud final.",
  },
];
let currentOrderWizardStep = 0;

/* ============================================================
   DOM HELPERS
============================================================ */
const qs = (s) => document.querySelector(s);
const qsa = (s) => Array.from(document.querySelectorAll(s));

function show(el) { if (el) el.style.display = ""; }
function hide(el) { if (el) el.style.display = "none"; }

const USER_STORAGE_KEY = "tintouser";
const TOKEN_STORAGE_KEY = "tintotoken";
const THEME_STORAGE_KEY = "tintotheme";
const RIDER_LOCATION_STORAGE_KEY = "tinto_rider_location";
const GESTOR_ZONE_FILTER_STORAGE_KEY = "tinto_gestor_zone_filter";
const pendingNotices = [];
let noticeSequence = 0;

function inferNoticeTone(message) {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return "info";

  const errorSignals = [
    "error",
    "no se pudo",
    "no pudimos",
    "no fue posible",
    "no encontrado",
    "inval",
    "incorrect",
    "fall",
    "expir",
    "permiso denegado",
  ];
  if (errorSignals.some((signal) => text.includes(signal))) return "error";

  const warningSignals = [
    "selecciona",
    "elige",
    "no hay",
    "no puedes",
    "no soporta",
    "necesitamos permiso",
    "intenta otra vez",
    "pendiente",
  ];
  if (warningSignals.some((signal) => text.includes(signal))) return "warning";

  const successSignals = [
    "cread",
    "asignad",
    "guardad",
    "copiad",
    "cancelad",
    "actualizad",
    "completad",
    "inicia sesion",
    "listo",
  ];
  if (successSignals.some((signal) => text.includes(signal))) return "success";

  return "info";
}

function noticeToneMeta(tone) {
  const map = {
    success: { tone: "success", title: "Listo", icon: "OK" },
    error: { tone: "error", title: "Atencion", icon: "ER" },
    warning: { tone: "warning", title: "Revisar", icon: "AV" },
    info: { tone: "info", title: "Aviso", icon: "IN" },
  };
  return map[tone] || map.info;
}

function ensureNoticeStack() {
  if (!document.body) return null;

  let stack = qs("#noticeStack");
  if (stack) return stack;

  stack = document.createElement("div");
  stack.id = "noticeStack";
  stack.className = "notice-stack";
  stack.setAttribute("aria-live", "polite");
  stack.setAttribute("aria-atomic", "false");
  document.body.appendChild(stack);
  return stack;
}

function closeNotice(notice) {
  if (!notice || notice.dataset.closing === "1") return;

  notice.dataset.closing = "1";
  notice.classList.remove("notice-show");
  notice.classList.add("notice-hide");
  window.setTimeout(() => notice.remove(), 220);
}

function showNotice(message, tone = "info", timeout = 3600) {
  const text = String(message || "").trim();
  if (!text) return null;

  if (!document.body) {
    pendingNotices.push({ message: text, tone, timeout });
    return null;
  }

  const stack = ensureNoticeStack();
  if (!stack) {
    pendingNotices.push({ message: text, tone, timeout });
    return null;
  }

  const meta = noticeToneMeta(tone);
  const notice = document.createElement("div");
  notice.className = `notice notice-${meta.tone}`;
  notice.dataset.noticeId = String(++noticeSequence);
  notice.setAttribute("role", meta.tone === "error" ? "alert" : "status");
  notice.innerHTML = `
    <div class="notice-accent" aria-hidden="true"></div>
    <div class="notice-icon" aria-hidden="true">${meta.icon}</div>
    <div class="notice-body">
      <div class="notice-title">${meta.title}</div>
      <div class="notice-copy">${escapeHtml(text)}</div>
    </div>
    <button type="button" class="notice-close" aria-label="Cerrar aviso">&#215;</button>
  `;

  notice.querySelector(".notice-close")?.addEventListener("click", () => closeNotice(notice));
  stack.prepend(notice);

  window.requestAnimationFrame(() => {
    notice.classList.add("notice-show");
  });

  Array.from(stack.children)
    .slice(4)
    .forEach((item) => closeNotice(item));

  if (timeout > 0) {
    window.setTimeout(() => closeNotice(notice), timeout);
  }

  return notice;
}

function flushPendingNotices() {
  if (!document.body || !pendingNotices.length) return;
  pendingNotices.splice(0).forEach((item) => {
    showNotice(item.message, item.tone, item.timeout);
  });
}

function showSuccess(message, timeout = 3200) {
  return showNotice(message, "success", timeout);
}

function showError(message, timeout = 4200) {
  return showNotice(message, "error", timeout);
}

function showWarning(message, timeout = 4200) {
  return showNotice(message, "warning", timeout);
}

function showInfo(message, timeout = 3600) {
  return showNotice(message, "info", timeout);
}

let authActionState = {
  mode: null,
  token: "",
  email: "",
};

function setInlineMessage(target, message, tone = "error", { html = false } = {}) {
  const node = typeof target === "string" ? qs(target) : target;
  if (!node) return;

  node.classList.remove(
    "auth-message-error",
    "auth-message-success",
    "auth-message-info",
    "auth-message-warning"
  );
  node.classList.add(`auth-message-${tone}`);
  if (html) {
    node.innerHTML = message;
  } else {
    node.textContent = String(message || "");
  }
  node.style.display = "block";
}

function clearInlineMessage(target) {
  const node = typeof target === "string" ? qs(target) : target;
  if (!node) return;
  node.style.display = "none";
  node.textContent = "";
  node.classList.remove(
    "auth-message-error",
    "auth-message-success",
    "auth-message-info",
    "auth-message-warning"
  );
}

function buildAuthResponseHtml(response, fallbackMessage) {
  const mainMessage = escapeHtml(fallbackMessage || response?.message || "");
  const actionUrl = String(response?.debugActionUrl || "").trim();
  if (!actionUrl) return mainMessage;

  return `
    ${mainMessage}<br>
    <a class="auth-inline-url" href="${escapeHtml(actionUrl)}">Abrir enlace de prueba</a>
  `;
}

function isEmailDeliveryIssue(payload) {
  const text = [payload?.code, payload?.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("email_delivery_failed") ||
    text.includes("email_auth_failed") ||
    text.includes("535") ||
    text.includes("invalid login") ||
    text.includes("authentication failed")
  );
}

function getFriendlyAuthMessage(payload, fallbackMessage) {
  const message = String(payload?.message || "").trim();
  if (isEmailDeliveryIssue(payload)) {
    return (
      message ||
      "No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos o contacta soporte."
    );
  }

  return message || fallbackMessage;
}

function ensureAuthSupportBlocks() {
  const authCard = qs("#authView .auth-card");
  const loginForm = qs("#loginForm");
  if (!authCard || !loginForm) return;

  if (!qs("#authQuickLinks")) {
    const links = document.createElement("div");
    links.id = "authQuickLinks";
    links.className = "auth-inline-actions";
    links.innerHTML = `
      <button id="showForgotPasswordBtn" class="auth-inline-btn" type="button">Olvide mi contrasena</button>
      <button id="showResendVerificationBtn" class="auth-inline-btn" type="button">Reenviar verificacion</button>
    `;
    loginForm.insertAdjacentElement("afterend", links);
  }

  if (!qs("#authActionPanel")) {
    const panel = document.createElement("section");
    panel.id = "authActionPanel";
    panel.className = "auth-action-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="auth-action-header">
        <div>
          <div id="authActionEyebrow" class="auth-action-eyebrow">Acceso</div>
          <h3 id="authActionTitle" class="auth-action-title">Gestiona tu cuenta</h3>
          <p id="authActionCopy" class="auth-action-copy"></p>
        </div>
        <button id="authActionCloseBtn" class="auth-action-close" type="button" aria-label="Cerrar panel">&#215;</button>
      </div>
      <div id="authActionMessage" class="auth-message auth-message-info" style="display:none;"></div>
      <form id="authActionForm" class="auth-form">
        <div id="authActionFields" class="auth-action-fields"></div>
        <div class="auth-action-buttons">
          <button id="authActionSubmit" class="btn btn-primary" type="submit">Continuar</button>
        </div>
      </form>
    `;
    authCard.appendChild(panel);
  }
}

function closeAuthActionPanel() {
  const panel = qs("#authActionPanel");
  if (panel) hide(panel);
  clearInlineMessage("#authActionMessage");
  authActionState = { mode: null, token: "", email: "" };
}

function openAuthActionPanel(mode, context = {}) {
  ensureAuthSupportBlocks();

  const panel = qs("#authActionPanel");
  const eyebrow = qs("#authActionEyebrow");
  const title = qs("#authActionTitle");
  const copy = qs("#authActionCopy");
  const fields = qs("#authActionFields");
  const submit = qs("#authActionSubmit");
  const message = qs("#authActionMessage");
  if (!panel || !eyebrow || !title || !copy || !fields || !submit || !message) return;

  authActionState = {
    mode,
    token: String(context.token || ""),
    email: String(context.email || ""),
  };

  clearInlineMessage(message);

  if (mode === "forgot") {
    eyebrow.textContent = "Recuperacion";
    title.textContent = "Restablecer contrasena";
    copy.textContent = "Te enviaremos un enlace para crear una nueva contrasena.";
    submit.textContent = "Enviar enlace";
    fields.innerHTML = `
      <div class="field-group">
        <label>Correo electronico</label>
        <input id="authActionEmail" type="email" placeholder="correo@ejemplo.com" value="${escapeHtml(authActionState.email)}" required />
      </div>
    `;
  } else if (mode === "resend") {
    eyebrow.textContent = "Verificacion";
    title.textContent = "Reenviar correo";
    copy.textContent = "Si tu cuenta aun no esta activa, te mandaremos un nuevo enlace de verificacion.";
    submit.textContent = "Reenviar correo";
    fields.innerHTML = `
      <div class="field-group">
        <label>Correo electronico</label>
        <input id="authActionEmail" type="email" placeholder="correo@ejemplo.com" value="${escapeHtml(authActionState.email)}" required />
      </div>
    `;
  } else if (mode === "reset") {
    eyebrow.textContent = "Nueva contrasena";
    title.textContent = "Crear una contrasena nueva";
    copy.textContent = "Elige una contrasena segura para volver a entrar a tu cuenta.";
    submit.textContent = "Guardar contrasena";
    fields.innerHTML = `
      <div class="field-group">
        <label>Nueva contrasena</label>
        <input id="authActionPassword" type="password" placeholder="Minimo 6 caracteres" required />
      </div>
      <div class="field-group">
        <label>Confirmar contrasena</label>
        <input id="authActionPasswordConfirm" type="password" placeholder="Repite la contrasena" required />
      </div>
    `;
  } else {
    return;
  }

  show(panel);
  window.requestAnimationFrame(() => {
    panel.querySelector("input")?.focus();
  });
}

async function handleAuthActionSubmit(e) {
  e.preventDefault();

  const message = qs("#authActionMessage");
  clearInlineMessage(message);

  try {
    if (authActionState.mode === "forgot") {
      const email = qs("#authActionEmail")?.value.trim() || "";
      const data = await requestPasswordReset(email);
      const tone = data?.emailDeliveryFailed ? "warning" : "success";
      setInlineMessage(message, buildAuthResponseHtml(data, data.message), tone, { html: true });
      if (data?.emailDeliveryFailed) {
        showWarning(getFriendlyAuthMessage(data, "No pudimos enviar el correo ahora mismo."));
      } else {
        showSuccess("Solicitud enviada. Revisa tu correo.");
      }
      return;
    }

    if (authActionState.mode === "resend") {
      const email = qs("#authActionEmail")?.value.trim() || "";
      const data = await resendVerification(email);
      const tone = data?.emailDeliveryFailed ? "warning" : "success";
      setInlineMessage(message, buildAuthResponseHtml(data, data.message), tone, { html: true });
      if (data?.emailDeliveryFailed) {
        showWarning(getFriendlyAuthMessage(data, "No pudimos enviar el correo ahora mismo."));
      } else {
        showSuccess("Correo de verificacion procesado.");
      }
      return;
    }

    if (authActionState.mode === "reset") {
      const nextPassword = qs("#authActionPassword")?.value || "";
      const confirmPassword = qs("#authActionPasswordConfirm")?.value || "";
      if (nextPassword.length < 6) {
        setInlineMessage(message, "La contrasena debe tener al menos 6 caracteres.", "warning");
        return;
      }
      if (nextPassword !== confirmPassword) {
        setInlineMessage(message, "Las contrasenas no coinciden.", "warning");
        return;
      }

      const email = authActionState.email;
      const data = await resetPassword(authActionState.token, nextPassword);
      closeAuthActionPanel();
      if (email) qs("#loginEmail").value = email;
      setInlineMessage("#loginMessage", data.message || "Contrasena actualizada.", "success");
      showSuccess(data.message || "Contrasena actualizada.");
    }
  } catch (err) {
    const friendlyMessage = getFriendlyAuthMessage(err, "No pudimos completar esta accion.");
    setInlineMessage(message, friendlyMessage, isEmailDeliveryIssue(err) ? "warning" : "error");
  }
}

function clearAuthLinkParams() {
  const url = new URL(window.location.href);
  ["verify", "reset", "token", "email"].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", url.toString());
}

function readAuthLinkState() {
  const url = new URL(window.location.href);
  return {
    verify: url.searchParams.get("verify") === "1",
    reset: url.searchParams.get("reset") === "1",
    token: String(url.searchParams.get("token") || ""),
    email: String(url.searchParams.get("email") || ""),
  };
}

async function handleAuthLinkState() {
  const state = readAuthLinkState();
  if (!state.token || (!state.verify && !state.reset)) return false;

  clearSession();
  show(qs("#authView"));
  hide(qs("#appView"));
  syncSessionChrome();

  try {
    if (state.verify) {
      const data = await verifyEmailToken(state.token);
      if (state.email) qs("#loginEmail").value = state.email;
      setInlineMessage("#loginMessage", data.message || "Correo verificado correctamente.", "success");
      showSuccess(data.message || "Correo verificado correctamente.");
    } else if (state.reset) {
      if (state.email) qs("#loginEmail").value = state.email;
      openAuthActionPanel("reset", { token: state.token, email: state.email });
      setInlineMessage("#loginMessage", "Crea tu nueva contrasena para terminar el proceso.", "info");
      showInfo("Listo para crear una nueva contrasena.");
    }
  } catch (err) {
    setInlineMessage("#loginMessage", err.message || "No pudimos procesar el enlace.", "error");
    showError(err.message || "No pudimos procesar el enlace.");
  } finally {
    clearAuthLinkParams();
  }

  return true;
}

let activeConfirmResolver = null;
let activeDeliveryProofResolver = null;

function ensureConfirmDialog() {
  if (!document.body) return null;

  let dialog = qs("#confirmDialog");
  if (dialog) return dialog;

  dialog = document.createElement("div");
  dialog.id = "confirmDialog";
  dialog.className = "confirm-dialog-overlay";
  dialog.setAttribute("aria-hidden", "true");
  dialog.innerHTML = `
    <div class="confirm-dialog-backdrop" data-confirm-action="cancel"></div>
    <div class="confirm-dialog-card" role="dialog" aria-modal="true" aria-labelledby="confirmDialogTitle">
      <div class="confirm-dialog-eyebrow">Confirmacion</div>
      <h3 id="confirmDialogTitle" class="confirm-dialog-title">Confirmar accion</h3>
      <p id="confirmDialogCopy" class="confirm-dialog-copy"></p>
      <div class="confirm-dialog-actions">
        <button type="button" class="confirm-dialog-btn confirm-dialog-btn-secondary" data-confirm-action="cancel">Volver</button>
        <button type="button" class="confirm-dialog-btn confirm-dialog-btn-primary" data-confirm-action="confirm">Confirmar</button>
      </div>
    </div>
  `;

  dialog.querySelectorAll("[data-confirm-action='cancel']").forEach((node) => {
    node.addEventListener("click", () => closeConfirmDialog(false));
  });
  dialog.querySelector("[data-confirm-action='confirm']")?.addEventListener("click", () => closeConfirmDialog(true));
  document.body.appendChild(dialog);
  return dialog;
}

function closeConfirmDialog(result = false) {
  const dialog = qs("#confirmDialog");
  const resolver = activeConfirmResolver;
  activeConfirmResolver = null;

  if (dialog) {
    dialog.classList.remove("confirm-dialog-visible");
    dialog.setAttribute("aria-hidden", "true");
  }

  document.body?.classList.remove("dialog-open");
  if (resolver) resolver(result);
}

function showConfirmDialog(message, options = {}) {
  if (!document.body) return Promise.resolve(window.confirm(message));

  const dialog = ensureConfirmDialog();
  if (!dialog) return Promise.resolve(window.confirm(message));

  if (activeConfirmResolver) {
    activeConfirmResolver(false);
    activeConfirmResolver = null;
  }

  const title = dialog.querySelector("#confirmDialogTitle");
  const copy = dialog.querySelector("#confirmDialogCopy");
  const cancelBtn = dialog.querySelector("[data-confirm-action='cancel'].confirm-dialog-btn");
  const confirmBtn = dialog.querySelector("[data-confirm-action='confirm']");

  if (title) title.textContent = options.title || "Confirmar accion";
  if (copy) copy.textContent = String(message || "");
  if (cancelBtn) cancelBtn.textContent = options.cancelLabel || "Volver";
  if (confirmBtn) confirmBtn.textContent = options.confirmLabel || "Confirmar";

  dialog.classList.add("confirm-dialog-visible");
  dialog.setAttribute("aria-hidden", "false");
  document.body.classList.add("dialog-open");

  window.requestAnimationFrame(() => {
    confirmBtn?.focus();
  });

  return new Promise((resolve) => {
    activeConfirmResolver = resolve;
  });
}

const DELIVERY_METHOD_LABELS = {
  cliente: "Cliente",
  porteria: "Porteria",
  recepcion: "Recepcion",
  familiar: "Familiar",
  otro: "Otro",
};

function formatDeliveryMethodLabel(method) {
  const key = String(method || "").trim().toLowerCase();
  return DELIVERY_METHOD_LABELS[key] || "Entrega validada";
}

function getDeliveryProof(order) {
  const proof = order?.deliveryProof;
  if (!proof || typeof proof !== "object") return null;

  const receiverName = String(proof.receiverName || proof.receivedBy || "").trim();
  const deliveryMethod = String(proof.deliveryMethod || proof.method || "").trim();
  const note = String(proof.note || "").trim();
  const deliveredAt = proof.deliveredAt || proof.at || "";
  const byName = String(proof.byName || "").trim();
  const deliveryCodeVerified = Boolean(proof.deliveryCodeVerified);

  if (!receiverName && !deliveryMethod && !note && !deliveredAt) return null;
  return { receiverName, deliveryMethod, note, deliveredAt, byName, deliveryCodeVerified };
}

function formatDeliveryProofDate(proof) {
  if (!proof?.deliveredAt) return "Sin hora registrada";
  return [fmtDate(proof.deliveredAt), fmtTime(proof.deliveredAt)].filter(Boolean).join(" ");
}

function getDeliveryCode(order) {
  const code = String(order?.deliveryCode || "").replace(/\D/g, "");
  if (currentUser?.role !== "cliente") return "";
  if (isClosedOrderStatus(order?.status)) return "";
  return code.length === 6 ? code : "";
}

function getPickupCode(order) {
  const code = String(order?.pickupCode || "").replace(/\D/g, "");
  const status = normalizeStatusValue(order?.status);
  if (currentUser?.role !== "cliente") return "";
  if (isClosedOrderStatus(status)) return "";
  if (!["pendiente", "asignado", "en camino a recoger"].includes(status)) return "";
  return code.length === 6 ? code : "";
}

function renderRouteCodeDigits(code) {
  return code.split("").map((digit) => `<b>${digit}</b>`).join("");
}

function renderDeliveryCodeCard(order, options = {}) {
  const codes = [
    {
      code: getPickupCode(order),
      title: "PIN de recogida",
      copy: "Compartelo solo cuando entregues la ropa al repartidor.",
      className: "delivery-code-card-pickup",
    },
    {
      code: getDeliveryCode(order),
      title: "PIN de entrega",
      copy: "Compartelo cuando recibas tus prendas limpias.",
      className: "delivery-code-card-final",
    },
  ].filter((item) => item.code);

  if (!codes.length) return "";

  const compactClass = options.compact ? " delivery-code-card-compact" : "";
  const stackClass = codes.length > 1 ? " delivery-code-card-stack" : "";
  return `
    <div class="delivery-code-cards${compactClass}${stackClass}">
      ${codes.map((item) => `
        <div class="delivery-code-card ${item.className}">
          <div>
            <span>${escapeHtml(options.title || item.title)}</span>
            <strong>${renderRouteCodeDigits(item.code)}</strong>
          </div>
          <small>${escapeHtml(item.copy)} El repartidor no puede avanzar ese paso sin este PIN.</small>
        </div>
      `).join("")}
    </div>
  `;
}

const CLIENT_TRACKING_STEPS = [
  {
    key: "pendiente",
    label: "Solicitud",
    icon: "receipt",
    emoji: "🧾",
    title: "Solicitud recibida",
    copy: "Tu servicio ya esta en la bandeja de Menta Laundry.",
    scene: "paper",
  },
  {
    key: "asignado",
    label: "Asignado",
    icon: "agent",
    emoji: "🧑‍💼",
    title: "Agente asignado",
    copy: "Un agente ya coordina tu servicio y prepara la ruta.",
    scene: "agent",
  },
  {
    key: "en camino a recoger",
    label: "A recoger",
    icon: "truck",
    emoji: "🚚",
    title: "En camino al cliente",
    copy: "La guaguita va hacia tu direccion para recoger las prendas.",
    scene: "truck",
  },
  {
    key: "recogido al cliente",
    label: "Recogido",
    icon: "check",
    emoji: "🚚✅",
    title: "Ropa recogida",
    copy: "Tus prendas ya fueron recibidas por el equipo de ruta.",
    scene: "truck-check",
  },
  {
    key: "de camino al local",
    label: "Al local",
    icon: "truck",
    emoji: "🚚",
    title: "De camino al local",
    copy: "La ropa va camino al local para iniciar el proceso.",
    scene: "truck",
  },
  {
    key: "recibido en local",
    label: "En local",
    icon: "shop",
    emoji: "🏪",
    title: "Recibido en local",
    copy: "El equipo de Menta Laundry ya recibio las prendas.",
    scene: "shop",
  },
  {
    key: "en tratamiento",
    label: "Tratamiento",
    icon: "wash",
    emoji: "🧺✨",
    title: "En tratamiento textil",
    copy: "Lavado, planchado o cuidado especial en proceso.",
    scene: "wash",
  },
  {
    key: "listo para entrega",
    label: "Listo",
    icon: "ready",
    emoji: "🏪✨",
    title: "Listo para entrega",
    copy: "Tus prendas estan listas para salir nuevamente.",
    scene: "shop-ready",
  },
  {
    key: "en camino a entregar",
    label: "En entrega",
    icon: "truck",
    emoji: "🚚",
    title: "En camino al cliente",
    copy: "La guaguita va de regreso con tu pedido.",
    scene: "truck",
  },
  {
    key: "entregado al cliente",
    label: "Entregado",
    icon: "happy",
    emoji: "😊",
    title: "Entregado al cliente",
    copy: "Servicio completado. Gracias por confiar en Menta Laundry.",
    scene: "happy",
  },
];

const TRACKING_STEP_ICONS = {
  receipt: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10a2 2 0 0 1 2 2v16l-3-1.7-2 1.1-2-1.1-2 1.1-2-1.1L5 21V5a2 2 0 0 1 2-2Z"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4.5"/></svg>`,
  agent: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M5 21a7 7 0 0 1 14 0"/><path d="M9 14.5 12 18l3-3.5"/></svg>`,
  truck: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h11v9H3Z"/><path d="M14 10h3.8l3.2 3.4V16h-7Z"/><path d="M6.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9.5 16.5 4 11"/><path d="M12 22a10 10 0 1 1 8.2-15.7"/></svg>`,
  shop: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16l-1.2-5H5.2Z"/><path d="M6 10v10h12V10"/><path d="M9 20v-6h6v6"/><path d="M4 10c0 1.4 1.1 2.5 2.5 2.5S9 11.4 9 10c0 1.4 1.1 2.5 2.5 2.5S14 11.4 14 10c0 1.4 1.1 2.5 2.5 2.5S19 11.4 19 10"/></svg>`,
  wash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18H6Z"/><path d="M9 7h.1M12 7h3"/><path d="M16 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"/><path d="M9 15c1.6-1.2 3.4 1.2 6 0"/></svg>`,
  ready: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16l-1.2-5H5.2Z"/><path d="M6 10v10h12V10"/><path d="M9 20v-6h6v6"/><path d="M17.5 4.5 19 3l1.5 1.5M18.5 7h3"/></svg>`,
  happy: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M8.5 10h.1M15.5 10h.1"/><path d="M8.5 14.5c1 1.6 2.2 2.3 3.5 2.3s2.5-.7 3.5-2.3"/></svg>`,
};

function renderTrackingStepIcon(step) {
  return TRACKING_STEP_ICONS[step?.icon] || TRACKING_STEP_ICONS.receipt;
}

function getClientTrackingStep(order) {
  const status = normalizeStatusValue(order?.status);
  return CLIENT_TRACKING_STEPS.find((step) => step.key === status) || CLIENT_TRACKING_STEPS[0];
}

function renderClientTrackingExperience(order, options = {}) {
  if (!order) return "";

  const currentStatus = normalizeStatusValue(order.status);
  const currentIndex = Math.max(
    CLIENT_TRACKING_STEPS.findIndex((step) => step.key === currentStatus),
    0
  );
  const currentStep = CLIENT_TRACKING_STEPS[currentIndex] || CLIENT_TRACKING_STEPS[0];
  const compactClass = options.compact ? " client-tracking-compact" : "";
  const progressWidth = CLIENT_TRACKING_STEPS.length > 1
    ? (currentIndex / (CLIENT_TRACKING_STEPS.length - 1)) * 100
    : 0;

  return `
    <section class="client-tracking${compactClass}" aria-label="Seguimiento animado del pedido">
      <div class="client-tracking-scene client-tracking-scene-${escapeHtml(currentStep.scene)}">
        <div class="client-tracking-emoji" aria-hidden="true">${currentStep.emoji}</div>
        <div>
          <span>${escapeHtml(formatStatusLabel(currentStep.key))}</span>
          <strong>${escapeHtml(currentStep.title)}</strong>
          <small>${escapeHtml(currentStep.copy)}</small>
        </div>
      </div>
      <div class="client-tracking-line-wrap">
        <div class="client-tracking-rail" aria-hidden="true">
          <span style="width:${progressWidth}%;"></span>
        </div>
        <div class="client-tracking-steps">
          ${CLIENT_TRACKING_STEPS.map((step, index) => {
            const className = [
              "client-tracking-step",
              index < currentIndex ? "is-done" : "",
              index === currentIndex ? "is-active" : "",
            ].filter(Boolean).join(" ");
            return `
              <div class="${className}">
                <b>${renderTrackingStepIcon(step)}</b>
                <span>${escapeHtml(step.label)}</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderDeliveryProofSummary(order, options = {}) {
  const proof = getDeliveryProof(order);
  if (!proof) return "";

  const compactClass = options.compact ? " delivery-proof-summary-compact" : "";
  const note = proof.note
    ? `<div class="delivery-proof-note">${escapeHtml(proof.note)}</div>`
    : "";
  const byLine = proof.byName ? ` | ${escapeHtml(proof.byName)}` : "";

  return `
    <div class="delivery-proof-summary${compactClass}">
      <div class="delivery-proof-summary-top">
        <span class="delivery-proof-icon">OK</span>
        <div>
          <div class="delivery-proof-title">Entrega validada</div>
          <div class="delivery-proof-meta">${escapeHtml(formatDeliveryMethodLabel(proof.deliveryMethod))} | ${escapeHtml(formatDeliveryProofDate(proof))}${byLine}${proof.deliveryCodeVerified ? " | Codigo verificado" : ""}</div>
        </div>
      </div>
      <div class="delivery-proof-receiver">
        Recibido por <strong>${escapeHtml(proof.receiverName || "Sin nombre")}</strong>
      </div>
      ${note}
    </div>
  `;
}

function ensureDeliveryProofDialog() {
  if (!document.body) return null;

  let dialog = qs("#deliveryProofDialog");
  if (dialog) return dialog;

  dialog = document.createElement("div");
  dialog.id = "deliveryProofDialog";
  dialog.className = "delivery-proof-overlay";
  dialog.setAttribute("aria-hidden", "true");
  dialog.innerHTML = `
    <div class="delivery-proof-backdrop" data-delivery-proof-action="cancel"></div>
    <form id="deliveryProofForm" class="delivery-proof-dialog" role="dialog" aria-modal="true" aria-labelledby="deliveryProofTitle">
      <div class="delivery-proof-dialog-head">
        <div>
          <div class="delivery-proof-eyebrow">Cierre de ruta</div>
          <h3 id="deliveryProofTitle" class="delivery-proof-dialog-title">Validar entrega</h3>
          <p id="deliveryProofCopy" class="delivery-proof-dialog-copy">Registra quien recibio el pedido antes de cerrarlo.</p>
        </div>
        <button type="button" class="delivery-proof-close" data-delivery-proof-action="cancel" aria-label="Cerrar">X</button>
      </div>
      <div id="deliveryProofMessage" class="delivery-proof-message" style="display:none;"></div>
      <div class="delivery-proof-fields">
        <label data-delivery-proof-field="code">
          <span id="deliveryProofCodeLabel">Codigo del cliente</span>
          <input id="deliveryProofCode" class="delivery-code-input" type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" required>
        </label>
        <label data-delivery-proof-field="receiver">
          <span>Nombre de quien recibio</span>
          <input id="deliveryProofReceiver" type="text" maxlength="80" placeholder="Ej. Maria Perez" autocomplete="off" required>
        </label>
        <label data-delivery-proof-field="method">
          <span>Metodo de entrega</span>
          <select id="deliveryProofMethod" required>
            <option value="">Seleccionar...</option>
            <option value="cliente">Cliente directo</option>
            <option value="porteria">Porteria / seguridad</option>
            <option value="recepcion">Recepcion</option>
            <option value="familiar">Familiar</option>
            <option value="otro">Otro</option>
          </select>
        </label>
        <label class="delivery-proof-note-field" data-delivery-proof-field="note">
          <span>Nota opcional</span>
          <textarea id="deliveryProofNote" maxlength="240" rows="3" placeholder="Ej. Entregado en recepcion, persona autorizada."></textarea>
        </label>
      </div>
      <div class="delivery-proof-actions">
        <button type="button" class="confirm-dialog-btn confirm-dialog-btn-secondary" data-delivery-proof-action="cancel">Volver</button>
        <button id="deliveryProofSubmit" type="submit" class="confirm-dialog-btn confirm-dialog-btn-primary">Entregado al cliente</button>
      </div>
    </form>
  `;

  dialog.querySelectorAll("[data-delivery-proof-action='cancel']").forEach((node) => {
    node.addEventListener("click", () => closeDeliveryProofDialog(null));
  });

  dialog.querySelector("#deliveryProofCode")?.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
  });

  dialog.querySelector("#deliveryProofForm")?.addEventListener("submit", (event) => {
    event.preventDefault();

    const mode = dialog.dataset.proofMode || "delivery";
    const receiverName = dialog.querySelector("#deliveryProofReceiver")?.value.trim() || "";
    const deliveryMethod = dialog.querySelector("#deliveryProofMethod")?.value.trim() || "";
    const note = dialog.querySelector("#deliveryProofNote")?.value.trim() || "";
    const deliveryCode = dialog.querySelector("#deliveryProofCode")?.value.replace(/\D/g, "") || "";
    const message = dialog.querySelector("#deliveryProofMessage");

    if (deliveryCode.length !== 6) {
      if (message) {
        message.textContent = mode === "pickup"
          ? "Pide al cliente su PIN de recogida de 6 digitos."
          : "Pide al cliente su PIN de entrega de 6 digitos.";
        message.style.display = "block";
      }
      return;
    }

    if (mode === "pickup") {
      closeDeliveryProofDialog({ pickupCode: deliveryCode });
      return;
    }

    if (receiverName.length < 2) {
      if (message) {
        message.textContent = "Indica el nombre de quien recibio.";
        message.style.display = "block";
      }
      return;
    }

    if (!deliveryMethod) {
      if (message) {
        message.textContent = "Selecciona como fue recibida la entrega.";
        message.style.display = "block";
      }
      return;
    }

    closeDeliveryProofDialog({ receiverName, deliveryMethod, note, deliveryCode });
  });

  document.body.appendChild(dialog);
  return dialog;
}

function closeDeliveryProofDialog(result = null) {
  const dialog = qs("#deliveryProofDialog");
  const resolver = activeDeliveryProofResolver;
  activeDeliveryProofResolver = null;

  if (dialog) {
    dialog.classList.remove("delivery-proof-visible");
    dialog.setAttribute("aria-hidden", "true");
  }

  document.body?.classList.remove("dialog-open");
  if (resolver) resolver(result);
}

function showDeliveryProofDialog(order, options = {}) {
  const mode = options.mode === "pickup" ? "pickup" : "delivery";
  if (!document.body) {
    const deliveryCode = window.prompt(mode === "pickup" ? "Codigo de recogida del cliente:" : "Codigo de entrega del cliente:");
    if (!deliveryCode) return Promise.resolve(null);
    if (mode === "pickup") {
      return Promise.resolve({ pickupCode: String(deliveryCode).replace(/\D/g, "") });
    }
    const receiverName = window.prompt("Nombre de quien recibio el pedido:");
    if (!receiverName) return Promise.resolve(null);
    return Promise.resolve({
      receiverName: receiverName.trim(),
      deliveryMethod: "cliente",
      note: "",
      deliveryCode: String(deliveryCode).replace(/\D/g, ""),
    });
  }

  const dialog = ensureDeliveryProofDialog();
  if (!dialog) return Promise.resolve(null);

  if (activeDeliveryProofResolver) {
    activeDeliveryProofResolver(null);
    activeDeliveryProofResolver = null;
  }

  const form = dialog.querySelector("#deliveryProofForm");
  const title = dialog.querySelector("#deliveryProofTitle");
  const copy = dialog.querySelector("#deliveryProofCopy");
  const codeLabel = dialog.querySelector("#deliveryProofCodeLabel");
  const message = dialog.querySelector("#deliveryProofMessage");
  const submit = dialog.querySelector("#deliveryProofSubmit");
  const receiverInput = dialog.querySelector("#deliveryProofReceiver");
  const methodInput = dialog.querySelector("#deliveryProofMethod");
  const noteInput = dialog.querySelector("#deliveryProofNote");
  const pickupMode = mode === "pickup";
  form?.reset();
  dialog.dataset.proofMode = mode;
  dialog.classList.toggle("delivery-proof-pickup-mode", pickupMode);
  dialog.querySelectorAll("[data-delivery-proof-field='receiver'], [data-delivery-proof-field='method'], [data-delivery-proof-field='note']").forEach((field) => {
    field.hidden = pickupMode;
  });
  if (receiverInput) {
    receiverInput.required = !pickupMode;
    receiverInput.disabled = pickupMode;
  }
  if (methodInput) {
    methodInput.required = !pickupMode;
    methodInput.disabled = pickupMode;
  }
  if (noteInput) {
    noteInput.disabled = pickupMode;
  }
  if (title) title.textContent = pickupMode ? "Validar recogida" : "Validar entrega";
  if (codeLabel) codeLabel.textContent = pickupMode ? "PIN de recogida" : "PIN de entrega";
  if (submit) submit.textContent = pickupMode ? "Confirmar recogida" : "Entregado al cliente";
  if (copy) {
    copy.textContent = pickupMode
      ? `Pedido #${order?.id || "--"} | ${order?.userName || "Cliente"} | pide el PIN de recogida antes de recibir las prendas.`
      : `Pedido #${order?.id || "--"} | ${order?.userName || "Cliente"} | pide el PIN de entrega antes de cerrar el servicio.`;
  }
  if (message) {
    message.textContent = "";
    message.style.display = "none";
  }

  dialog.classList.add("delivery-proof-visible");
  dialog.setAttribute("aria-hidden", "false");
  document.body.classList.add("dialog-open");

  window.requestAnimationFrame(() => {
    dialog.querySelector("#deliveryProofCode")?.focus();
  });

  return new Promise((resolve) => {
    activeDeliveryProofResolver = resolve;
  });
}

window.alert = (message) => {
  showNotice(message, inferNoticeTone(message));
};

function formatRoleLabel(role) {
  const map = {
    cliente: "Cliente",
    gestor: "Gestor",
    repartidor: "Repartidor",
    cajera: "Cajera",
  };
  return map[role] || role || "Usuario";
}

function formatStatusLabel(status) {
  const raw = String(status || "").trim();
  const s = raw.toLowerCase();
  const labels = {
    pendiente: "Pendiente",
    asignado: "Asignado",
    "en camino a recoger": "En camino a recoger",
    "recogido al cliente": "Recogido al cliente",
    "de camino al local": "De camino al local",
    "recibido en local": "Recibido en local",
    "en tratamiento": "En tratamiento",
    "listo para entrega": "Listo para entrega",
    "en camino a entregar": "En camino a entregar",
    "entregado al cliente": "Entregado al cliente",
    cancelado: "Cancelado",
  };
  if (!raw) return "Sin estado";
  if (labels[s]) return labels[s];
  if (s.includes("cancel")) return "Cancelado";
  if (s.includes("entregado")) return "Entregado al cliente";
  if (s.includes("camino")) return "En camino";
  if (s.includes("recibido")) return "Recibido";
  if (s.includes("pendiente")) return "Pendiente";
  if (s.includes("asignado")) return "Asignado";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function getStatusTone(status) {
  const s = normalizeStatusValue(status);
  if (s.includes("cancel")) return "status-cancelled";
  if (s === "entregado al cliente") return "status-delivered";
  if (["recibido en local", "en tratamiento", "listo para entrega"].includes(s)) return "status-progress";
  if (s.includes("camino") || s.includes("recogido") || s.includes("asignado")) return "status-progress";
  if (s.includes("pendiente")) return "status-pending";
  return "status-empty";
}

function renderStatusBadge(status, extraClass = "") {
  return `<span class="status-pill ${getStatusTone(status)} ${extraClass}">${formatStatusLabel(status)}</span>`;
}

function tableEmptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}"><div class="table-empty">${message}</div></td></tr>`;
}

function sortByNewestId(items) {
  return [...items].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}

function currentTheme() {
  return document.body.classList.contains("theme-light") ? "light" : "dark";
}

function updateThemeToggle() {
  const icon = qs("#themeIcon");
  const text = qs("#themeText");
  const isLight = currentTheme() === "light";

  if (icon) icon.innerHTML = isLight ? "MO" : "SO";
  if (text) text.textContent = isLight ? "Oscuro" : "Claro";
}

function applyTheme(theme, persist = true) {
  document.body.classList.toggle("theme-light", theme === "light");
  updateThemeToggle();
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function toggleTheme() {
  applyTheme(currentTheme() === "light" ? "dark" : "light");
}

function syncSessionChrome() {
  const logoutBtn = qs("#logoutBtn");
  const bottomNav = qs(".bottom-nav");

  if (currentUser) {
    show(logoutBtn);
    show(bottomNav);
  } else {
    hide(logoutBtn);
    hide(bottomNav);
  }
}

function setHeroStat(index, label, value) {
  const labelNode = qs(`#heroStatLabel${index}`);
  const valueNode = qs(`#heroStatValue${index}`);
  if (labelNode) labelNode.textContent = label;
  if (valueNode) valueNode.textContent = value;
}

function updateDashboardHero() {
  if (!currentUser) return;

  const badge = qs("#homeContextBadge");
  const today = new Date().toISOString().slice(0, 10);
  const clientOrders = ordersCache.filter((o) => o.userId === currentUser.id);
  const localToday = localOrdersCache.filter((o) => o.date === today);

  if (currentUser.role === "cliente") {
    const active = clientOrders.filter((o) => !isClosedOrderStatus(o.status));
    const delivered = clientOrders.filter((o) => isFinalDeliveryStatus(o.status));
    setHeroStat(1, "Pedidos", String(clientOrders.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Entregados", String(delivered.length));
    if (badge) badge.textContent = "Servicio signature";
    return;
  }

  if (currentUser.role === "gestor") {
    const pending = ordersCache.filter((o) => o.channel !== "local" && o.status === "pendiente");
    const active = ordersCache.filter((o) => o.channel !== "local" && !isClosedOrderStatus(o.status));
    setHeroStat(1, "Pendientes", String(pending.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Rutas", String(repartidoresCache.length));
    if (badge) badge.textContent = "Salon operativo";
    return;
  }

  if (currentUser.role === "repartidor") {
    const assigned = ordersCache.filter((o) => o.repartidorId === currentUser.id);
    const todayCount = assigned.filter((o) => o.date === today);
    const delivered = assigned.filter((o) => isFinalDeliveryStatus(o.status));
    setHeroStat(1, "Asignados", String(assigned.length));
    setHeroStat(2, "Hoy", String(todayCount.length));
    setHeroStat(3, "Entregados", String(delivered.length));
    if (badge) badge.textContent = "Ruta del dia";
    return;
  }

  if (currentUser.role === "cajera") {
    const received = localOrdersCache.filter((o) => String(o.status).toLowerCase().includes("recibido"));
    setHeroStat(1, "Local", String(localOrdersCache.length));
    setHeroStat(2, "Hoy", String(localToday.length));
    setHeroStat(3, "Recibidos", String(received.length));
    if (badge) badge.textContent = "Caja boutique";
  }
}

function setDefaultFormValues() {
  const dateInput = qs("#homeDate");
  const timeInput = qs("#homeTime");
  if (!dateInput || !timeInput) return;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  dateInput.min = today;
  timeInput.min = "08:00";
  timeInput.max = "22:00";

  if (dateInput.value) return;

  const nextHour = Math.min(Math.max(now.getHours() + 1, 8), 22);
  const hour = String(nextHour).padStart(2, "0");
  dateInput.value = today;
  timeInput.value = `${hour}:00`;
}

function ensureUIEnhancements() {
  document.title = `${BUSINESS_PROFILE.name} | ${BUSINESS_PROFILE.tagline}`;
  ensureTopbarEnhancements();
  ensureAuthEnhancements();
  ensureWelcomeEnhancements();
  ensureHomeEnhancements();
  ensureSecondaryEnhancements();
  normalizeStaticCopy();
}

function ensureTopbarEnhancements() {
  const topbar = qs(".topbar");
  if (!topbar) return;

  if (qs(".app-name")) qs(".app-name").textContent = BUSINESS_PROFILE.name;
  if (qs(".app-subtitle")) qs(".app-subtitle").textContent = BUSINESS_PROFILE.tagline;
  const logo = qs(".app-logo");
  if (logo) {
    logo.setAttribute("aria-label", BUSINESS_PROFILE.name);
    logo.innerHTML = `<img src="${BUSINESS_ASSETS.logo}" alt="${BUSINESS_PROFILE.name}" />`;
  }
  let favicon = document.querySelector('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.setAttribute("rel", "icon");
    document.head.appendChild(favicon);
  }
  favicon.setAttribute("href", BUSINESS_ASSETS.icon);
  favicon.setAttribute("type", "image/png");

  if (!qs(".topbar-center")) {
    const center = document.createElement("div");
    center.className = "topbar-center";
    center.innerHTML = `
      <div class="service-pill">
        <span class="service-dot"></span>
        Recepcion, lavado y entrega | 8:00 AM - 10:00 PM
      </div>
    `;
    const right = topbar.querySelector(".topbar-right");
    if (right) topbar.insertBefore(center, right);
  }

  const darkToggle = qs("#darkModeToggle");
  if (darkToggle) {
    darkToggle.innerHTML = `
      <span id="themeIcon" class="icon-symbol">SO</span>
      <span id="themeText" class="icon-label">Claro</span>
    `;
  }

  const logoutBtn = qs("#logoutBtn");
  if (logoutBtn) {
    logoutBtn.innerHTML = `
      <span class="icon-symbol">SA</span>
      <span class="icon-label">Salir</span>
    `;
  }
}

function ensureAuthEnhancements() {
  const authView = qs("#authView");
  const authCard = authView?.querySelector(".auth-card");
  if (!authView || !authCard) return;

  if (!authView.querySelector(".auth-shell")) {
    const shell = document.createElement("div");
    shell.className = "auth-shell";

    const showcase = document.createElement("aside");
    showcase.className = "auth-showcase";
    showcase.innerHTML = `
      <div class="auth-kicker">Edicion signature</div>
      <h1 class="auth-title">Una experiencia de tintoreria con presencia premium.</h1>
      <p class="auth-copy">
        Centraliza pedidos, seguimiento, facturacion y operacion del local con una
        interfaz mas refinada, sobria y exclusiva.
      </p>
      <div class="auth-metrics">
        <div class="auth-metric"><strong>Pickup</strong><span>coordinado por zona</span></div>
        <div class="auth-metric"><strong>Control</strong><span>operativo y visual</span></div>
        <div class="auth-metric"><strong>Entrega</strong><span>con seguimiento claro</span></div>
      </div>
      <div class="auth-feature-grid">
        <div class="auth-feature-card"><span class="feature-pill">Seguimiento privado</span><p>Visualiza el estado de cada pedido con una lectura clara y elegante.</p></div>
        <div class="auth-feature-card"><span class="feature-pill">Atencion concierge</span><p>Coordina repartidores, local y clientes desde una misma experiencia.</p></div>
        <div class="auth-feature-card"><span class="feature-pill">Factura signature</span><p>Consulta detalles y totales con una presentacion mas cuidada.</p></div>
      </div>
      <div class="auth-preview">
        <div class="preview-header">
          <span class="preview-label">Flujo signature</span>
          <span class="preview-note">Operacion</span>
        </div>
        <div class="preview-steps">
          <div class="preview-step preview-step-active">Solicitud</div>
          <div class="preview-step">Recibido</div>
          <div class="preview-step">En camino</div>
          <div class="preview-step">Entregado</div>
        </div>
      </div>
    `;

    authView.innerHTML = "";
    shell.append(showcase, authCard);
    authView.appendChild(shell);
  }

  const titles = authCard.querySelectorAll("h2");
  if (titles[0]) titles[0].textContent = "Iniciar sesion";
  if (titles[1]) {
    titles[1].textContent = "Crear cuenta";
    titles[1].classList.add("secondary-title");
  }

  const subtitles = authCard.querySelectorAll(".auth-subtitle");
  if (subtitles[0]) subtitles[0].textContent = "Accede con tu perfil de cliente, gestor, repartidor o cajera.";
  if (subtitles[1]) subtitles[1].textContent = "Las cuentas nuevas de cliente se activan primero desde el correo.";

  const loginGroups = qs("#loginForm")?.querySelectorAll(".field-group") || [];
  if (loginGroups[0]) loginGroups[0].querySelector("label").textContent = "Correo electronico";
  if (loginGroups[1]) loginGroups[1].querySelector("label").textContent = "Contrasena";
  if (qs("#loginPassword")) qs("#loginPassword").placeholder = "Minimo 6 caracteres";
  if (qs("#loginForm .btn")) qs("#loginForm .btn").textContent = "Entrar al panel";

  const registerGroups = qs("#registerForm")?.querySelectorAll(".field-group") || [];
  if (registerGroups[1]) registerGroups[1].querySelector("label").textContent = "Correo electronico";
  if (registerGroups[2]) registerGroups[2].querySelector("label").textContent = "Contrasena";
  if (qs("#registerPassword")) qs("#registerPassword").placeholder = "Minimo 6 caracteres";
  if (qs("#registerForm .btn")) qs("#registerForm .btn").textContent = "Crear cuenta";

  const hint = authCard.querySelector(".auth-hint");
  if (hint && !hint.querySelector(".auth-hint-title")) {
    const title = document.createElement("div");
    title.className = "auth-hint-title";
    title.textContent = "Soporte de acceso";
    hint.prepend(title);
  }

  ensureAuthSupportBlocks();
}

function ensureWelcomeEnhancements() {
  const welcomeBlock = qs(".welcome-block");
  const welcomeText = welcomeBlock?.querySelector(".welcome-text");
  const roleBadge = welcomeBlock?.querySelector(".role-badge");
  if (!welcomeBlock || !welcomeText || welcomeBlock.querySelector(".welcome-main")) return;
  if (roleBadge) roleBadge.hidden = true;

  const main = document.createElement("div");
  main.className = "welcome-main";
  main.innerHTML = `<div class="card-eyebrow">Panel operativo</div>`;
  main.appendChild(welcomeText);

  const tags = document.createElement("div");
  tags.className = "welcome-tags";
  tags.innerHTML = `
    <span class="info-chip">Vista editorial</span>
    <span class="info-chip">Facturacion signature</span>
    <span class="info-chip">Operacion de atelier</span>
  `;
  main.appendChild(tags);

  const side = document.createElement("div");
  side.className = "welcome-side";

  const stats = document.createElement("div");
  stats.className = "hero-stats";
  stats.innerHTML = `
    <div class="hero-stat">
      <span id="heroStatLabel1" class="hero-stat-label">Pedidos</span>
      <strong id="heroStatValue1" class="hero-stat-value">0</strong>
    </div>
    <div class="hero-stat">
      <span id="heroStatLabel2" class="hero-stat-label">Estado</span>
      <strong id="heroStatValue2" class="hero-stat-value">0</strong>
    </div>
    <div class="hero-stat">
      <span id="heroStatLabel3" class="hero-stat-label">Clientes</span>
      <strong id="heroStatValue3" class="hero-stat-value">0</strong>
    </div>
  `;
  side.appendChild(stats);

  welcomeBlock.innerHTML = "";
  welcomeBlock.append(main, side);
}

function ensureHomeEnhancements() {
  const screenHome = qs("#screenHome");
  if (!screenHome) return;

  if (!screenHome.querySelector(".screen-heading")) {
    const heading = document.createElement("div");
    heading.className = "screen-heading";
    heading.innerHTML = `
      <div>
        <div class="screen-kicker">Salon principal</div>
        <h3 class="screen-title">Resumen del dia</h3>
      </div>
      <div id="homeContextBadge" class="screen-badge">Experiencia sincronizada</div>
    `;
    screenHome.prepend(heading);
  }

  const nextOrderCard = qs("#nextOrderCard");
  const quickOrderCard = qs("#quickOrderCard");
  if (nextOrderCard && !screenHome.querySelector(".home-client-layout")) {
    const layout = document.createElement("div");
    layout.className = "home-client-layout";
    screenHome.insertBefore(layout, nextOrderCard);
    layout.appendChild(nextOrderCard);

    const serviceCard = document.createElement("div");
    serviceCard.id = "serviceExperienceCard";
    serviceCard.className = "card service-card";
    serviceCard.innerHTML = `
      <div class="card-title">Experiencia signature</div>
      <div class="service-grid">
        <div class="service-item"><strong>Recogida privada</strong><span>Agenda por zona con fecha y hora.</span></div>
        <div class="service-item"><strong>Trazabilidad elegante</strong><span>Sigue el pedido desde solicitud hasta entrega.</span></div>
        <div class="service-item"><strong>Factura de atelier</strong><span>Consulta precios, extras e ITBIS desde el panel.</span></div>
      </div>
    `;
    layout.appendChild(serviceCard);
  }

  quickOrderCard?.classList.add("order-card");
  qs("#cashierForm")?.closest(".card")?.classList.add("order-card");
  qs("#ridersActivity")?.classList.add("riders-activity");

  const activityCard = qs("#screenActivity .card");
  if (activityCard && !activityCard.querySelector(".card-secondary")) {
    const subtitle = document.createElement("div");
    subtitle.className = "card-secondary";
    subtitle.textContent = "Historial reciente de pedidos y movimientos.";
    activityCard.insertBefore(subtitle, qs("#activityTimeline"));
  }

  const localCard = qs("#screenLocal .card + .card");
  localCard?.classList.add("card-spaced");

  const gestorCard = qs("#gestorHomePanel .card");
  gestorCard?.classList.add("card-spaced");
}

function ensureSecondaryEnhancements() {
  const navConfig = {
    screenHome: "IN",
    screenActivity: "AC",
    screenPremium: "PR",
    screenDelivered: "OK",
    screenProduction: "OP",
    screenControl: "CO",
    screenRiders: "RP",
    screenLocal: "LC",
    screenHistory: "HI",
    screenAccount: "CT",
  };

  qsa(".nav-item").forEach((btn) => {
    const target = btn.dataset.screenTarget;
    const icon = btn.querySelector(".nav-icon");
    if (icon && navConfig[target]) icon.textContent = navConfig[target];
  });

  const printBtn = qs("#invoicePrintBtn");
  if (printBtn) {
    printBtn.innerHTML = `<span class="icon-symbol">PR</span><span class="icon-label">Imprimir</span>`;
    printBtn.parentElement?.classList.add("invoice-actions");
  }

  const closeBtn = qs("#invoiceCloseBtn");
  if (closeBtn) {
    closeBtn.innerHTML = `<span class="icon-symbol">X</span><span class="icon-label">Cerrar</span>`;
    closeBtn.parentElement?.classList.add("invoice-actions");
  }
}

function normalizeStaticCopy() {
  const nextOrderTitle = qs("#nextOrderCard .card-title");
  if (nextOrderTitle) nextOrderTitle.textContent = "Tu pedido activo";

  const quickTitle = qs("#quickOrderCard .card-title");
  const quickSubtitle = qs("#quickOrderCard .card-secondary");
  if (quickTitle) quickTitle.textContent = "Ordenar recogida a domicilio";
  if (quickSubtitle) quickSubtitle.textContent = "Agenda de 8:00 AM a 10:00 PM con seguimiento privado.";

  const quickLabels = qs("#quickOrderForm")?.querySelectorAll("label") || [];
  const quickTexts = ["Zona", "Direccion", "Fecha", "Hora", "Tipo de servicio", "Paquete principal", "Extras", "Notas"];
  quickLabels.forEach((label, index) => {
    if (quickTexts[index]) label.textContent = quickTexts[index];
  });

  if (qs("#homeAddress")) qs("#homeAddress").placeholder = "Ej: Calle 27 #14, Naco";
  if (qs("#homeNotes")) qs("#homeNotes").placeholder = "Ej: tocar el timbre, dejar en recepcion...";

  const serviceOptions = qs("#homeServicePack")?.options || [];
  if (serviceOptions[3]) serviceOptions[3].textContent = "Tintoreria en seco";

  const cashierTitleNodes = qsa("#cashierHomePanel .card-title");
  if (cashierTitleNodes[0]) cashierTitleNodes[0].textContent = "Local y caja";
  if (cashierTitleNodes[1]) cashierTitleNodes[1].textContent = "Crear pedido en local";
  const cashierSubtitle = qs("#cashierHomePanel .card-secondary");
  if (cashierSubtitle) cashierSubtitle.textContent = "Registra pedidos cuando el cliente entrega en tienda.";

  const cashierLabels = qs("#cashierForm")?.querySelectorAll("label") || [];
  const cashierTexts = ["Nombre del cliente", "Telefono", "Correo", "Libras", "Paquete principal", "Extras", "Notas"];
  cashierLabels.forEach((label, index) => {
    if (cashierTexts[index]) label.textContent = cashierTexts[index];
  });

  if (qs("#cashierPhone")) qs("#cashierPhone").placeholder = "Ej: 809-000-0000";
  const cashierOptions = qs("#cashierPack")?.options || [];
  if (cashierOptions[3]) cashierOptions[3].textContent = "Tintoreria en seco";

  const premiumTitle = qs("#screenPremium .card-title");
  const premiumText = qs("#screenPremium .premium-text");
  const premiumNote = qs("#screenPremium .premium-note");
  if (premiumTitle) premiumTitle.textContent = "Club Signature";
  if (premiumText) premiumText.textContent = "Proximamente: membresia mensual o anual con beneficios exclusivos, prioridad y recompensas.";
  if (premiumNote) premiumNote.textContent = "Beneficios sujetos a disponibilidad del servicio.";
  qsa("#screenPremium .premium-list li").forEach((item, index) => {
    const texts = [
      "Beneficios privados por pedidos",
      "Prioridad de atencion y promociones exclusivas",
      "Lavado sin costo cada cierta cantidad de libras",
    ];
    item.textContent = texts[index] || item.textContent;
  });
  const premiumBtn = qs("#screenPremium .btn");
  if (premiumBtn) premiumBtn.textContent = "Proximamente";

  const ridersCardTitles = qsa("#screenRiders .card-title");
  const ridersCardSubtitle = qs("#screenRiders .card-secondary");
  if (ridersCardTitles[0]) ridersCardTitles[0].textContent = "Actividad de repartidores";
  if (ridersCardSubtitle) ridersCardSubtitle.textContent = "Metas diarias por zona y progreso en tiempo real.";

  const localTitles = qsa("#screenLocal .card-title");
  if (localTitles[0]) localTitles[0].textContent = "Pedidos del local";
  if (localTitles[1]) localTitles[1].textContent = "Lista de pedidos";
  const localSubtitles = qsa("#screenLocal .card-secondary");
  if (localSubtitles[0]) localSubtitles[0].textContent = "Pedidos creados por la cajera en tienda.";

  const accountTitle = qs("#screenAccount .card-title");
  const accountSubtitle = qs("#screenAccount .card-secondary");
  if (accountTitle) accountTitle.textContent = "Cuenta";
  if (accountSubtitle) accountSubtitle.textContent = "Administra tu informacion principal y canales de contacto.";
  const profileLabels = qs("#profileForm")?.querySelectorAll("label") || [];
  const profileTexts = ["Nombre", "Correo", "Rol"];
  profileLabels.forEach((label, index) => {
    if (profileTexts[index]) label.textContent = profileTexts[index];
  });
  const helpItems = qsa(".help-list li");
  const helpTexts = [
    `Soporte: ${BUSINESS_PROFILE.email}`,
    "Horario: 8:00 AM - 10:00 PM",
    "Agenda: recogida y entrega coordinada por zona",
  ];
  helpItems.forEach((item, index) => {
    if (helpTexts[index]) item.textContent = helpTexts[index];
  });
}

function showScreen(screenId, { skipData = false, skipRender = false, forceRender = false } = {}) {
  const resolvedScreen = resolveRoleScreen(screenId);
  qsa(".screen").forEach((s) => s.classList.remove("screen-active"));
  const target = qs(`#${resolvedScreen}`);
  if (target) target.classList.add("screen-active");

  qsa(".nav-item").forEach((btn) => {
    btn.classList.toggle("nav-item-active", btn.dataset.screenTarget === resolvedScreen);
  });

  if (skipRender) return;

  void (async () => {
    try {
      if (!skipData) {
        await ensureScreenDataForCurrentRole(resolvedScreen);
      }
      renderScreenForCurrentRole(resolvedScreen, { force: forceRender });
    } catch (error) {
      showWarning(error?.message || "No pudimos preparar esta vista en este momento.");
    }
  })();
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr || "";
  return d.toLocaleDateString("es-DO", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtTime(isoOrTime) {
  if (!isoOrTime) return "";
  // Si viene ISO:
  if (String(isoOrTime).includes("T")) {
    const d = new Date(isoOrTime);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" });
  }
  return isoOrTime;
}

/* ============================================================
   STATUS RULES (frontend extra; backend ya valida)
============================================================ */
const STATUS_FLOW = [
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
const ALLOWED_STATUS_TRANSITIONS = {
  pendiente: ["asignado"],
  asignado: ["en camino a recoger"],
  "en camino a recoger": ["recogido al cliente"],
  "recogido al cliente": ["de camino al local"],
  "de camino al local": ["recibido en local"],
  "recibido en local": ["en tratamiento"],
  "en tratamiento": ["listo para entrega"],
  "listo para entrega": ["en camino a entregar"],
  "en camino a entregar": ["entregado al cliente"],
};

function normalizeStatusValue(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "camino" || s === "en camino") return "en camino a entregar";
  if (s === "recibido") return "recogido al cliente";
  if (s === "entregado") return "entregado al cliente";
  return s;
}

function getStatusRank(status) {
  const s = normalizeStatusValue(status);
  if (s.includes("cancelado")) return 99;
  const index = STATUS_FLOW.indexOf(s);
  return index >= 0 ? index : 0;
}
function canMoveTo(currentStatus, targetStatus) {
  const current = normalizeStatusValue(currentStatus);
  const target = normalizeStatusValue(targetStatus);
  if (!current || !target || current === target) return false;
  return (ALLOWED_STATUS_TRANSITIONS[current] || []).includes(target);
}

function isFinalDeliveryStatus(status) {
  return normalizeStatusValue(status) === "entregado al cliente";
}

function isCancelledStatus(status) {
  return normalizeStatusValue(status).includes("cancel");
}

function isClosedOrderStatus(status) {
  return isFinalDeliveryStatus(status) || isCancelledStatus(status);
}

function isOperationalActiveStatus(status) {
  const value = normalizeStatusValue(status);
  return Boolean(value) && !["pendiente", "entregado al cliente", "cancelado"].includes(value);
}

function isRiderRouteStatus(status) {
  return [
    "asignado",
    "en camino a recoger",
    "recogido al cliente",
    "de camino al local",
    "listo para entrega",
    "en camino a entregar",
  ].includes(normalizeStatusValue(status));
}

/* ============================================================
   CANCEL WINDOW (5 min)
============================================================ */
function canCancel(order) {
  if (!order || !order.createdAt) return false;
  if (isClosedOrderStatus(order.status)) return false;
  const diff = Date.now() - new Date(order.createdAt).getTime();
  return diff <= 5 * 60 * 1000;
}

/* ============================================================
   AUTH
============================================================ */
function getStoredToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

function setSession(user, token) {
  currentUser = user || null;
  if (currentUser) {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser));
  } else {
    localStorage.removeItem(USER_STORAGE_KEY);
  }

  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }

  if (currentUser && token) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

function clearSession() {
  currentUser = null;
  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  stopAutoRefresh();
}

function getActiveScreenId() {
  return qs(".screen.screen-active")?.id || "screenHome";
}

function getAllowedScreensForCurrentRole() {
  switch (currentUser?.role) {
    case "cliente":
      return ["screenHome", "screenActivity", "screenPremium", "screenAccount"];
    case "gestor":
      return ["screenHome", "screenControl", "screenRiders", "screenLocal", "screenHistory", "screenAccount"];
    case "repartidor":
      return ["screenHome", "screenDelivered", "screenAccount"];
    case "cajera":
      return ["screenHome", "screenProduction", "screenHistory", "screenAccount"];
    default:
      return ["screenHome"];
  }
}

function resolveRoleScreen(screenId) {
  const target = String(screenId || "").trim() || "screenHome";
  const allowed = getAllowedScreensForCurrentRole();
  return allowed.includes(target) ? target : "screenHome";
}

async function apiRequest(path, options = {}) {
  const token = getStoredToken();
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const fallback = options.method === "GET" ? [] : {};
  const data = await res.json().catch(() => fallback);

  if (!res.ok) {
    if (res.status === 401 && !["/login", "/register"].includes(path)) {
      clearSession();
    }
    throw data;
  }

  return data;
}

async function apiPost(path, body) {
  return apiRequest(path, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

async function apiPut(path, body) {
  return apiRequest(path, {
    method: "PUT",
    body: JSON.stringify(body || {}),
  });
}

async function apiGet(path) {
  return apiRequest(path, { method: "GET" });
}

async function warmBackendConnection({ force = false } = {}) {
  const now = Date.now();
  if (!force && backendWarmPromise && now - backendWarmAt < 120000) {
    return backendWarmPromise;
  }

  backendWarmAt = now;
  backendWarmPromise = fetch(`${API_BASE}/health`, { method: "GET" }).catch(() => null);
  return backendWarmPromise;
}

function setButtonBusy(button, isBusy, busyLabel = "Procesando...") {
  if (!button) return;

  if (!button.dataset.idleLabel) {
    button.dataset.idleLabel = button.textContent.trim();
  }

  button.disabled = isBusy;
  button.classList.toggle("btn-busy", isBusy);
  button.setAttribute("aria-busy", String(isBusy));
  button.innerHTML = isBusy
    ? `<span class="btn-spinner" aria-hidden="true"></span><span>${busyLabel}</span>`
    : button.dataset.idleLabel;
}

async function login(email, password) {
  const data = await apiPost("/login", { email, password });
  setSession(data.user, data.token);
  return currentUser;
}

async function register(name, email, password) {
  return apiPost("/register", { name, email, password });
}

async function resendVerification(email) {
  return apiPost("/auth/resend-verification", { email });
}

async function requestPasswordReset(email) {
  return apiPost("/auth/forgot-password", { email });
}

async function resetPassword(token, password) {
  return apiPost("/auth/reset-password", { token, password });
}

async function verifyEmailToken(token) {
  return apiGet(`/auth/verify-email?token=${encodeURIComponent(token)}`);
}

async function restoreSessionFromToken() {
  const token = getStoredToken();
  if (!token) {
    clearSession();
    return null;
  }

  const data = await apiGet("/me");
  setSession(data.user, token);
  return currentUser;
}

function logout() {
  clearSession();
  location.reload();
}

function ensureAppEntryOverlay() {
  let overlay = qs("#appEntryOverlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "appEntryOverlay";
  overlay.className = "app-entry-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="app-entry-card">
      <div class="app-entry-mark">
        <img src="${BUSINESS_ASSETS.logo}" alt="${BUSINESS_PROFILE.name}" />
      </div>
      <div class="app-entry-kicker">Acceso privado</div>
      <div id="appEntryTitle" class="app-entry-title">Preparando tu panel</div>
      <div id="appEntryCopy" class="app-entry-copy">Estamos abriendo tu experiencia de ${BUSINESS_PROFILE.name}.</div>
      <div class="app-entry-progress"><span></span></div>
      <div class="app-entry-tags">
        <span>Recepcion</span>
        <span>Seguimiento</span>
        <span>Cuenta</span>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  return overlay;
}

function showAppEntryOverlay(message = "Preparando tu panel privado...") {
  const overlay = ensureAppEntryOverlay();
  const title = overlay.querySelector("#appEntryTitle");
  const copy = overlay.querySelector("#appEntryCopy");
  const firstName = String(currentUser?.name || BUSINESS_PROFILE.name).trim().split(/\s+/)[0] || BUSINESS_PROFILE.name;
  const roleLabel = formatRoleLabel(currentUser?.role || "cliente");

  if (title) title.textContent = `Bienvenido, ${firstName}`;
  if (copy) copy.textContent = `${message} Vista ${roleLabel} con una transicion mas limpia y premium.`;

  appEntryVisibleAt = Date.now();
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-visible"));
}

function hideAppEntryOverlay() {
  const overlay = qs("#appEntryOverlay");
  if (!overlay) return Promise.resolve();

  const elapsed = Date.now() - appEntryVisibleAt;
  const waitTime = Math.max(0, 520 - elapsed);

  return new Promise((resolve) => {
    setTimeout(() => {
      overlay.classList.remove("is-visible");
      setTimeout(() => {
        overlay.hidden = true;
        resolve();
      }, 240);
    }, waitTime);
  });
}

function ensureAppLoadingBanner() {
  const header = qs(".app-header-section");
  const welcomeBlock = header?.querySelector(".welcome-block");
  if (!header || !welcomeBlock) return null;

  let banner = qs("#appLoadingBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "appLoadingBanner";
    banner.className = "app-loading-banner";
    banner.hidden = true;
    welcomeBlock.insertAdjacentElement("afterend", banner);
  }

  return banner;
}

function setAppLoadingState(isLoading, message = "Cargando panel...") {
  const banner = ensureAppLoadingBanner();
  const appView = qs("#appView");
  if (!banner || !appView) return;

  if (isLoading) {
    banner.textContent = message;
    banner.hidden = false;
    appView.classList.add("app-view-busy");
    return;
  }

  banner.hidden = true;
  banner.textContent = "";
  appView.classList.remove("app-view-busy");
}

function getScreenRendererMap() {
  switch (currentUser?.role) {
    case "cliente":
      return {
        screenHome: renderClientHome,
        screenActivity: renderClientActivity,
        screenAccount: renderClientAccount,
      };
    case "gestor":
      return {
        screenHome: renderGestorHome,
        screenControl: renderGestorControl,
        screenRiders: renderGestorRidersActivity,
        screenLocal: renderGestorLocal,
        screenHistory: renderOperationalHistory,
      };
    case "repartidor":
      return {
        screenHome: renderRepartidorHome,
        screenDelivered: renderRepartidorDelivered,
      };
    case "cajera":
      return {
        screenHome: renderCashierHome,
        screenProduction: renderCashierProduction,
        screenHistory: renderOperationalHistory,
      };
    default:
      return {};
  }
}

function markDashboardDataDirty() {
  dashboardDataVersion += 1;
}

function renderScreenForCurrentRole(screenId, { force = false } = {}) {
  const resolvedScreen = resolveRoleScreen(screenId);
  const renderers = getScreenRendererMap();
  const renderer = renderers[resolvedScreen];
  if (!renderer || !currentUser) return false;

  const key = `${currentUser.role}:${resolvedScreen}`;
  if (!force && screenRenderVersions.get(key) === dashboardDataVersion) {
    return false;
  }

  renderer();
  screenRenderVersions.set(key, dashboardDataVersion);
  return true;
}

async function ensureScreenDataForCurrentRole(screenId) {
  const resolvedScreen = resolveRoleScreen(screenId);
  const needsLocalOrders =
    (currentUser?.role === "cajera" && ["screenHome", "screenProduction", "screenHistory"].includes(resolvedScreen)) ||
    (currentUser?.role === "gestor" && ["screenLocal", "screenHistory"].includes(resolvedScreen));

  if (needsLocalOrders && !dashboardResourceState.localOrdersLoaded) {
    const tbody = qs("#localOrdersBody");
    if (resolvedScreen === "screenLocal" && tbody) {
      tbody.innerHTML = tableEmptyRow(8, "Cargando pedidos del local...");
    }

    setAppLoadingState(true, resolvedScreen === "screenHistory" ? "Preparando historial operativo..." : "Preparando pedidos del local...");
    try {
      localOrdersCache = await apiGet("/local-orders").catch(() => []);
      dashboardResourceState.localOrdersLoaded = true;
      markDashboardDataDirty();
    } finally {
      setAppLoadingState(false);
    }
  }
}

function revealAuthenticatedApp(loadingMessage = "") {
  if (currentUser) {
    updateUIByRole();
    updateDashboardHero();
  }

  hide(qs("#authView"));
  show(qs("#appView"));
  syncSessionChrome();

  if (loadingMessage) {
    showAppEntryOverlay(loadingMessage);
  }
}

/* ============================================================
   LOAD DATA
============================================================ */
function applyDashboardPayload(payload = {}, { merge = false } = {}) {
  if (payload.user) {
    currentUser = payload.user;
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser));
  }

  const hasOrders = Array.isArray(payload.orders);
  const hasRiders = Array.isArray(payload.repartidores);
  const hasLocalOrders = Array.isArray(payload.localOrders);

  if (hasOrders || !merge) {
    ordersCache = hasOrders ? payload.orders : [];
  }

  if (hasRiders || !merge) {
    repartidoresCache = hasRiders ? payload.repartidores : [];
  }

  if (hasLocalOrders || !merge) {
    localOrdersCache = hasLocalOrders ? payload.localOrders : [];
  }

  if (Object.prototype.hasOwnProperty.call(payload, "localOrdersLoaded")) {
    dashboardResourceState.localOrdersLoaded = Boolean(payload.localOrdersLoaded);
  } else if (hasLocalOrders) {
    dashboardResourceState.localOrdersLoaded = true;
  } else if (!merge) {
    dashboardResourceState.localOrdersLoaded = false;
  }

  markDashboardDataDirty();
}

async function fetchDashboardPayload(screenId = getActiveScreenId()) {
  const resolvedScreen = resolveRoleScreen(screenId);
  const bootstrapPath = `/bootstrap?screen=${encodeURIComponent(resolvedScreen)}`;
  const shouldFetchLocalOrders =
    (currentUser?.role === "cajera" && ["screenHome", "screenProduction", "screenHistory"].includes(resolvedScreen)) ||
    (currentUser?.role === "gestor" && ["screenLocal", "screenHistory"].includes(resolvedScreen));

  try {
    const payload = await apiGet(bootstrapPath);
    const bootstrapHasLocalOrders = Array.isArray(payload?.localOrders);
    const localOrders = bootstrapHasLocalOrders
      ? payload.localOrders
      : shouldFetchLocalOrders
        ? await apiGet("/local-orders").catch(() => [])
        : [];

    return {
      user: payload?.user || null,
      orders: Array.isArray(payload?.orders) ? payload.orders : [],
      repartidores: Array.isArray(payload?.repartidores) ? payload.repartidores : [],
      localOrders,
      localOrdersLoaded: bootstrapHasLocalOrders ? Boolean(payload?.localOrdersLoaded) || shouldFetchLocalOrders : shouldFetchLocalOrders,
    };
  } catch (_error) {
    const shouldFetchRiders = currentUser?.role === "gestor";

    const [orders, repartidores, localOrders] = await Promise.all([
      apiGet("/orders"),
      shouldFetchRiders ? apiGet("/repartidores") : Promise.resolve([]),
      shouldFetchLocalOrders ? apiGet("/local-orders").catch(() => []) : Promise.resolve([]),
    ]);

    return {
      orders,
      repartidores,
      localOrders,
      localOrdersLoaded: shouldFetchLocalOrders,
    };
  }
}

async function loadAll({ screenId = getActiveScreenId(), merge = false } = {}) {
  const resolvedScreen = resolveRoleScreen(screenId);
  const payload = await fetchDashboardPayload(resolvedScreen);
  applyDashboardPayload(payload, { merge });

  updateUIByRole();
  updateDashboardHero();
  renderScreenForCurrentRole(resolvedScreen, { force: true });

  return payload;
}

function isElementVisible(element) {
  if (!element || element.hidden) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function isAutoRefreshPausedByInteraction() {
  const openOverlay = [
    "#detailModal",
    "#invoiceModal",
    "#confirmDialog",
    "#deliveryProofDialog",
    "#authActionPanel",
  ].some((selector) => isElementVisible(qs(selector)));

  if (openOverlay) return true;

  const active = document.activeElement;
  if (!active || active === document.body) return false;

  const isEditable =
    active.matches?.("input, textarea, select, [contenteditable='true']") ||
    active.closest?.("[contenteditable='true']");

  return Boolean(isEditable && active.closest("#appView, #authView"));
}

function shouldSkipAutoRefresh() {
  if (!currentUser || !getStoredToken()) return true;
  if (document.visibilityState === "hidden") return true;
  return isAutoRefreshPausedByInteraction();
}

async function autoRefreshDashboard({ force = false } = {}) {
  if (autoRefreshInFlight || shouldSkipAutoRefresh()) return false;

  const now = Date.now();
  if (!force && now - lastAutoRefreshAt < AUTO_REFRESH_FOCUS_THROTTLE_MS) {
    return false;
  }

  autoRefreshInFlight = true;
  lastAutoRefreshAt = now;

  try {
    const activeScreen = resolveRoleScreen(getActiveScreenId());
    const payload = await fetchDashboardPayload(activeScreen);
    applyDashboardPayload(payload, { merge: true });

    updateUIByRole();
    updateDashboardHero();
    renderScreenForCurrentRole(activeScreen, { force: true });

    return true;
  } catch (_error) {
    return false;
  } finally {
    autoRefreshInFlight = false;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!currentUser || !getStoredToken()) return;

  autoRefreshTimer = window.setInterval(() => {
    autoRefreshDashboard();
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (!autoRefreshTimer) return;
  window.clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

function attachAutoRefreshEvents() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      autoRefreshDashboard({ force: true });
    }
  });

  window.addEventListener("focus", () => {
    autoRefreshDashboard();
  });
}

/* ============================================================
   UI BY ROLE
============================================================ */
function updateUIByRole() {
  const preferredScreen = resolveRoleScreen(getActiveScreenId());
  qs("#welcomeTitle").textContent = `Hola, ${currentUser.name}`;
  const roleLabel = qs("#roleLabel");
  if (roleLabel) roleLabel.textContent = formatRoleLabel(currentUser.role);

  // nav
  const navActivity = qs("[data-screen-target='screenActivity']");
  const navPremium = qs("[data-screen-target='screenPremium']");
  const navDelivered = qs("#navDelivered");
  const navProduction = qs("#navProduction");
  const navControl = qs("#navControl");
  const navRiders = qs("#navRiders");
  const navLocal = qs("#navLocal");
  const navHistory = qs("#navHistory");

  // cards cliente
  const nextOrderCard = qs("#nextOrderCard");
  const quickOrderCard = qs("#quickOrderCard");
  const serviceCard = qs("#serviceExperienceCard");
  const communicationCard = qs("#clientCommunicationCard");

  // panels
  const gestorPanel = qs("#gestorHomePanel");
  const repPanel = qs("#repartidorHomePanel");
  const cashierPanel = qs("#cashierHomePanel");

  // reset
  show(navActivity); show(navPremium);
  hide(navDelivered); hide(navProduction); hide(navControl); hide(navRiders); hide(navLocal); hide(navHistory);

  show(nextOrderCard); show(quickOrderCard); show(serviceCard); show(communicationCard);
  hide(gestorPanel); hide(repPanel); hide(cashierPanel);
  syncSessionChrome();

  // Perfil
  if (qs("#profileName")) qs("#profileName").value = currentUser.name || "";
  if (qs("#profileEmail")) qs("#profileEmail").value = currentUser.email || "";
  if (qs("#profileRole")) qs("#profileRole").value = formatRoleLabel(currentUser.role);

  // Cliente
  if (currentUser.role === "cliente") {
    qs("#welcomeSubtitle").textContent = "Ordena tu servicio y sigue tu pedido.";
    showScreen(preferredScreen, { skipData: true, skipRender: true });
    return;
  }

  // Gestor
  if (currentUser.role === "gestor") {
    hide(navActivity); hide(navPremium);
    hide(navDelivered); hide(navProduction); show(navControl); show(navRiders); show(navLocal); show(navHistory);
    hide(nextOrderCard); hide(quickOrderCard); hide(serviceCard); hide(communicationCard);
    show(gestorPanel);
    qs("#welcomeSubtitle").textContent = "Administra pedidos, asignaciones, local y repartidores.";
    showScreen(preferredScreen, { skipData: true, skipRender: true });
    return;
  }

  // Repartidor
  if (currentUser.role === "repartidor") {
    hide(navActivity); hide(navPremium);
    show(navDelivered); hide(navProduction); hide(navControl); hide(navRiders); hide(navLocal); hide(navHistory);
    hide(nextOrderCard); hide(quickOrderCard); hide(serviceCard); hide(communicationCard);
    show(repPanel);
    qs("#welcomeSubtitle").textContent = "Gestiona tus pedidos asignados y actualiza estados.";
    showScreen(preferredScreen, { skipData: true, skipRender: true });
    return;
  }

  // Cajera
  if (currentUser.role === "cajera") {
    hide(navActivity); hide(navPremium);
    hide(navDelivered); show(navProduction); hide(navControl); hide(navRiders); hide(navLocal); show(navHistory);
    hide(nextOrderCard); hide(quickOrderCard); hide(serviceCard); hide(communicationCard);
    show(cashierPanel);
    qs("#welcomeSubtitle").textContent = "Caja: registra pedidos del local con libras.";
    showScreen(preferredScreen, { skipData: true, skipRender: true });
    return;
  }
}

/* ============================================================
   CLIENTE: CREATE ORDER (domicilio)
============================================================ */
async function onCreateOrder(e) {
  e.preventDefault();

  const extras = Array.from(qs("#quickOrderForm").querySelectorAll(".chip input:checked"))
    .map((i) => i.value);

  const body = {
    userId: currentUser.id,
    address: qs("#homeAddress").value.trim(),
    zone: qs("#homeZone").value,
    serviceType: qs("#homePickupType").value,
    date: qs("#homeDate").value,
    time: qs("#homeTime").value,
    pack: qs("#homeServicePack").value,
    extras,
    notes: qs("#homeNotes").value.trim(),
  };

  try {
    await apiPost("/orders", body);
    alert("Pedido creado ✅");
    qs("#quickOrderForm").reset();
    await loadAll();
  } catch (err) {
    alert(err.message || "Error creando pedido");
  }
}

function renderClientHome() {
  const my = ordersCache.filter((o) => o.userId === currentUser.id);
  const active = my.find((o) => o.status !== "entregado" && o.status !== "cancelado");

  if (!active) {
    qs("#nextOrderStatus").textContent = "Sin pedidos";
    qs("#nextOrderInfo").textContent = "Cuando crees un pedido, verás aquí su estado.";
    return;
  }

  qs("#nextOrderStatus").textContent = active.status;

  let info = `${fmtDate(active.date)} · ${active.time} · ${active.zone}`;
  if (active.repartidorName) info += ` · Repartidor: ${active.repartidorName}`;

  if (canCancel(active)) {
    qs("#nextOrderInfo").innerHTML = `
      ${info}<br/>
      <button class="btn btn-small btn-outline" id="homeCancelBtn">Cancelar (5 min)</button>
    `;
    qs("#homeCancelBtn").addEventListener("click", () => cancelOrder(active.id));
  } else {
    qs("#nextOrderInfo").textContent = info;
  }
}

function renderClientActivity() {
  const timeline = qs("#activityTimeline");
  timeline.innerHTML = "";

  const my = ordersCache.filter((o) => o.userId === currentUser.id);

  my.forEach((o) => {
    const li = document.createElement("li");
    li.className = "timeline-item";
    li.innerHTML = `
      <div class="timeline-icon">🧺</div>
      <div class="timeline-content">
        <div class="timeline-title">Pedido #${o.id} · ${o.status}</div>
        <div class="timeline-meta">${fmtDate(o.date)} · ${o.zone} · ${o.repartidorName || "Sin asignar"}</div>
        <div class="timeline-actions">
          <button class="btn btn-small" data-factura="${o.id}">Factura</button>
          ${canCancel(o) ? `<button class="btn btn-small btn-outline" data-cancel="${o.id}">Cancelar</button>` : ""}
        </div>
      </div>
    `;
    timeline.appendChild(li);
  });

  qsa("[data-factura]").forEach((b) => b.addEventListener("click", openInvoice));
  qsa("[data-cancel]").forEach((b) => b.addEventListener("click", (ev) => cancelOrder(ev.target.dataset.cancel)));
}

/* ============================================================
   GESTOR: HOME (pendientes + en proceso)
============================================================ */
function renderGestorHome() {
  const pendientes = ordersCache.filter((o) => o.channel !== "local" && o.status === "pendiente");
  const enProceso = ordersCache.filter(
    (o) =>
      o.channel !== "local" &&
      o.status !== "pendiente" &&
      o.status !== "entregado" &&
      o.status !== "cancelado"
  );

  qs("#gestorActiveCount").textContent = ordersCache.filter((o) => o.channel !== "local").length;
  qs("#gestorTodayCount").textContent = ordersCache.filter((o) => o.channel !== "local").length;
  qs("#gestorClientsCount").textContent = new Set(ordersCache.filter(o=>o.channel!=="local").map((o) => o.userId)).size;

  // tabla asignación
  const tbody = qs("#gestorAssignBody");
  tbody.innerHTML = "";

  pendientes.forEach((o) => {
    const reps = repartidoresCache.filter((r) => r.zone === o.zone);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.zone}</td>
      <td>${o.date}</td>
      <td>${o.status}</td>
      <td>
        <select data-assign="${o.id}">
          <option value="">Elegir…</option>
          ${reps.map((r) => `<option value="${r.id}">${r.name}</option>`).join("")}
        </select>
      </td>
      <td><button class="btn btn-small" data-factura="${o.id}">Ver</button></td>
      <td><button class="btn btn-small" data-detalle="${o.id}">Ver</button></td>
      <td><button class="btn btn-primary btn-small" data-save="${o.id}">Asignar</button></td>
    `;
    tbody.appendChild(tr);
  });

  qsa("[data-save]").forEach((btn) => btn.addEventListener("click", gestorAssign));
  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openInvoice));

  // tabla en proceso (inyectada)
  let card = qs("#gestorInProgressCard");
  if (!card) {
    card = document.createElement("div");
    card.className = "role-panel";
    card.id = "gestorInProgressCard";
    card.innerHTML = `
      <div class="card" style="margin-top:.75rem;">
        <div class="card-title">Pedidos asignados / en proceso</div>
        <div class="role-table-wrapper" style="margin-top:0.5rem;">
          <table class="role-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Zona</th>
                <th>Dirección</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Repartidor</th>
                <th>Factura</th>
                <th>Detalles</th>
              </tr>
            </thead>
            <tbody id="gestorInProgressBody"></tbody>
          </table>
        </div>
      </div>
    `;
    qs("#gestorHomePanel").appendChild(card);
  }

  const body2 = qs("#gestorInProgressBody");
  body2.innerHTML = "";

  enProceso.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.zone}</td>
      <td>${o.address}</td>
      <td>${o.date} ${o.time}</td>
      <td>${o.status}</td>
      <td>${o.repartidorName || "-"}</td>
      <td><button class="btn btn-small" data-factura="${o.id}">Ver</button></td>
      <td><button class="btn btn-small" data-detalle="${o.id}">Ver</button></td>
    `;
    body2.appendChild(tr);
  });

  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openInvoice));
}

async function gestorAssign(ev) {
  const orderId = ev.target.dataset.save;
  const select = qs(`select[data-assign="${orderId}"]`);
  const repartidorId = select.value;
  if (!repartidorId) return alert("Elige un repartidor");

  try {
    await apiPut(`/orders/${orderId}/assign`, { repartidorId });
    await loadAll();
  } catch (err) {
    alert(err.message || "Error asignando");
  }
}

/* ============================================================
   GESTOR: RIDERS ACTIVITY (meta 30 por zona)
============================================================ */
function renderGestorRidersActivity() {
  const container = qs("#ridersActivity");
  if (!container) return;
  container.innerHTML = "";

  const today = new Date().toISOString().slice(0, 10);

  const zones = {};
  repartidoresCache.forEach((rep) => {
    const z = rep.zone || "Distrito Nacional";
    if (!zones[z]) zones[z] = [];
    zones[z].push(rep);
  });

  Object.keys(zones).forEach((zone) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-title">Zona ${zone}</div>`;
    container.appendChild(card);

    zones[zone].forEach((rep) => {
      const count = ordersCache.filter((o) => o.repartidorId === rep.id && o.date === today).length;
      const meta = 30;
      const pct = Math.min((count / meta) * 100, 100);
      const faltan = Math.max(meta - count, 0);

      const block = document.createElement("div");
      block.className = "rider-progress-block";
      block.innerHTML = `
        <div class="card-line">
          <span class="card-label">${rep.name}</span>
          <span class="status-pill">${count}/${meta}</span>
        </div>
        <div class="progress-row">
          <div class="progress-bar">
            <div class="progress-fill" style="width:${pct}%"></div>
          </div>
          <span class="progress-text">Te faltan ${faltan} para tener un bono y comisión, vamos que tú puedes 💪</span>
        </div>
      `;
      card.appendChild(block);
    });
  });
}

/* ============================================================
   GESTOR: LOCAL TAB
============================================================ */
function renderGestorLocal() {
  const tbody = qs("#localOrdersBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  localOrdersCache.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.phone || "—"}</td>
      <td>${o.lbs || 0}</td>
      <td>${o.pack}</td>
      <td>${o.status}</td>
      <td><button class="btn btn-small" data-factura="${o.id}">Ver</button></td>
      <td><button class="btn btn-small" data-detalle="${o.id}">Ver</button></td>
    `;
    tbody.appendChild(tr);
  });

  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openInvoice));
}

/* ============================================================
   REPARTIDOR: HOME
============================================================ */
function renderRepartidorHome() {
  const assigned = ordersCache.filter((o) => o.repartidorId === currentUser.id);
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = assigned.filter((o) => o.date === today).length;

  const meta = 30;
  const extra = Math.max(todayCount - meta, 0);
  const comision = extra * 50;

  qs("#repartidorMetaText").textContent = `Meta ${todayCount}/${meta}. Comisión: RD$ ${comision}`;

  const tbody = qs("#repartidorOrdersBody");
  tbody.innerHTML = "";

  assigned.forEach((o) => {
    const stRecibido = "recibido";
    const stCamino = "en camino";
    const stEntregado = "entregado";

    const disRecibido = !canMoveTo(o.status, stRecibido);
    const disCamino = !canMoveTo(o.status, stCamino);
    const disEntregado = !canMoveTo(o.status, stEntregado);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.zone}</td>
      <td>${o.address}</td>
      <td>${o.date} ${o.time}</td>
      <td><input type="number" min="0" step="0.1" data-lbs="${o.id}" value="${o.lbs || 0}"></td>
      <td>${o.status}</td>
      <td>
        <button class="btn btn-small" data-factura="${o.id}">Factura</button>
        <button class="btn btn-small" data-detalle="${o.id}">Detalles</button>
      </td>
      <td>
        <button class="btn btn-small" data-state="recibido" data-id="${o.id}" ${disRecibido ? "disabled" : ""}>Recibido</button>
        <button class="btn btn-small" data-state="camino" data-id="${o.id}" ${disCamino ? "disabled" : ""}>Camino</button>
        <button class="btn btn-small" data-state="entregado" data-id="${o.id}" ${disEntregado ? "disabled" : ""}>Entregado</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  qsa("[data-state]").forEach((btn) => btn.addEventListener("click", repartidorUpdateStatus));
  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openInvoice));
}

async function repartidorUpdateStatus(ev) {
  const orderId = ev.target.dataset.id;
  const state = ev.target.dataset.state;

  const order = ordersCache.find((o) => o.id == orderId);
  if (!order) return;

  const lbs = parseFloat(qs(`[data-lbs="${orderId}"]`).value || "0");

  const map = {
    recibido: "recibido",
    camino: "en camino",
    entregado: "entregado",
  };
  const targetStatus = map[state];

  if (!canMoveTo(order.status, targetStatus)) {
    return alert("No puedes retroceder el estado.");
  }

  try {
    await apiPut(`/orders/${orderId}/status`, { status: targetStatus, lbs });
    await loadAll();
  } catch (err) {
    alert(err.message || "Error cambiando estado");
  }
}

/* ============================================================
   CAJERA: CREATE LOCAL ORDER
============================================================ */
function renderCashierHome() {
  qs("#cashierLocalOpsCard")?.remove();
}

function renderCashierProduction() {
  const panel = qs("#cashierProductionPanel");
  if (!panel) return;

  panel.innerHTML = `<div id="cashierLocalOpsCard" class="card local-ops-card"></div>`;
  renderLocalOperationsPanel(qs("#cashierLocalOpsCard"), {
    title: "Mesa de produccion",
    subtitle: "Recibe, pesa y mueve los pedidos del local desde una vista dedicada.",
    orders: getLocalOperationOrders(),
  });
}

async function onCreateLocalOrder(e) {
  e.preventDefault();

  const extras = Array.from(qs("#cashierForm").querySelectorAll(".chip input:checked"))
    .map((i) => i.value);

  const body = {
    customerName: qs("#cashierName").value.trim(),
    customerPhone: qs("#cashierPhone").value.trim(),
    customerEmail: qs("#cashierEmail").value.trim(),
    lbs: parseFloat(qs("#cashierLbs").value || "0"),
    pack: qs("#cashierPack").value,
    extras,
    notes: qs("#cashierNotes").value.trim(),
  };

  try {
    await apiPost("/local-orders", body);
    alert("Pedido local creado ✅");
    qs("#cashierForm").reset();
    await loadAll();
  } catch (err) {
    alert(err.message || "Error creando pedido local");
  }
}

/* ============================================================
   FACTURA (modal)
============================================================ */
function money(n) {
  return `RD$ ${(Number(n) || 0).toFixed(2)}`;
}

function openInvoice(ev) {
  const id = ev.target.dataset.factura || ev.target.dataset.detalle;

  // buscar en domicilio + local
  let order = ordersCache.find((o) => o.id == id);
  if (!order) order = localOrdersCache.find((o) => o.id == id);
  if (!order) return alert("Pedido no encontrado");

  qs("#invoiceSubtitle").textContent = `Pedido #${order.id} (${order.channel || "domicilio"})`;

  const attendedBy = order.repartidorName ? `Atendido por: ${order.repartidorName}` : "";
  const linesHistory = (order.history || [])
    .slice(-5)
    .map((h) => `• ${h.status} (${h.by}) ${fmtTime(h.at)}`)
    .join("<br/>");

  qs("#invoiceClient").innerHTML = `
    <strong>${order.userName}</strong><br/>
    Zona: ${order.zone || "—"}<br/>
    Dirección: ${order.address || "—"}<br/>
    Tel: ${order.phone || "—"}<br/>
    ${attendedBy ? attendedBy + "<br/>" : ""}
    <span style="color:var(--muted); font-size:12.5px;">Últimos movimientos:</span><br/>
    <span style="color:var(--muted); font-size:12.5px;">${linesHistory || "—"}</span>
  `;

  // ==== CALCULO DEMO ====
  // Libra normal: RD$30/lb
  // Extras: RD$75 c/u
  // Pack puede sumarse RD$0 (por ahora es solo texto)
  const lbs = Number(order.lbs || 0);
  const base = lbs * 30;

  const extrasCount = (order.extras || []).length;
  const extrasTotal = extrasCount * 75;

  const subtotal = base + extrasTotal;
  const itbis = subtotal * 0.18;
  const total = subtotal + itbis;

  qs("#invoiceLines").innerHTML = `
    <tr>
      <td>Ropa por libra</td>
      <td>${lbs.toFixed(1)} lb</td>
      <td>${money(30)}</td>
      <td>${money(base)}</td>
    </tr>
    ${
      extrasCount
        ? `<tr>
            <td>Extras (${order.extras.join(", ")})</td>
            <td>${extrasCount}</td>
            <td>${money(75)}</td>
            <td>${money(extrasTotal)}</td>
          </tr>`
        : ""
    }
  `;

  qs("#invoiceSubtotal").textContent = money(subtotal);
  qs("#invoiceItbis").textContent = money(itbis);
  qs("#invoiceTotal").textContent = money(total);

  // Footer demo
  qs("#invoiceFooterText").textContent =
    "Ejemplo de factura · ITBIS 18% · Cuentas: BHD 33008190011 | Popular 831576806";

  // imprimir solo gestor / repartidor
  const printBtn = qs("#invoicePrintBtn");
  if (currentUser.role === "gestor" || currentUser.role === "repartidor") {
    show(printBtn);
  } else {
    hide(printBtn);
  }

  qs("#invoiceModal").style.display = "flex";
}

function closeInvoice() {
  qs("#invoiceModal").style.display = "none";
}

function printInvoice() {
  window.print();
}

/* ============================================================
   CANCEL ORDER
============================================================ */
async function cancelOrder(orderId) {
  const confirmed = await showConfirmDialog("Seguro que deseas cancelar el pedido?", {
    title: "Cancelar pedido",
    confirmLabel: "Si, cancelar",
    cancelLabel: "Volver",
  });
  if (!confirmed) return;

  try {
    await apiPut(`/orders/${orderId}/cancel`, {});
    alert("Pedido cancelado ✅");
    await loadAll();
  } catch (err) {
    alert(err.message || "No se pudo cancelar");
  }
}

/* ============================================================
   UI OVERRIDES
============================================================ */
async function onCreateOrder(e) {
  e.preventDefault();

  const extras = Array.from(qs("#quickOrderForm").querySelectorAll(".chip input:checked"))
    .map((i) => i.value);

  const body = {
    userId: currentUser.id,
    address: qs("#homeAddress").value.trim(),
    phone: qs("#homeContactPhone")?.value.trim() || "",
    location: homeLocation ? { ...homeLocation } : null,
    zone: qs("#homeZone").value,
    serviceType: qs("#homePickupType").value,
    date: qs("#homeDate").value,
    time: qs("#homeTime").value,
    pack: qs("#homeServicePack").value,
    extras,
    notes: qs("#homeNotes").value.trim(),
  };

  try {
    await apiPost("/orders", body);
    alert("Pedido creado correctamente.");
    qs("#quickOrderForm").reset();
    setDefaultFormValues();
    await loadAll();
  } catch (err) {
    alert(err.message || "Error creando pedido");
  }
}

function compactMoney(value) {
  const amount = Number(value) || 0;
  if (amount >= 1000000) return `RD$ ${(amount / 1000000).toFixed(amount >= 10000000 ? 0 : 1)}M`;
  if (amount >= 1000) return `RD$ ${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}k`;
  return money(amount);
}

function getClientCareTier(totalOrders) {
  if (totalOrders >= 8) return "Cliente Signature";
  if (totalOrders >= 4) return "Cliente Frecuente";
  if (totalOrders >= 1) return "Cliente Activo";
  return "Cuenta nueva";
}

function getClientVerificationBadgeMarkup() {
  if (currentUser?.emailVerified) {
    return `
      <div class="estimate-badge is-verified" aria-label="Cuenta verificada">
        <span class="estimate-badge-icon" aria-hidden="true">✓</span>
        <span class="estimate-badge-copy">
          <strong>Cuenta verificada</strong>
          <small>Correo confirmado</small>
        </span>
      </div>
    `;
  }

  return `
    <div class="estimate-badge is-neutral" aria-label="Cuenta lista">
      <span class="estimate-badge-icon" aria-hidden="true">•</span>
      <span class="estimate-badge-copy">
        <strong>Cuenta lista</strong>
        <small>Correo pendiente</small>
      </span>
    </div>
  `;
}

function buildClientOrderStats(clientOrders) {
  const my = sortByNewestId(clientOrders);
  const activeOrders = my.filter((order) => !isClosedOrderStatus(order.status));
  const delivered = my.filter((order) => isFinalDeliveryStatus(order.status));
  const cancelled = my.filter((order) => String(order.status || "").toLowerCase().includes("cancel"));
  const favoriteCounts = new Map();
  let estimatedRevenue = 0;
  let gpsReadyCount = 0;

  my.forEach((order) => {
    getOrderPacks(order).forEach((pack) => {
      favoriteCounts.set(pack, (favoriteCounts.get(pack) || 0) + 1);
    });
    estimatedRevenue += Number(buildOrderChargeBreakdown(order).total || 0);
    if (getOrderHighlightFlags(order).hasGps) gpsReadyCount += 1;
  });

  return {
    my,
    active: activeOrders[0] || null,
    activeCount: activeOrders.length,
    delivered,
    cancelled,
    recentOrder: my[0] || null,
    recentDelivered: delivered[0] || null,
    favoritePack: [...favoriteCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Lavado + Planchado",
    estimatedRevenue,
    gpsReadyCount,
  };
}

function getClientActivityFilters(stats) {
  return [
    { key: "all", label: "Todo", count: stats.my.length },
    { key: "active", label: "Activos", count: stats.activeCount },
    { key: "delivered", label: "Entregados", count: stats.delivered.length },
    { key: "cancelled", label: "Cancelados", count: stats.cancelled.length },
  ];
}

function getFilteredClientOrders(stats, filterKey) {
  const normalized = String(filterKey || "all").toLowerCase();
  if (normalized === "active") {
    return stats.my.filter((order) => !isClosedOrderStatus(order.status));
  }
  if (normalized === "delivered") return stats.delivered;
  if (normalized === "cancelled") return stats.cancelled;
  return stats.my;
}

function getOrderLatestMovementText(order) {
  const history = Array.isArray(order?.history) ? order.history : [];
  const last = history[history.length - 1];
  if (!last) return "Seguimiento disponible tan pronto el servicio tenga nuevos movimientos.";

  const actor = String(last.by || "").trim() || "sistema";
  const time = last.at ? fmtTime(last.at) : "";
  return `${formatStatusLabel(last.status)} (${actor})${time ? ` | ${time}` : ""}`;
}

function getOrderPrimaryPackLabel(order) {
  const packs = getOrderPacks(order);
  return packs.join(", ") || order?.pack || "Servicio general";
}

function getClientCommunicationSummary(order) {
  if (!order) {
    return {
      eyebrow: "Centro de comunicacion",
      title: "Avisos listos para tu proximo servicio",
      copy: "Cuando crees un pedido, aqui veras que correos debe recibir el cliente y el canal directo de soporte.",
      statusLabel: currentUser?.emailVerified ? "Correo activo" : "Correo pendiente",
    };
  }

  const status = normalizeStatusValue(order.status);
  if (isCancelledStatus(status)) {
    return {
      eyebrow: `Pedido #${order.id}`,
      title: "Servicio cancelado",
      copy: "El historial queda guardado y soporte puede ayudarte a reprogramar si necesitas una nueva recogida.",
      statusLabel: "Sin avisos activos",
    };
  }

  if (getStatusRank(status) >= getStatusRank("entregado al cliente")) {
    return {
      eyebrow: `Pedido #${order.id}`,
      title: "Entrega confirmada por correo",
      copy: "El cliente debe tener el cierre del servicio en su correo y el detalle disponible en su cuenta.",
      statusLabel: "Servicio cerrado",
    };
  }

  if (getStatusRank(status) >= getStatusRank("recibido en local")) {
    return {
      eyebrow: `Pedido #${order.id}`,
      title: "Tu pedido ya esta en el local",
      copy: "El aviso de recepcion en local mantiene al cliente tranquilo mientras el equipo prepara el tratamiento.",
      statusLabel: "Avisos activos",
    };
  }

  if (getStatusRank(status) >= getStatusRank("en camino a recoger")) {
    return {
      eyebrow: `Pedido #${order.id}`,
      title: "Ruta en camino a tu direccion",
      copy: "El cliente recibe el primer aviso importante: el repartidor ya va hacia el punto de recogida.",
      statusLabel: "Ruta notificada",
    };
  }

  return {
    eyebrow: `Pedido #${order.id}`,
    title: "Avisos preparados",
    copy: "El pedido esta listo para activar correos automaticos cuando avance la ruta o entre al local.",
    statusLabel: "En espera",
  };
}

function getClientNotificationMoments(order) {
  const hasTrackableOrder = Boolean(order) && !isCancelledStatus(order.status);
  const statusRank = hasTrackableOrder ? getStatusRank(order.status) : -1;
  const moments = [
    {
      status: "en camino a recoger",
      label: "Ruta al cliente",
      copy: "Correo cuando el repartidor salga a recoger.",
    },
    {
      status: "recibido en local",
      label: "En local",
      copy: "Correo cuando las prendas lleguen al local.",
    },
    {
      status: "entregado al cliente",
      label: "Entregado",
      copy: "Correo final cuando el servicio cierre.",
    },
  ];

  let activeAssigned = false;
  return moments.map((moment) => {
    const done = statusRank >= getStatusRank(moment.status);
    const active = hasTrackableOrder && !done && !activeAssigned;
    if (active) activeAssigned = true;
    return { ...moment, done, active };
  });
}

function renderClientCommunicationPanel(stats) {
  const activeOrder = stats.active || stats.recentOrder || null;
  const summary = getClientCommunicationSummary(activeOrder);
  const emailReady = Boolean(currentUser?.emailVerified);
  const supportSubject = activeOrder ? `pedido #${activeOrder.id}` : "mi cuenta";
  const supportMessage = encodeURIComponent(`Hola, necesito ayuda con ${supportSubject} de ${BUSINESS_PROFILE.name}.`);
  const latestMovement = activeOrder ? getOrderLatestMovementText(activeOrder) : "Sin movimientos todavia. Tu primer pedido activara esta bitacora.";
  const moments = getClientNotificationMoments(activeOrder);

  return `
    <div class="communication-shell">
      <div class="communication-head">
        <div>
          <div class="estimate-kicker">${escapeHtml(summary.eyebrow)}</div>
          <div class="communication-title">${escapeHtml(summary.title)}</div>
          <div class="communication-copy">${escapeHtml(summary.copy)}</div>
        </div>
        <div class="communication-status ${emailReady ? "is-ready" : "is-pending"}">
          <span>${emailReady ? "OK" : "!"}</span>
          <strong>${emailReady ? "Correo activo" : "Correo pendiente"}</strong>
          <small>${emailReady ? "Listo para avisos automaticos" : "Verifica tu correo para recibir avisos"}</small>
        </div>
      </div>

      <div class="communication-moments" aria-label="Momentos de correo automatico">
        ${moments.map((moment, index) => `
          <div class="communication-moment ${moment.done ? "is-done" : ""} ${moment.active ? "is-active" : ""}">
            <b>${String(index + 1).padStart(2, "0")}</b>
            <div>
              <strong>${escapeHtml(moment.label)}</strong>
              <span>${escapeHtml(moment.done ? "Aviso completado" : moment.copy)}</span>
            </div>
          </div>
        `).join("")}
      </div>

      <div class="communication-grid">
        <div class="communication-info">
          <span>Ultimo movimiento</span>
          <strong>${escapeHtml(latestMovement)}</strong>
        </div>
        <div class="communication-info">
          <span>Estado de avisos</span>
          <strong>${escapeHtml(summary.statusLabel)}</strong>
        </div>
      </div>

      <div class="communication-actions">
        <a class="btn btn-small" href="https://wa.me/${BUSINESS_PHONE_DIGITS}?text=${supportMessage}" target="_blank" rel="noreferrer">WhatsApp</a>
        <a class="btn btn-small btn-outline" href="tel:+${BUSINESS_PHONE_DIGITS}">Llamar</a>
        <a class="btn btn-small btn-outline" href="mailto:${BUSINESS_PROFILE.email}">Correo</a>
        <button class="btn btn-small btn-outline" type="button" data-go-communication-activity="1">Ver actividad</button>
      </div>
    </div>
  `;
}

function renderClientHome() {
  const stats = buildClientOrderStats(ordersCache.filter((o) => o.userId === currentUser.id));
  const { my, active, activeCount, delivered, cancelled, recentOrder, recentDelivered, favoritePack, gpsReadyCount } = stats;
  const nextOrderCard = qs("#nextOrderCard");
  const serviceCard = qs("#serviceExperienceCard");
  const quickOrderCard = qs("#quickOrderCard");
  const homeLayout = qs(".home-client-layout");
  let executiveCard = qs("#clientExecutiveCard");
  let communicationCard = qs("#clientCommunicationCard");
  const careTier = getClientCareTier(my.length);
  const greetingName = String(currentUser?.name || "Cliente").trim().split(/\s+/)[0] || "Cliente";
  const focusZone = active?.zone || recentOrder?.zone || "Distrito Nacional";
  const supportMessage = encodeURIComponent(`Hola, necesito ayuda con mi cuenta en ${BUSINESS_PROFILE.name}.`);

  if (!executiveCard && (homeLayout || quickOrderCard)) {
    executiveCard = document.createElement("div");
    executiveCard.id = "clientExecutiveCard";
    executiveCard.className = "card card-spaced client-executive-card";
  }

  if (executiveCard) {
    if (homeLayout) {
      homeLayout.insertAdjacentElement("beforebegin", executiveCard);
    } else if (quickOrderCard) {
      quickOrderCard.insertAdjacentElement("beforebegin", executiveCard);
    }
  }

  if (!communicationCard && (homeLayout || quickOrderCard || executiveCard)) {
    communicationCard = document.createElement("div");
    communicationCard.id = "clientCommunicationCard";
    communicationCard.className = "card card-spaced client-communication-card";
  }

  if (communicationCard) {
    if (executiveCard?.parentElement) {
      executiveCard.insertAdjacentElement("afterend", communicationCard);
    } else if (homeLayout) {
      homeLayout.insertAdjacentElement("beforebegin", communicationCard);
    } else if (quickOrderCard) {
      quickOrderCard.insertAdjacentElement("beforebegin", communicationCard);
    }
    communicationCard.innerHTML = renderClientCommunicationPanel(stats);
  }

  if (nextOrderCard) {
    nextOrderCard.classList.add("home-focus-card");
    nextOrderCard.classList.toggle("home-focus-card-active", Boolean(active));
    nextOrderCard.classList.toggle("home-focus-card-empty", !active);

    if (!active) {
      nextOrderCard.innerHTML = `
        <div class="home-focus-shell home-focus-shell-empty">
          <div class="home-focus-top">
            <div>
              <div class="estimate-kicker">Private care</div>
              <div class="home-focus-title">Tu siguiente servicio aun no ha comenzado</div>
              <div class="card-secondary">Dejamos este espacio listo para que tu pedido activo se vea como una experiencia premium: clara, elegante y facil de seguir.</div>
            </div>
            <div class="estimate-badge">Agenda abierta</div>
          </div>
          <div class="home-focus-grid">
            <div class="home-focus-item">
              <span>Estado</span>
              <strong>Sin pedidos activos</strong>
              <small>Tu primera solicitud aparecera aqui con estatus, monto y seguimiento.</small>
            </div>
            <div class="home-focus-item">
              <span>Horario</span>
              <strong>${escapeHtml(BUSINESS_PROFILE.schedule)}</strong>
              <small>Recepcion, lavado y entrega listos para coordinar cuando quieras.</small>
            </div>
            <div class="home-focus-item">
              <span>Cuenta</span>
              <strong>${currentUser?.emailVerified ? "Correo verificado" : "Cuenta lista"}</strong>
              <small>${escapeHtml(careTier)} con una portada pensada para clientes reales.</small>
            </div>
          </div>
          <div class="home-focus-note">
            <strong>Tu portada se vera mucho mejor desde el primer pedido.</strong>
            <span>Agenda la recogida, combina paquetes y deja que el seguimiento quede visible desde el inicio.</span>
          </div>
          <div class="brand-pill-row">
            <span class="estimate-tag">Recogida programada</span>
            <span class="estimate-tag">Seguimiento elegante</span>
            <span class="estimate-tag">Factura clara</span>
          </div>
          <div class="client-support-row home-focus-actions">
            <button class="btn btn-small" type="button" id="homeCreateServiceBtn">Solicitar servicio</button>
            <button class="btn btn-small btn-outline" type="button" id="homeGoActivityBtn">Ver actividad</button>
            <button class="btn btn-small btn-outline" type="button" id="homeGoAccountBtn">Cuenta</button>
          </div>
        </div>
      `;
    } else {
      const activeBreakdown = buildOrderChargeBreakdown(active);
      const activeLocation = getOrderLocation(active);
      const packs = getOrderPacks(active);
      const amountLabel = activeBreakdown.weightPending
        ? activeBreakdown.total > 0
          ? `Desde ${money(activeBreakdown.total)}`
          : "Total por confirmar"
        : money(activeBreakdown.total);
      const scheduleLabel = [fmtDate(active.date), fmtTime(active.time)].filter(Boolean).join(" | ");
      const routeLabel = active.repartidorName || "Asignacion pendiente";
      const locationLabel = activeLocation
        ? `Ubicacion valida para ${activeLocation.inferredZone || active.zone || "tu zona"}`
        : "Sin punto GPS. Se usa la direccion registrada.";

      nextOrderCard.innerHTML = `
        <div class="home-focus-shell">
          <div class="home-focus-top">
            <div>
              <div class="estimate-kicker">Pedido activo</div>
              <div class="home-focus-title">${escapeHtml(getOrderPrimaryPackLabel(active))}</div>
              <div class="card-secondary">${escapeHtml(active.serviceType || "Recogida coordinada")} | ${escapeHtml(describePricingMode(active.pricingMode))}</div>
            </div>
            <div class="home-focus-status">
              ${renderStatusBadge(active.status)}
            </div>
          </div>
          <div class="signal-chip-row">${renderSignalChips(active)}</div>
          ${renderClientTrackingExperience(active)}
          <div class="home-focus-grid">
            <div class="home-focus-item">
              <span>Agenda</span>
              <strong>${escapeHtml(scheduleLabel || "Pendiente")}</strong>
              <small>${escapeHtml(getOrderLatestMovementText(active))}</small>
            </div>
            <div class="home-focus-item">
              <span>Monto estimado</span>
              <strong>${escapeHtml(amountLabel)}</strong>
              <small>${escapeHtml(activeBreakdown.weightPending ? "El total final se confirma al pesar o revisar." : "Incluye cargos estimados visibles desde el inicio.")}</small>
            </div>
            <div class="home-focus-item">
              <span>Ruta</span>
              <strong>${escapeHtml(routeLabel)}</strong>
              <small>${escapeHtml(locationLabel)}</small>
            </div>
          </div>
          <div class="home-focus-note">
            <strong>${escapeHtml(active.address || "Direccion pendiente")}</strong>
            <span>${escapeHtml(active.zone || focusZone)} | ${escapeHtml(activeLocation ? "Seguimiento reforzado con GPS." : "Seguimiento apoyado por la direccion escrita.")}</span>
          </div>
          <div class="brand-pill-row">
            ${(packs.length ? packs : [active.pack || "Servicio general"]).map((pack) => `<span class="estimate-tag">${escapeHtml(pack)}</span>`).join("")}
            <span class="estimate-tag">${escapeHtml(active.zone || focusZone)}</span>
            <span class="estimate-tag ${activeLocation ? "" : "estimate-tag-muted"}">${activeLocation ? "GPS verificado" : "Direccion manual"}</span>
          </div>
          ${renderDeliveryCodeCard(active)}
          <div class="client-support-row home-focus-actions">
            <button class="btn btn-small" type="button" data-factura="${active.id}">Factura</button>
            <button class="btn btn-small btn-outline" type="button" data-detalle="${active.id}">Detalle</button>
            <button class="btn btn-small btn-outline" type="button" id="homeGoActivityBtn">Seguimiento</button>
            ${canCancel(active) ? `<button class="btn btn-small btn-outline" type="button" data-cancel-home="${active.id}">Cancelar (5 min)</button>` : `<button class="btn btn-small btn-outline" type="button" id="homeGoAccountBtn">Cuenta</button>`}
          </div>
        </div>
      `;
    }
  }

  if (serviceCard) {
    const recentDeliveredLabel = recentDelivered
      ? `${fmtDate(recentDelivered.date)} | ${getOrderPacks(recentDelivered).join(", ") || recentDelivered.pack || "Servicio general"}`
      : "Tu primera entrega confirmada aparecera aqui cuando completes un servicio.";

    serviceCard.innerHTML = `
      <div class="estimate-top">
        <div>
          <div class="estimate-kicker">Concierge ${escapeHtml(BUSINESS_PROFILE.name)}</div>
          <div class="estimate-title">${escapeHtml(careTier)} con una recepcion mas elegante y mejor organizada</div>
        </div>
        ${getClientVerificationBadgeMarkup()}
      </div>
      <div class="home-concierge-grid">
        <div class="home-concierge-card">
          <span>Zona de servicio</span>
          <strong>${escapeHtml(focusZone)}</strong>
          <small>Atencion alineada con tu sector y tu direccion registrada.</small>
        </div>
        <div class="home-concierge-card">
          <span>Pedidos con GPS</span>
          <strong>${gpsReadyCount}</strong>
          <small>${gpsReadyCount ? "Ubicaciones validadas para despacho." : "Activa tu ubicacion para una recepcion mas precisa."}</small>
        </div>
        <div class="home-concierge-card">
          <span>Ultima entrega</span>
          <strong>${recentDelivered ? fmtDate(recentDelivered.date) : "Pendiente"}</strong>
          <small>${escapeHtml(recentDeliveredLabel)}</small>
        </div>
      </div>
      <div class="attention-board">
        <div class="detail-section-title">Atencion signature</div>
        <div class="attention-list">
          <div class="attention-item">
            <div>
              <strong>Tu servicio mas usado</strong>
              <span>${escapeHtml(favoritePack)}</span>
            </div>
            <div class="attention-side">
              <small>${my.length} pedidos registrados</small>
            </div>
          </div>
          <div class="attention-item">
            <div>
              <strong>Soporte inmediato</strong>
              <span>Te asistimos por WhatsApp, llamada o correo si necesitas mover un servicio, ajustar una entrega o aclarar un detalle.</span>
            </div>
            <div class="attention-side">
              <small>${escapeHtml(BUSINESS_PROFILE.schedule)}</small>
            </div>
          </div>
        </div>
      </div>
      <div class="client-support-row client-support-links">
        <a class="btn btn-small btn-outline" href="https://wa.me/${BUSINESS_PHONE_DIGITS}?text=${supportMessage}" target="_blank" rel="noreferrer">WhatsApp</a>
        <a class="btn btn-small btn-outline" href="tel:+${BUSINESS_PHONE_DIGITS}">Llamar</a>
        <a class="btn btn-small btn-outline" href="mailto:${BUSINESS_PROFILE.email}">Correo</a>
      </div>
    `;
  }

  if (executiveCard) {
    const nextServiceLabel = active
      ? `${fmtDate(active.date)} ${fmtTime(active.time)} | ${escapeHtml(active.zone)}`
      : "Agenda tu primer servicio cuando quieras";
    const recentLabel = recentOrder
      ? `${fmtDate(recentOrder.date)} | ${escapeHtml(recentOrder.zone || "--")}`
      : "Aun sin historial";
    const heroTitle = active
      ? `${greetingName}, tu pedido ya luce mas claro, sobrio y premium`
      : `${greetingName}, tu cuenta esta lista para una recepcion mas elegante`;
    const heroNarrative = active
      ? "Desde esta portada sigues agenda, ruta, detalle y factura con una lectura mas limpia para revisar tu servicio sin ruido."
      : "Preparamos un lobby privado para que pidas, confirmes y sigas cada servicio con una presencia mas refinada y confiable.";
    const heroStatusLabel = active ? "Servicio en curso" : "Agenda abierta";
    const heroSupportLabel = currentUser?.emailVerified
      ? "Confirmaciones activas para avisos, cambios y entregas."
      : "Activa tu correo cuando quieras para recibir confirmaciones y avisos.";
    const heroRouteHint = gpsReadyCount
      ? `${gpsReadyCount} servicios con GPS listo`
      : "GPS opcional para una recepcion mas precisa";
    const heroSideNote = active
      ? `Siguiente paso: ${nextServiceLabel}`
      : `${favoritePack} puede ser un gran punto de partida para tu siguiente servicio.`;

    executiveCard.innerHTML = `
      <div class="client-hero-banner home-hero-premium">
        <div class="client-hero-copy">
          <div class="estimate-kicker">Client lounge by ${escapeHtml(BUSINESS_PROFILE.name)}</div>
          <div class="client-hero-title">${escapeHtml(heroTitle)}</div>
          <div class="client-hero-text">${escapeHtml(heroNarrative)}</div>
          <div class="client-hero-pill-row">
            <span class="client-hero-pill">Recepcion cuidada</span>
            <span class="client-hero-pill">Seguimiento claro</span>
            <span class="client-hero-pill">Soporte directo</span>
          </div>
        </div>
        <div class="client-hero-side home-hero-side">
          <div class="client-hero-side-head">
            <span>${escapeHtml(careTier)}</span>
            <strong>${escapeHtml(heroStatusLabel)}</strong>
          </div>
          <small>${escapeHtml(heroSupportLabel)}</small>
          <div class="client-hero-side-stack">
            <span class="client-hero-side-pill ${currentUser?.emailVerified ? "is-verified" : ""}">${currentUser?.emailVerified ? "✓ Correo verificado" : "Correo pendiente"}</span>
            <span class="client-hero-side-pill">${escapeHtml(focusZone)}</span>
            <span class="client-hero-side-pill">${escapeHtml(heroRouteHint)}</span>
          </div>
          <div class="client-hero-side-note">${escapeHtml(heroSideNote)}</div>
        </div>
      </div>
      <div class="home-lounge-strip">
        <div class="home-lounge-card">
          <span>Pedidos</span>
          <strong>${my.length}</strong>
          <small>${escapeHtml(favoritePack)}</small>
        </div>
        <div class="home-lounge-card">
          <span>Activos</span>
          <strong>${activeCount}</strong>
          <small>${active ? "Uno visible en tu portada" : "Listo para tu siguiente agenda"}</small>
        </div>
        <div class="home-lounge-card">
          <span>Entregados</span>
          <strong>${delivered.length}</strong>
          <small>${recentDelivered ? fmtDate(recentDelivered.date) : "Aun pendiente"}</small>
        </div>
        <div class="home-lounge-card">
          <span>Zona base</span>
          <strong>${escapeHtml(focusZone)}</strong>
          <small>${gpsReadyCount ? `${gpsReadyCount} pedidos con GPS listo` : "Activa GPS para una experiencia mas precisa"}</small>
        </div>
      </div>
      <div class="attention-board home-lounge-board">
        <div class="detail-section-title">Momentos clave</div>
        <div class="attention-list">
          <div class="attention-item">
            <div>
              <strong>${active ? "Proximo movimiento" : "Proxima experiencia"}</strong>
              <span>${escapeHtml(nextServiceLabel)}</span>
            </div>
            <div class="attention-side">
              ${active ? renderStatusBadge(active.status) : `<small>Listo para coordinar</small>`}
            </div>
          </div>
          <div class="attention-item">
            <div>
              <strong>Ultimo pedido visible</strong>
              <span>${escapeHtml(recentLabel)}</span>
            </div>
            <div class="attention-side">
              <small>${escapeHtml(recentOrder ? getOrderPacks(recentOrder).join(", ") || recentOrder.pack || "Servicio general" : favoritePack)}</small>
            </div>
          </div>
          <div class="attention-item">
            <div>
              <strong>Cuenta y soporte</strong>
              <span>${currentUser?.emailVerified ? "Tu correo ya esta listo para recibir notificaciones y confirmaciones." : "Tu cuenta esta activa y puedes completar la validacion por correo cuando quieras."}</span>
            </div>
            <div class="attention-side">
              <small>${cancelled.length} cancelados</small>
            </div>
          </div>
        </div>
      </div>
      <div class="client-support-row client-hero-actions">
        <button class="btn btn-small" type="button" id="clientGoActivityBtn">Ver actividad</button>
        <button class="btn btn-small btn-outline" type="button" id="clientFocusOrderBtn">Solicitar servicio</button>
        <a class="btn btn-small btn-outline" href="https://wa.me/${BUSINESS_PHONE_DIGITS}?text=${supportMessage}" target="_blank" rel="noreferrer">Soporte</a>
        <button class="btn btn-small btn-outline" type="button" id="clientGoAccountBtn">Cuenta</button>
      </div>
    `;

    qs("#clientGoActivityBtn")?.addEventListener("click", () => showScreen("screenActivity"));
    qs("#clientFocusOrderBtn")?.addEventListener("click", () => {
      quickOrderCard?.scrollIntoView({ behavior: "smooth", block: "start" });
      qs("#homeZone")?.focus();
    });
    qs("#clientGoAccountBtn")?.addEventListener("click", () => showScreen("screenAccount"));
  }

  bindInvoiceAndDetailButtons(nextOrderCard || undefined);
  qs("#homeGoActivityBtn")?.addEventListener("click", () => showScreen("screenActivity"));
  qs("#homeGoAccountBtn")?.addEventListener("click", () => showScreen("screenAccount"));
  qsa("[data-go-communication-activity]").forEach((btn) => {
    if (btn.dataset.navBound === "1") return;
    btn.dataset.navBound = "1";
    btn.addEventListener("click", () => showScreen("screenActivity"));
  });
  qs("#homeCreateServiceBtn")?.addEventListener("click", () => {
    quickOrderCard?.scrollIntoView({ behavior: "smooth", block: "start" });
    qs("#homeZone")?.focus();
  });
  Array.from((nextOrderCard || document).querySelectorAll?.("[data-cancel-home]") || []).forEach((btn) => {
    if (btn.dataset.cancelBound === "1") return;
    btn.dataset.cancelBound = "1";
    btn.addEventListener("click", (ev) => cancelOrder(ev.currentTarget.dataset.cancelHome));
  });
}

function renderClientActivity() {
  const screen = qs("#screenActivity");
  if (!screen) return;

  const stats = buildClientOrderStats(ordersCache.filter((o) => o.userId === currentUser.id));
  const filters = getClientActivityFilters(stats);
  if (!filters.some((item) => item.key === clientActivityFilter)) {
    clientActivityFilter = "all";
  }

  let summaryCard = qs("#clientActivitySummaryCard");
  let focusCard = qs("#clientActivityFocusCard");
  let feedCard = qs("#clientActivityFeedCard");

  if (!feedCard) {
    const anchorCard = Array.from(screen.querySelectorAll(".card")).find(
      (card) => !["clientActivitySummaryCard", "clientActivityFocusCard"].includes(card.id)
    );
    if (anchorCard) {
      anchorCard.id = "clientActivityFeedCard";
      anchorCard.classList.add("client-activity-feed-card");
      feedCard = anchorCard;
    }
  }

  if (!summaryCard && feedCard) {
    summaryCard = document.createElement("div");
    summaryCard.id = "clientActivitySummaryCard";
    summaryCard.className = "card card-spaced client-activity-summary";
    screen.insertBefore(summaryCard, feedCard);
  }

  if (!focusCard && feedCard) {
    focusCard = document.createElement("div");
    focusCard.id = "clientActivityFocusCard";
    focusCard.className = "card card-spaced client-activity-focus-card";
    screen.insertBefore(focusCard, feedCard);
  }

  const greetingName = String(currentUser?.name || "Cliente").trim().split(/\s+/)[0] || "Cliente";
  const careTier = getClientCareTier(stats.my.length);
  const featuredOrder = stats.active || stats.recentDelivered || stats.recentOrder || null;
  const filteredOrders = getFilteredClientOrders(stats, clientActivityFilter);

  if (summaryCard) {
    summaryCard.innerHTML = `
      <div class="activity-hero-row">
        <div>
          <div class="card-title">Seguimiento premium para ${escapeHtml(greetingName)}</div>
          <div class="card-secondary">Lee tus pedidos como una bitacora clara: estado, ruta, detalle, factura y mapa desde una misma vista.</div>
        </div>
        ${getClientVerificationBadgeMarkup()}
      </div>
      <div class="executive-grid client-executive-grid">
        <div class="executive-metric">
          <span>Historial</span>
          <strong>${stats.my.length}</strong>
        </div>
        <div class="executive-metric">
          <span>Activos</span>
          <strong>${stats.activeCount}</strong>
        </div>
        <div class="executive-metric">
          <span>Entregados</span>
          <strong>${stats.delivered.length}</strong>
        </div>
        <div class="executive-metric">
          <span>GPS listos</span>
          <strong>${stats.gpsReadyCount}</strong>
        </div>
      </div>
      <div class="client-spotlight activity-spotlight">
        <div class="client-spotlight-copy">
          <strong>${featuredOrder ? `Pedido #${featuredOrder.id} como referencia principal` : "Tu panel esta listo para recibir pedidos"}</strong>
          <span>${featuredOrder ? `${escapeHtml(getOrderPrimaryPackLabel(featuredOrder))} | ${escapeHtml(featuredOrder.zone || "Zona por definir")} | ${escapeHtml(getOrderLatestMovementText(featuredOrder))}` : "Cuando confirmes tu primer servicio, esta vista te dejara seguirlo sin perder detalle."}</span>
        </div>
        <div class="client-spotlight-side">
          <small>Nivel actual</small>
          <strong>${escapeHtml(careTier)}</strong>
        </div>
      </div>
      <div class="client-activity-overview activity-overview-grid">
        <div class="client-luxury-card">
          <span>Paquete favorito</span>
          <strong>${escapeHtml(stats.favoritePack)}</strong>
          <small>La preferencia que mas se repite en tu historial reciente.</small>
        </div>
        <div class="client-luxury-card">
          <span>Ultima entrega</span>
          <strong>${stats.recentDelivered ? fmtDate(stats.recentDelivered.date) : "Pendiente"}</strong>
          <small>${escapeHtml(stats.recentDelivered ? getOrderPrimaryPackLabel(stats.recentDelivered) : "Tu primera entrega confirmada aparecera aqui.")}</small>
        </div>
        <div class="client-luxury-card">
          <span>Zona reciente</span>
          <strong>${escapeHtml(stats.recentOrder?.zone || "Sin historial")}</strong>
          <small>${escapeHtml(stats.recentOrder?.address || "Tu direccion mas reciente se mostrara aqui.")}</small>
        </div>
      </div>
    `;
  }

  if (focusCard) {
    if (featuredOrder) {
      const featuredBreakdown = buildOrderChargeBreakdown(featuredOrder);
      const featuredAmount = featuredBreakdown.weightPending
        ? featuredBreakdown.total > 0
          ? `Desde ${money(featuredBreakdown.total)}`
          : "Por confirmar"
        : money(featuredBreakdown.total);
      const featuredLocation = getOrderLocation(featuredOrder);
      const featuredSchedule = [fmtDate(featuredOrder.date), fmtTime(featuredOrder.time)].filter(Boolean).join(" | ");

      focusCard.innerHTML = `
        <div class="activity-focus-top">
          <div>
            <div class="card-title">${stats.active ? "Pedido en seguimiento" : "Pedido destacado"}</div>
            <div class="card-secondary">${stats.active ? "Este es el servicio que mas atencion necesita ahora mismo." : "Te mostramos el pedido mas reciente para que tengas referencia inmediata."}</div>
          </div>
          <div class="activity-focus-side">
            <span>${stats.active ? "En curso" : "Referencia"}</span>
            <strong>#${featuredOrder.id}</strong>
          </div>
        </div>
        <div class="signal-chip-row">${renderSignalChips(featuredOrder)}</div>
        <div class="activity-focus-grid">
          <div class="activity-focus-item">
            <span>Servicio</span>
            <strong>${escapeHtml(getOrderPrimaryPackLabel(featuredOrder))}</strong>
            <small>${escapeHtml(featuredOrder.serviceType || "Servicio a domicilio")} | ${escapeHtml(describePricingMode(featuredOrder.pricingMode))}</small>
          </div>
          <div class="activity-focus-item">
            <span>Agenda</span>
            <strong>${escapeHtml(featuredSchedule || "Pendiente")}</strong>
            <small>${renderStatusBadge(featuredOrder.status)}</small>
          </div>
          <div class="activity-focus-item">
            <span>Monto</span>
            <strong>${escapeHtml(featuredAmount)}</strong>
            <small>${escapeHtml(featuredLocation ? "GPS verificado para esta parada" : "Direccion manual aun visible para el chofer")}</small>
          </div>
        </div>
        <div class="activity-focus-note">
          ${escapeHtml(getOrderLatestMovementText(featuredOrder))}. ${escapeHtml(featuredOrder.repartidorName ? `Repartidor asignado: ${featuredOrder.repartidorName}.` : "Asignacion pendiente por el equipo.")}
        </div>
        ${renderClientTrackingExperience(featuredOrder, { compact: true })}
        ${renderDeliveryCodeCard(featuredOrder, { compact: true })}
        <div class="timeline-actions activity-focus-actions">
          <button class="btn btn-small" data-factura="${featuredOrder.id}">Factura</button>
          <button class="btn btn-small btn-outline" data-detalle="${featuredOrder.id}">Detalle</button>
          <a class="btn btn-small btn-outline" href="${getOrderMapLink(featuredOrder)}" target="_blank" rel="noreferrer">Mapa</a>
          ${canCancel(featuredOrder) ? `<button class="btn btn-small btn-outline" data-cancel="${featuredOrder.id}">Cancelar</button>` : `<button class="btn btn-small btn-outline" type="button" data-go-account="1">Cuenta</button>`}
        </div>
      `;
    } else {
      focusCard.innerHTML = `
        <div class="activity-focus-top">
          <div>
            <div class="card-title">Tu seguimiento comenzara aqui</div>
            <div class="card-secondary">Cuando hagas tu primer pedido, esta pantalla te dara una lectura mas clara del estado, ruta y detalle.</div>
          </div>
          <div class="activity-focus-side">
            <span>Sin pedidos</span>
            <strong>Nuevo</strong>
          </div>
        </div>
        <div class="activity-focus-note">Todavia no hay historial registrado. Puedes volver a inicio para solicitar el primer servicio o entrar a tu cuenta para revisar tus datos.</div>
        <div class="timeline-actions activity-focus-actions">
          <button class="btn btn-small" type="button" data-go-home-order="1">Solicitar servicio</button>
          <button class="btn btn-small btn-outline" type="button" data-go-account="1">Ver cuenta</button>
        </div>
      `;
    }
  }

  if (feedCard) {
    feedCard.innerHTML = `
      <div class="activity-feed-head">
        <div>
          <div class="card-title">Historial visible</div>
          <div class="card-secondary">Filtra tus pedidos para revisar solo lo que importa ahora: servicios activos, entregas o cancelaciones.</div>
        </div>
        <div class="estimate-badge">${escapeHtml(filters.find((item) => item.key === clientActivityFilter)?.label || "Todo")}</div>
      </div>
      <div class="activity-filter-row">
        ${filters.map((filter) => `
          <button class="activity-filter-chip ${filter.key === clientActivityFilter ? "is-active" : ""}" type="button" data-client-activity-filter="${filter.key}">
            <span>${escapeHtml(filter.label)}</span>
            <strong>${filter.count}</strong>
          </button>
        `).join("")}
      </div>
      <ul id="activityTimeline" class="timeline"></ul>
    `;
  }

  const timeline = qs("#activityTimeline");
  if (!timeline) return;
  timeline.innerHTML = "";

  if (!stats.my.length) {
    timeline.innerHTML = `
      <li class="timeline-empty">
        <div class="timeline-empty-shell">
          <strong>Aun no tienes pedidos registrados.</strong>
          <span>Cuando confirmes tu primer servicio, aqui veras seguimiento, factura y detalle de una forma mucho mas clara.</span>
          <div class="timeline-actions timeline-empty-actions">
            <button class="btn btn-small" type="button" data-go-home-order="1">Solicitar servicio</button>
            <button class="btn btn-small btn-outline" type="button" data-go-account="1">Ver cuenta</button>
          </div>
        </div>
      </li>
    `;
  } else if (!filteredOrders.length) {
    const activeFilterLabel = filters.find((item) => item.key === clientActivityFilter)?.label || "seleccion";
    timeline.innerHTML = `
      <li class="timeline-empty">
        <div class="timeline-empty-shell">
          <strong>No hay pedidos en ${escapeHtml(activeFilterLabel.toLowerCase())} ahora mismo.</strong>
          <span>Puedes cambiar el filtro o volver al historial completo para seguir revisando tus servicios.</span>
        </div>
      </li>
    `;
  }

  filteredOrders.forEach((o) => {
    const packs = getOrderPacks(o);
    const breakdown = buildOrderChargeBreakdown(o);
    const location = getOrderLocation(o);
    const flags = getOrderHighlightFlags(o);
    const amountLabel = breakdown.weightPending
      ? breakdown.total > 0
        ? `Desde ${money(breakdown.total)}`
        : "Monto por confirmar"
      : money(breakdown.total);
    const serviceMoment = [fmtDate(o.date), fmtTime(o.time)].filter(Boolean).join(" | ");
    const stateClass = isFinalDeliveryStatus(o.status)
      ? "timeline-item-complete"
      : isCancelledStatus(o.status)
        ? "timeline-item-cancelled"
        : "timeline-item-active";
    const li = document.createElement("li");
    li.className = `timeline-item ${stateClass}`;
    li.innerHTML = `
      <div class="timeline-icon">#${String(o.id).padStart(2, "0")}</div>
      <div class="timeline-content">
        <div class="timeline-serial-row">
          <span class="timeline-order-id">Pedido #${o.id}</span>
          <span class="timeline-order-moment">${escapeHtml(serviceMoment || "Agenda pendiente")}</span>
        </div>
        <div class="timeline-title">
          <span>${escapeHtml(getOrderPrimaryPackLabel(o))}</span>
          ${renderStatusBadge(o.status)}
        </div>
        <div class="timeline-meta">${escapeHtml(o.serviceType || "Servicio a domicilio")} | ${escapeHtml(o.zone || "--")} | ${escapeHtml(o.repartidorName || "Asignacion pendiente")}</div>
        <div class="signal-chip-row">${renderSignalChips(o)}</div>
        <div class="timeline-summary-row">
          <div class="timeline-summary-block">
            <strong>${escapeHtml(describePricingMode(o.pricingMode))}</strong>
            <span>${escapeHtml(location ? "GPS verificado para esta direccion" : "Direccion manual como referencia")}</span>
          </div>
          <div class="timeline-summary-block timeline-summary-price">
            <strong>${escapeHtml(amountLabel)}</strong>
            <span>${escapeHtml(flags.delayed ? "Requiere atencion por horario" : "Agenda dentro del seguimiento")}</span>
          </div>
        </div>
        <div class="timeline-tag-row">
          ${(packs.length ? packs : [o.pack || "Servicio general"]).map((pack) => `<span class="estimate-tag">${escapeHtml(pack)}</span>`).join("")}
        </div>
        <div class="timeline-route-note">
          <strong>${escapeHtml(o.address || "Direccion pendiente")}</strong>
          <span>${escapeHtml(flags.hasGps ? `Ubicacion valida para ${location?.inferredZone || o.zone || "tu zona"}` : "Sin punto GPS registrado. Seguimos usando la direccion escrita.")}</span>
        </div>
        ${renderClientTrackingExperience(o, { compact: true })}
        ${renderDeliveryCodeCard(o, { compact: true })}
        <div class="timeline-history-note">
          <span>Ultimo movimiento</span>
          <strong>${escapeHtml(getOrderLatestMovementText(o))}</strong>
        </div>
        <div class="timeline-extra">${o.notes ? escapeHtml(o.notes) : "Factura, detalle y mapa disponibles para cada servicio."}</div>
        <div class="timeline-actions">
          <button class="btn btn-small" data-factura="${o.id}">Factura</button>
          <button class="btn btn-small btn-outline" data-detalle="${o.id}">Detalle</button>
          <a class="btn btn-small btn-outline" href="${getOrderMapLink(o)}" target="_blank" rel="noreferrer">Mapa</a>
          ${canCancel(o) ? `<button class="btn btn-small btn-outline" data-cancel="${o.id}">Cancelar</button>` : ""}
        </div>
      </div>
    `;
    timeline.appendChild(li);
  });

  bindInvoiceAndDetailButtons(screen);
  Array.from(screen.querySelectorAll("[data-cancel]")).forEach((btn) => {
    if (btn.dataset.cancelBound === "1") return;
    btn.dataset.cancelBound = "1";
    btn.addEventListener("click", (ev) => cancelOrder(ev.currentTarget.dataset.cancel));
  });
  Array.from(screen.querySelectorAll("[data-client-activity-filter]")).forEach((btn) => {
    if (btn.dataset.filterBound === "1") return;
    btn.dataset.filterBound = "1";
    btn.addEventListener("click", (ev) => {
      clientActivityFilter = ev.currentTarget.dataset.clientActivityFilter || "all";
      renderClientActivity();
    });
  });
  Array.from(screen.querySelectorAll("[data-go-home-order]")).forEach((btn) => {
    if (btn.dataset.navBound === "1") return;
    btn.dataset.navBound = "1";
    btn.addEventListener("click", () => {
      showScreen("screenHome");
      qs("#quickOrderCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
      qs("#homeZone")?.focus();
    });
  });
  Array.from(screen.querySelectorAll("[data-go-account]")).forEach((btn) => {
    if (btn.dataset.navBound === "1") return;
    btn.dataset.navBound = "1";
    btn.addEventListener("click", () => showScreen("screenAccount"));
  });
}

function renderClientAccount() {
  const accountCard = qs("#screenAccount .card");
  const profileForm = qs("#profileForm");
  if (!accountCard || !profileForm || currentUser.role !== "cliente") return;

  const stats = buildClientOrderStats(ordersCache.filter((o) => o.userId === currentUser.id));
  const { my, activeCount, delivered, recentOrder, favoritePack, estimatedRevenue } = stats;
  let summaryCard = qs("#accountExecutiveCard");
  let billingCard = qs("#accountBillingCard");
  const helpBlock = profileForm.nextElementSibling;

  if (!summaryCard) {
    summaryCard = document.createElement("div");
    summaryCard.id = "accountExecutiveCard";
    summaryCard.className = "card-spaced account-overview-shell";
    profileForm.insertAdjacentElement("beforebegin", summaryCard);
  }

  if (!billingCard) {
    billingCard = document.createElement("div");
    billingCard.id = "accountBillingCard";
    billingCard.className = "account-billing-card";
    if (helpBlock) {
      helpBlock.insertAdjacentElement("beforebegin", billingCard);
    } else {
      profileForm.insertAdjacentElement("afterend", billingCard);
    }
  }

  summaryCard.innerHTML = `
    <div class="executive-head">
      <div>
        <div class="card-title">Cuenta privada ${escapeHtml(BUSINESS_PROFILE.name)}</div>
        <div class="card-secondary">Aqui dejamos la informacion mas personal de tu cuenta para no cargar la portada del cliente.</div>
      </div>
      <div class="estimate-badge">${escapeHtml(getClientCareTier(my.length))}</div>
    </div>
    <div class="client-luxury-strip account-luxury-strip">
      <div class="client-luxury-card">
        <span>Pedidos</span>
        <strong>${my.length}</strong>
        <small>${activeCount} activos y ${delivered.length} entregados.</small>
      </div>
      <div class="client-luxury-card">
        <span>Servicio frecuente</span>
        <strong>${escapeHtml(favoritePack)}</strong>
        <small>Lo que mas repites cuando agendas desde tu cuenta.</small>
      </div>
      <div class="client-luxury-card">
        <span>Correo</span>
        <strong>${currentUser?.emailVerified ? "Verificado" : "Pendiente"}</strong>
        <small>${escapeHtml(currentUser.email || BUSINESS_PROFILE.email)}</small>
      </div>
    </div>
  `;

  billingCard.innerHTML = `
    <div class="account-billing-box">
      <div class="account-billing-copy">
        <span>Resumen privado</span>
        <strong>Referencia acumulada de facturas</strong>
        <small>Solo se muestra aqui dentro de tu cuenta para consulta personal.</small>
      </div>
      <div class="account-billing-value">${money(estimatedRevenue)}</div>
    </div>
    <div class="account-billing-meta">
      <span>${my.length} facturas registradas</span>
      <span>${escapeHtml(recentOrder ? `Ultimo pedido: #${recentOrder.id} | ${fmtDate(recentOrder.date)}` : "Aun no tienes pedidos registrados.")}</span>
    </div>
  `;
}

function renderGestorHome() {
  const today = new Date().toISOString().slice(0, 10);
  const nonLocal = ordersCache.filter((o) => o.channel !== "local");
  const pendientes = sortByNewestId(nonLocal.filter((o) => o.status === "pendiente"));
  const enProceso = sortByNewestId(nonLocal.filter((o) => !["pendiente", "entregado", "cancelado"].includes(o.status)));

  qs("#gestorActiveCount").textContent = String(nonLocal.length);
  qs("#gestorTodayCount").textContent = String(nonLocal.filter((o) => o.date === today).length);
  qs("#gestorClientsCount").textContent = String(new Set(nonLocal.map((o) => o.userId).filter(Boolean)).size);

  const tbody = qs("#gestorAssignBody");
  tbody.innerHTML = pendientes.length ? "" : tableEmptyRow(9, "No hay pedidos pendientes de asignar.");

  pendientes.forEach((o) => {
    const reps = repartidoresCache.filter((r) => r.zone === o.zone);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.zone}</td>
      <td>${fmtDate(o.date)}</td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>
        <select data-assign="${o.id}">
          <option value="">Elegir...</option>
          ${reps.map((r) => `<option value="${r.id}">${r.name}</option>`).join("")}
        </select>
      </td>
      <td><button class="btn btn-small" data-factura="${o.id}">Ver</button></td>
      <td><button class="btn btn-small" data-detalle="${o.id}">Ver</button></td>
      <td><button class="btn btn-primary btn-small" data-save="${o.id}">Asignar</button></td>
    `;
    tbody.appendChild(tr);
  });

  let card = qs("#gestorInProgressCard");
  if (!card) {
    card = document.createElement("div");
    card.className = "role-panel";
    card.id = "gestorInProgressCard";
    card.innerHTML = `
      <div class="card card-spaced">
        <div class="card-title">Pedidos asignados y en proceso</div>
        <div class="card-secondary">Seguimiento de ruta, entrega y control operativo.</div>
        <div class="role-table-wrapper">
          <table class="role-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Zona</th>
                <th>Direccion</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Repartidor</th>
                <th>Factura</th>
                <th>Detalles</th>
              </tr>
            </thead>
            <tbody id="gestorInProgressBody"></tbody>
          </table>
        </div>
      </div>
    `;
    qs("#gestorHomePanel")?.appendChild(card);
  }

  const body2 = qs("#gestorInProgressBody");
  body2.innerHTML = enProceso.length ? "" : tableEmptyRow(9, "No hay pedidos en proceso.");

  enProceso.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.zone}</td>
      <td>${o.address || "Por definir"}</td>
      <td>${fmtDate(o.date)} ${fmtTime(o.time)}</td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>${o.repartidorName || "-"}</td>
      <td><button class="btn btn-small" data-factura="${o.id}">Ver</button></td>
      <td><button class="btn btn-small" data-detalle="${o.id}">Ver</button></td>
    `;
    body2.appendChild(tr);
  });

  qsa("[data-save]").forEach((btn) => btn.addEventListener("click", gestorAssign));
  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openInvoice));
}

function renderGestorRidersActivity() {
  const container = qs("#ridersActivity");
  if (!container) return;
  container.innerHTML = "";

  if (!repartidoresCache.length) {
    container.innerHTML = `<div class="card"><div class="table-empty">No hay repartidores cargados.</div></div>`;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const zones = {};

  repartidoresCache.forEach((rep) => {
    const zone = rep.zone || "Distrito Nacional";
    if (!zones[zone]) zones[zone] = [];
    zones[zone].push(rep);
  });

  Object.keys(zones).forEach((zone) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-title">Zona ${zone}</div><div class="card-secondary">Meta diaria por repartidor: 30 pedidos.</div>`;
    container.appendChild(card);

    zones[zone].forEach((rep) => {
      const count = ordersCache.filter((o) => o.repartidorId === rep.id && o.date === today).length;
      const meta = 30;
      const pct = Math.min((count / meta) * 100, 100);
      const faltan = Math.max(meta - count, 0);

      const block = document.createElement("div");
      block.className = "rider-progress-block";
      block.innerHTML = `
        <div class="card-line">
          <span class="card-label">${rep.name}</span>
          <span class="status-pill status-progress">${count}/${meta}</span>
        </div>
        <div class="progress-row">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-text">Faltan ${faltan} pedidos para la meta diaria.</span>
        </div>
      `;
      card.appendChild(block);
    });
  });
}

function renderGestorLocal() {
  const tbody = qs("#localOrdersBody");
  if (!tbody) return;

  const localOrders = sortByNewestId(localOrdersCache);
  tbody.innerHTML = localOrders.length ? "" : tableEmptyRow(8, "No hay pedidos registrados en el local.");

  localOrders.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.phone || "--"}</td>
      <td>${Number(o.lbs || 0).toFixed(1)}</td>
      <td>${o.pack}</td>
      <td>${renderStatusBadge(o.status)}</td>
      <td><button class="btn btn-small" data-factura="${o.id}">Ver</button></td>
      <td><button class="btn btn-small" data-detalle="${o.id}">Ver</button></td>
    `;
    tbody.appendChild(tr);
  });

  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openInvoice));
}

function renderRepartidorHome() {
  const assigned = sortByNewestId(ordersCache.filter((o) => o.repartidorId === currentUser.id));
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = assigned.filter((o) => o.date === today).length;
  const meta = 30;
  const extra = Math.max(todayCount - meta, 0);
  const comision = extra * 50;

  qs("#repartidorMetaText").textContent = `Meta ${todayCount}/${meta}. Comision proyectada: ${money(comision)}`;

  const tbody = qs("#repartidorOrdersBody");
  tbody.innerHTML = assigned.length ? "" : tableEmptyRow(9, "No tienes pedidos asignados en este momento.");

  assigned.forEach((o) => {
    const stRecibido = "recibido";
    const stCamino = "en camino";
    const stEntregado = "entregado";
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.userName}</td>
      <td>${o.zone}</td>
      <td>${o.address || "Por definir"}</td>
      <td>${fmtDate(o.date)} ${fmtTime(o.time)}</td>
      <td><input type="number" min="0" step="0.1" data-lbs="${o.id}" value="${Number(o.lbs || 0).toFixed(1)}"></td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>
        <button class="btn btn-small" data-factura="${o.id}">Factura</button>
        <button class="btn btn-small" data-detalle="${o.id}">Detalles</button>
      </td>
      <td>
        <button class="btn btn-small" data-state="recibido" data-id="${o.id}" ${!canMoveTo(o.status, stRecibido) ? "disabled" : ""}>Recibido</button>
        <button class="btn btn-small" data-state="camino" data-id="${o.id}" ${!canMoveTo(o.status, stCamino) ? "disabled" : ""}>Camino</button>
        <button class="btn btn-small" data-state="entregado" data-id="${o.id}" ${!canMoveTo(o.status, stEntregado) ? "disabled" : ""}>Entregado</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  qsa("[data-state]").forEach((btn) => btn.addEventListener("click", repartidorUpdateStatus));
  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openInvoice));
}

async function repartidorUpdateStatus(ev) {
  const trigger = ev.currentTarget || ev.target;
  const orderId = trigger?.dataset?.id;
  const state = trigger?.dataset?.state;
  const order = ordersCache.find((o) => o.id == orderId);
  if (!order) return;

  const lbs = parseFloat(qs(`[data-lbs="${orderId}"]`)?.value || "0");
  const targetStatus = normalizeStatusValue(state);

  if (!canMoveTo(order.status, targetStatus)) {
    showWarning("Ese cambio no sigue el flujo de ruta.");
    return;
  }

  let pickupProof = null;
  let deliveryProof = null;
  if (targetStatus === "recogido al cliente") {
    pickupProof = await showDeliveryProofDialog(order, { mode: "pickup" });
    if (!pickupProof) return;
  }

  if (targetStatus === "entregado al cliente") {
    deliveryProof = await showDeliveryProofDialog(order, { mode: "delivery" });
    if (!deliveryProof) return;
  }

  try {
    setButtonBusy(trigger, true, "Actualizando...");
    await apiPut(`/orders/${orderId}/status`, { status: targetStatus, lbs, pickupProof, deliveryProof });
    showSuccess(`Pedido #${orderId} actualizado a ${formatStatusLabel(targetStatus)}.`);
    await loadAll();
  } catch (err) {
    showError(err.message || "Error cambiando estado");
  } finally {
    setButtonBusy(trigger, false);
  }
}

async function onCreateLocalOrder(e) {
  e.preventDefault();

  const extras = Array.from(qs("#cashierForm").querySelectorAll(".chip input:checked"))
    .map((i) => i.value);

  const body = {
    customerName: qs("#cashierName").value.trim(),
    customerPhone: qs("#cashierPhone").value.trim(),
    customerEmail: qs("#cashierEmail").value.trim(),
    lbs: parseFloat(qs("#cashierLbs").value || "0"),
    pack: qs("#cashierPack").value,
    extras,
    notes: qs("#cashierNotes").value.trim(),
  };

  try {
    await apiPost("/local-orders", body);
    showSuccess("Pedido local creado correctamente.");
    qs("#cashierForm").reset();
    await loadAll();
  } catch (err) {
    showError(err.message || "Error creando pedido local");
  }
}

function openInvoice(ev) {
  const id = ev.target.dataset.factura || ev.target.dataset.detalle;
  let order = ordersCache.find((o) => o.id == id);
  if (!order) order = localOrdersCache.find((o) => o.id == id);
  if (!order) return alert("Pedido no encontrado");

  qs("#invoiceSubtitle").textContent = `Pedido #${order.id} | ${order.channel || "domicilio"}`;

  const attendedBy = order.repartidorName ? `Atendido por: ${order.repartidorName}` : "";
  const historyLines = (order.history || [])
    .slice(-5)
    .map((h) => `&bull; ${formatStatusLabel(h.status)} (${formatRoleLabel(h.by)}) ${fmtTime(h.at)}`)
    .join("<br>");

  qs("#invoiceClient").innerHTML = `
    <strong>${order.userName || "Cliente"}</strong><br>
    Zona: ${order.zone || "--"}<br>
    Direccion: ${order.address || "Entrega en local"}<br>
    Tel: ${order.phone || "--"}<br>
    ${attendedBy ? `${attendedBy}<br>` : ""}
    <span style="color:var(--muted); font-size:12.5px;">Ultimos movimientos:</span><br>
    <span style="color:var(--muted); font-size:12.5px;">${historyLines || "--"}</span>
  `;

  const lbs = Number(order.lbs || 0);
  const base = lbs * 30;
  const extrasCount = (order.extras || []).length;
  const extrasTotal = extrasCount * 75;
  const subtotal = base + extrasTotal;
  const itbis = subtotal * 0.18;
  const total = subtotal + itbis;

  qs("#invoiceLines").innerHTML = `
    <tr>
      <td>Ropa por libra</td>
      <td>${lbs.toFixed(1)} lb</td>
      <td>${money(30)}</td>
      <td>${money(base)}</td>
    </tr>
    ${extrasCount ? `<tr><td>Extras (${order.extras.join(", ")})</td><td>${extrasCount}</td><td>${money(75)}</td><td>${money(extrasTotal)}</td></tr>` : ""}
  `;

  qs("#invoiceSubtotal").textContent = money(subtotal);
  qs("#invoiceItbis").textContent = money(itbis);
  qs("#invoiceTotal").textContent = money(total);
  qs("#invoiceFooterText").textContent = "Ejemplo de factura | ITBIS 18% | Cuentas: BHD 33008190011 | Popular 831576806";

  const printBtn = qs("#invoicePrintBtn");
  if (currentUser.role === "gestor" || currentUser.role === "repartidor") show(printBtn);
  else hide(printBtn);

  qs("#invoiceModal").style.display = "flex";
}

async function cancelOrder(orderId) {
  const confirmed = await showConfirmDialog("Seguro que deseas cancelar el pedido?", {
    title: "Cancelar pedido",
    confirmLabel: "Si, cancelar",
    cancelLabel: "Volver",
  });
  if (!confirmed) return;

  try {
    await apiPut(`/orders/${orderId}/cancel`, {});
    showSuccess("Pedido cancelado correctamente.");
    await loadAll();
  } catch (err) {
    showError(err.message || "No se pudo cancelar");
  }
}

/* ============================================================
   EVENTS / INIT
============================================================ */
function attachNavEvents() {
  qsa(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showScreen(btn.dataset.screenTarget));
  });
}

function attachAuthEvents() {
  qs("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hide(qs("#loginMessage"));
    try {
      await login(qs("#loginEmail").value, qs("#loginPassword").value);
      hide(qs("#authView"));
      show(qs("#appView"));
      await loadAll();
    } catch (err) {
      qs("#loginMessage").style.display = "block";
      qs("#loginMessage").textContent = err.message || "Error de login";
    }
  });

  qs("#registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hide(qs("#registerMessage"));
    try {
      await register(
        qs("#registerName").value,
        qs("#registerEmail").value,
        qs("#registerPassword").value
      );
      alert("Cuenta creada. Inicia sesión.");
      qs("#registerForm").reset();
    } catch (err) {
      qs("#registerMessage").style.display = "block";
      qs("#registerMessage").textContent = err.message || "Error de registro";
    }
  });
}

function attachAppEvents() {
  qs("#logoutBtn").addEventListener("click", logout);

  qs("#darkModeToggle").addEventListener("click", () => {
    document.body.classList.toggle("theme-light");
  });

  qs("#quickOrderForm")?.addEventListener("submit", onCreateOrder);
  qs("#cashierForm")?.addEventListener("submit", onCreateLocalOrder);

  qs("#invoiceCloseBtn")?.addEventListener("click", closeInvoice);
  qs("#invoicePrintBtn")?.addEventListener("click", printInvoice);

  qs("#profileForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    alert("Perfil revisado. Para cambios sensibles, contacta soporte.");
  });
}

function setAuthMode(mode = "login", { focusField = false } = {}) {
  const authCard = qs("#authView .auth-card");
  if (!authCard) return;

  const nextMode = mode === "register" ? "register" : "login";
  authCard.dataset.authMode = nextMode;

  authCard.querySelectorAll("[data-auth-mode-target]").forEach((btn) => {
    const isActive = btn.dataset.authModeTarget === nextMode;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  });

  authCard.querySelectorAll("[data-auth-panel]").forEach((panel) => {
    const isActive = panel.dataset.authPanel === nextMode;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
    panel.setAttribute("aria-hidden", String(!isActive));
  });

  if (!focusField) return;

  const focusSelector = nextMode === "register" ? "#registerName" : "#loginEmail";
  requestAnimationFrame(() => {
    qs(focusSelector)?.focus();
  });
}

function bindAuthModeSwitch(switcher) {
  if (!switcher || switcher.dataset.bound === "1") return;
  switcher.dataset.bound = "1";

  switcher.addEventListener("click", (event) => {
    const button = event.target.closest("[data-auth-mode-target]");
    if (!button) return;
    setAuthMode(button.dataset.authModeTarget, { focusField: false });
  });

  switcher.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;

    const tabs = Array.from(switcher.querySelectorAll("[data-auth-mode-target]"));
    const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
    const baseIndex = currentIndex >= 0 ? currentIndex : tabs.findIndex((tab) => tab.classList.contains("is-active"));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (baseIndex + delta + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;

    event.preventDefault();
    nextTab.focus();
    setAuthMode(nextTab.dataset.authModeTarget, { focusField: false });
  });
}

function attachAuthEvents() {
  qs("#loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = qs("#loginForm .btn");
    let authenticated = false;
    clearInlineMessage("#loginMessage");
    setButtonBusy(submitBtn, true, "Entrando...");
    setInlineMessage("#loginMessage", "Conectando con tu panel...", "info");
    try {
      await login(qs("#loginEmail").value, qs("#loginPassword").value);
      authenticated = true;
      revealAuthenticatedApp("Cargando tu panel...");
      await loadAll();
      await hideAppEntryOverlay();
    } catch (err) {
      if (authenticated) {
        await hideAppEntryOverlay();
        showWarning(err.message || "Entraste, pero tardamos en cargar tu panel. Prueba refrescando en unos segundos.");
      } else {
        setInlineMessage("#loginMessage", err.message || "Error de inicio de sesion", err.code === "EMAIL_NOT_VERIFIED" ? "warning" : "error");
      }
      if (!authenticated && err.code === "EMAIL_NOT_VERIFIED") {
        openAuthActionPanel("resend", {
          email: err.email || qs("#loginEmail")?.value.trim() || "",
        });
      }
    } finally {
      setButtonBusy(submitBtn, false);
    }
  });

  qs("#registerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = qs("#registerForm .btn");
    clearInlineMessage("#registerMessage");
    setButtonBusy(submitBtn, true, "Creando cuenta...");
    try {
      const data = await register(
        qs("#registerName").value,
        qs("#registerEmail").value,
        qs("#registerPassword").value
      );
      const tone = data?.emailDeliveryFailed ? "warning" : "success";
      setInlineMessage("#registerMessage", buildAuthResponseHtml(data, data.message), tone, { html: true });
      if (data?.user?.email) qs("#loginEmail").value = data.user.email;
      clearInlineMessage("#loginMessage");
      setAuthMode("login");
      setInlineMessage(
        "#loginMessage",
        data?.emailDeliveryFailed
          ? "Cuenta creada. Si no recibes el correo ahora mismo, usa Verificar correo para reenviarlo."
          : "Cuenta creada. Revisa tu correo y luego inicia sesion.",
        tone
      );
      if (data?.emailDeliveryFailed) {
        showWarning(getFriendlyAuthMessage(data, "La cuenta fue creada, pero el correo no pudo enviarse ahora mismo."));
      } else {
        showSuccess(data.message || "Cuenta creada. Revisa tu correo.");
      }
      qs("#registerForm").reset();
    } catch (err) {
      const friendlyMessage = getFriendlyAuthMessage(err, "Error de registro");
      setInlineMessage("#registerMessage", friendlyMessage, isEmailDeliveryIssue(err) ? "warning" : "error");
    } finally {
      setButtonBusy(submitBtn, false);
    }
  });

  qs("#showForgotPasswordBtn")?.addEventListener("click", () => {
    openAuthActionPanel("forgot", { email: qs("#loginEmail")?.value.trim() || "" });
  });

  qs("#showResendVerificationBtn")?.addEventListener("click", () => {
    openAuthActionPanel("resend", { email: qs("#loginEmail")?.value.trim() || "" });
  });

  qs("#authActionCloseBtn")?.addEventListener("click", closeAuthActionPanel);
  qs("#authActionForm")?.addEventListener("submit", handleAuthActionSubmit);
}

function attachAppEvents() {
  qs("#logoutBtn")?.addEventListener("click", logout);
  qs("#darkModeToggle")?.addEventListener("click", toggleTheme);
  qs("#quickOrderForm")?.addEventListener("submit", onCreateOrder);
  qs("#cashierForm")?.addEventListener("submit", onCreateLocalOrder);
  qs("#invoiceCloseBtn")?.addEventListener("click", closeInvoice);
  qs("#invoicePrintBtn")?.addEventListener("click", printInvoice);
  qs("#profileForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    alert("Perfil revisado. Para cambios sensibles, contacta soporte.");
  });
}

const PACKAGE_OPTIONS = [
  { value: "Lavado + Planchado", note: "Servicio completo para el dia a dia" },
  { value: "Lavado delicado", note: "Para tejidos y acabados sensibles" },
  { value: "Solo Planchado", note: "Ideal para piezas listas para usar" },
  { value: "Tintoreria en seco", note: "Tratamiento premium para prendas finas" },
];

const GARMENT_OPTIONS = [
  { key: "camisas", label: "Camisas", price: 120 },
  { key: "pantalones_finos", label: "Pantalones finos", price: 190 },
  { key: "blusas", label: "Blusas", price: 115 },
  { key: "vestidos", label: "Vestidos", price: 320 },
  { key: "sacos", label: "Sacos", price: 360 },
];

const PRICING_MODE_LABELS = {
  por_libra: "Por libra",
  por_prendas: "Por prendas",
  mixto: "Mixto",
};

const BUSINESS_PROFILE = {
  name: "Menta Laundry",
  legalName: "Menta Laundry SRL",
  tagline: "Frescura en cada prenda",
  rnc: "",
  phone: "829-448-7876",
  email: "admin@mentalaundry.com",
  address: "Isabel Aguiar",
  schedule: "Lunes a sabado | 8:00 AM - 10:00 PM",
};

const BUSINESS_PHONE_DIGITS = "18294487876";
const BUSINESS_ASSETS = {
  logo: "assets/menta-header-logo.png",
  icon: "assets/menta-icon.svg",
};

const ZONE_CENTERS = {
  "Distrito Nacional": { lat: 18.47952, lng: -69.93118 },
  Sur: { lat: 18.43265, lng: -69.9562 },
  Este: { lat: 18.50384, lng: -69.85391 },
  Oeste: { lat: 18.48478, lng: -69.99142 },
};

const ZONE_REFERENCE_POINTS = {
  "Distrito Nacional": [
    { lat: 18.48606, lng: -69.93121 },
    { lat: 18.47584, lng: -69.91859 },
    { lat: 18.47111, lng: -69.90672 },
  ],
  Sur: [
    { lat: 18.45182, lng: -69.96257 },
    { lat: 18.43054, lng: -69.95842 },
    { lat: 18.42174, lng: -69.97021 },
  ],
  Este: [
    { lat: 18.49958, lng: -69.84791 },
    { lat: 18.51179, lng: -69.83037 },
    { lat: 18.49402, lng: -69.81281 },
  ],
  Oeste: [
    { lat: 18.48478, lng: -69.99142 },
    { lat: 18.47271, lng: -69.98363 },
    { lat: 18.50724, lng: -70.00384 },
  ],
};

function getOrderById(id, preferredSource = "") {
  const source = String(preferredSource || "").toLowerCase();
  let order = null;

  if (source === "local") {
    order = localOrdersCache.find((item) => item.id == id);
    if (!order) order = ordersCache.find((item) => item.id == id && item.channel === "local");
  } else if (source === "domicilio") {
    order = ordersCache.find((item) => item.id == id && item.channel !== "local");
  }

  if (!order) order = ordersCache.find((item) => item.id == id);
  if (!order) order = localOrdersCache.find((item) => item.id == id);
  return order;
}

function getOrderPacks(order) {
  if (Array.isArray(order?.packs) && order.packs.length) return order.packs;
  if (order?.pack) return String(order.pack).split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function getSelectedPacks() {
  return qsa('[name="homePacks"]:checked').map((input) => input.value);
}

function collectSelectedGarments() {
  return GARMENT_OPTIONS
    .map((item) => {
      const toggle = qs(`[data-garment-toggle="${item.key}"]`);
      const qty = Number(qs(`[data-garment-qty="${item.key}"]`)?.value || 0);
      return toggle?.checked && qty > 0 ? { name: item.label, qty, price: item.price } : null;
    })
    .filter(Boolean);
}

function describePricingMode(mode) {
  return PRICING_MODE_LABELS[mode] || "Por libra";
}

function bindInvoiceAndDetailButtons() {
  qsa("[data-factura]").forEach((btn) => btn.addEventListener("click", openInvoice));
  qsa("[data-detalle]").forEach((btn) => btn.addEventListener("click", openDetail));
}

function ensureDetailModal() {
  if (qs("#detailModal")) return;

  const modal = document.createElement("div");
  modal.id = "detailModal";
  modal.className = "detail-modal";
  modal.style.display = "none";
  modal.innerHTML = `
    <div class="detail-backdrop"></div>
    <div class="detail-dialog">
      <div class="detail-header">
        <div>
          <div class="invoice-title">Detalle del pedido</div>
          <div id="detailSubtitle" class="invoice-subtitle">Pedido</div>
        </div>
        <button id="detailCloseBtn" class="icon-btn" type="button">
          <span class="icon-symbol">X</span>
          <span class="icon-label">Cerrar</span>
        </button>
      </div>
      <div id="detailBody" class="detail-body"></div>
    </div>
  `;

  document.body.appendChild(modal);
  qs("#detailCloseBtn")?.addEventListener("click", closeDetail);
  modal.querySelector(".detail-backdrop")?.addEventListener("click", closeDetail);
}

function closeDetail() {
  const modal = qs("#detailModal");
  if (modal) modal.style.display = "none";
}

function syncGarmentInputs() {
  GARMENT_OPTIONS.forEach((item) => {
    const toggle = qs(`[data-garment-toggle="${item.key}"]`);
    const qty = qs(`[data-garment-qty="${item.key}"]`);
    if (!toggle || !qty) return;

    qty.disabled = !toggle.checked;
    if (!toggle.checked) qty.value = "0";
  });

  updateOrderEstimatePreview();
}

function syncPricingModeUI() {
  const mode = qs("#homePricingMode")?.value || "por_libra";
  const garmentField = qs("#homeGarmentField");
  const weightField = qs("#homeWeightField");
  if (garmentField) {
    garmentField.style.display = mode === "por_libra" ? "none" : "";
  }
  if (weightField) {
    weightField.style.display = mode === "por_prendas" ? "none" : "";
  }
  syncGarmentInputs();
  updateOrderEstimatePreview();
}

function ensureClientOrderEnhancements() {
  const form = qs("#quickOrderForm");
  const packSelect = qs("#homeServicePack");
  const packField = packSelect?.closest(".field-group");
  if (!form || !packField) return;

  if (!qs("#homePackSelector")) {
    packField.classList.add("field-group-wide");
    packField.innerHTML = `
      <label>Paquetes de servicio</label>
      <div id="homePackSelector" class="selection-grid">
        ${PACKAGE_OPTIONS.map((item) => `
          <label class="selection-card">
            <input type="checkbox" name="homePacks" value="${item.value}">
            <span class="selection-card-title">${item.value}</span>
            <span class="selection-card-text">${item.note}</span>
          </label>
        `).join("")}
      </div>
      <div class="field-help">Puedes elegir uno o varios paquetes para el mismo pedido.</div>
    `;
  }

  if (!qs("#homePricingMode")) {
    const pricingField = document.createElement("div");
    pricingField.className = "field-group";
    pricingField.innerHTML = `
      <label>Tipo de cobro</label>
      <select id="homePricingMode">
        <option value="por_libra">Por libra</option>
        <option value="por_prendas">Por prendas</option>
        <option value="mixto">Mixto</option>
      </select>
      <div class="field-help">Elige si este servicio se calculara por libra, por prendas o ambos.</div>
    `;
    packField.insertAdjacentElement("afterend", pricingField);
    pricingField.querySelector("select")?.addEventListener("change", syncPricingModeUI);
  }

  if (!qs("#homeContactPhone")) {
    const phoneField = document.createElement("div");
    phoneField.className = "field-group";
    phoneField.innerHTML = `
      <label>Telefono de contacto</label>
      <input id="homeContactPhone" type="text" placeholder="Ej: 829-000-0000" />
      <div class="field-help">Opcional. Sirve para que el repartidor pueda llamarte o escribirte por WhatsApp.</div>
    `;
    const addressField = qs("#homeAddress")?.closest(".field-group");
    addressField?.insertAdjacentElement("afterend", phoneField);
  }

  if (!qs("#homeLocationField")) {
    const geoField = document.createElement("div");
    geoField.id = "homeLocationField";
    geoField.className = "field-group field-group-wide";
    geoField.innerHTML = `
      <label>Ubicacion real del punto de recogida</label>
      <div class="geo-panel">
        <div class="geo-panel-top">
          <div>
            <div id="homeGeoStatus" class="geo-status">GPS requerido para recoger</div>
            <div id="homeGeoMeta" class="geo-meta">Comparte tu ubicacion para fijar el punto exacto de recogida y sugerir la zona mas cercana.</div>
          </div>
          <span id="homeGeoZone" class="estimate-tag estimate-tag-muted">GPS pendiente</span>
        </div>
        <div id="homePickupMap" class="pickup-map pickup-map-empty" role="button" tabindex="0" aria-label="Mapa real del punto de recogida">
          <div id="homePickupMapFallback" class="pickup-map-fallback" aria-hidden="true">
            <div class="pickup-map-grid"></div>
            <div class="pickup-map-route pickup-map-route-a"></div>
            <div class="pickup-map-route pickup-map-route-b"></div>
            <div id="homePickupAccuracy" class="pickup-map-accuracy"></div>
            <div id="homePickupPin" class="pickup-map-pin"></div>
          </div>
          <div id="homePickupMapLabel" class="pickup-map-label">Activa el GPS para ver el punto de recogida</div>
        </div>
        <div id="homeGeoCoords" class="geo-coords">Aun no hay coordenadas registradas en este pedido.</div>
        <div class="geo-action-row">
          <button id="homeGeoLocateBtn" class="btn btn-small" type="button">Usar mi ubicacion</button>
          <button id="homeGeoClearBtn" class="btn btn-small btn-outline" type="button">Limpiar GPS</button>
          <a id="homeGeoOpenLink" class="btn btn-small btn-outline btn-disabled" href="#" target="_blank" rel="noreferrer" aria-disabled="true">Ver punto</a>
        </div>
      </div>
      <div class="field-help">La direccion escrita sigue siendo obligatoria como referencia, pero el pedido no se envia sin GPS confirmado.</div>
    `;
    const phoneField = qs("#homeContactPhone")?.closest(".field-group");
    phoneField?.insertAdjacentElement("afterend", geoField);
  }

  if (!qs("#homeWeightField")) {
    const weightField = document.createElement("div");
    weightField.id = "homeWeightField";
    weightField.className = "field-group";
    weightField.innerHTML = `
      <label>Libras estimadas</label>
      <input id="homeEstimatedLbs" type="number" min="0" step="0.1" placeholder="Ej: 8.5" />
      <div class="field-help">Opcional. Sirve para mostrar un estimado antes del pesaje final.</div>
    `;
    const pricingField = qs("#homePricingMode")?.closest(".field-group");
    pricingField?.insertAdjacentElement("afterend", weightField);
  }

  if (!qs("#homeGarmentField")) {
    const garmentField = document.createElement("div");
    garmentField.id = "homeGarmentField";
    garmentField.className = "field-group field-group-wide";
    garmentField.innerHTML = `
      <label>Prendas seleccionadas</label>
      <div class="garment-grid">
        ${GARMENT_OPTIONS.map((item) => `
          <div class="garment-card">
            <label class="garment-head">
              <span class="garment-check">
                <input type="checkbox" data-garment-toggle="${item.key}">
                <span>${item.label}</span>
              </span>
              <span class="garment-price">${money(item.price)}</span>
            </label>
            <input class="garment-qty" type="number" min="0" step="1" value="0" data-garment-qty="${item.key}" disabled>
          </div>
        `).join("")}
      </div>
      <div class="field-help">Usa esta seccion cuando el pedido sea por prendas o mixto.</div>
    `;
    const notesField = qs("#homeNotes")?.closest(".field-group");
    if (notesField) notesField.insertAdjacentElement("beforebegin", garmentField);
  }

  qsa("[data-garment-toggle]").forEach((input) => {
    input.removeEventListener("change", syncGarmentInputs);
    input.addEventListener("change", syncGarmentInputs);
  });

  if (!qs("#homeEstimateCard")) {
    const estimateCard = document.createElement("div");
    estimateCard.id = "homeEstimateCard";
    estimateCard.className = "order-estimate-card field-group-wide";
    estimateCard.innerHTML = `
      <div class="estimate-top">
        <div>
          <div class="estimate-kicker">Resumen del pedido</div>
          <div class="estimate-title">Tu servicio antes de confirmar</div>
        </div>
        <div class="estimate-badge">Estimado</div>
      </div>
      <div id="homeEstimateService" class="estimate-tag-row"></div>
      <div id="homeEstimateMeta" class="estimate-meta-row"></div>
      <div id="homeEstimateLines" class="estimate-line-list"></div>
      <div class="estimate-total-box">
        <div class="estimate-total-row">
          <span>Subtotal</span>
          <strong id="homeEstimateSubtotal">RD$ 0.00</strong>
        </div>
        <div class="estimate-total-row estimate-total-row-strong">
          <span>Total estimado</span>
          <strong id="homeEstimateTotal">RD$ 0.00</strong>
        </div>
      </div>
      <div id="homeEstimateNote" class="field-help">Selecciona tu servicio para ver el resumen estimado.</div>
    `;
    const notesField = qs("#homeNotes")?.closest(".field-group");
    notesField?.insertAdjacentElement("afterend", estimateCard);
  }

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn && !submitBtn.closest(".form-actions")) {
    const actions = document.createElement("div");
    actions.className = "form-actions field-group-wide";
    submitBtn.insertAdjacentElement("beforebegin", actions);
    actions.appendChild(submitBtn);
  }

  qsa('[name="homePacks"]').forEach((input) => {
    if (input.dataset.quoteBound === "1") return;
    input.dataset.quoteBound = "1";
    input.addEventListener("change", updateOrderEstimatePreview);
  });

  qsa("#quickOrderForm .chip input").forEach((input) => {
    if (input.dataset.quoteBound === "1") return;
    input.dataset.quoteBound = "1";
    input.addEventListener("change", updateOrderEstimatePreview);
  });

  ["#homeEstimatedLbs", "#homeZone", "#homeDate", "#homeTime", "#homePickupType"].forEach((selector) => {
    const input = qs(selector);
    if (!input || input.dataset.quoteBound === "1") return;
    input.dataset.quoteBound = "1";
    input.addEventListener("input", updateOrderEstimatePreview);
    input.addEventListener("change", updateOrderEstimatePreview);
  });

  const zoneInput = qs("#homeZone");
  if (zoneInput && zoneInput.dataset.geoMapBound !== "1") {
    zoneInput.dataset.geoMapBound = "1";
    zoneInput.addEventListener("change", renderHomePickupMap);
  }

  const locateBtn = qs("#homeGeoLocateBtn");
  if (locateBtn && locateBtn.dataset.geoBound !== "1") {
    locateBtn.dataset.geoBound = "1";
    locateBtn.addEventListener("click", captureHomeLocation);
  }

  const clearBtn = qs("#homeGeoClearBtn");
  if (clearBtn && clearBtn.dataset.geoBound !== "1") {
    clearBtn.dataset.geoBound = "1";
    clearBtn.addEventListener("click", clearHomeLocation);
  }

  const pickupMap = qs("#homePickupMap");
  if (pickupMap && pickupMap.dataset.geoBound !== "1") {
    pickupMap.dataset.geoBound = "1";
    pickupMap.addEventListener("click", adjustHomeLocationFromMapEvent);
    pickupMap.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      if (!homeLocation) {
        showWarning("Primero activa el GPS para confirmar que estas cerca del punto de recogida.");
        return;
      }
      homeLocation = {
        ...homeLocation,
        capturedAt: new Date().toISOString(),
      };
      renderHomeLocationStatus();
      showSuccess("Punto de recogida confirmado.");
    });
  }

  qsa("[data-garment-qty]").forEach((input) => {
    if (input.dataset.quoteBound === "1") return;
    input.dataset.quoteBound = "1";
    input.addEventListener("input", updateOrderEstimatePreview);
    input.addEventListener("change", updateOrderEstimatePreview);
  });

  ensureClientOrderWizard();
  syncPricingModeUI();
  renderHomeLocationStatus();
  updateOrderEstimatePreview();
}

function appendOrderWizardNode(container, node) {
  if (container && node) container.appendChild(node);
}

function formatPricingModeLabel(mode) {
  const labels = {
    por_libra: "Por libra",
    por_prendas: "Por prendas",
    mixto: "Mixto",
  };
  return labels[mode] || "Por libra";
}

function validateOrderWizardStep(stepIndex, options = {}) {
  const silent = options.silent === true;
  const fail = (message, node) => {
    if (!silent) {
      showWarning(message);
      try {
        node?.focus?.({ preventScroll: true });
      } catch {
        node?.focus?.();
      }
      node?.reportValidity?.();
    }
    return false;
  };

  if (stepIndex === 0) {
    const packs = getSelectedPacks();
    const pricingMode = qs("#homePricingMode")?.value || "por_libra";

    if (!packs.length) {
      return fail("Selecciona al menos un paquete principal antes de continuar.", qs('[name="homePacks"]'));
    }

    if ((pricingMode === "por_prendas" || pricingMode === "mixto") && !collectSelectedGarments().length) {
      return fail("Selecciona al menos una prenda y su cantidad para ese tipo de cobro.", qs("[data-garment-toggle]"));
    }

    return true;
  }

  if (stepIndex === 1) {
    const zoneInput = qs("#homeZone");
    const addressInput = qs("#homeAddress");
    const dateInput = qs("#homeDate");
    const timeInput = qs("#homeTime");

    if (!zoneInput?.value) {
      return fail("Elige la zona donde pasaremos a recoger o entregar.", zoneInput);
    }

    if (!addressInput?.value.trim()) {
      return fail("Agrega la direccion del servicio para continuar.", addressInput);
    }

    if (!homeLocation) {
      return fail("Activa el GPS para confirmar el punto real de recogida.", qs("#homeGeoLocateBtn"));
    }

    if (!dateInput?.value) {
      return fail("Selecciona la fecha del servicio.", dateInput);
    }

    if (dateInput.min && dateInput.value < dateInput.min) {
      return fail("La fecha no puede ser anterior al dia de hoy.", dateInput);
    }

    if (!timeInput?.value) {
      return fail("Selecciona la hora del servicio.", timeInput);
    }

    if (timeInput.value < "08:00" || timeInput.value > "22:00") {
      return fail("La agenda a domicilio opera entre 8:00 AM y 10:00 PM.", timeInput);
    }

    return true;
  }

  return true;
}

function renderOrderWizardReview() {
  const reviewCard = qs("#orderWizardReviewCard");
  if (!reviewCard) return;

  const estimateOrder = buildHomeEstimateOrder();
  const packs = getSelectedPacks();
  const breakdown = buildOrderChargeBreakdown(estimateOrder);
  const date = qs("#homeDate")?.value;
  const time = qs("#homeTime")?.value;
  const zone = qs("#homeZone")?.value || "Zona pendiente";
  const address = qs("#homeAddress")?.value.trim();
  const phone = qs("#homeContactPhone")?.value.trim();
  const schedule = [date ? fmtDate(date) : "Fecha pendiente", time ? fmtTime(time) : "Hora pendiente"].join(" | ");
  const garmentsText = breakdown.garments.length
    ? breakdown.garments.map((item) => `${item.label} x${item.qty}`).join(", ")
    : estimateOrder.pricingMode === "por_libra"
      ? estimateOrder.lbs > 0
        ? `${estimateOrder.lbs} lb estimadas`
        : "Pesaje final al recibir"
      : "Prendas pendientes";
  const totalText = breakdown.weightPending
    ? breakdown.total > 0
      ? `Desde ${money(breakdown.total)}`
      : "Por confirmar"
    : money(breakdown.total);
  const gpsText = homeLocation
    ? `GPS listo en ${homeLocation.inferredZone || zone}`
    : "GPS pendiente";

  reviewCard.innerHTML = `
    <div class="order-review-top">
      <div>
        <div class="estimate-kicker">Control final</div>
        <div class="estimate-title">Tu solicitud ya casi esta lista</div>
      </div>
      <div class="estimate-badge">${homeLocation ? "GPS listo" : "GPS requerido"}</div>
    </div>
    <div class="order-review-grid">
      <div class="order-review-item">
        <span>Servicio</span>
        <strong>${packs.length ? escapeHtml(packs.join(" + ")) : "Selecciona uno o varios paquetes"}</strong>
      </div>
      <div class="order-review-item">
        <span>Tipo de cobro</span>
        <strong>${escapeHtml(formatPricingModeLabel(estimateOrder.pricingMode))}</strong>
      </div>
      <div class="order-review-item">
        <span>Prendas o libras</span>
        <strong>${escapeHtml(garmentsText)}</strong>
      </div>
      <div class="order-review-item">
        <span>Agenda</span>
        <strong>${escapeHtml(schedule)}</strong>
      </div>
      <div class="order-review-item">
        <span>Ubicacion</span>
        <strong>${escapeHtml(address || "Direccion pendiente")} | ${escapeHtml(zone)}</strong>
      </div>
      <div class="order-review-item">
        <span>Contacto</span>
        <strong>${escapeHtml(phone || "Usaremos los datos principales de tu cuenta")} | ${escapeHtml(gpsText)}</strong>
      </div>
    </div>
    <div class="order-review-note">
      Estimado actual: <strong>${escapeHtml(totalText)}</strong>. Si el pedido incluye libras, el valor final puede ajustarse despues del pesaje y revision en recepcion.
    </div>
  `;
}

function renderOrderWizardState() {
  const form = qs("#quickOrderForm");
  if (!form || !qs("#orderWizardIntro")) return;

  const lastStepIndex = ORDER_WIZARD_STEPS.length - 1;
  const safeStep = Math.max(0, Math.min(lastStepIndex, currentOrderWizardStep));
  if (safeStep !== currentOrderWizardStep) currentOrderWizardStep = safeStep;

  const packs = getSelectedPacks();
  const estimateOrder = buildHomeEstimateOrder();
  const breakdown = buildOrderChargeBreakdown(estimateOrder);
  const date = qs("#homeDate")?.value;
  const zone = qs("#homeZone")?.value || "Zona";
  const address = qs("#homeAddress")?.value.trim();
  const totalText = breakdown.weightPending
    ? breakdown.total > 0
      ? `Desde ${money(breakdown.total)}`
      : "Por confirmar"
    : money(breakdown.total);
  const stepCaptions = [
    packs.length ? `${packs.length} paquete${packs.length === 1 ? "" : "s"} listo${packs.length === 1 ? "" : "s"}` : "Elige tu servicio",
    address ? `${zone} | ${homeLocation ? "GPS listo" : "GPS pendiente"} | ${date ? fmtDate(date) : "Agenda pendiente"}` : "Agrega direccion, GPS y horario",
    breakdown.lines.length ? totalText : "Revisa antes de confirmar",
  ];

  qsa(".order-step-pill").forEach((pill, index) => {
    pill.classList.toggle("is-active", index === currentOrderWizardStep);
    pill.classList.toggle("is-complete", index < currentOrderWizardStep);
    pill.setAttribute("aria-current", index === currentOrderWizardStep ? "step" : "false");
    const caption = pill.querySelector(".order-step-pill-caption");
    if (caption) caption.textContent = stepCaptions[index] || "";
  });

  qsa(".order-step-panel").forEach((panel, index) => {
    const isActive = index === currentOrderWizardStep;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  });

  const prevBtn = qs("#orderWizardPrevBtn");
  const nextBtn = qs("#orderWizardNextBtn");
  const submitBtn = form.querySelector('button[type="submit"]');
  const actionCopy = qs("#orderWizardActionCopy");

  if (prevBtn) prevBtn.hidden = currentOrderWizardStep === 0;
  if (nextBtn) {
    nextBtn.hidden = currentOrderWizardStep === lastStepIndex;
    nextBtn.textContent = currentOrderWizardStep === lastStepIndex - 1 ? "Ir al resumen" : "Continuar";
  }
  if (submitBtn) {
    submitBtn.hidden = currentOrderWizardStep !== lastStepIndex;
    submitBtn.textContent = "Confirmar pedido";
  }
  if (actionCopy) {
    actionCopy.innerHTML = `
      <span>Paso ${currentOrderWizardStep + 1} de ${ORDER_WIZARD_STEPS.length}</span>
      <strong>${ORDER_WIZARD_STEPS[currentOrderWizardStep].label}</strong>
    `;
  }

  renderOrderWizardReview();
}

function goToOrderWizardStep(targetStep, options = {}) {
  const lastStepIndex = ORDER_WIZARD_STEPS.length - 1;
  const nextStep = Math.max(0, Math.min(lastStepIndex, Number(targetStep) || 0));

  if (!options.force && nextStep > currentOrderWizardStep) {
    for (let step = currentOrderWizardStep; step < nextStep; step += 1) {
      if (!validateOrderWizardStep(step)) return false;
    }
  }

  currentOrderWizardStep = nextStep;
  renderOrderWizardState();

  const activePanel = qs(`.order-step-panel[data-step="${currentOrderWizardStep}"]`);
  if (!options.skipScroll) {
    activePanel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (!options.skipFocus) {
    const focusTarget = activePanel?.querySelector("input, select, textarea, button");
    try {
      focusTarget?.focus?.({ preventScroll: true });
    } catch {
      focusTarget?.focus?.();
    }
  }

  return true;
}

function ensureClientOrderWizard() {
  const form = qs("#quickOrderForm");
  if (!form) return;

  form.noValidate = true;

  let intro = qs("#orderWizardIntro");
  if (!intro) {
    intro = document.createElement("div");
    intro.id = "orderWizardIntro";
    intro.className = "order-wizard-shell field-group-wide";
    form.prepend(intro);
  }

  intro.innerHTML = `
    <div class="order-wizard-intro">
      <div>
        <div class="order-wizard-kicker">Solicitud guiada</div>
        <div class="order-wizard-title">Agenda tu servicio en 3 pasos</div>
        <div class="order-wizard-copy">
          Primero definimos el servicio, luego cerramos la ubicacion y al final revisas todo antes de enviar.
        </div>
      </div>
      <div class="order-wizard-badge">Agenda privada</div>
    </div>
    <div class="order-wizard-progress">
      ${ORDER_WIZARD_STEPS.map((step, index) => `
        <button class="order-step-pill" type="button" data-order-step-target="${index}">
          <span class="order-step-pill-index">${index + 1}</span>
          <span class="order-step-pill-copy">
            <span class="order-step-pill-label">${step.label}</span>
            <span class="order-step-pill-caption">Pendiente</span>
          </span>
        </button>
      `).join("")}
    </div>
  `;

  let panelsHost = qs("#orderWizardPanels");
  if (!panelsHost) {
    panelsHost = document.createElement("div");
    panelsHost.id = "orderWizardPanels";
    panelsHost.className = "order-wizard-panels field-group-wide";
    intro.insertAdjacentElement("afterend", panelsHost);
  }

  ORDER_WIZARD_STEPS.forEach((step, index) => {
    let panel = panelsHost.querySelector(`.order-step-panel[data-step="${index}"]`);
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "order-step-panel";
      panel.dataset.step = String(index);
      panel.innerHTML = `
        <div class="order-step-header">
          <div>
            <div class="order-step-kicker">${step.kicker}</div>
            <div class="order-step-title">${step.label}</div>
            <div class="order-step-copy">${step.copy}</div>
          </div>
          <div class="order-step-marker">${step.key.toUpperCase()}</div>
        </div>
        <div class="order-step-content"></div>
      `;
      panelsHost.appendChild(panel);
    }
  });

  const serviceContent = panelsHost.querySelector('.order-step-panel[data-step="0"] .order-step-content');
  const locationContent = panelsHost.querySelector('.order-step-panel[data-step="1"] .order-step-content');
  const reviewContent = panelsHost.querySelector('.order-step-panel[data-step="2"] .order-step-content');

  appendOrderWizardNode(serviceContent, qs("#homePickupType")?.closest(".field-group"));
  appendOrderWizardNode(serviceContent, qs("#homePackSelector")?.closest(".field-group"));
  appendOrderWizardNode(serviceContent, qs("#homePricingMode")?.closest(".field-group"));
  appendOrderWizardNode(serviceContent, qs("#homeWeightField"));
  appendOrderWizardNode(serviceContent, qs("#homeGarmentField"));
  appendOrderWizardNode(serviceContent, qs("#quickOrderForm .chip-group")?.closest(".field-group"));

  appendOrderWizardNode(locationContent, qs("#homeZone")?.closest(".field-group"));
  appendOrderWizardNode(locationContent, qs("#homeAddress")?.closest(".field-group"));
  appendOrderWizardNode(locationContent, qs("#homeContactPhone")?.closest(".field-group"));
  appendOrderWizardNode(locationContent, qs("#homeLocationField"));
  appendOrderWizardNode(locationContent, qs("#homeDate")?.closest(".field-row"));

  let reviewCard = qs("#orderWizardReviewCard");
  if (!reviewCard) {
    reviewCard = document.createElement("div");
    reviewCard.id = "orderWizardReviewCard";
    reviewCard.className = "order-review-card";
  }
  appendOrderWizardNode(reviewContent, reviewCard);
  appendOrderWizardNode(reviewContent, qs("#homeNotes")?.closest(".field-group"));
  appendOrderWizardNode(reviewContent, qs("#homeEstimateCard"));

  let actions = form.querySelector(".form-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "form-actions field-group-wide";
    form.appendChild(actions);
  }

  const submitBtn = actions.querySelector('button[type="submit"]') || form.querySelector('button[type="submit"]');
  let actionsShell = qs("#orderWizardActionsShell");
  if (!actionsShell) {
    actionsShell = document.createElement("div");
    actionsShell.id = "orderWizardActionsShell";
    actionsShell.className = "order-wizard-actions-shell";

    const copy = document.createElement("div");
    copy.id = "orderWizardActionCopy";
    copy.className = "order-wizard-action-copy";

    const buttons = document.createElement("div");
    buttons.className = "order-wizard-action-buttons";

    const prevBtn = document.createElement("button");
    prevBtn.id = "orderWizardPrevBtn";
    prevBtn.type = "button";
    prevBtn.className = "btn btn-outline";
    prevBtn.textContent = "Anterior";

    const nextBtn = document.createElement("button");
    nextBtn.id = "orderWizardNextBtn";
    nextBtn.type = "button";
    nextBtn.className = "btn btn-primary";
    nextBtn.textContent = "Continuar";

    buttons.append(prevBtn, nextBtn);
    if (submitBtn) {
      submitBtn.classList.add("order-wizard-submit");
      buttons.appendChild(submitBtn);
    }

    actions.textContent = "";
    actions.classList.add("order-wizard-actions", "field-group-wide");
    actionsShell.append(copy, buttons);
    actions.appendChild(actionsShell);
  }

  qsa("[data-order-step-target]").forEach((button) => {
    if (button.dataset.wizardBound === "1") return;
    button.dataset.wizardBound = "1";
    button.addEventListener("click", () => {
      const target = Number(button.dataset.orderStepTarget || 0);
      goToOrderWizardStep(target, { skipFocus: target === currentOrderWizardStep });
    });
  });

  const prevBtn = qs("#orderWizardPrevBtn");
  if (prevBtn && prevBtn.dataset.wizardBound !== "1") {
    prevBtn.dataset.wizardBound = "1";
    prevBtn.addEventListener("click", () => goToOrderWizardStep(currentOrderWizardStep - 1));
  }

  const nextBtn = qs("#orderWizardNextBtn");
  if (nextBtn && nextBtn.dataset.wizardBound !== "1") {
    nextBtn.dataset.wizardBound = "1";
    nextBtn.addEventListener("click", () => goToOrderWizardStep(currentOrderWizardStep + 1));
  }

  renderOrderWizardState();
}

function ensureAuthEnhancements() {
  const authView = qs("#authView");
  const authCard = authView?.querySelector(".auth-card");
  if (!authView || !authCard) return;

  if (!authView.querySelector(".auth-shell")) {
    const shell = document.createElement("div");
    shell.className = "auth-shell";
    const showcase = document.createElement("aside");
    showcase.className = "auth-showcase";
    shell.append(showcase, authCard);
    authView.innerHTML = "";
    authView.appendChild(shell);
  }

  ensureAuthSupportBlocks();

  const showcase = authView.querySelector(".auth-showcase");
  if (showcase) {
    showcase.innerHTML = `
      <div class="auth-showcase-brand">
        <div class="auth-showcase-mark">
          <img src="${BUSINESS_ASSETS.logo}" alt="${BUSINESS_PROFILE.name}" />
        </div>
        <div class="auth-showcase-brand-copy">
          <span>${BUSINESS_PROFILE.name}</span>
          <strong>${BUSINESS_PROFILE.tagline}</strong>
          <small>${BUSINESS_PROFILE.phone} | acceso privado y registro</small>
        </div>
      </div>
      <div class="auth-kicker">Recepcion y cuidado textil</div>
      <h1 class="auth-title">Una primera impresion premium para una tintoreria que si parece una marca real.</h1>
      <p class="auth-copy">
        ${BUSINESS_PROFILE.name} combina recogida, seguimiento, facturacion y atencion
        con una presencia mas sobria, elegante y lista para compartirse con clientes y terceros.
      </p>
      <div class="auth-trust-grid">
        <div class="auth-trust-card">
          <span>Horario</span>
          <strong>${BUSINESS_PROFILE.schedule}</strong>
        </div>
        <div class="auth-trust-card">
          <span>Canal directo</span>
          <strong>${BUSINESS_PROFILE.phone}</strong>
        </div>
        <div class="auth-trust-card">
          <span>Acceso</span>
          <strong>Iniciar sesion o crear cuenta</strong>
        </div>
      </div>
      <div class="auth-feature-grid auth-feature-grid-premium">
        <div class="auth-feature-card">
          <span class="feature-pill">Seguimiento</span>
          <strong>Lectura limpia del pedido</strong>
          <p>Consulta cada servicio con estado, factura, detalle y mapa en una sola experiencia.</p>
        </div>
        <div class="auth-feature-card">
          <span class="feature-pill">Coordinacion</span>
          <strong>Operacion mas ordenada</strong>
          <p>Clientes, gestor, repartidores y caja conviven desde una recepcion visual mucho mas clara.</p>
        </div>
        <div class="auth-feature-card auth-feature-card-wide">
          <span class="feature-pill">Servicio</span>
          <strong>Preparada para crecer</strong>
          <p>Opera por libra, por prendas o en formato mixto con un tono mas serio, mas premium y mas confiable.</p>
        </div>
      </div>
      <div class="auth-preview auth-preview-premium">
        <div class="preview-header">
          <span class="preview-label">Flujo privado</span>
          <span class="preview-note">${BUSINESS_PROFILE.schedule}</span>
        </div>
        <div class="preview-steps">
          <div class="preview-step preview-step-active">Solicitud</div>
          <div class="preview-step">Coordinacion</div>
          <div class="preview-step">Ruta</div>
          <div class="preview-step">Entrega</div>
        </div>
      </div>
    `;
  }

  authView.querySelector(".auth-metrics")?.remove();

  authCard.classList.add("auth-card-premium");

  let hero = authCard.querySelector(".auth-card-hero");
  if (!hero) {
    hero = document.createElement("div");
    hero.className = "auth-card-hero";
  }

  if (!authCard.querySelector(".auth-login-panel") || !authCard.querySelector(".auth-register-panel")) {
    const titles = authCard.querySelectorAll("h2");
    const subtitles = authCard.querySelectorAll(".auth-subtitle");
    const loginPanel = document.createElement("section");
    loginPanel.className = "auth-panel auth-login-panel";
    const registerPanel = document.createElement("section");
    registerPanel.className = "auth-panel auth-register-panel";

    [
      titles[0],
      subtitles[0],
      qs("#loginMessage"),
      qs("#loginForm"),
      qs("#authQuickLinks"),
      qs("#authActionPanel"),
      authCard.querySelector(".auth-hint"),
    ].forEach((node) => {
      if (node) loginPanel.appendChild(node);
    });

    [
      titles[1],
      subtitles[1],
      qs("#registerMessage"),
      qs("#registerForm"),
    ].forEach((node) => {
      if (node) registerPanel.appendChild(node);
    });

    authCard.innerHTML = "";
    authCard.append(hero, loginPanel, registerPanel);
  } else if (authCard.firstElementChild !== hero) {
    authCard.prepend(hero);
  }

  hero.innerHTML = `
    <div class="auth-card-hero-row">
      <div class="auth-card-eyebrow">Acceso premium</div>
      <div class="auth-card-hero-badge">${BUSINESS_PROFILE.name}</div>
    </div>
    <div class="auth-card-hero-title">Iniciar sesion o crear cuenta</div>
    <div class="auth-card-hero-copy">
      Entra a tu panel privado o abre una cuenta nueva desde una experiencia mas clara, sobria y asistida.
    </div>
    <div class="auth-card-points">
      <div class="auth-card-point">
        <strong>Soporte directo</strong>
        <span>WhatsApp, llamada y correo cuando necesites ayuda o verificacion.</span>
      </div>
    </div>
    <div class="auth-card-meta">
      <span>${BUSINESS_PROFILE.phone}</span>
      <span>${BUSINESS_PROFILE.email}</span>
    </div>
  `;

  const loginPanel = authCard.querySelector(".auth-login-panel");
  const registerPanel = authCard.querySelector(".auth-register-panel");
  let modeSwitch = authCard.querySelector(".auth-mode-switch");
  if (!modeSwitch) {
    modeSwitch = document.createElement("div");
    modeSwitch.className = "auth-mode-switch";
    modeSwitch.setAttribute("role", "tablist");
    modeSwitch.setAttribute("aria-label", "Acceso de cuenta");
  }

  modeSwitch.innerHTML = `
    <button
      id="authModeLoginTab"
      class="auth-mode-tab"
      type="button"
      role="tab"
      aria-controls="authLoginPanel"
      data-auth-mode-target="login"
    >
      <strong>Iniciar sesion</strong>
      <small>Acceso rapido a tu panel</small>
    </button>
    <button
      id="authModeRegisterTab"
      class="auth-mode-tab"
      type="button"
      role="tab"
      aria-controls="authRegisterPanel"
      data-auth-mode-target="register"
    >
      <strong>Crear cuenta</strong>
      <small>Alta nueva para cliente</small>
    </button>
  `;

  if (hero.nextElementSibling !== modeSwitch) {
    hero.insertAdjacentElement("afterend", modeSwitch);
  }

  if (loginPanel) {
    loginPanel.id = "authLoginPanel";
    loginPanel.dataset.authPanel = "login";
    loginPanel.setAttribute("role", "tabpanel");
    loginPanel.setAttribute("aria-labelledby", "authModeLoginTab");
    let loginKicker = loginPanel.querySelector(".auth-panel-kicker");
    if (!loginKicker) {
      loginKicker = document.createElement("div");
      loginKicker.className = "auth-panel-kicker";
      loginPanel.prepend(loginKicker);
    }
    loginKicker.textContent = "Acceso principal";
  }
  if (registerPanel) {
    registerPanel.id = "authRegisterPanel";
    registerPanel.dataset.authPanel = "register";
    registerPanel.setAttribute("role", "tabpanel");
    registerPanel.setAttribute("aria-labelledby", "authModeRegisterTab");
    let registerKicker = registerPanel.querySelector(".auth-panel-kicker");
    if (!registerKicker) {
      registerKicker = document.createElement("div");
      registerKicker.className = "auth-panel-kicker";
      registerPanel.prepend(registerKicker);
    }
    registerKicker.textContent = "Cuenta nueva";
  }

  const titles = authCard.querySelectorAll("h2");
  if (titles[0]) titles[0].textContent = "Iniciar sesion";
  if (titles[1]) {
    titles[1].textContent = "Crear cuenta";
    titles[1].classList.add("secondary-title");
  }

  const subtitles = authCard.querySelectorAll(".auth-subtitle");
  if (subtitles[0]) subtitles[0].textContent = "Accede con tu perfil de cliente, gestor, repartidor o cajera.";
  if (subtitles[1]) subtitles[1].textContent = "Las cuentas nuevas de cliente se activan primero desde el correo.";

  const loginGroups = qs("#loginForm")?.querySelectorAll(".field-group") || [];
  if (loginGroups[0]) loginGroups[0].querySelector("label").textContent = "Correo electronico";
  if (loginGroups[1]) loginGroups[1].querySelector("label").textContent = "Contrasena";
  if (qs("#loginPassword")) qs("#loginPassword").placeholder = "Minimo 6 caracteres";
  if (qs("#loginForm .btn")) qs("#loginForm .btn").textContent = "Entrar al panel";
  if (qs("#showForgotPasswordBtn")) qs("#showForgotPasswordBtn").textContent = "Recuperar acceso";
  if (qs("#showResendVerificationBtn")) qs("#showResendVerificationBtn").textContent = "Verificar correo";

  const registerGroups = qs("#registerForm")?.querySelectorAll(".field-group") || [];
  if (registerGroups[1]) registerGroups[1].querySelector("label").textContent = "Correo electronico";
  if (registerGroups[2]) registerGroups[2].querySelector("label").textContent = "Contrasena";
  if (qs("#registerPassword")) qs("#registerPassword").placeholder = "Minimo 6 caracteres";
  if (qs("#registerForm .btn")) qs("#registerForm .btn").textContent = "Crear cuenta";

  const hint = authCard.querySelector(".auth-hint");
  if (hint) {
    const supportMessage = `Hola, necesito ayuda con mi acceso en ${BUSINESS_PROFILE.name}.`;
    hint.classList.add("auth-hint-support");
    hint.innerHTML = `
      <div class="auth-hint-title">Acceso asistido</div>
      <div class="auth-support-copy">
        Si necesitas acceso privado, verificacion o ayuda para entrar, te atendemos por WhatsApp, llamada o correo.
      </div>
      <div class="auth-support-actions">
        <a class="auth-support-link" href="https://wa.me/${BUSINESS_PHONE_DIGITS}?text=${encodeURIComponent(supportMessage)}" target="_blank" rel="noreferrer">WhatsApp</a>
        <a class="auth-support-link" href="tel:+${BUSINESS_PHONE_DIGITS}">Llamar</a>
        <a class="auth-support-link" href="mailto:${BUSINESS_PROFILE.email}">Correo</a>
      </div>
    `;
  }

  bindAuthModeSwitch(modeSwitch);
  setAuthMode(authCard.dataset.authMode || "login");
}

function bindInvoiceAndDetailButtons(root = document) {
  const scope = root && typeof root.querySelectorAll === "function" ? root : document;

  Array.from(scope.querySelectorAll("[data-factura]")).forEach((btn) => {
    if (btn.dataset.invoiceBound === "1") return;
    btn.dataset.invoiceBound = "1";
    btn.addEventListener("click", openInvoice);
  });

  Array.from(scope.querySelectorAll("[data-detalle]")).forEach((btn) => {
    if (btn.dataset.detailBound === "1") return;
    btn.dataset.detailBound = "1";
    btn.addEventListener("click", openDetail);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

function getOrderContactPhone(order) {
  const raw = String(order?.phone || "").trim();
  if (raw && raw.toLowerCase() !== "x") return raw;
  return BUSINESS_PROFILE.phone;
}

function getOrderContactDigits(order) {
  const phone = getOrderContactPhone(order);
  return normalizePhoneDigits(phone) || BUSINESS_PHONE_DIGITS;
}

function getOrderMapLink(order) {
  const location = getOrderLocation(order);
  if (location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.lat},${location.lng}`)}`;
  }

  const query = [order?.address || "", order?.zone || "", "Republica Dominicana"]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function getOrderDestinationQuery(order) {
  const location = getOrderLocation(order);
  if (location) return `${location.lat},${location.lng}`;

  return [order?.address || "", order?.zone || "", "Republica Dominicana"]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(", ") || BUSINESS_PROFILE.address;
}

function getOrderDirectionsLink(order, origin = null) {
  const params = new URLSearchParams({
    api: "1",
    destination: getOrderDestinationQuery(order),
    travelmode: "driving",
  });
  const normalizedOrigin = normalizeOrderLocation(origin);
  if (normalizedOrigin) params.set("origin", `${normalizedOrigin.lat},${normalizedOrigin.lng}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function getOrderWazeLink(order) {
  const location = getOrderLocation(order);
  if (location) {
    return `https://waze.com/ul?ll=${encodeURIComponent(`${location.lat},${location.lng}`)}&navigate=yes`;
  }

  return `https://waze.com/ul?q=${encodeURIComponent(getOrderDestinationQuery(order))}&navigate=yes`;
}

function getOrderContactMessage(order) {
  return `Hola, te contactamos por tu pedido #${order?.id || ""} de ${BUSINESS_PROFILE.name}.`;
}

function renderOrderOpsLinks(order, options = {}) {
  const contactDigits = getOrderContactDigits(order);
  const mapsLink = options.directions
    ? getOrderDirectionsLink(order, options.origin)
    : getOrderMapLink(order);
  const includeContact = options.includeContact !== false;
  const classes = ["order-op-actions"];
  if (options.compact) classes.push("order-op-actions-compact");
  if (options.className) classes.push(options.className);

  return `
    <div class="${classes.join(" ")}">
      <a class="order-op-link order-op-link-primary" href="${mapsLink}" target="_blank" rel="noreferrer">${escapeHtml(options.mapLabel || "Google Maps")}</a>
      <a class="order-op-link" href="${getOrderWazeLink(order)}" target="_blank" rel="noreferrer">Waze</a>
      ${includeContact ? `<a class="order-op-link" href="tel:+${contactDigits}">Llamar</a>` : ""}
      ${includeContact ? `<a class="order-op-link" href="https://wa.me/${contactDigits}?text=${encodeURIComponent(getOrderContactMessage(order))}" target="_blank" rel="noreferrer">WhatsApp</a>` : ""}
    </div>
  `;
}

function getRiderPriority(order, index) {
  const status = normalizeStatusValue(order?.status);
  if (isCancelledStatus(status)) return { label: "Cancelado", tone: "rider-priority-base" };
  if (isFinalDeliveryStatus(status)) return { label: "Completado", tone: "rider-priority-done" };
  if (status.includes("camino")) return { label: status.includes("local") ? "Camino al local" : "Ruta en curso", tone: "rider-priority-live" };
  if (status === "recibido en local" || status === "en tratamiento") return { label: "Proceso interno", tone: "rider-priority-soon" };
  if (status === "listo para entrega") return { label: "Listo para ruta final", tone: "rider-priority-soon" };
  if (index === 0) return { label: "Siguiente parada", tone: "rider-priority-next" };
  if (status.includes("recogido")) return { label: "Ir al local", tone: "rider-priority-soon" };
  return { label: "Pendiente de atender", tone: "rider-priority-base" };
}

function getRiderNextStatus(order) {
  const status = normalizeStatusValue(order?.status);
  return (ALLOWED_STATUS_TRANSITIONS[status] || [])[0] || null;
}

function getRiderNextActionLabel(order) {
  const nextStatus = getRiderNextStatus(order);
  const labels = {
    "en camino a recoger": "Ir a recoger",
    "recogido al cliente": "Confirmar recogida con PIN",
    "de camino al local": "De camino al local",
    "recibido en local": "Recibido en local",
    "en tratamiento": "Iniciar tratamiento",
    "listo para entrega": "Listo para entrega",
    "en camino a entregar": "Salir a entregar cliente",
    "entregado al cliente": "Cerrar entrega con PIN",
  };
  if (labels[nextStatus]) return labels[nextStatus];
  return "Sin accion pendiente";
}

function renderRiderStateActions(order) {
  const nextStatus = getRiderNextStatus(order);
  if (!nextStatus) {
    return `<button class="btn btn-small btn-outline" type="button" disabled>Sin siguiente estado</button>`;
  }

  const primaryClass = ["recogido al cliente", "entregado al cliente"].includes(nextStatus) ? "btn-primary" : "";
  return `
    <button class="btn btn-small rider-state-action ${primaryClass}" data-state="${escapeHtml(nextStatus)}" data-id="${order.id}">
      ${escapeHtml(getRiderNextActionLabel(order))}
    </button>
  `;
}

function renderRiderProgress(order) {
  const currentRank = getStatusRank(order?.status);
  const currentStatus = normalizeStatusValue(order?.status);
  const steps = [
    { key: "asignado", label: "Asignado" },
    { key: "en camino a recoger", label: "A recoger" },
    { key: "recogido al cliente", label: "Recogido" },
    { key: "de camino al local", label: "Al local" },
    { key: "recibido en local", label: "En local" },
    { key: "en tratamiento", label: "Tratamiento" },
    { key: "listo para entrega", label: "Listo" },
    { key: "en camino a entregar", label: "A entregar" },
    { key: "entregado al cliente", label: "Entregado" },
  ];

  return `
    <div class="rider-progress-line" aria-label="Progreso del pedido">
      ${steps
        .map((step) => {
          const stepRank = getStatusRank(step.key);
          const className = [
            "rider-progress-step",
            stepRank < currentRank ? "rider-progress-step-done" : "",
            step.key === currentStatus ? "rider-progress-step-active" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `
            <div class="${className}">
              <span></span>
              <strong>${escapeHtml(step.label)}</strong>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function getRiderChargeSummary(order) {
  const breakdown = buildOrderChargeBreakdown(order);
  const totalText = breakdown.weightPending
    ? breakdown.total > 0
      ? `Desde ${money(breakdown.total)}`
      : "Por confirmar"
    : money(breakdown.total);
  return {
    totalText,
    weightPending: breakdown.weightPending,
    note: breakdown.weightPending
      ? "Requiere pesaje para cerrar monto final."
      : "Monto estimado listo para factura.",
  };
}

function renderRiderReadinessChips(order) {
  const location = getOrderLocation(order);
  const contactPhone = getOrderContactPhone(order);
  const charge = getRiderChargeSummary(order);
  const chips = [
    {
      label: location ? "GPS listo" : "Sin GPS",
      tone: location ? "rider-ready-chip-good" : "rider-ready-chip-warn",
    },
    {
      label: contactPhone ? "Contacto listo" : "Sin contacto",
      tone: contactPhone ? "rider-ready-chip-good" : "rider-ready-chip-warn",
    },
    {
      label: charge.weightPending ? "Pesaje pendiente" : "Monto listo",
      tone: charge.weightPending ? "rider-ready-chip-warn" : "rider-ready-chip-good",
    },
  ];

  if (String(order?.notes || "").trim()) {
    chips.push({ label: "Tiene nota", tone: "rider-ready-chip-info" });
  }

  return `<div class="rider-ready-row">${chips.map((chip) => `<span class="rider-ready-chip ${chip.tone}">${escapeHtml(chip.label)}</span>`).join("")}</div>`;
}

const RIDER_STAGE_CONFIG = {
  pickup: {
    label: "Recoger",
    title: "Recogidas pendientes",
    copy: "Ir al cliente y confirmar recogida con PIN.",
    icon: "R",
  },
  local: {
    label: "Al local",
    title: "Llevar al local",
    copy: "Prendas recogidas que deben llegar a Menta Laundry.",
    icon: "L",
  },
  delivery: {
    label: "Entregar",
    title: "Entregas finales",
    copy: "Pedidos listos para salir o cerrarse con PIN.",
    icon: "E",
  },
  internal: {
    label: "Interno",
    title: "Proceso interno",
    copy: "Pedidos en local, tratamiento o preparacion.",
    icon: "I",
  },
  done: {
    label: "Listo",
    title: "Completados",
    copy: "Servicios cerrados o cancelados.",
    icon: "OK",
  },
};

function getRiderStageKey(order) {
  const status = normalizeStatusValue(order?.status);
  if (["asignado", "en camino a recoger"].includes(status)) return "pickup";
  if (["recogido al cliente", "de camino al local"].includes(status)) return "local";
  if (["listo para entrega", "en camino a entregar"].includes(status)) return "delivery";
  if (isClosedOrderStatus(status)) return "done";
  return "internal";
}

function renderRiderStageOverview(routePlan) {
  const entries = [...(routePlan?.active || []), ...(routePlan?.waiting || []), ...(routePlan?.done || [])];
  const stageOrder = ["pickup", "local", "delivery", "internal"];

  return `
    <div class="rider-stage-overview" aria-label="Resumen operativo por etapa">
      ${stageOrder.map((stageKey) => {
        const config = RIDER_STAGE_CONFIG[stageKey];
        const stageEntries = entries.filter((entry) => getRiderStageKey(entry.order) === stageKey);
        const nextEntry = stageEntries[0];
        return `
          <div class="rider-stage-card ${stageEntries.length ? "rider-stage-card-live" : ""}">
            <span class="rider-stage-icon">${escapeHtml(config.icon)}</span>
            <div>
              <strong>${escapeHtml(config.title)}</strong>
              <small>${escapeHtml(stageEntries.length ? `${stageEntries.length} pedido${stageEntries.length === 1 ? "" : "s"}` : config.copy)}</small>
              ${nextEntry ? `<em>#${nextEntry.order.id} | ${escapeHtml(nextEntry.order.userName || "Cliente")}</em>` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function getRiderNextStopKind(order) {
  const stage = getRiderStageKey(order);
  return RIDER_STAGE_CONFIG[stage]?.label || "Ruta";
}

function renderRiderNextStopHero(entry, routePlan, assigned = []) {
  const completionCount = assigned.filter((order) => isFinalDeliveryStatus(order.status)).length;
  const completionPercent = assigned.length ? Math.round((completionCount / assigned.length) * 100) : 0;

  if (!entry) {
    return `
      <div class="rider-next-stop-hero rider-next-stop-empty">
        <div class="rider-next-copy">
          <span>Siguiente parada</span>
          <strong>Ruta limpia por ahora</strong>
          <small>No hay pedidos activos pendientes en este momento.</small>
        </div>
        <div class="rider-route-progress"><span style="width:${completionPercent}%"></span></div>
      </div>
    `;
  }

  const order = entry.order;
  const location = getOrderLocation(order);
  const contactDigits = getOrderContactDigits(order);

  return `
    <div class="rider-next-stop-hero">
      <div class="rider-next-copy">
        <span>${escapeHtml(getRiderNextStopKind(order))} | Parada ${entry.stopNumber || "--"}</span>
        <strong>Pedido #${order.id} | ${escapeHtml(order.userName || "Cliente")}</strong>
        <small>${escapeHtml(order.zone || "--")} | ${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time) || "")} | ${escapeHtml(entry.distanceLabel)}</small>
      </div>
      <div class="rider-next-address">
        <div>${escapeHtml(order.address || "Direccion por confirmar")}</div>
        <small>${location ? escapeHtml(formatCoordinatePair(location)) : "Sin GPS, usa la direccion escrita."}</small>
      </div>
      <div class="rider-next-primary-actions">
        ${renderOrderOpsLinks(order, {
          compact: true,
          directions: true,
          origin: routePlan?.routeOrigin?.point,
          mapLabel: "Abrir ruta",
          includeContact: false,
          className: "rider-hero-op-links",
        })}
        <a class="btn btn-small btn-outline" href="tel:+${contactDigits}">Llamar</a>
        <a class="btn btn-small btn-outline" href="https://wa.me/${contactDigits}?text=${encodeURIComponent(getOrderContactMessage(order))}" target="_blank" rel="noreferrer">WhatsApp</a>
        ${renderRiderStateActions(order)}
      </div>
      <div class="rider-route-progress"><span style="width:${completionPercent}%"></span></div>
      <div class="card-secondary">${completionCount} de ${assigned.length} pedidos completados hoy en tu ruta.</div>
    </div>
  `;
}

function renderRiderRouteLog(orders) {
  const movements = orders
    .flatMap((order) => (Array.isArray(order.history) ? order.history : []).map((item) => ({ ...item, order })))
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime())
    .slice(0, 6);

  if (!movements.length) {
    return `
      <div class="rider-route-log">
        <div class="detail-section-title">Bitacora de ruta</div>
        <div class="rider-guide-muted">Cuando actualices pedidos, aqui aparecera el historial rapido de la ruta.</div>
      </div>
    `;
  }

  return `
    <div class="rider-route-log">
      <div class="rider-route-guide-head">
        <div>
          <div class="detail-section-title">Bitacora de ruta</div>
          <div class="card-secondary">Ultimos movimientos sin abrir el detalle.</div>
        </div>
      </div>
      <div class="rider-log-list">
        ${movements.map((movement) => `
          <div class="rider-log-item">
            <span></span>
            <div>
              <strong>#${movement.order.id} | ${escapeHtml(formatStatusLabel(movement.status))}</strong>
              <small>${escapeHtml(movement.order.userName || "Cliente")} | ${escapeHtml(movement.by || "Sistema")} | ${escapeHtml(fmtDate(movement.at))} ${escapeHtml(fmtTime(movement.at))}</small>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function copyText(value, successMessage = "Copiado") {
  const text = String(value || "").trim();
  if (!text) {
    showWarning("No hay informacion para copiar.");
    return;
  }

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showSuccess(successMessage))
      .catch(() => showInfo(text, 5200));
    return;
  }

  showInfo(text, 5200);
}

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

function haversineKm(a, b) {
  if (!a || !b) return null;

  const earthKm = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const arc =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  return earthKm * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function normalizeOrderLocation(location) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const accuracy = Number(location?.accuracy);
  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    inferredZone: String(location?.inferredZone || "").trim() || null,
    source: String(location?.source || "").trim() || "browser",
    capturedAt: String(location?.capturedAt || "").trim() || null,
  };
}

function formatCoordinatePair(location) {
  const point = normalizeOrderLocation(location);
  if (!point) return "--";
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}

function formatAccuracyMeters(value) {
  const meters = Number(value);
  if (!Number.isFinite(meters) || meters <= 0) return "Precision no disponible";
  if (meters < 1000) return `Precision aprox. ${Math.round(meters)} m`;
  return `Precision aprox. ${(meters / 1000).toFixed(1)} km`;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function inferZoneFromCoords(lat, lng) {
  const point = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return "Distrito Nacional";

  if (point.lng <= -69.982 && point.lat >= 18.445) return "Oeste";
  if (point.lng >= -69.875 && point.lat >= 18.43) return "Este";
  if (point.lat <= 18.442 && point.lng <= -69.905) return "Sur";
  if (point.lat >= 18.452 && point.lng > -69.982 && point.lng < -69.885) return "Distrito Nacional";

  const ranked = Object.entries(ZONE_REFERENCE_POINTS)
    .map(([zone, references]) => ({
      zone,
      distance: Math.min(...references.map((reference) => haversineKm(point, reference))),
    }))
    .sort((a, b) => a.distance - b.distance);

  return ranked[0]?.zone || "Distrito Nacional";
}

function getOrderLocation(order) {
  return normalizeOrderLocation(order?.location);
}

function getOrderDistanceFromZone(order) {
  const location = getOrderLocation(order);
  const center = ZONE_CENTERS[order?.zone] || null;
  if (!location || !center) return null;
  return haversineKm(location, center);
}

function getGeoStatusLabel(order) {
  return getOrderLocation(order) ? "GPS verificado" : "Sin punto GPS";
}

function getOrderServiceTimestamp(order) {
  const rawDate = String(order?.date || "").trim();
  if (!rawDate) return null;
  const rawTime = String(order?.time || "").trim() || "00:00";
  const timestamp = new Date(`${rawDate}T${rawTime}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isOrderDelayed(order) {
  if (isClosedOrderStatus(order?.status)) return false;

  const serviceTimestamp = getOrderServiceTimestamp(order);
  if (!Number.isFinite(serviceTimestamp)) return false;
  return serviceTimestamp < Date.now();
}

function getOrderHighlightFlags(order) {
  const location = getOrderLocation(order);
  const zone = String(order?.zone || "").trim() || "Distrito Nacional";
  const distanceFromZone = getOrderDistanceFromZone(order);
  const inferredZone = location?.inferredZone || null;

  return {
    hasGps: Boolean(location),
    noGps: !location,
    delayed: isOrderDelayed(order),
    nearZone: Number.isFinite(distanceFromZone) && distanceFromZone <= 5,
    distanceFromZone,
    inferredZone,
    zoneMismatch: Boolean(location && inferredZone && inferredZone !== zone),
  };
}

function renderSignalChips(order) {
  const flags = getOrderHighlightFlags(order);
  const chips = [];

  if (flags.hasGps) {
    chips.push(`<span class="signal-chip signal-chip-gps">GPS listo</span>`);
  } else {
    chips.push(`<span class="signal-chip signal-chip-warning">Sin GPS</span>`);
  }

  if (flags.delayed) {
    chips.push(`<span class="signal-chip signal-chip-danger">Atrasado</span>`);
  }

  if (flags.nearZone) {
    chips.push(`<span class="signal-chip signal-chip-info">Cerca de su zona</span>`);
  }

  if (flags.zoneMismatch) {
    chips.push(`<span class="signal-chip signal-chip-warning">GPS sugiere ${escapeHtml(flags.inferredZone)}</span>`);
  }

  return chips.join("");
}

function getGestorZoneMapLink(zone) {
  const center = ZONE_CENTERS[zone];
  if (!center) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${center.lat},${center.lng}`)}`;
}

function getGestorRowClass(order) {
  const flags = getOrderHighlightFlags(order);
  if (flags.delayed) return "gestor-row-delayed";
  if (flags.noGps) return "gestor-row-no-gps";
  if (flags.nearZone) return "gestor-row-near";
  return "";
}

function getGestorZoneValidationText(order, flags = getOrderHighlightFlags(order)) {
  const zone = normalizeZoneName(order?.zone);
  if (!flags.hasGps) return "Sin punto GPS";
  if (flags.zoneMismatch && flags.inferredZone) return `GPS sugiere ${flags.inferredZone}`;
  return `Ubicacion valida para ${zone}`;
}

function normalizeZoneName(value) {
  return String(value || "").trim() || "Distrito Nacional";
}

function normalizeGestorZoneFilter(value, zoneList = []) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "all") return "all";
  return zoneList.includes(normalized) ? normalized : "all";
}

function saveGestorZoneFilter(value) {
  gestorZoneFilter = String(value || "").trim() || "all";
  localStorage.setItem(GESTOR_ZONE_FILTER_STORAGE_KEY, gestorZoneFilter);
}

function loadGestorZoneFilter() {
  gestorZoneFilter = localStorage.getItem(GESTOR_ZONE_FILTER_STORAGE_KEY) || "all";
}

function getOrdersByGestorZone(orders, zoneFilter) {
  if (zoneFilter === "all") return [...orders];
  return orders.filter((order) => normalizeZoneName(order?.zone) === zoneFilter);
}

function getRidersByGestorZone(riders, zoneFilter) {
  if (zoneFilter === "all") return [...riders];
  return riders.filter((rider) => normalizeZoneName(rider?.zone) === zoneFilter);
}

function bindGestorZoneFilters(scope) {
  if (!scope) return;

  const refreshGestorZoneView = () => {
    renderScreenForCurrentRole(getActiveScreenId(), { force: true });
  };

  Array.from(scope.querySelectorAll("[data-zone-filter]")).forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      const zone = event.currentTarget?.dataset?.zoneFilter;
      if (!zone) return;
      saveGestorZoneFilter(zone);
      refreshGestorZoneView();
    });

    node.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      const zone = event.currentTarget?.dataset?.zoneFilter;
      if (!zone) return;
      saveGestorZoneFilter(zone);
      refreshGestorZoneView();
    });
  });

  Array.from(scope.querySelectorAll("[data-zone-clear]")).forEach((node) => {
    node.addEventListener("click", () => {
      saveGestorZoneFilter("all");
      refreshGestorZoneView();
    });
  });
}

function getHomePickupMapCenter() {
  const zone = qs("#homeZone")?.value || homeLocation?.inferredZone || "Distrito Nacional";
  return ZONE_CENTERS[zone] || ZONE_CENTERS["Distrito Nacional"];
}

function getHomePickupMapSpan() {
  return { lat: 0.07, lng: 0.09 };
}

function pointToHomePickupMapPosition(point) {
  const location = normalizeOrderLocation(point);
  const center = getHomePickupMapCenter();
  const span = getHomePickupMapSpan();
  if (!location || !center) return { x: 50, y: 50 };

  return {
    x: clampNumber(50 + ((location.lng - center.lng) / span.lng) * 100, 8, 92),
    y: clampNumber(50 - ((location.lat - center.lat) / span.lat) * 100, 8, 92),
  };
}

function homePickupMapPositionToPoint(x, y) {
  const center = getHomePickupMapCenter();
  const span = getHomePickupMapSpan();
  const lat = center.lat + ((50 - y) / 100) * span.lat;
  const lng = center.lng + ((x - 50) / 100) * span.lng;

  return {
    lat,
    lng,
    accuracy: homeLocation?.accuracy || null,
    inferredZone: inferZoneFromCoords(lat, lng),
    source: homeLocation?.source === "browser" ? "browser-adjusted" : "map-adjusted",
    capturedAt: new Date().toISOString(),
  };
}

function setHomeLocationFromMapPoint(lat, lng, options = {}) {
  const normalizedLat = Number(lat);
  const normalizedLng = Number(lng);
  if (!Number.isFinite(normalizedLat) || !Number.isFinite(normalizedLng)) return;

  homeLocation = {
    lat: normalizedLat,
    lng: normalizedLng,
    accuracy: options.accuracy ?? homeLocation?.accuracy ?? null,
    inferredZone: inferZoneFromCoords(normalizedLat, normalizedLng),
    source: options.source || (homeLocation?.source === "browser" ? "browser-adjusted" : "map-adjusted"),
    capturedAt: new Date().toISOString(),
  };

  const zoneInput = qs("#homeZone");
  if (zoneInput && ZONE_CENTERS[homeLocation.inferredZone]) zoneInput.value = homeLocation.inferredZone;
  renderHomeLocationStatus();
  if (options.notify) showSuccess(options.notify);
}

function ensureHomeLeafletMap() {
  const mapEl = qs("#homePickupMap");
  if (!mapEl || !window.L) return false;

  const center = getHomePickupMapCenter();
  mapEl.classList.add("pickup-map-leaflet");

  if (!homePickupLeafletMap) {
    homePickupLeafletMap = window.L.map(mapEl, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: false,
    }).setView([center.lat, center.lng], 14);

    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(homePickupLeafletMap);

    window.L.control.zoom({ position: "bottomright" }).addTo(homePickupLeafletMap);

    homePickupLeafletMarker = window.L.marker([center.lat, center.lng], {
      draggable: true,
      autoPan: true,
      title: "Punto de recogida",
    }).addTo(homePickupLeafletMap);

    homePickupLeafletMarker.on("dragend", () => {
      const point = homePickupLeafletMarker.getLatLng();
      setHomeLocationFromMapPoint(point.lat, point.lng, {
        source: "map-adjusted",
        notify: "Punto de recogida ajustado.",
      });
    });

    homePickupLeafletMap.on("click", (event) => {
      if (!homeLocation) {
        showWarning("Primero activa el GPS para confirmar que estas cerca del punto de recogida.");
        return;
      }
      setHomeLocationFromMapPoint(event.latlng.lat, event.latlng.lng, {
        source: "map-adjusted",
        notify: "Punto de recogida ajustado.",
      });
    });
  }

  window.setTimeout(() => homePickupLeafletMap?.invalidateSize?.(), 40);
  return true;
}

function renderHomePickupMap() {
  const map = qs("#homePickupMap");
  const pin = qs("#homePickupPin");
  const accuracy = qs("#homePickupAccuracy");
  const label = qs("#homePickupMapLabel");
  if (!map || !label) return;

  map.classList.toggle("pickup-map-empty", !homeLocation);
  map.classList.toggle("pickup-map-ready", Boolean(homeLocation));
  const center = getHomePickupMapCenter();
  const target = homeLocation || center;

  if (ensureHomeLeafletMap()) {
    const latLng = [target.lat, target.lng];
    const zoom = homeLocation ? 16 : 13;
    homePickupLeafletMap.setView(latLng, zoom, { animate: true });
    homePickupLeafletMarker?.setLatLng(latLng);
    homePickupLeafletMarker?.setOpacity(homeLocation ? 1 : 0.42);

    if (homePickupLeafletAccuracy) {
      homePickupLeafletAccuracy.remove();
      homePickupLeafletAccuracy = null;
    }

    if (homeLocation) {
      homePickupLeafletAccuracy = window.L.circle(latLng, {
        radius: clampNumber(homeLocation.accuracy || 80, 35, 250),
        color: "#2fa883",
        weight: 1,
        fillColor: "#64cedd",
        fillOpacity: 0.14,
      }).addTo(homePickupLeafletMap);
    }

    label.textContent = homeLocation
      ? `Punto de recogida | ${homeLocation.inferredZone || qs("#homeZone")?.value || "Zona sugerida"}`
      : "Activa el GPS para fijar el pin exacto";
    return;
  }

  if (!pin || !accuracy) return;

  if (!homeLocation) {
    pin.style.left = "50%";
    pin.style.top = "50%";
    accuracy.style.width = "96px";
    accuracy.style.height = "96px";
    label.textContent = "Activa el GPS para ver el punto de recogida";
    return;
  }

  const position = pointToHomePickupMapPosition(homeLocation);
  const accuracySize = clampNumber(Number(homeLocation.accuracy || 0) / 3, 54, 150);
  pin.style.left = `${position.x}%`;
  pin.style.top = `${position.y}%`;
  accuracy.style.left = `${position.x}%`;
  accuracy.style.top = `${position.y}%`;
  accuracy.style.width = `${accuracySize}px`;
  accuracy.style.height = `${accuracySize}px`;
  label.textContent = `Punto de recogida | ${homeLocation.inferredZone || qs("#homeZone")?.value || "Zona sugerida"}`;
}

function adjustHomeLocationFromMapEvent(event) {
  const map = qs("#homePickupMap");
  if (!map) return;
  if (homePickupLeafletMap) return;

  if (!homeLocation) {
    showWarning("Primero activa el GPS para confirmar que estas cerca del punto de recogida.");
    return;
  }

  const rect = map.getBoundingClientRect();
  const x = clampNumber(((event.clientX - rect.left) / rect.width) * 100, 8, 92);
  const y = clampNumber(((event.clientY - rect.top) / rect.height) * 100, 8, 92);
  homeLocation = homePickupMapPositionToPoint(x, y);

  const zoneInput = qs("#homeZone");
  if (zoneInput && ZONE_CENTERS[homeLocation.inferredZone]) zoneInput.value = homeLocation.inferredZone;
  renderHomeLocationStatus();
  showSuccess("Punto de recogida ajustado.");
}

function renderHomeLocationStatus() {
  const statusNode = qs("#homeGeoStatus");
  const metaNode = qs("#homeGeoMeta");
  const coordsNode = qs("#homeGeoCoords");
  const zoneNode = qs("#homeGeoZone");
  const openLink = qs("#homeGeoOpenLink");
  if (!statusNode || !metaNode || !coordsNode || !zoneNode || !openLink) return;

  if (!homeLocation) {
    renderHomePickupMap();
    statusNode.textContent = "GPS requerido para recoger";
    statusNode.className = "geo-status";
    metaNode.textContent = "Comparte tu ubicacion para fijar el punto exacto de recogida y sugerir la zona mas cercana.";
    coordsNode.textContent = "Aun no hay coordenadas registradas en este pedido.";
    zoneNode.textContent = "GPS pendiente";
    zoneNode.className = "estimate-tag estimate-tag-muted";
    openLink.removeAttribute("href");
    openLink.setAttribute("aria-disabled", "true");
    openLink.classList.add("btn-disabled");
    updateOrderEstimatePreview();
    renderOrderWizardState();
    return;
  }

  renderHomePickupMap();
  statusNode.textContent = "Ubicacion capturada";
  statusNode.className = "geo-status geo-status-success";
  const sourceLabel = homeLocation.source?.includes("adjusted") ? "GPS ajustado en mapa" : "GPS del navegador";
  metaNode.textContent = `${formatAccuracyMeters(homeLocation.accuracy)} | Fuente: ${sourceLabel}`;
  coordsNode.textContent = formatCoordinatePair(homeLocation);
  zoneNode.textContent = `Zona sugerida: ${homeLocation.inferredZone || "Distrito Nacional"}`;
  zoneNode.className = "estimate-tag";
  openLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${homeLocation.lat},${homeLocation.lng}`)}`;
  openLink.removeAttribute("aria-disabled");
  openLink.classList.remove("btn-disabled");
  updateOrderEstimatePreview();
  renderOrderWizardState();
}

function clearHomeLocation() {
  homeLocation = null;
  renderHomeLocationStatus();
}

function saveRiderLocation(location) {
  riderLocation = normalizeOrderLocation(location);
  if (riderLocation) {
    localStorage.setItem(RIDER_LOCATION_STORAGE_KEY, JSON.stringify(riderLocation));
  } else {
    localStorage.removeItem(RIDER_LOCATION_STORAGE_KEY);
  }
}

function loadSavedRiderLocation() {
  const saved = localStorage.getItem(RIDER_LOCATION_STORAGE_KEY);
  if (!saved) {
    riderLocation = null;
    return;
  }

  try {
    riderLocation = normalizeOrderLocation(JSON.parse(saved));
  } catch {
    riderLocation = null;
    localStorage.removeItem(RIDER_LOCATION_STORAGE_KEY);
  }
}

function captureHomeLocation() {
  if (!navigator.geolocation) {
    showWarning("Tu navegador no soporta geolocalizacion.");
    return;
  }

  const locateBtn = qs("#homeGeoLocateBtn");
  if (locateBtn) {
    locateBtn.disabled = true;
    locateBtn.textContent = "Ubicando...";
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = Number(position.coords.latitude);
      const lng = Number(position.coords.longitude);
      const accuracy = Number(position.coords.accuracy || 0);
      const inferredZone = inferZoneFromCoords(lat, lng);

      homeLocation = {
        lat,
        lng,
        accuracy,
        inferredZone,
        source: "browser",
        capturedAt: new Date().toISOString(),
      };

      const zoneInput = qs("#homeZone");
      if (zoneInput && ZONE_CENTERS[inferredZone]) zoneInput.value = inferredZone;

      const addressInput = qs("#homeAddress");
      if (addressInput && !addressInput.value.trim()) {
        addressInput.placeholder = "GPS capturado. Agrega una referencia como torre, calle o apartamento.";
      }

      renderHomeLocationStatus();
      updateOrderEstimatePreview();

      if (locateBtn) {
        locateBtn.disabled = false;
        locateBtn.textContent = "Actualizar ubicacion";
      }
    },
    (error) => {
      const messages = {
        1: "Necesitamos permiso de ubicacion para capturar el punto real del pedido.",
        2: "No pudimos obtener tu ubicacion actual.",
        3: "La geolocalizacion tardó demasiado. Intenta otra vez.",
      };
      showWarning(messages[error.code] || "No fue posible capturar la ubicacion.");
      if (locateBtn) {
        locateBtn.disabled = false;
        locateBtn.textContent = "Usar mi ubicacion";
      }
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

function getRiderRouteOrigin() {
  const gpsPoint = normalizeOrderLocation(riderLocation);
  if (gpsPoint) {
    return {
      point: gpsPoint,
      mode: "gps_actual",
      label: "Tu ubicacion actual",
      summary: `${formatCoordinatePair(gpsPoint)} | ${formatAccuracyMeters(gpsPoint.accuracy)}`,
      mapLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${gpsPoint.lat},${gpsPoint.lng}`)}`,
    };
  }

  const zoneCenter = currentUser?.zone ? ZONE_CENTERS[currentUser.zone] : null;
  if (zoneCenter) {
    return {
      point: zoneCenter,
      mode: "centro_zona",
      label: `Centro aproximado de ${currentUser.zone}`,
      summary: `${zoneCenter.lat.toFixed(5)}, ${zoneCenter.lng.toFixed(5)}`,
      mapLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${zoneCenter.lat},${zoneCenter.lng}`)}`,
    };
  }

  return {
    point: null,
    mode: "sin_origen",
    label: "Sin punto de partida",
    summary: "Comparte tu ubicacion para ordenar la ruta por cercania real.",
    mapLink: "",
  };
}

function compareByServiceMoment(a, b) {
  const aDate = new Date(`${a.date || "1970-01-01"}T${a.time || "00:00"}`).getTime();
  const bDate = new Date(`${b.date || "1970-01-01"}T${b.time || "00:00"}`).getTime();
  return aDate - bDate;
}

function buildRiderRoutePlan(orders) {
  const routeOrigin = getRiderRouteOrigin();
  const active = orders.filter((order) => isRiderRouteStatus(order.status));
  const waiting = orders
    .filter((order) => !isRiderRouteStatus(order.status) && !isClosedOrderStatus(order.status))
    .sort(compareByServiceMoment)
    .map((order) => ({
      order,
      stopNumber: null,
      routeType: "interno",
      distanceFromPreviousKm: null,
      distanceLabel: "Proceso interno o preparacion para la siguiente ruta.",
    }));
  const done = orders.filter((order) => isClosedOrderStatus(order.status));

  const withGps = active.filter((order) => getOrderLocation(order));
  const withoutGps = active.filter((order) => !getOrderLocation(order)).sort(compareByServiceMoment);

  const orderedActive = [];
  const remaining = [...withGps];
  let currentPoint = routeOrigin.point;
  let stopNumber = 1;

  while (remaining.length) {
    remaining.sort((a, b) => {
      const aPoint = getOrderLocation(a);
      const bPoint = getOrderLocation(b);
      const distanceA = currentPoint && aPoint ? haversineKm(currentPoint, aPoint) : Infinity;
      const distanceB = currentPoint && bPoint ? haversineKm(currentPoint, bPoint) : Infinity;

      if (Math.abs(distanceA - distanceB) > 0.01) return distanceA - distanceB;
      return compareByServiceMoment(a, b);
    });

    const nextOrder = remaining.shift();
    const nextPoint = getOrderLocation(nextOrder);
    const distanceFromPreviousKm = currentPoint && nextPoint ? haversineKm(currentPoint, nextPoint) : null;

    orderedActive.push({
      order: nextOrder,
      stopNumber,
      routeType: routeOrigin.mode,
      distanceFromPreviousKm,
      distanceLabel: Number.isFinite(distanceFromPreviousKm)
        ? `${distanceFromPreviousKm.toFixed(1)} km desde ${stopNumber === 1 ? routeOrigin.label.toLowerCase() : "la parada anterior"}`
        : "Sin distancia calculable",
    });

    currentPoint = nextPoint || currentPoint;
    stopNumber += 1;
  }

  withoutGps.forEach((order) => {
    orderedActive.push({
      order,
      stopNumber,
      routeType: "sin_gps",
      distanceFromPreviousKm: null,
      distanceLabel: "Sin GPS. Ordenado por fecha y hora.",
    });
    stopNumber += 1;
  });

  const orderedDone = done
    .sort(compareByServiceMoment)
    .map((order) => ({
      order,
      stopNumber: null,
      routeType: "completado",
      distanceFromPreviousKm: null,
      distanceLabel: "Pedido completado.",
    }));

  return {
    routeOrigin,
    active: orderedActive,
    waiting,
    done: orderedDone,
    gpsCount: withGps.length,
    noGpsCount: withoutGps.length,
  };
}

const RIDER_NEARBY_GROUP_KM = 1.6;
const RIDER_MULTI_STOP_LIMIT = 9;

function formatRoutePoint(point) {
  const location = normalizeOrderLocation(point);
  if (!location) return "";
  return `${location.lat},${location.lng}`;
}

function getRiderGpsRouteEntries(routePlan) {
  return (routePlan?.active || []).filter((entry) => getOrderLocation(entry.order));
}

function buildRiderMultiStopDirectionsLink(routePlan) {
  const gpsEntries = getRiderGpsRouteEntries(routePlan).slice(0, RIDER_MULTI_STOP_LIMIT);
  if (!gpsEntries.length) return "";

  const destinationPoint = getOrderLocation(gpsEntries[gpsEntries.length - 1].order);
  const params = new URLSearchParams({
    api: "1",
    destination: formatRoutePoint(destinationPoint),
    travelmode: "driving",
  });

  if (routePlan?.routeOrigin?.point) {
    params.set("origin", formatRoutePoint(routePlan.routeOrigin.point));
  }

  const waypointEntries = gpsEntries.length > 1 ? gpsEntries.slice(0, -1) : [];
  if (waypointEntries.length) {
    params.set(
      "waypoints",
      waypointEntries
        .map((entry) => formatRoutePoint(getOrderLocation(entry.order)))
        .filter(Boolean)
        .join("|")
    );
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function buildRiderNearbyGroups(routePlan) {
  const gpsEntries = getRiderGpsRouteEntries(routePlan);
  const groups = [];
  let currentGroup = [];

  gpsEntries.forEach((entry) => {
    const point = getOrderLocation(entry.order);
    const previous = currentGroup[currentGroup.length - 1];
    const previousPoint = previous ? getOrderLocation(previous.order) : null;
    const distanceFromPrevious = previousPoint && point ? haversineKm(previousPoint, point) : null;

    if (!currentGroup.length || Number.isFinite(distanceFromPrevious) && distanceFromPrevious <= RIDER_NEARBY_GROUP_KM) {
      currentGroup.push({ ...entry, nearbyDistanceKm: distanceFromPrevious });
      return;
    }

    if (currentGroup.length > 1) groups.push(currentGroup);
    currentGroup = [{ ...entry, nearbyDistanceKm: null }];
  });

  if (currentGroup.length > 1) groups.push(currentGroup);
  return groups;
}

function renderRiderRouteGuide(routePlan) {
  const activeEntries = routePlan?.active || [];
  const gpsEntries = getRiderGpsRouteEntries(routePlan);
  const noGpsEntries = activeEntries.filter((entry) => !getOrderLocation(entry.order));
  const nearbyGroups = buildRiderNearbyGroups(routePlan);
  const fullRouteLink = buildRiderMultiStopDirectionsLink(routePlan);
  const totalKm = activeEntries.reduce((sum, entry) => (
    Number.isFinite(entry.distanceFromPreviousKm) ? sum + entry.distanceFromPreviousKm : sum
  ), 0);
  const mappedStops = Math.min(gpsEntries.length, RIDER_MULTI_STOP_LIMIT);

  if (!activeEntries.length) {
    return `
      <div class="rider-route-guide">
        <div class="detail-section-title">Guia de paradas cercanas</div>
        <div class="rider-guide-empty">Cuando tengas pedidos activos, aqui veras la ruta recomendada por cercania.</div>
      </div>
    `;
  }

  return `
    <div class="rider-route-guide">
      <div class="rider-route-guide-head">
        <div>
          <div class="detail-section-title">Guia de paradas cercanas</div>
          <div class="card-secondary">
            ${gpsEntries.length} paradas con GPS | ${noGpsEntries.length} sin GPS | ${totalKm > 0 ? `${totalKm.toFixed(1)} km estimados` : "Distancia por confirmar"}
          </div>
        </div>
        ${
          fullRouteLink
            ? `<a class="btn btn-small btn-primary" href="${fullRouteLink}" target="_blank" rel="noreferrer">Abrir ruta completa</a>`
            : `<span class="btn btn-small btn-outline btn-disabled">Ruta sin GPS</span>`
        }
      </div>

      <div class="rider-guide-grid">
        <div class="rider-guide-panel">
          <div class="rider-guide-panel-title">Orden recomendado</div>
          <div class="rider-guide-stop-list">
            ${
              gpsEntries.length
                ? gpsEntries.slice(0, RIDER_MULTI_STOP_LIMIT).map((entry) => `
                  <div class="rider-guide-stop">
                    <span>${entry.stopNumber}</span>
                    <div>
                      <strong>#${entry.order.id} | ${escapeHtml(entry.order.userName || "Cliente")}</strong>
                      <small>${escapeHtml(entry.order.zone || "--")} | ${escapeHtml(entry.distanceLabel)}</small>
                    </div>
                  </div>
                `).join("")
                : `<div class="rider-guide-muted">No hay paradas con GPS para calcular cercania.</div>`
            }
          </div>
          ${
            gpsEntries.length > RIDER_MULTI_STOP_LIMIT
              ? `<div class="rider-guide-note">Maps abre las primeras ${mappedStops} paradas para mantener la ruta estable.</div>`
              : ""
          }
        </div>

        <div class="rider-guide-panel">
          <div class="rider-guide-panel-title">Pedidos cerca entre si</div>
          <div class="rider-nearby-list">
            ${
              nearbyGroups.length
                ? nearbyGroups.slice(0, 3).map((group, index) => `
                  <div class="rider-nearby-group">
                    <strong>Bloque ${index + 1}: ${group.length} paradas cercanas</strong>
                    <span>Conviene hacerlas juntas antes de saltar a otra zona.</span>
                    <div class="rider-nearby-orders">
                      ${group.map((entry) => `<small>#${entry.order.id} | ${escapeHtml(entry.order.userName || "Cliente")} | ${escapeHtml(entry.order.zone || "--")}</small>`).join("")}
                    </div>
                  </div>
                `).join("")
                : `<div class="rider-guide-muted">Por ahora no hay dos paradas suficientemente cercanas.</div>`
            }
          </div>
        </div>
      </div>

      ${
        noGpsEntries.length
          ? `
            <div class="rider-no-gps-strip">
              <strong>Revisar antes de salir:</strong>
              <span>${escapeHtml(noGpsEntries.slice(0, 4).map((entry) => `#${entry.order.id} ${entry.order.address || entry.order.zone || ""}`).join(" | "))}</span>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function refreshRiderRoute() {
  if (currentUser?.role === "repartidor") renderRepartidorHome();
}

function clearRiderLocation() {
  saveRiderLocation(null);
  refreshRiderRoute();
}

function captureRiderLocation() {
  if (!navigator.geolocation) {
    showWarning("Tu navegador no soporta geolocalizacion.");
    return;
  }

  const locateBtn = qs("#riderGeoLocateBtn");
  if (locateBtn) {
    locateBtn.disabled = true;
    locateBtn.textContent = "Calculando...";
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      saveRiderLocation({
        lat: Number(position.coords.latitude),
        lng: Number(position.coords.longitude),
        accuracy: Number(position.coords.accuracy || 0),
        inferredZone: inferZoneFromCoords(position.coords.latitude, position.coords.longitude),
        source: "browser",
        capturedAt: new Date().toISOString(),
      });

      refreshRiderRoute();

      const btn = qs("#riderGeoLocateBtn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Actualizar mi punto";
      }
    },
    (error) => {
      const messages = {
        1: "Debes permitir la ubicacion para calcular la ruta real.",
        2: "No pudimos obtener tu ubicacion actual.",
        3: "La consulta de ubicacion tardó demasiado. Intenta otra vez.",
      };
      showWarning(messages[error.code] || "No fue posible capturar tu ubicacion.");
      const btn = qs("#riderGeoLocateBtn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = riderLocation ? "Actualizar mi punto" : "Usar mi ubicacion";
      }
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

function getGarmentPriceByName(name) {
  return GARMENT_OPTIONS.find((item) => item.label === name)?.price || 0;
}

function getNormalizedGarments(order) {
  return Array.isArray(order?.selectedGarments)
    ? order.selectedGarments
        .map((item) => ({
          name: String(item?.name || "").trim(),
          qty: Number(item?.qty || 0),
          price: Number(item?.price || getGarmentPriceByName(item?.name)),
        }))
        .filter((item) => item.name && item.qty > 0)
    : [];
}

function buildOrderChargeBreakdown(order) {
  const pricingMode = order?.pricingMode || "por_libra";
  const lbs = Number(order?.lbs || 0);
  const garments = getNormalizedGarments(order);
  const extras = Array.isArray(order?.extras) ? order.extras : [];
  const lines = [];
  const weightPending = (pricingMode === "por_libra" || pricingMode === "mixto") && lbs <= 0;

  if (pricingMode === "por_libra" || pricingMode === "mixto") {
    const base = lbs * 30;
    lines.push({
      label: "Ropa por libra",
      qty: lbs > 0 ? `${lbs.toFixed(1)} lb` : "Pendiente de pesaje",
      price: 30,
      total: base,
    });
  }

  if (pricingMode === "por_prendas" || pricingMode === "mixto") {
    garments.forEach((item) => {
      lines.push({
        label: item.name,
        qty: item.qty,
        price: item.price,
        total: item.qty * item.price,
      });
    });
  }

  if (extras.length) {
    lines.push({
      label: `Extras (${extras.join(", ")})`,
      qty: extras.length,
      price: 75,
      total: extras.length * 75,
    });
  }

  if (!lines.length) {
    lines.push({
      label: getOrderPacks(order).join(", ") || order?.pack || "Servicio solicitado",
      qty: 1,
      price: 0,
      total: 0,
    });
  }

  const subtotal = lines.reduce((sum, line) => sum + Number(line.total || 0), 0);
  const itbis = subtotal * 0.18;

  return {
    lines,
    subtotal,
    itbis,
    total: subtotal + itbis,
    garments,
    lbs,
    weightPending,
  };
}

function renderTagList(items, emptyText = "No aplica") {
  if (!items.length) return `<span class="detail-tag detail-tag-muted">${escapeHtml(emptyText)}</span>`;
  return items.map((item) => `<span class="detail-tag">${escapeHtml(item)}</span>`).join("");
}

function getHomeEstimatedLbs() {
  return Number(qs("#homeEstimatedLbs")?.value || 0);
}

function buildHomeEstimateOrder() {
  return {
    packs: getSelectedPacks(),
    pricingMode: qs("#homePricingMode")?.value || "por_libra",
    selectedGarments: collectSelectedGarments(),
    extras: Array.from(qs("#quickOrderForm")?.querySelectorAll(".chip input:checked") || []).map((input) => input.value),
    lbs: getHomeEstimatedLbs(),
  };
}

function updateOrderEstimatePreview() {
  const summary = qs("#homeEstimateCard");
  if (!summary) return;

  const estimateOrder = buildHomeEstimateOrder();
  const packs = getOrderPacks(estimateOrder);
  const breakdown = buildOrderChargeBreakdown(estimateOrder);
  const date = qs("#homeDate")?.value;
  const time = qs("#homeTime")?.value;
  const zone = qs("#homeZone")?.value;
  const serviceType = qs("#homePickupType")?.value;
  const geoText = homeLocation ? `GPS en ${homeLocation.inferredZone || zone || "zona detectada"}` : "Sin GPS";

  qs("#homeEstimateService").innerHTML = packs.length
    ? packs.map((pack) => `<span class="estimate-tag">${escapeHtml(pack)}</span>`).join("")
    : `<span class="estimate-tag estimate-tag-muted">Selecciona uno o varios paquetes</span>`;

  qs("#homeEstimateMeta").innerHTML = `
    <span>${escapeHtml(serviceType || "Servicio")}</span>
    <span>${escapeHtml(zone || "Zona")}</span>
    <span>${escapeHtml(geoText)}</span>
    <span>${date ? escapeHtml(fmtDate(date)) : "Fecha pendiente"}</span>
    <span>${time ? escapeHtml(fmtTime(time)) : "Hora pendiente"}</span>
  `;

  qs("#homeEstimateLines").innerHTML = breakdown.lines
    .map(
      (line) => `
        <div class="estimate-line">
          <span>${escapeHtml(line.label)} <small>${escapeHtml(String(line.qty))}</small></span>
          <strong>${line.total > 0 ? money(line.total) : "Por confirmar"}</strong>
        </div>
      `
    )
    .join("");

  const subtotalNode = qs("#homeEstimateSubtotal");
  const totalNode = qs("#homeEstimateTotal");
  const noteNode = qs("#homeEstimateNote");

  if (subtotalNode) {
    subtotalNode.textContent = breakdown.weightPending
      ? breakdown.subtotal > 0
        ? `Desde ${money(breakdown.subtotal)}`
        : "Por confirmar"
      : money(breakdown.subtotal);
  }
  if (totalNode) {
    totalNode.textContent = breakdown.weightPending
      ? breakdown.total > 0
        ? `Desde ${money(breakdown.total)}`
        : "Por confirmar"
      : money(breakdown.total);
  }

  if (noteNode) {
    if (breakdown.weightPending) {
      noteNode.textContent = `${homeLocation ? "GPS capturado para esta direccion. " : ""}El total por libra se confirma al pesar las prendas en recepcion o al recoger.`;
    } else if (!packs.length) {
      noteNode.textContent = homeLocation
        ? "GPS capturado. Selecciona tu servicio para ver el resumen estimado."
        : "Selecciona tu servicio para ver el resumen estimado.";
    } else {
      noteNode.textContent = `${homeLocation ? "Ubicacion real incluida. " : ""}Incluye ITBIS y extras seleccionados. El total final puede ajustarse segun revision.`;
    }
  }

  renderOrderWizardState();
}

function updateDashboardHero() {
  if (!currentUser) return;

  const badge = qs("#homeContextBadge");
  const today = new Date().toISOString().slice(0, 10);
  const clientOrders = ordersCache.filter((o) => o.userId === currentUser.id);
  const localToday = localOrdersCache.filter((o) => o.date === today);

  if (currentUser.role === "cliente") {
    const active = clientOrders.filter((o) => !isClosedOrderStatus(o.status));
    const delivered = clientOrders.filter((o) => isFinalDeliveryStatus(o.status));
    setHeroStat(1, "Pedidos", String(clientOrders.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Entregados", String(delivered.length));
    if (badge) badge.textContent = "Servicio a domicilio";
    return;
  }

  if (currentUser.role === "gestor") {
    const pending = ordersCache.filter((o) => o.channel !== "local" && o.status === "pendiente");
    const active = ordersCache.filter((o) => o.channel !== "local" && !isClosedOrderStatus(o.status));
    setHeroStat(1, "Pendientes", String(pending.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Rutas", String(repartidoresCache.length));
    if (badge) badge.textContent = "Panel de operaciones";
    return;
  }

  if (currentUser.role === "repartidor") {
    const assigned = ordersCache.filter((o) => Number(o.repartidorId) === Number(currentUser.id));
    const todayCount = assigned.filter((o) => o.date === today);
    const delivered = assigned.filter((o) => isFinalDeliveryStatus(o.status));
    setHeroStat(1, "Asignados", String(assigned.length));
    setHeroStat(2, "Hoy", String(todayCount.length));
    setHeroStat(3, "Entregados", String(delivered.length));
    if (badge) badge.textContent = "Ruta del dia";
    return;
  }

  if (currentUser.role === "cajera") {
    const received = localOrdersCache.filter((o) => String(o.status).toLowerCase().includes("recibido"));
    setHeroStat(1, "Local", String(localOrdersCache.length));
    setHeroStat(2, "Hoy", String(localToday.length));
    setHeroStat(3, "Recibidos", String(received.length));
    if (badge) badge.textContent = "Recepcion local";
  }
}

function ensureWelcomeEnhancements() {
  const welcomeBlock = qs(".welcome-block");
  const welcomeText = welcomeBlock?.querySelector(".welcome-text");
  const roleBadge = welcomeBlock?.querySelector(".role-badge");
  if (!welcomeBlock || !welcomeText) return;
  if (roleBadge) roleBadge.hidden = true;

  let main = welcomeBlock.querySelector(".welcome-main");
  let side = welcomeBlock.querySelector(".welcome-side");

  if (!main || !side) {
    main = document.createElement("div");
    main.className = "welcome-main";
    main.innerHTML = `<div class="card-eyebrow">Centro de control</div>`;
    main.appendChild(welcomeText);

    const tags = document.createElement("div");
    tags.className = "welcome-tags";
    main.appendChild(tags);

    side = document.createElement("div");
    side.className = "welcome-side";

    const stats = document.createElement("div");
    stats.className = "hero-stats";
    stats.innerHTML = `
      <div class="hero-stat">
        <span id="heroStatLabel1" class="hero-stat-label">Pedidos</span>
        <strong id="heroStatValue1" class="hero-stat-value">0</strong>
      </div>
      <div class="hero-stat">
        <span id="heroStatLabel2" class="hero-stat-label">Estado</span>
        <strong id="heroStatValue2" class="hero-stat-value">0</strong>
      </div>
      <div class="hero-stat">
        <span id="heroStatLabel3" class="hero-stat-label">Clientes</span>
        <strong id="heroStatValue3" class="hero-stat-value">0</strong>
      </div>
    `;
    side.appendChild(stats);

    welcomeBlock.innerHTML = "";
    welcomeBlock.append(main, side);
  }

  const eyebrow = welcomeBlock.querySelector(".card-eyebrow");
  if (eyebrow) eyebrow.textContent = BUSINESS_PROFILE.tagline;

  const tags = welcomeBlock.querySelector(".welcome-tags");
  if (tags) {
    tags.innerHTML = `
      <span class="info-chip">Domicilio y local</span>
      <span class="info-chip">Prendas delicadas</span>
      <span class="info-chip">Seguimiento profesional</span>
    `;
  }
}

function ensureHomeEnhancements() {
  const screenHome = qs("#screenHome");
  if (!screenHome) return;

  let heading = screenHome.querySelector(".screen-heading");
  if (!heading) {
    heading = document.createElement("div");
    heading.className = "screen-heading";
    screenHome.prepend(heading);
  }

  heading.innerHTML = `
    <div>
      <div class="screen-kicker">${BUSINESS_PROFILE.tagline}</div>
      <h3 class="screen-title">Operacion y experiencia</h3>
    </div>
    <div id="homeContextBadge" class="screen-badge">Servicio profesional</div>
  `;

  const nextOrderCard = qs("#nextOrderCard");
  const quickOrderCard = qs("#quickOrderCard");
  if (nextOrderCard && !screenHome.querySelector(".home-client-layout")) {
    const layout = document.createElement("div");
    layout.className = "home-client-layout";
    screenHome.insertBefore(layout, nextOrderCard);
    layout.appendChild(nextOrderCard);

    const serviceCard = document.createElement("div");
    serviceCard.id = "serviceExperienceCard";
    serviceCard.className = "card service-card";
    layout.appendChild(serviceCard);
  }

  const serviceCard = qs("#serviceExperienceCard");
  if (serviceCard) {
    serviceCard.innerHTML = `
      <div class="card-title">Servicio pensado para clientes reales</div>
      <div class="service-grid">
        <div class="service-item"><strong>Recogida programada</strong><span>Agenda tu visita por zona con fecha y hora claras.</span></div>
        <div class="service-item"><strong>Clasificacion del servicio</strong><span>Combina paquetes y define si sera por libra, por prendas o mixto.</span></div>
        <div class="service-item"><strong>Estimado antes de confirmar</strong><span>Revisa el resumen del pedido antes de enviarlo.</span></div>
      </div>
    `;
  }

  quickOrderCard?.classList.add("order-card");
  qs("#cashierForm")?.closest(".card")?.classList.add("order-card");
  qs("#ridersActivity")?.classList.add("riders-activity");

  const activityCard = qs("#screenActivity .card");
  if (activityCard && !activityCard.querySelector(".card-secondary")) {
    const subtitle = document.createElement("div");
    subtitle.className = "card-secondary";
    subtitle.textContent = "Historial reciente de pedidos y movimientos.";
    activityCard.insertBefore(subtitle, qs("#activityTimeline"));
  }

  const localCard = qs("#screenLocal .card + .card");
  localCard?.classList.add("card-spaced");

  const gestorCard = qs("#gestorHomePanel .card");
  gestorCard?.classList.add("card-spaced");

  ensureClientOrderEnhancements();
  ensureDetailModal();
}

function normalizeStaticCopy() {
  const nextOrderTitle = qs("#nextOrderCard .card-title");
  if (nextOrderTitle) nextOrderTitle.textContent = "Tu pedido activo";

  const quickTitle = qs("#quickOrderCard .card-title");
  const quickSubtitle = qs("#quickOrderCard .card-secondary");
  if (quickTitle) quickTitle.textContent = "Solicitar servicio a domicilio";
  if (quickSubtitle) {
    quickSubtitle.textContent =
      "Completa 3 pasos claros: servicio, ubicacion y confirmacion final.";
  }

  const homeZoneLabel = qs("#homeZone")?.closest(".field-group")?.querySelector("label");
  const homeAddressLabel = qs("#homeAddress")?.closest(".field-group")?.querySelector("label");
  const homePhoneLabel = qs("#homeContactPhone")?.closest(".field-group")?.querySelector("label");
  const homeDateLabel = qs("#homeDate")?.closest(".field-group")?.querySelector("label");
  const homeTimeLabel = qs("#homeTime")?.closest(".field-group")?.querySelector("label");
  const homePickupLabel = qs("#homePickupType")?.closest(".field-group")?.querySelector("label");
  const homePackLabel = qs("#homePackSelector")?.closest(".field-group")?.querySelector("label");
  const homePricingLabel = qs("#homePricingMode")?.closest(".field-group")?.querySelector("label");
  const homeGarmentsLabel = qs("#homeGarmentField")?.querySelector("label");
  const homeExtrasLabel = qs("#quickOrderForm .chip-group")?.closest(".field-group")?.querySelector("label");
  const homeNotesLabel = qs("#homeNotes")?.closest(".field-group")?.querySelector("label");

  if (homeZoneLabel) homeZoneLabel.textContent = "Zona";
  if (homeAddressLabel) homeAddressLabel.textContent = "Direccion";
  if (homePhoneLabel) homePhoneLabel.textContent = "Telefono de contacto";
  if (homeDateLabel) homeDateLabel.textContent = "Fecha";
  if (homeTimeLabel) homeTimeLabel.textContent = "Hora";
  if (homePickupLabel) homePickupLabel.textContent = "Tipo de servicio";
  if (homePackLabel) homePackLabel.textContent = "Paquetes de servicio";
  if (homePricingLabel) homePricingLabel.textContent = "Tipo de cobro";
  if (homeGarmentsLabel) homeGarmentsLabel.textContent = "Prendas seleccionadas";
  if (homeExtrasLabel) homeExtrasLabel.textContent = "Extras";
  if (homeNotesLabel) homeNotesLabel.textContent = "Notas";

  if (qs("#homeAddress")) qs("#homeAddress").placeholder = "Ej: Calle 27 #14, Naco";
  if (qs("#homeNotes")) qs("#homeNotes").placeholder = "Ej: tocar el timbre, dejar en recepcion...";

  const cashierTitleNodes = qsa("#cashierHomePanel .card-title");
  if (cashierTitleNodes[0]) cashierTitleNodes[0].textContent = "Local y caja";
  if (cashierTitleNodes[1]) cashierTitleNodes[1].textContent = "Crear pedido en local";
  const cashierSubtitle = qs("#cashierHomePanel .card-secondary");
  if (cashierSubtitle) cashierSubtitle.textContent = "Registra pedidos cuando el cliente entrega en tienda.";

  const cashierOptions = qs("#cashierPack")?.options || [];
  if (cashierOptions[3]) cashierOptions[3].textContent = "Tintoreria en seco";

  const premiumTitle = qs("#screenPremium .card-title");
  const premiumText = qs("#screenPremium .premium-text");
  const premiumNote = qs("#screenPremium .premium-note");
  if (premiumTitle) premiumTitle.textContent = "Servicios y beneficios";
  if (premiumText) {
    premiumText.textContent =
      "Trabajamos para hogares, oficinas y clientes que necesitan una experiencia clara y confiable.";
  }
  if (premiumNote) {
    premiumNote.textContent =
      "Proximamente: planes hogar, convenios empresariales y beneficios por frecuencia.";
  }
  qsa("#screenPremium .premium-list li").forEach((item, index) => {
    const texts = [
      "Recogida y entrega programada por zona",
      "Atencion para prendas delicadas y piezas finas",
      "Seguimiento operativo y factura clara por pedido",
    ];
    item.textContent = texts[index] || item.textContent;
  });
  const premiumBtn = qs("#screenPremium .btn");
  if (premiumBtn) premiumBtn.textContent = "Plan hogar";

  const premiumHero = qs("#screenPremium .premium-hero");
  if (premiumHero) {
    premiumHero.innerHTML = `
      <div class="card-eyebrow">Experiencia de marca</div>
      <div class="card-title">Servicios y beneficios</div>
      <div class="premium-text">
        ${BUSINESS_PROFILE.name} combina atencion de domicilio, gestion operativa y cuidado textil
        con una presentacion mucho mas profesional.
      </div>
      <div class="brand-pill-row">
        <span class="estimate-tag">Domicilio</span>
        <span class="estimate-tag">Local</span>
        <span class="estimate-tag">Prendas delicadas</span>
      </div>
      <div class="brand-promise-grid">
        <div class="brand-promise-card">
          <strong>Recepcion cuidadosa</strong>
          <span>Clasificacion por tipo de servicio, prenda y observaciones.</span>
        </div>
        <div class="brand-promise-card">
          <strong>Seguimiento claro</strong>
          <span>Pedido, repartidor, historial y factura visibles en un mismo flujo.</span>
        </div>
        <div class="brand-promise-card">
          <strong>Planes futuros</strong>
          <span>Base lista para beneficios hogar, cuentas corporativas y membresias.</span>
        </div>
      </div>
      <div class="premium-pricing plan-strip">
        <div class="premium-price">RD$ 499 <span>/ mes</span></div>
        <button class="btn btn-primary btn-small" type="button">Plan hogar</button>
      </div>
      <div class="premium-note">
        Proximamente: prioridad de recogida, historial extendido y beneficios por frecuencia.
      </div>
    `;
  }

  const premiumNavLabel = qs('[data-screen-target="screenPremium"] .nav-label');
  if (premiumNavLabel) premiumNavLabel.textContent = "Servicios";

  const helpItems = qsa(".help-list li");
  const helpTexts = [
    `Soporte: ${BUSINESS_PROFILE.email}`,
    `Horario: ${BUSINESS_PROFILE.schedule}`,
    `Sucursal principal: ${BUSINESS_PROFILE.address}`,
  ];
  helpItems.forEach((item, index) => {
    if (helpTexts[index]) item.textContent = helpTexts[index];
  });
}

async function onCreateOrder(e) {
  e.preventDefault();

  if (currentOrderWizardStep < ORDER_WIZARD_STEPS.length - 1) {
    goToOrderWizardStep(currentOrderWizardStep + 1);
    return;
  }

  if (!validateOrderWizardStep(0)) {
    goToOrderWizardStep(0, { force: true, skipScroll: true, skipFocus: true });
    return;
  }

  if (!validateOrderWizardStep(1)) {
    goToOrderWizardStep(1, { force: true, skipScroll: true, skipFocus: true });
    return;
  }

  const extras = Array.from(qs("#quickOrderForm").querySelectorAll(".chip input:checked")).map((i) => i.value);
  const packs = getSelectedPacks();
  const pricingMode = qs("#homePricingMode")?.value || "por_libra";
  const selectedGarments = collectSelectedGarments();
  const lbs = getHomeEstimatedLbs();

  if (!homeLocation) {
    showWarning("Activa el GPS para confirmar el punto real de recogida.");
    goToOrderWizardStep(1, { force: true, skipScroll: true, skipFocus: true });
    qs("#homeGeoLocateBtn")?.focus?.();
    return;
  }

  if (!packs.length) {
    showWarning("Selecciona al menos un paquete principal.");
    return;
  }

  if ((pricingMode === "por_prendas" || pricingMode === "mixto") && !selectedGarments.length) {
    showWarning("Selecciona al menos una prenda y cantidad para ese tipo de cobro.");
    return;
  }

  const body = {
    userId: currentUser.id,
    address: qs("#homeAddress").value.trim(),
    phone: qs("#homeContactPhone")?.value.trim() || "",
    location: homeLocation ? { ...homeLocation } : null,
    zone: qs("#homeZone").value,
    serviceType: qs("#homePickupType").value,
    date: qs("#homeDate").value,
    time: qs("#homeTime").value,
    pack: packs.join(", "),
    packs,
    pricingMode,
    selectedGarments,
    lbs,
    extras,
    notes: qs("#homeNotes").value.trim(),
  };

  try {
    await apiPost("/orders", body);
    showSuccess("Pedido creado correctamente.");
    qs("#quickOrderForm").reset();
    clearHomeLocation();
    setDefaultFormValues();
    syncPricingModeUI();
    updateOrderEstimatePreview();
    goToOrderWizardStep(0, { force: true, skipScroll: true, skipFocus: true });
    await loadAll();
  } catch (err) {
    showError(err.message || "Error creando pedido");
  }
}

function renderGestorHome() {
  const today = new Date().toISOString().slice(0, 10);
  const nonLocal = ordersCache.filter((o) => o.channel !== "local");
  const pendientes = sortByNewestId(nonLocal.filter((o) => o.status === "pendiente"));
  const enProceso = sortByNewestId(nonLocal.filter((o) => isOperationalActiveStatus(o.status)));
  const sinAsignar = nonLocal.filter((o) => !o.repartidorId && !isClosedOrderStatus(o.status));
  const enRuta = nonLocal.filter((o) => isRiderRouteStatus(o.status));
  const entregadosHoy = nonLocal.filter((o) => o.date === today && isFinalDeliveryStatus(o.status));
  const zoneList = Array.from(new Set([...Object.keys(ZONE_CENTERS), ...nonLocal.map((o) => String(o.zone || "").trim()).filter(Boolean), ...repartidoresCache.map((r) => String(r.zone || "").trim()).filter(Boolean)]));
  const getOrderUrgencyScore = (order) => {
    const flags = getOrderHighlightFlags(order);
    const status = String(order.status || "").toLowerCase();
    let score = 0;
    if (flags.delayed) score += 10;
    if (flags.noGps) score += 4;
    if (!order.repartidorId) score += 3;
    if (status === "pendiente") score += 2;
    if (normalizeStatusValue(status).includes("camino")) score += 1;
    return score;
  };

  qs("#gestorActiveCount").textContent = String(nonLocal.length);
  qs("#gestorTodayCount").textContent = String(nonLocal.filter((o) => o.date === today).length);
  qs("#gestorClientsCount").textContent = String(new Set(nonLocal.map((o) => o.userId).filter(Boolean)).size);

  let executiveCard = qs("#gestorExecutiveCard");
  if (!executiveCard) {
    executiveCard = document.createElement("div");
    executiveCard.id = "gestorExecutiveCard";
    executiveCard.className = "card card-spaced executive-card";
    const anchor = qs("#gestorControlTowerCard") || qs("#gestorHomePanel .role-summary-row");
    anchor?.insertAdjacentElement("afterend", executiveCard);
  }

  const priorityOrders = [...nonLocal]
    .filter((o) => !isClosedOrderStatus(o.status))
    .sort((a, b) => {
      const scoreDiff = getOrderUrgencyScore(b) - getOrderUrgencyScore(a);
      if (scoreDiff) return scoreDiff;
      return compareByServiceMoment(a, b);
    })
    .slice(0, 3);

  executiveCard.innerHTML = `
    <div class="executive-head">
      <div>
        <div class="card-title">Panel ejecutivo</div>
        <div class="card-secondary">Lo que necesita seguimiento inmediato en la operacion.</div>
      </div>
      <div class="estimate-badge">Hoy</div>
    </div>
    <div class="executive-grid">
      <div class="executive-metric">
        <span>Pendientes</span>
        <strong>${pendientes.length}</strong>
      </div>
      <div class="executive-metric">
        <span>Sin repartir</span>
        <strong>${sinAsignar.length}</strong>
      </div>
      <div class="executive-metric">
        <span>En ruta</span>
        <strong>${enRuta.length}</strong>
      </div>
      <div class="executive-metric">
        <span>Entregados hoy</span>
        <strong>${entregadosHoy.length}</strong>
      </div>
    </div>
    <div class="attention-board">
      <div class="detail-section-title">Atencion prioritaria</div>
      <div class="attention-list">
        ${
          priorityOrders.length
            ? priorityOrders
                .map(
                  (order) => `
                    <div class="attention-item">
                      <div>
                        <strong>Pedido #${order.id} | ${escapeHtml(order.userName)}</strong>
                        <span>${escapeHtml(order.zone)} | ${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time))}</span>
                        <div class="signal-chip-row">${renderSignalChips(order)}</div>
                      </div>
                      <div class="attention-side">
                        ${renderStatusBadge(order.status)}
                        <small>${escapeHtml(order.repartidorName || "Sin repartidor")}</small>
                      </div>
                    </div>
                  `
                )
                .join("")
            : `<div class="attention-empty">No hay alertas prioritarias en este momento.</div>`
        }
      </div>
    </div>
  `;

  let geoCard = qs("#gestorGeoCard");
  if (!geoCard) {
    geoCard = document.createElement("div");
    geoCard.id = "gestorGeoCard";
    geoCard.className = "card card-spaced gestor-geo-card";
    executiveCard.insertAdjacentElement("afterend", geoCard);
  }

  const zoneCards = zoneList.map((zone) => {
    const activeOrders = nonLocal.filter((o) => {
      const status = String(o.status || "").toLowerCase();
      return (String(o.zone || "").trim() || "Distrito Nacional") === zone && !isClosedOrderStatus(status);
    });
    const gpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).hasGps).length;
    const noGpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).noGps).length;
    const delayedCount = activeOrders.filter((o) => getOrderHighlightFlags(o).delayed).length;
    const routeCount = activeOrders.filter((o) => isRiderRouteStatus(o.status)).length;
    const zoneRiders = repartidoresCache.filter((r) => (String(r.zone || "").trim() || "Distrito Nacional") === zone);
    const hotOrders = [...activeOrders]
      .sort((a, b) => {
        const scoreDiff = getOrderUrgencyScore(b) - getOrderUrgencyScore(a);
        if (scoreDiff) return scoreDiff;
        return compareByServiceMoment(a, b);
      })
      .slice(0, 2);
    const mapLink = getGestorZoneMapLink(zone);

    return `
      <div class="zone-overview-card">
        <div class="zone-overview-head">
          <div>
            <strong>${escapeHtml(zone)}</strong>
            <span>${activeOrders.length} pedidos activos | ${zoneRiders.length} repartidores en cobertura</span>
          </div>
          ${mapLink ? `<a class="btn btn-small btn-outline" href="${mapLink}" target="_blank" rel="noreferrer">Abrir zona</a>` : ""}
        </div>
        <div class="zone-overview-metrics">
          <div class="zone-overview-metric">
            <span>Con GPS</span>
            <strong>${gpsCount}</strong>
          </div>
          <div class="zone-overview-metric">
            <span>Sin GPS</span>
            <strong>${noGpsCount}</strong>
          </div>
          <div class="zone-overview-metric">
            <span>Atrasados</span>
            <strong>${delayedCount}</strong>
          </div>
          <div class="zone-overview-metric">
            <span>En ruta</span>
            <strong>${routeCount}</strong>
          </div>
        </div>
        <div class="zone-order-list">
          ${
            hotOrders.length
              ? hotOrders
                  .map((order) => `
                    <div class="zone-order-item">
                      <div>
                        <strong>#${order.id} | ${escapeHtml(order.userName)}</strong>
                        <span>${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time))} | ${escapeHtml(order.repartidorName || "Sin repartidor")}</span>
                      </div>
                      <div class="signal-chip-row">${renderSignalChips(order)}</div>
                    </div>
                  `)
                  .join("")
              : `<div class="zone-order-empty">Sin alertas activas en esta zona.</div>`
          }
        </div>
      </div>
    `;
  }).join("");

  geoCard.innerHTML = `
    <div class="executive-head">
      <div>
        <div class="card-title">Cobertura GPS por zonas</div>
        <div class="card-secondary">Visibilidad rapida de pedidos listos para ruta, faltantes de GPS y atrasos.</div>
      </div>
      <div class="estimate-badge">Mapa operativo</div>
    </div>
    <div class="zone-overview-grid">${zoneCards}</div>
  `;

  const tbody = qs("#gestorAssignBody");
  if (!tbody) return;
  tbody.innerHTML = pendientes.length ? "" : tableEmptyRow(9, "No hay pedidos pendientes de asignar.");

  pendientes.forEach((o) => {
    const repsByZone = repartidoresCache.filter((r) => r.zone === o.zone);
    const reps = repsByZone.length ? repsByZone : repartidoresCache;
    const tr = document.createElement("tr");
    const flags = getOrderHighlightFlags(o);
    const location = getOrderLocation(o);
    const zoneMeta = [];
    if (location && Number.isFinite(flags.distanceFromZone)) zoneMeta.push(`${flags.distanceFromZone.toFixed(1)} km del centro`);
    zoneMeta.push(flags.zoneMismatch ? `GPS sugiere ${flags.inferredZone}` : getGeoStatusLabel(o));
    tr.className = getGestorRowClass(o);
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>
        <div class="table-main">${escapeHtml(o.userName)}</div>
        <div class="table-sub">${escapeHtml(o.phone || o.email || "Sin contacto directo")}</div>
        <div class="signal-chip-row">${renderSignalChips(o)}</div>
      </td>
      <td>
        <div class="table-main">${escapeHtml(o.zone)}</div>
        <div class="table-sub">${escapeHtml(zoneMeta.join(" | "))}</div>
      </td>
      <td>
        <div class="table-main">${fmtDate(o.date)} ${fmtTime(o.time)}</div>
        <div class="table-sub">${flags.delayed ? "Fuera de hora programada" : "Programacion activa"}</div>
      </td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>
        <select data-assign="${o.id}">
          <option value="">Elegir...</option>
          ${reps.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}${r.zone === o.zone ? "" : ` (${escapeHtml(r.zone)})`}</option>`).join("")}
        </select>
      </td>
      <td><button class="btn btn-small" data-factura="${o.id}">Factura</button></td>
      <td><button class="btn btn-small btn-outline" data-detalle="${o.id}">Detalle</button></td>
      <td><button class="btn btn-primary btn-small" data-save="${o.id}">Asignar</button></td>
    `;
    tbody.appendChild(tr);
  });

  let card = qs("#gestorInProgressCard");
  if (!card) {
    card = document.createElement("div");
    card.className = "role-panel";
    card.id = "gestorInProgressCard";
    card.innerHTML = `
      <div class="card card-spaced">
        <div class="card-title">Pedidos asignados y en proceso</div>
        <div class="card-secondary">Seguimiento de ruta, entrega y control operativo.</div>
        <div class="role-table-wrapper">
          <table class="role-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Zona</th>
                <th>Direccion</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Repartidor</th>
                <th>Factura</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody id="gestorInProgressBody"></tbody>
          </table>
        </div>
      </div>
    `;
    qs("#gestorHomePanel")?.appendChild(card);
  }

  const body2 = qs("#gestorInProgressBody");
  if (!body2) return;
  body2.innerHTML = enProceso.length ? "" : tableEmptyRow(9, "No hay pedidos en proceso.");

  enProceso.forEach((o) => {
    const tr = document.createElement("tr");
    const flags = getOrderHighlightFlags(o);
    const location = getOrderLocation(o);
    const zoneMeta = getGestorZoneValidationText(o, flags);
    tr.className = getGestorRowClass(o);
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>
        <div class="table-main">${escapeHtml(o.userName)}</div>
        <div class="table-sub">${escapeHtml(o.phone || o.email || "Sin contacto directo")}</div>
        <div class="signal-chip-row">${renderSignalChips(o)}</div>
      </td>
      <td>
        <div class="table-main">${escapeHtml(o.zone)}</div>
        <div class="table-sub">${escapeHtml(zoneMeta)}</div>
      </td>
      <td>
        <div class="table-main">${escapeHtml(o.address || "Por definir")}</div>
        <div class="table-sub">${escapeHtml(location ? formatCoordinatePair(location) : "Sin coordenadas registradas")}</div>
      </td>
      <td>
        <div class="table-main">${fmtDate(o.date)} ${fmtTime(o.time)}</div>
        <div class="table-sub">${flags.delayed ? "Requiere seguimiento inmediato" : "Ruta en seguimiento"}</div>
      </td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>
        <div class="table-main">${escapeHtml(o.repartidorName || "-")}</div>
        <div class="table-sub">${escapeHtml(location ? getGeoStatusLabel(o) : "Coordenadas pendientes")}</div>
      </td>
      <td><button class="btn btn-small" data-factura="${o.id}">Factura</button></td>
      <td><button class="btn btn-small btn-outline" data-detalle="${o.id}">Detalle</button></td>
    `;
    body2.appendChild(tr);
  });

  Array.from(tbody.querySelectorAll("[data-save]")).forEach((btn) => btn.addEventListener("click", gestorAssign));
  bindInvoiceAndDetailButtons(tbody);
  bindInvoiceAndDetailButtons(body2);
}

function getGestorOrderUrgencyScore(order) {
  const flags = getOrderHighlightFlags(order);
  const status = normalizeStatusValue(order?.status);
  let score = 0;
  if (flags.delayed) score += 10;
  if (flags.noGps) score += 4;
  if (!order?.repartidorId) score += 3;
  if (status === "pendiente") score += 2;
  if (status.includes("camino")) score += 1;
  return score;
}

function sortGestorDispatchQueue(orders) {
  return [...orders].sort((a, b) => {
    const scoreDiff = getGestorOrderUrgencyScore(b) - getGestorOrderUrgencyScore(a);
    if (scoreDiff) return scoreDiff;
    const momentDiff = compareByServiceMoment(a, b);
    if (momentDiff) return momentDiff;
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

function isActiveRouteOrder(order) {
  return isRiderRouteStatus(order?.status);
}

function getRiderWorkload(rider, orders = ordersCache) {
  const activeOrders = orders.filter((order) => (
    Number(order.repartidorId) === Number(rider?.id) &&
    order.channel !== "local" &&
    isActiveRouteOrder(order)
  ));
  const today = new Date().toISOString().slice(0, 10);

  return {
    activeOrders,
    activeCount: activeOrders.length,
    todayCount: activeOrders.filter((order) => order.date === today).length,
    delayedCount: activeOrders.filter((order) => getOrderHighlightFlags(order).delayed).length,
    gpsReady: activeOrders.filter((order) => getOrderLocation(order)).length,
  };
}

function getGestorRiderRecommendation(order, riders = repartidoresCache, orders = ordersCache) {
  const availableRiders = riders.filter((rider) => rider?.role === "repartidor" || rider?.zone);
  if (!availableRiders.length) return null;

  const orderZone = normalizeZoneName(order?.zone);
  const sameZoneRiders = availableRiders.filter((rider) => normalizeZoneName(rider.zone) === orderZone);
  const pool = sameZoneRiders.length ? sameZoneRiders : availableRiders;
  const flags = getOrderHighlightFlags(order);

  const candidates = pool
    .map((rider) => {
      const workload = getRiderWorkload(rider, orders);
      const sameZone = normalizeZoneName(rider.zone) === orderZone;
      const score =
        (sameZone ? 100 : 62) +
        (workload.activeCount === 0 ? 12 : 0) +
        (flags.delayed && sameZone ? 8 : 0) -
        workload.activeCount * 9 -
        workload.delayedCount * 4 -
        workload.todayCount * 1.5;

      return {
        rider,
        workload,
        sameZone,
        score,
        reason: sameZone
          ? `${workload.activeCount} activos en su cobertura`
          : `Apoyo desde ${normalizeZoneName(rider.zone)} con ${workload.activeCount} activos`,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.workload.activeCount !== b.workload.activeCount) return a.workload.activeCount - b.workload.activeCount;
      return String(a.rider.name || "").localeCompare(String(b.rider.name || ""), "es");
    });

  return candidates[0] || null;
}

function renderGestorRiderRecommendation(order, recommendation = getGestorRiderRecommendation(order)) {
  if (!recommendation?.rider) {
    return `
      <div class="dispatch-suggestion dispatch-suggestion-muted">
        <strong>Sin repartidor sugerido</strong>
        <span>Agrega repartidores para activar asignacion inteligente.</span>
      </div>
    `;
  }

  return `
    <div class="dispatch-suggestion">
      <div>
        <strong>${escapeHtml(recommendation.rider.name)}</strong>
        <span>${escapeHtml(recommendation.sameZone ? "Misma zona" : `Fuera de zona: ${normalizeZoneName(recommendation.rider.zone)}`)} | ${escapeHtml(recommendation.reason)}</span>
      </div>
      <span class="dispatch-workload-pill">${recommendation.workload.activeCount} activos</span>
    </div>
  `;
}

function getGestorStageBuckets(orders) {
  const activeOrders = orders.filter((order) => !isClosedOrderStatus(order.status));
  return {
    pickup: activeOrders.filter((order) => ["pendiente", "asignado", "en camino a recoger"].includes(normalizeStatusValue(order.status))),
    toLocal: activeOrders.filter((order) => ["recogido al cliente", "de camino al local"].includes(normalizeStatusValue(order.status))),
    internal: activeOrders.filter((order) => ["recibido en local", "en tratamiento"].includes(normalizeStatusValue(order.status))),
    delivery: activeOrders.filter((order) => ["listo para entrega", "en camino a entregar"].includes(normalizeStatusValue(order.status))),
  };
}

function getGestorControlTowerMetrics({
  scopedOrders,
  scopedRiders,
  pendientes,
  sinAsignar,
}) {
  const activeOrders = scopedOrders.filter((order) => !isClosedOrderStatus(order.status));
  const delayedOrders = activeOrders.filter((order) => getOrderHighlightFlags(order).delayed);
  const noGpsOrders = activeOrders.filter((order) => getOrderHighlightFlags(order).noGps);
  const zoneMismatchOrders = activeOrders.filter((order) => getOrderHighlightFlags(order).zoneMismatch);
  const readyForDelivery = activeOrders.filter((order) => ["listo para entrega", "en camino a entregar"].includes(normalizeStatusValue(order.status)));
  const riderLoads = scopedRiders.map((rider) => ({
    rider,
    workload: getRiderWorkload(rider, scopedOrders),
  }));
  const overloadedRiders = riderLoads.filter((entry) => entry.workload.activeCount >= 5);
  const idleRiders = riderLoads.filter((entry) => entry.workload.activeCount === 0);
  const healthScore = clampNumber(
    100 -
      delayedOrders.length * 18 -
      sinAsignar.length * 12 -
      noGpsOrders.length * 7 -
      overloadedRiders.length * 10 -
      zoneMismatchOrders.length * 8,
    0,
    100
  );
  const tone = healthScore >= 78 ? "good" : healthScore >= 52 ? "warn" : "danger";
  const label = healthScore >= 78 ? "Operacion estable" : healthScore >= 52 ? "Requiere atencion" : "Prioridad critica";

  return {
    activeOrders,
    delayedOrders,
    noGpsOrders,
    zoneMismatchOrders,
    readyForDelivery,
    riderLoads,
    overloadedRiders,
    idleRiders,
    healthScore,
    tone,
    label,
    stages: getGestorStageBuckets(scopedOrders),
    pendingDispatch: pendientes,
  };
}

function renderGestorOpsActionQueue(metrics) {
  const actions = [];
  const firstUnassigned = metrics.pendingDispatch?.find((order) => !order.repartidorId) || metrics.pendingDispatch?.[0];
  const delayedOrder = metrics.delayedOrders[0];
  const noGpsOrder = metrics.noGpsOrders[0];
  const readyOrder = metrics.readyForDelivery[0];
  const overloaded = metrics.overloadedRiders[0];

  if (firstUnassigned) {
    const recommendation = getGestorRiderRecommendation(firstUnassigned);
    actions.push({
      tone: "urgent",
      kicker: "Asignar ahora",
      title: `Pedido #${firstUnassigned.id} | ${firstUnassigned.userName || "Cliente"}`,
      copy: recommendation?.rider
        ? `Sugerido: ${recommendation.rider.name} (${recommendation.workload.activeCount} activos).`
        : "No hay repartidor sugerido. Revisa cobertura manualmente.",
      action: recommendation?.rider
        ? `<button class="btn btn-primary btn-small" type="button" data-suggested-assign="${firstUnassigned.id}" data-rider-id="${recommendation.rider.id}">Asignar sugerido</button>`
        : `<button class="btn btn-small btn-outline" type="button" data-detalle="${firstUnassigned.id}">Ver pedido</button>`,
    });
  }

  if (delayedOrder) {
    actions.push({
      tone: "danger",
      kicker: "Atraso",
      title: `Pedido #${delayedOrder.id} fuera de hora`,
      copy: `${delayedOrder.zone || "Zona"} | ${fmtDate(delayedOrder.date)} ${fmtTime(delayedOrder.time)} | ${delayedOrder.repartidorName || "Sin repartidor"}.`,
      action: `<button class="btn btn-small btn-outline" type="button" data-detalle="${delayedOrder.id}">Revisar detalle</button>`,
    });
  }

  if (noGpsOrder) {
    actions.push({
      tone: "warn",
      kicker: "GPS pendiente",
      title: `Confirmar ubicacion #${noGpsOrder.id}`,
      copy: "Este pedido depende de direccion escrita. Conviene validar antes de enviar ruta.",
      action: renderOrderOpsLinks(noGpsOrder, { compact: true }),
    });
  }

  if (readyOrder) {
    actions.push({
      tone: "info",
      kicker: "Salida final",
      title: `Preparar entrega #${readyOrder.id}`,
      copy: readyOrder.repartidorName ? `Asignado a ${readyOrder.repartidorName}.` : "Listo para asignar ruta final.",
      action: `<button class="btn btn-small btn-outline" type="button" data-detalle="${readyOrder.id}">Ver ruta</button>`,
    });
  }

  if (overloaded) {
    actions.push({
      tone: "warn",
      kicker: "Carga alta",
      title: `${overloaded.rider.name} lleva ${overloaded.workload.activeCount} activos`,
      copy: metrics.idleRiders[0]
        ? `Puedes balancear con ${metrics.idleRiders[0].rider.name}.`
        : "No hay repartidor libre en esta vista.",
      action: "",
    });
  }

  const visibleActions = actions.slice(0, 4);
  if (!visibleActions.length) {
    return `<div class="gestor-control-empty">La operacion luce despejada. Mantente atento al auto-sync para nuevos pedidos.</div>`;
  }

  return visibleActions.map((item) => `
    <article class="gestor-action-card gestor-action-${item.tone}">
      <div>
        <span>${escapeHtml(item.kicker)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.copy)}</small>
      </div>
      ${item.action ? `<div class="gestor-action-card-actions">${item.action}</div>` : ""}
    </article>
  `).join("");
}

function renderGestorControlTowerPanel({
  activeZoneFilter,
  zoneLabel,
  scopedOrders,
  scopedRiders,
  pendientes,
  sinAsignar,
  cardId = "gestorControlTowerCard",
  mountSelector = "#gestorHomePanel .role-summary-row",
  mountMode = "after",
  extraClass = "",
}) {
  let controlCard = document.getElementById(cardId);
  if (!controlCard) {
    controlCard = document.createElement("div");
    controlCard.id = cardId;
    controlCard.className = `card card-spaced gestor-control-card ${extraClass}`.trim();
    const mountEl = typeof mountSelector === "string" ? qs(mountSelector) : mountSelector;
    if (mountMode === "append") {
      mountEl?.appendChild(controlCard);
    } else {
      mountEl?.insertAdjacentElement("afterend", controlCard);
    }
  }

  const metrics = getGestorControlTowerMetrics({
    scopedOrders,
    scopedRiders,
    pendientes,
    sinAsignar,
  });
  const stageItems = [
    { key: "pickup", label: "Recoger", value: metrics.stages.pickup.length },
    { key: "toLocal", label: "Al local", value: metrics.stages.toLocal.length },
    { key: "internal", label: "Tratamiento", value: metrics.stages.internal.length },
    { key: "delivery", label: "Entregar", value: metrics.stages.delivery.length },
  ];

  controlCard.innerHTML = `
    <div class="gestor-control-hero">
      <div>
        <div class="gestor-control-kicker">Centro de mando</div>
        <h3>${escapeHtml(metrics.label)}</h3>
        <p>${activeZoneFilter === "all" ? "Lectura general de despacho, ruta y atencion al cliente." : `Operacion enfocada en ${escapeHtml(zoneLabel)}.`}</p>
      </div>
      <div class="gestor-health-ring gestor-health-${metrics.tone}" style="--health:${metrics.healthScore}%">
        <strong>${metrics.healthScore}</strong>
        <span>salud</span>
      </div>
    </div>

    <div class="gestor-control-grid">
      <div class="gestor-control-metric">
        <span>Sin asignar</span>
        <strong>${sinAsignar.length}</strong>
      </div>
      <div class="gestor-control-metric">
        <span>Atrasados</span>
        <strong>${metrics.delayedOrders.length}</strong>
      </div>
      <div class="gestor-control-metric">
        <span>Sin GPS</span>
        <strong>${metrics.noGpsOrders.length}</strong>
      </div>
      <div class="gestor-control-metric">
        <span>Repartidores libres</span>
        <strong>${metrics.idleRiders.length}</strong>
      </div>
    </div>

    <div class="gestor-flow-strip">
      ${stageItems.map((stage) => `
        <div class="gestor-flow-step gestor-flow-${stage.key}">
          <span>${escapeHtml(stage.label)}</span>
          <strong>${stage.value}</strong>
        </div>
      `).join("")}
    </div>

    <div class="gestor-action-queue">
      <div class="detail-section-title">Proximas acciones recomendadas</div>
      <div class="gestor-action-list">${renderGestorOpsActionQueue(metrics)}</div>
    </div>
  `;

  bindGestorSuggestedAssignButtons(controlCard);
  bindInvoiceAndDetailButtons(controlCard);
}

function getGestorDashboardContext() {
  const today = new Date().toISOString().slice(0, 10);
  const nonLocal = ordersCache.filter((o) => o.channel !== "local");
  const zoneList = Array.from(new Set([
    ...Object.keys(ZONE_CENTERS),
    ...nonLocal.map((o) => normalizeZoneName(o.zone)),
    ...repartidoresCache.map((r) => normalizeZoneName(r.zone)),
  ])).sort((a, b) => a.localeCompare(b, "es"));
  const activeZoneFilter = normalizeGestorZoneFilter(gestorZoneFilter, zoneList);
  if (activeZoneFilter !== gestorZoneFilter) saveGestorZoneFilter(activeZoneFilter);

  const scopedOrders = getOrdersByGestorZone(nonLocal, activeZoneFilter);
  const scopedRiders = getRidersByGestorZone(repartidoresCache, activeZoneFilter);
  const zoneLabel = activeZoneFilter === "all" ? "Todas las zonas" : activeZoneFilter;
  const pendientes = sortGestorDispatchQueue(scopedOrders.filter((o) => o.status === "pendiente"));
  const enProceso = sortGestorDispatchQueue(scopedOrders.filter((o) => isOperationalActiveStatus(o.status)));
  const sinAsignar = scopedOrders.filter((o) => !o.repartidorId && !isClosedOrderStatus(o.status));
  const enRuta = scopedOrders.filter((o) => isRiderRouteStatus(o.status));
  const entregadosHoy = scopedOrders.filter((o) => o.date === today && isFinalDeliveryStatus(o.status));
  const priorityOrders = [...scopedOrders]
    .filter((o) => !isClosedOrderStatus(o.status))
    .sort((a, b) => {
      const scoreDiff = getGestorOrderUrgencyScore(b) - getGestorOrderUrgencyScore(a);
      if (scoreDiff) return scoreDiff;
      return compareByServiceMoment(a, b);
    })
    .slice(0, 3);

  return {
    today,
    nonLocal,
    zoneList,
    activeZoneFilter,
    scopedOrders,
    scopedRiders,
    zoneLabel,
    pendientes,
    enProceso,
    sinAsignar,
    enRuta,
    entregadosHoy,
    priorityOrders,
  };
}

function removeGestorControlCards() {
  [
    "gestorControlTowerCard",
    "gestorExecutiveCard",
    "gestorDispatchCard",
    "gestorGeoCard",
    "gestorRiderCoverageCard",
  ].forEach((id) => document.getElementById(id)?.remove());
}

function renderGestorControlIntro(panel, context, metrics) {
  const zoneCopy = context.activeZoneFilter === "all"
    ? "Todas las zonas sincronizadas para decidir rapido."
    : `${context.zoneLabel} enfocado para operar sin ruido.`;

  panel.innerHTML = `
    <div class="card card-spaced gestor-command-card">
      <div class="executive-head">
        <div>
          <div class="gestor-control-kicker">Control del gestor</div>
          <div class="card-title">Cabina operativa Menta Laundry</div>
          <div class="card-secondary">Prioridades, rutas, GPS y repartidores en una sola vista ejecutiva.</div>
        </div>
        <div class="estimate-badge">${escapeHtml(context.zoneLabel)}</div>
      </div>
      <div class="gestor-command-grid">
        <div class="gestor-command-stat">
          <span>Pedidos activos</span>
          <strong>${metrics.activeOrders.length}</strong>
          <small>${escapeHtml(zoneCopy)}</small>
        </div>
        <div class="gestor-command-stat">
          <span>Salud operativa</span>
          <strong>${metrics.healthScore}%</strong>
          <small>${escapeHtml(metrics.label)}</small>
        </div>
        <div class="gestor-command-stat">
          <span>Listos para salida</span>
          <strong>${metrics.readyForDelivery.length}</strong>
          <small>Pedidos que pueden avanzar a entrega.</small>
        </div>
        <div class="gestor-command-stat">
          <span>Equipo libre</span>
          <strong>${metrics.idleRiders.length}</strong>
          <small>Repartidores disponibles en esta vista.</small>
        </div>
      </div>
    </div>
    <div id="gestorControlMount" class="gestor-control-mount"></div>
  `;
}

function renderGestorControl() {
  const panel = qs("#gestorControlPanel");
  if (!panel) return;

  removeGestorControlCards();
  const context = getGestorDashboardContext();
  const metrics = getGestorControlTowerMetrics(context);
  renderGestorControlIntro(panel, context, metrics);
  const mount = qs("#gestorControlMount");

  renderGestorControlTowerPanel({
    ...context,
    mountSelector: mount,
    mountMode: "append",
    extraClass: "gestor-control-card-standalone",
  });
  renderGestorExecutivePanel(context);
  renderGestorDispatchCommandPanel(context);
  renderGestorZoneOverviewPanel(context);
  renderGestorRiderCoveragePanel(context);
}

function renderGestorHome() {
  const context = getGestorDashboardContext();
  const {
    today,
    scopedOrders,
    pendientes,
    enProceso,
    activeZoneFilter,
    zoneLabel,
  } = context;

  qs("#gestorActiveCount").textContent = String(scopedOrders.length);
  qs("#gestorTodayCount").textContent = String(scopedOrders.filter((o) => o.date === today).length);
  qs("#gestorClientsCount").textContent = String(new Set(scopedOrders.map((o) => o.userId).filter(Boolean)).size);

  renderGestorAssignTable({
    pendientes,
    activeZoneFilter,
    zoneLabel,
  });
  renderGestorInProgressPanel({
    enProceso,
    activeZoneFilter,
    zoneLabel,
  });
}

function renderGestorExecutivePanel({
  activeZoneFilter,
  zoneLabel,
  pendientes,
  sinAsignar,
  enRuta,
  entregadosHoy,
  priorityOrders,
}) {
  let executiveCard = qs("#gestorExecutiveCard");
  if (!executiveCard) {
    executiveCard = document.createElement("div");
    executiveCard.id = "gestorExecutiveCard";
    executiveCard.className = "card card-spaced executive-card";
    const anchor = qs("#gestorControlTowerCard") || qs("#gestorHomePanel .role-summary-row");
    anchor?.insertAdjacentElement("afterend", executiveCard);
  }

  executiveCard.innerHTML = `
    <div class="executive-head">
      <div>
        <div class="card-title">Panel ejecutivo</div>
        <div class="card-secondary">${activeZoneFilter === "all" ? "Lo que necesita seguimiento inmediato en la operacion." : `Vista enfocada en ${escapeHtml(zoneLabel)} para asignar y despachar con mas precision.`}</div>
      </div>
      <div class="estimate-badge">${escapeHtml(zoneLabel)}</div>
    </div>
    <div class="executive-grid">
      <div class="executive-metric">
        <span>Pendientes</span>
        <strong>${pendientes.length}</strong>
      </div>
      <div class="executive-metric">
        <span>Sin repartir</span>
        <strong>${sinAsignar.length}</strong>
      </div>
      <div class="executive-metric">
        <span>En ruta</span>
        <strong>${enRuta.length}</strong>
      </div>
      <div class="executive-metric">
        <span>Entregados hoy</span>
        <strong>${entregadosHoy.length}</strong>
      </div>
    </div>
    <div class="attention-board">
      <div class="detail-section-title">Atencion prioritaria</div>
      <div class="attention-list">
        ${
          priorityOrders.length
            ? priorityOrders
                .map(
                  (order) => `
                    <div class="attention-item">
                      <div>
                        <strong>Pedido #${order.id} | ${escapeHtml(order.userName)}</strong>
                        <span>${escapeHtml(order.zone)} | ${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time))}</span>
                        <div class="signal-chip-row">${renderSignalChips(order)}</div>
                      </div>
                      <div class="attention-side">
                        ${renderStatusBadge(order.status)}
                        <small>${escapeHtml(order.repartidorName || "Sin repartidor")}</small>
                      </div>
                    </div>
                  `
                )
                .join("")
            : `<div class="attention-empty">No hay alertas prioritarias en este momento.</div>`
        }
      </div>
    </div>
  `;
}

function renderGestorDispatchCommandPanel({
  pendientes,
  scopedRiders,
  activeZoneFilter,
  zoneLabel,
}) {
  let dispatchCard = qs("#gestorDispatchCard");
  if (!dispatchCard) {
    dispatchCard = document.createElement("div");
    dispatchCard.id = "gestorDispatchCard";
    dispatchCard.className = "card card-spaced dispatch-command-card";
    qs("#gestorExecutiveCard")?.insertAdjacentElement("afterend", dispatchCard);
  }

  const dispatchQueue = pendientes.slice(0, 4);
  const ridersReady = scopedRiders.length || repartidoresCache.length;
  const noGpsCount = pendientes.filter((order) => getOrderHighlightFlags(order).noGps).length;
  const delayedCount = pendientes.filter((order) => getOrderHighlightFlags(order).delayed).length;

  dispatchCard.innerHTML = `
    <div class="executive-head">
      <div>
        <div class="card-title">Despacho inteligente</div>
        <div class="card-secondary">${activeZoneFilter === "all" ? "Pedidos pendientes ordenados por urgencia, zona y senales operativas." : `Asignaciones sugeridas para ${escapeHtml(zoneLabel)} segun cobertura y carga activa.`}</div>
      </div>
      <div class="dispatch-command-badges">
        <span class="estimate-badge">${pendientes.length} por asignar</span>
        <span class="estimate-badge">${ridersReady} repartidores</span>
      </div>
    </div>
    <div class="dispatch-health-grid">
      <div class="dispatch-health-card">
        <span>Sin GPS</span>
        <strong>${noGpsCount}</strong>
      </div>
      <div class="dispatch-health-card">
        <span>Atrasados</span>
        <strong>${delayedCount}</strong>
      </div>
      <div class="dispatch-health-card">
        <span>Listos para asignar</span>
        <strong>${dispatchQueue.length}</strong>
      </div>
    </div>
    <div class="dispatch-command-grid">
      ${
        dispatchQueue.length
          ? dispatchQueue
              .map((order) => {
                const recommendation = getGestorRiderRecommendation(order);
                const flags = getOrderHighlightFlags(order);
                const zoneMeta = getGestorZoneValidationText(order, flags);
                return `
                  <article class="dispatch-command-item ${getGestorRowClass(order)}">
                    <div class="dispatch-command-head">
                      <div>
                        <div class="gestor-mobile-id">Pedido #${order.id}</div>
                        <h4>${escapeHtml(order.userName || "Cliente")}</h4>
                      </div>
                      ${renderStatusBadge(order.status)}
                    </div>
                    <div class="dispatch-command-meta">
                      <span>${escapeHtml(order.zone || "--")}</span>
                      <span>${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time))}</span>
                      <span>${escapeHtml(zoneMeta)}</span>
                    </div>
                    <div class="signal-chip-row">${renderSignalChips(order)}</div>
                    ${renderGestorRiderRecommendation(order, recommendation)}
                    <div class="dispatch-command-actions">
                      ${renderOrderOpsLinks(order, { compact: true })}
                      ${
                        recommendation?.rider
                          ? `<button class="btn btn-primary btn-small" type="button" data-suggested-assign="${order.id}" data-rider-id="${recommendation.rider.id}">Asignar a ${escapeHtml(recommendation.rider.name)}</button>`
                          : `<button class="btn btn-small btn-outline" type="button" disabled>Sin sugerencia</button>`
                      }
                      <button class="btn btn-small btn-outline" type="button" data-detalle="${order.id}">Detalle</button>
                    </div>
                  </article>
                `;
              })
              .join("")
          : `<div class="dispatch-empty">No hay pedidos pendientes en esta vista. La operacion esta despejada.</div>`
      }
    </div>
  `;

  bindGestorSuggestedAssignButtons(dispatchCard);
  bindInvoiceAndDetailButtons(dispatchCard);
}

function renderGestorZoneOverviewPanel({
  nonLocal,
  scopedOrders,
  scopedRiders,
  zoneList,
  activeZoneFilter,
  zoneLabel,
}) {
  let geoCard = qs("#gestorGeoCard");
  if (!geoCard) {
    geoCard = document.createElement("div");
    geoCard.id = "gestorGeoCard";
    geoCard.className = "card card-spaced gestor-geo-card";
    (qs("#gestorDispatchCard") || qs("#gestorExecutiveCard"))?.insertAdjacentElement("afterend", geoCard);
  }

  const zoneCards = zoneList
    .map((zone) => {
      const activeOrders = nonLocal.filter((o) => {
        const status = String(o.status || "").toLowerCase();
        return normalizeZoneName(o.zone) === zone && !isClosedOrderStatus(status);
      });
      const gpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).hasGps).length;
      const noGpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).noGps).length;
      const delayedCount = activeOrders.filter((o) => getOrderHighlightFlags(o).delayed).length;
      const routeCount = activeOrders.filter((o) => isRiderRouteStatus(o.status)).length;
      const zoneRiders = repartidoresCache.filter((r) => normalizeZoneName(r.zone) === zone);
      const hotOrders = [...activeOrders]
        .sort((a, b) => {
          const scoreDiff = getGestorOrderUrgencyScore(b) - getGestorOrderUrgencyScore(a);
          if (scoreDiff) return scoreDiff;
          return compareByServiceMoment(a, b);
        })
        .slice(0, 2);
      const mapLink = getGestorZoneMapLink(zone);
      const isActive = activeZoneFilter === zone;

      return {
        zone,
        activeCount: activeOrders.length,
        markup: `
          <div class="zone-overview-card ${isActive ? "zone-overview-card-active" : ""}" data-zone-filter="${escapeHtml(zone)}" tabindex="0" role="button" aria-pressed="${isActive ? "true" : "false"}">
            <div class="zone-overview-head">
              <div>
                <strong>${escapeHtml(zone)}</strong>
                <span>${activeOrders.length} pedidos activos | ${zoneRiders.length} repartidores en cobertura</span>
              </div>
              ${isActive ? `<span class="zone-filter-cta zone-filter-cta-active">Zona activa</span>` : `<span class="zone-filter-cta">Filtrar zona</span>`}
            </div>
            <div class="zone-overview-metrics">
              <div class="zone-overview-metric">
                <span>Con GPS</span>
                <strong>${gpsCount}</strong>
              </div>
              <div class="zone-overview-metric">
                <span>Sin GPS</span>
                <strong>${noGpsCount}</strong>
              </div>
              <div class="zone-overview-metric">
                <span>Atrasados</span>
                <strong>${delayedCount}</strong>
              </div>
              <div class="zone-overview-metric">
                <span>En ruta</span>
                <strong>${routeCount}</strong>
              </div>
            </div>
            <div class="zone-order-list">
              ${
                hotOrders.length
                  ? hotOrders
                      .map((order) => `
                        <div class="zone-order-item">
                          <div>
                            <strong>#${order.id} | ${escapeHtml(order.userName)}</strong>
                            <span>${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time))} | ${escapeHtml(order.repartidorName || "Sin repartidor")}</span>
                          </div>
                          <div class="signal-chip-row">${renderSignalChips(order)}</div>
                        </div>
                      `)
                      .join("")
                  : `<div class="zone-order-empty">Sin alertas activas en esta zona.</div>`
              }
            </div>
            <div class="zone-overview-card-footer">
              <small>${mapLink ? "Toca la tarjeta para enfocar esta zona." : "Toca la tarjeta para filtrar su operacion."}</small>
              ${mapLink ? `<a class="zone-card-link" href="${mapLink}" target="_blank" rel="noreferrer">Abrir mapa</a>` : ""}
            </div>
          </div>
        `,
      };
    })
    .sort((a, b) => {
      if (a.zone === activeZoneFilter) return -1;
      if (b.zone === activeZoneFilter) return 1;
      if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
      return a.zone.localeCompare(b.zone, "es");
    })
    .map((entry) => entry.markup)
    .join("");

  geoCard.innerHTML = `
    <div class="executive-head">
      <div>
        <div class="card-title">Cobertura GPS por zonas</div>
        <div class="card-secondary">Toca una zona para enfocar pedidos, asignaciones y cobertura humana sin salir del panel.</div>
      </div>
      <div class="estimate-badge">Mapa operativo</div>
    </div>
    <div class="zone-filter-toolbar">
      <button class="btn btn-small ${activeZoneFilter === "all" ? "btn-primary" : "btn-outline"}" type="button" data-zone-clear="1">Todas las zonas</button>
      <div class="zone-filter-summary">
        <strong>${escapeHtml(zoneLabel)}</strong>
        <span>${scopedOrders.length} pedidos visibles | ${scopedRiders.length} repartidores en cobertura</span>
      </div>
    </div>
    <div class="zone-overview-grid">${zoneCards}</div>
  `;

  bindGestorZoneFilters(geoCard);
}

function renderGestorRiderCoveragePanel({
  scopedOrders,
  scopedRiders,
  activeZoneFilter,
  zoneLabel,
}) {
  let riderCoverageCard = qs("#gestorRiderCoverageCard");
  if (!riderCoverageCard) {
    riderCoverageCard = document.createElement("div");
    riderCoverageCard.id = "gestorRiderCoverageCard";
    riderCoverageCard.className = "card card-spaced gestor-geo-card";
    qs("#gestorGeoCard")?.insertAdjacentElement("afterend", riderCoverageCard);
  }

  const riderCoverageMarkup = scopedRiders
    .map((rider) => {
      const riderOrders = scopedOrders.filter((order) => Number(order.repartidorId) === Number(rider.id) && !isClosedOrderStatus(order.status));
      const gpsReady = riderOrders.filter((order) => getOrderHighlightFlags(order).hasGps).length;
      const delayedCount = riderOrders.filter((order) => getOrderHighlightFlags(order).delayed).length;
      const noGpsCount = riderOrders.filter((order) => getOrderHighlightFlags(order).noGps).length;
      const nextOrder = [...riderOrders]
        .sort((a, b) => {
          const scoreDiff = getGestorOrderUrgencyScore(b) - getGestorOrderUrgencyScore(a);
          if (scoreDiff) return scoreDiff;
          return compareByServiceMoment(a, b);
        })[0];
      const riderState = riderOrders.length
        ? riderOrders.some((order) => normalizeStatusValue(order.status).includes("camino"))
          ? "En calle"
          : "Con ruta"
        : "Disponible";

      return `
        <div class="coverage-rider-card">
          <div class="coverage-rider-head">
            <div>
              <strong>${escapeHtml(rider.name)}</strong>
              <div class="coverage-rider-meta">${escapeHtml(rider.email || "Sin correo")} | ${escapeHtml(normalizeZoneName(rider.zone))}</div>
            </div>
            <span class="coverage-rider-state ${riderOrders.length ? "coverage-rider-state-busy" : ""}">${riderState}</span>
          </div>
          <div class="coverage-rider-stats">
            <div class="coverage-rider-stat">
              <span>Activos</span>
              <strong>${riderOrders.length}</strong>
            </div>
            <div class="coverage-rider-stat">
              <span>GPS listos</span>
              <strong>${gpsReady}</strong>
            </div>
            <div class="coverage-rider-stat">
              <span>Sin GPS</span>
              <strong>${noGpsCount}</strong>
            </div>
            <div class="coverage-rider-stat">
              <span>Atrasados</span>
              <strong>${delayedCount}</strong>
            </div>
          </div>
          <div class="coverage-rider-next">
            ${
              nextOrder
                ? `
                  <strong>Proximo pedido sensible: #${nextOrder.id} | ${escapeHtml(nextOrder.userName)}</strong>
                  <span>${escapeHtml(fmtDate(nextOrder.date))} ${escapeHtml(fmtTime(nextOrder.time))} | ${escapeHtml(nextOrder.address || nextOrder.zone)}</span>
                `
                : `
                  <strong>Sin ruta activa</strong>
                  <span>Este repartidor puede recibir nuevas asignaciones en esta cobertura.</span>
                `
            }
          </div>
        </div>
      `;
    })
    .join("");

  riderCoverageCard.innerHTML = `
    <div class="executive-head">
      <div>
        <div class="card-title">${activeZoneFilter === "all" ? "Cobertura de repartidores" : `Repartidores en ${escapeHtml(zoneLabel)}`}</div>
        <div class="card-secondary">${activeZoneFilter === "all" ? "Carga operativa por repartidor en todas las zonas activas." : "Quien esta cubriendo esta zona y con que carga sale hoy."}</div>
      </div>
      <div class="estimate-badge">${scopedRiders.length} en cobertura</div>
    </div>
    ${
      riderCoverageMarkup
        ? `<div class="coverage-rider-grid">${riderCoverageMarkup}</div>`
        : `<div class="coverage-rider-empty">No hay repartidores configurados para ${escapeHtml(zoneLabel)}.</div>`
    }
  `;
}

function renderGestorEmptyMobileBoard(message) {
  return `<div class="gestor-mobile-empty">${escapeHtml(message)}</div>`;
}

function renderGestorAssignMobileCards(pendientes) {
  return pendientes
    .map((order) => {
      const repsByZone = repartidoresCache.filter((r) => normalizeZoneName(r.zone) === normalizeZoneName(order.zone));
      const reps = repsByZone.length ? repsByZone : repartidoresCache;
      const flags = getOrderHighlightFlags(order);
      const zoneMeta = getGestorZoneValidationText(order, flags);
      const recommendation = getGestorRiderRecommendation(order);
      const recommendedRiderId = recommendation?.rider?.id;

      return `
        <article class="gestor-mobile-card ${getGestorRowClass(order)}" data-assign-scope="${order.id}">
          <div class="gestor-mobile-head">
            <div>
              <div class="gestor-mobile-id">Pedido #${order.id}</div>
              <h4>${escapeHtml(order.userName)}</h4>
            </div>
            ${renderStatusBadge(order.status)}
          </div>
          <div class="gestor-mobile-copy">${escapeHtml(order.phone || order.email || "Sin contacto directo")}</div>
          <div class="signal-chip-row">${renderSignalChips(order)}</div>
          <div class="gestor-mobile-grid">
            <div>
              <span class="gestor-mobile-label">Zona</span>
              <div class="gestor-mobile-value">${escapeHtml(order.zone)}</div>
              <div class="gestor-mobile-sub">${escapeHtml(zoneMeta)}</div>
            </div>
            <div>
              <span class="gestor-mobile-label">Fecha</span>
              <div class="gestor-mobile-value">${fmtDate(order.date)} ${fmtTime(order.time)}</div>
              <div class="gestor-mobile-sub">${flags.delayed ? "Fuera de hora programada" : "Programacion activa"}</div>
            </div>
          </div>
          ${renderGestorRiderRecommendation(order, recommendation)}
          <div class="field-group gestor-mobile-field">
            <label>Asignar repartidor</label>
            <select data-assign="${order.id}">
              <option value="">Elegir...</option>
              ${reps.map((r) => `<option value="${r.id}" ${String(r.id) === String(recommendedRiderId) ? "selected" : ""}>${escapeHtml(r.name)}${normalizeZoneName(r.zone) === normalizeZoneName(order.zone) ? "" : ` (${escapeHtml(normalizeZoneName(r.zone))})`}</option>`).join("")}
            </select>
          </div>
          <div class="gestor-mobile-actions">
            ${renderOrderOpsLinks(order, { compact: true })}
            <button class="btn btn-small" data-factura="${order.id}">Factura</button>
            <button class="btn btn-small btn-outline" data-detalle="${order.id}">Detalle</button>
            <button class="btn btn-primary btn-small" data-save="${order.id}">Asignar</button>
            ${
              recommendedRiderId
                ? `<button class="btn btn-small btn-outline" type="button" data-suggested-assign="${order.id}" data-rider-id="${recommendedRiderId}">Asignar sugerido</button>`
                : ""
            }
          </div>
        </article>
      `;
    })
    .join("");
}

function renderGestorInProgressMobileCards(enProceso) {
  return enProceso
    .map((order) => {
      const flags = getOrderHighlightFlags(order);
      const location = getOrderLocation(order);
      const zoneMeta = [];
      if (location && Number.isFinite(flags.distanceFromZone)) zoneMeta.push(`${flags.distanceFromZone.toFixed(1)} km del centro`);
      zoneMeta.push(flags.zoneMismatch ? `GPS sugiere ${flags.inferredZone}` : getGeoStatusLabel(order));

      return `
        <article class="gestor-mobile-card ${getGestorRowClass(order)}">
          <div class="gestor-mobile-head">
            <div>
              <div class="gestor-mobile-id">Pedido #${order.id}</div>
              <h4>${escapeHtml(order.userName)}</h4>
            </div>
            ${renderStatusBadge(order.status)}
          </div>
          <div class="gestor-mobile-copy">${escapeHtml(order.phone || order.email || "Sin contacto directo")}</div>
          <div class="signal-chip-row">${renderSignalChips(order)}</div>
          <div class="gestor-mobile-grid">
            <div>
              <span class="gestor-mobile-label">Zona</span>
              <div class="gestor-mobile-value">${escapeHtml(order.zone)}</div>
              <div class="gestor-mobile-sub">${escapeHtml(zoneMeta.join(" | "))}</div>
            </div>
            <div>
              <span class="gestor-mobile-label">Repartidor</span>
              <div class="gestor-mobile-value">${escapeHtml(order.repartidorName || "-")}</div>
              <div class="gestor-mobile-sub">${escapeHtml(location ? getGeoStatusLabel(order) : "Coordenadas pendientes")}</div>
            </div>
            <div>
              <span class="gestor-mobile-label">Direccion</span>
              <div class="gestor-mobile-value">${escapeHtml(order.address || "Por definir")}</div>
              <div class="gestor-mobile-sub">${escapeHtml(location ? formatCoordinatePair(location) : "Sin coordenadas registradas")}</div>
            </div>
            <div>
              <span class="gestor-mobile-label">Fecha</span>
              <div class="gestor-mobile-value">${fmtDate(order.date)} ${fmtTime(order.time)}</div>
              <div class="gestor-mobile-sub">${flags.delayed ? "Requiere seguimiento inmediato" : "Ruta en seguimiento"}</div>
            </div>
          </div>
          <div class="gestor-mobile-actions">
            ${renderOrderOpsLinks(order, { compact: true })}
            <button class="btn btn-small" data-factura="${order.id}">Factura</button>
            <button class="btn btn-small btn-outline" data-detalle="${order.id}">Detalle</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderGestorLocalMobileCards(localOrders) {
  return localOrders
    .map((order) => `
      <article class="gestor-mobile-card">
        <div class="gestor-mobile-head">
          <div>
            <div class="gestor-mobile-id">Pedido #${order.id}</div>
            <h4>${escapeHtml(order.userName)}</h4>
          </div>
          ${renderStatusBadge(order.status)}
        </div>
        <div class="gestor-mobile-grid">
          <div>
            <span class="gestor-mobile-label">Telefono</span>
            <div class="gestor-mobile-value">${escapeHtml(order.phone || "--")}</div>
          </div>
          <div>
            <span class="gestor-mobile-label">Libras</span>
            <div class="gestor-mobile-value">${Number(order.lbs || 0).toFixed(1)} lb</div>
          </div>
          <div class="gestor-mobile-grid-span">
            <span class="gestor-mobile-label">Paquete</span>
            <div class="gestor-mobile-value">${escapeHtml(getOrderPacks(order).join(", ") || order.pack || "Servicio general")}</div>
          </div>
        </div>
        <div class="gestor-mobile-actions">
          <button class="btn btn-small" data-factura="${order.id}">Factura</button>
          <button class="btn btn-small btn-outline" data-detalle="${order.id}">Detalle</button>
        </div>
      </article>
    `)
    .join("");
}

function renderGestorAssignTable({
  pendientes,
  activeZoneFilter,
  zoneLabel,
}) {
  const tbody = qs("#gestorAssignBody");
  let mobileBoard = qs("#gestorAssignMobileBoard");
  const tableWrapper = tbody?.closest(".role-table-wrapper");
  const assignCard = tableWrapper?.closest(".card");
  tableWrapper?.classList.add("gestor-desktop-table");
  if (!mobileBoard && assignCard) {
    mobileBoard = document.createElement("div");
    mobileBoard.id = "gestorAssignMobileBoard";
    mobileBoard.className = "gestor-mobile-board";
    assignCard.appendChild(mobileBoard);
  }
  if (!tbody) return;

  tbody.innerHTML = pendientes.length
    ? ""
    : tableEmptyRow(9, activeZoneFilter === "all" ? "No hay pedidos pendientes de asignar." : `No hay pedidos pendientes de asignar en ${zoneLabel}.`);

  if (mobileBoard) {
    mobileBoard.innerHTML = pendientes.length
      ? renderGestorAssignMobileCards(pendientes)
      : renderGestorEmptyMobileBoard(activeZoneFilter === "all" ? "No hay pedidos pendientes de asignar." : `No hay pedidos pendientes de asignar en ${zoneLabel}.`);
  }

  pendientes.forEach((o) => {
    const repsByZone = repartidoresCache.filter((r) => normalizeZoneName(r.zone) === normalizeZoneName(o.zone));
    const reps = repsByZone.length ? repsByZone : repartidoresCache;
    const tr = document.createElement("tr");
    const flags = getOrderHighlightFlags(o);
    const zoneMeta = getGestorZoneValidationText(o, flags);
    const recommendation = getGestorRiderRecommendation(o);
    const recommendedRiderId = recommendation?.rider?.id;
    tr.className = getGestorRowClass(o);
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>
        <div class="table-main">${escapeHtml(o.userName)}</div>
        <div class="table-sub">${escapeHtml(o.phone || o.email || "Sin contacto directo")}</div>
        <div class="signal-chip-row">${renderSignalChips(o)}</div>
        ${renderOrderOpsLinks(o, { compact: true })}
      </td>
      <td>
        <div class="table-main">${escapeHtml(o.zone)}</div>
        <div class="table-sub">${escapeHtml(zoneMeta)}</div>
      </td>
      <td>
        <div class="table-main">${fmtDate(o.date)} ${fmtTime(o.time)}</div>
        <div class="table-sub">${flags.delayed ? "Fuera de hora programada" : "Programacion activa"}</div>
      </td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>
        <select data-assign="${o.id}">
          <option value="">Elegir...</option>
          ${reps.map((r) => `<option value="${r.id}" ${String(r.id) === String(recommendedRiderId) ? "selected" : ""}>${escapeHtml(r.name)}${normalizeZoneName(r.zone) === normalizeZoneName(o.zone) ? "" : ` (${escapeHtml(normalizeZoneName(r.zone))})`}</option>`).join("")}
        </select>
        ${renderGestorRiderRecommendation(o, recommendation)}
      </td>
      <td><button class="btn btn-small" data-factura="${o.id}">Factura</button></td>
      <td><button class="btn btn-small btn-outline" data-detalle="${o.id}">Detalle</button></td>
      <td>
        <button class="btn btn-primary btn-small" data-save="${o.id}">Asignar</button>
        ${
          recommendedRiderId
            ? `<button class="btn btn-small btn-outline dispatch-table-suggest" type="button" data-suggested-assign="${o.id}" data-rider-id="${recommendedRiderId}">Sugerido</button>`
            : ""
        }
      </td>
    `;
    tr.setAttribute("data-assign-scope", o.id);
    tbody.appendChild(tr);
  });

  Array.from(tbody.querySelectorAll("[data-save]")).forEach((btn) => btn.addEventListener("click", gestorAssign));
  Array.from(mobileBoard?.querySelectorAll("[data-save]") || []).forEach((btn) => btn.addEventListener("click", gestorAssign));
  bindGestorSuggestedAssignButtons(tbody);
  bindGestorSuggestedAssignButtons(mobileBoard);
  bindInvoiceAndDetailButtons(tbody);
  bindInvoiceAndDetailButtons(mobileBoard);
}

function renderGestorInProgressPanel({
  enProceso,
  activeZoneFilter,
  zoneLabel,
}) {
  let card = qs("#gestorInProgressCard");
  if (!card) {
    card = document.createElement("div");
    card.className = "role-panel";
    card.id = "gestorInProgressCard";
    qs("#gestorHomePanel")?.appendChild(card);
  }

  card.innerHTML = `
    <div class="card card-spaced">
      <div class="card-title">Pedidos asignados y en proceso</div>
      <div class="card-secondary">${activeZoneFilter === "all" ? "Seguimiento de ruta, entrega y control operativo." : `Seguimiento concentrado en ${escapeHtml(zoneLabel)} para no perder visibilidad en despacho.`}</div>
      <div class="role-table-wrapper gestor-desktop-table">
        <table class="role-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Cliente</th>
              <th>Zona</th>
              <th>Direccion</th>
              <th>Fecha</th>
              <th>Estado</th>
              <th>Repartidor</th>
              <th>Factura</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody id="gestorInProgressBody"></tbody>
        </table>
      </div>
      <div id="gestorInProgressMobileBoard" class="gestor-mobile-board"></div>
    </div>
  `;

  const body2 = qs("#gestorInProgressBody");
  const mobileBoard = qs("#gestorInProgressMobileBoard");
  if (!body2) return;

  body2.innerHTML = enProceso.length
    ? ""
    : tableEmptyRow(9, activeZoneFilter === "all" ? "No hay pedidos en proceso." : `No hay pedidos en proceso en ${zoneLabel}.`);

  if (mobileBoard) {
    mobileBoard.innerHTML = enProceso.length
      ? renderGestorInProgressMobileCards(enProceso)
      : renderGestorEmptyMobileBoard(activeZoneFilter === "all" ? "No hay pedidos en proceso." : `No hay pedidos en proceso en ${zoneLabel}.`);
  }

  enProceso.forEach((o) => {
    const tr = document.createElement("tr");
    const flags = getOrderHighlightFlags(o);
    const location = getOrderLocation(o);
    const zoneMeta = [];
    if (location && Number.isFinite(flags.distanceFromZone)) zoneMeta.push(`${flags.distanceFromZone.toFixed(1)} km del centro`);
    zoneMeta.push(flags.zoneMismatch ? `GPS sugiere ${flags.inferredZone}` : getGeoStatusLabel(o));
    tr.className = getGestorRowClass(o);
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>
        <div class="table-main">${escapeHtml(o.userName)}</div>
        <div class="table-sub">${escapeHtml(o.phone || o.email || "Sin contacto directo")}</div>
        <div class="signal-chip-row">${renderSignalChips(o)}</div>
      </td>
      <td>
        <div class="table-main">${escapeHtml(o.zone)}</div>
        <div class="table-sub">${escapeHtml(zoneMeta.join(" | "))}</div>
      </td>
      <td>
        <div class="table-main">${escapeHtml(o.address || "Por definir")}</div>
        <div class="table-sub">${escapeHtml(location ? formatCoordinatePair(location) : "Sin coordenadas registradas")}</div>
        ${renderOrderOpsLinks(o, { compact: true })}
      </td>
      <td>
        <div class="table-main">${fmtDate(o.date)} ${fmtTime(o.time)}</div>
        <div class="table-sub">${flags.delayed ? "Requiere seguimiento inmediato" : "Ruta en seguimiento"}</div>
      </td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>
        <div class="table-main">${escapeHtml(o.repartidorName || "-")}</div>
        <div class="table-sub">${escapeHtml(location ? getGeoStatusLabel(o) : "Coordenadas pendientes")}</div>
      </td>
      <td><button class="btn btn-small" data-factura="${o.id}">Factura</button></td>
      <td><button class="btn btn-small btn-outline" data-detalle="${o.id}">Detalle</button></td>
    `;
    body2.appendChild(tr);
  });

  bindInvoiceAndDetailButtons(body2);
  bindInvoiceAndDetailButtons(mobileBoard);
}

function bindGestorSuggestedAssignButtons(scope) {
  if (!scope) return;

  Array.from(scope.querySelectorAll("[data-suggested-assign]")).forEach((btn) => {
    btn.addEventListener("click", gestorAssignSuggested);
  });
}

async function gestorAssignSuggested(ev) {
  const trigger = ev.currentTarget || ev.target;
  const orderId = trigger?.dataset?.suggestedAssign;
  const repartidorId = trigger?.dataset?.riderId;
  if (!orderId || !repartidorId) {
    showWarning("No hay sugerencia disponible para este pedido.");
    return;
  }

  try {
    setButtonBusy(trigger, true, "Asignando...");
    const data = await apiPut(`/orders/${orderId}/assign`, { repartidorId: Number(repartidorId) });
    showSuccess(`Pedido #${orderId} asignado a ${data.order?.repartidorName || "repartidor"}.`);
    await loadAll();
  } catch (err) {
    showError(err.message || "No pudimos asignar el pedido sugerido.");
  } finally {
    setButtonBusy(trigger, false);
  }
}

async function gestorAssign(ev) {
  const trigger = ev.currentTarget || ev.target;
  const orderId = trigger?.dataset?.save;
  const scope = trigger?.closest("[data-assign-scope]");
  const select = scope?.querySelector(`select[data-assign="${orderId}"]`) || qs(`select[data-assign="${orderId}"]`);
  const repartidorId = select?.value;
  if (!repartidorId) {
    showWarning("Elige un repartidor.");
    return;
  }

  try {
    setButtonBusy(trigger, true, "Asignando...");
    const data = await apiPut(`/orders/${orderId}/assign`, { repartidorId: Number(repartidorId) });
    showSuccess(`Pedido asignado a ${data.order?.repartidorName || "repartidor"}.`);
    await loadAll();
  } catch (err) {
    showError(err.message || "Error asignando");
  } finally {
    setButtonBusy(trigger, false);
  }
}

const LOCAL_STAGE_CONFIG = [
  {
    key: "incoming",
    label: "Por recibir",
    title: "Camino al local",
    empty: "No hay rutas llegando al local.",
    actionLabel: "Recibir pedido",
    targetStatus: "recibido en local",
  },
  {
    key: "received",
    label: "Recibidos",
    title: "Recepcion y pesaje",
    empty: "No hay pedidos esperando tratamiento.",
    actionLabel: "Enviar a tratamiento",
    targetStatus: "en tratamiento",
  },
  {
    key: "treatment",
    label: "Tratamiento",
    title: "Lavado, planchado y cuidado",
    empty: "No hay prendas en tratamiento.",
    actionLabel: "Marcar listo",
    targetStatus: "listo para entrega",
  },
  {
    key: "ready",
    label: "Listos",
    title: "Preparar salida final",
    empty: "No hay pedidos listos para entrega.",
    actionLabel: "",
    targetStatus: "",
  },
];

function getLocalOperationStatus(order) {
  const raw = String(order?.status || "").trim().toLowerCase();
  if (raw === "recibido") return "recibido en local";
  const normalized = normalizeStatusValue(raw);
  if (order?.channel === "local" && normalized === "recogido al cliente") return "recibido en local";
  return normalized;
}

function isLocalOperationOrder(order) {
  const status = getLocalOperationStatus(order);
  return ["de camino al local", "recibido en local", "en tratamiento", "listo para entrega"].includes(status);
}

function getLocalOperationOrders() {
  const byId = new Map();
  [...ordersCache, ...localOrdersCache].forEach((order) => {
    if (!order || !isLocalOperationOrder(order)) return;
    byId.set(String(order.id), order);
  });
  return sortByNewestId(Array.from(byId.values()));
}

function getLocalStageKey(order) {
  const status = getLocalOperationStatus(order);
  if (status === "de camino al local") return "incoming";
  if (status === "recibido en local") return "received";
  if (status === "en tratamiento") return "treatment";
  if (status === "listo para entrega") return "ready";
  return "received";
}

function getLocalStageBuckets(orders) {
  return LOCAL_STAGE_CONFIG.reduce((buckets, stage) => {
    buckets[stage.key] = [];
    return buckets;
  }, {});
}

function buildLocalStageBuckets(orders) {
  const buckets = getLocalStageBuckets(orders);
  orders.forEach((order) => {
    const key = getLocalStageKey(order);
    if (buckets[key]) buckets[key].push(order);
  });
  return buckets;
}

function renderLocalOpsMetrics(buckets) {
  return LOCAL_STAGE_CONFIG.map((stage) => `
    <div class="local-ops-metric local-ops-metric-${stage.key}">
      <span>${escapeHtml(stage.label)}</span>
      <strong>${buckets[stage.key]?.length || 0}</strong>
    </div>
  `).join("");
}

function renderLocalOrderOpsCard(order, stage) {
  const status = getLocalOperationStatus(order);
  const source = order.channel === "local" ? "Cliente en tienda" : "Ruta a domicilio";
  const charge = getRiderChargeSummary(order);
  const latest = getOrderLatestMovementText(order);
  const actionButton = stage.targetStatus
    ? `<button class="btn btn-primary btn-small" type="button" data-local-status="${order.id}" data-target-status="${stage.targetStatus}">${escapeHtml(stage.actionLabel)}</button>`
    : `<span class="local-ready-note">Listo para asignar salida final.</span>`;

  return `
    <article class="local-order-card local-order-card-${stage.key}">
      <div class="local-order-head">
        <div>
          <span class="local-order-id">Pedido #${order.id} | ${escapeHtml(source)}</span>
          <h4>${escapeHtml(order.userName || "Cliente")}</h4>
          <small>${escapeHtml(getOrderPacks(order).join(", ") || order.pack || "Servicio general")} | ${escapeHtml(charge.totalText)}</small>
        </div>
        ${renderStatusBadge(status)}
      </div>

      <div class="local-order-fields">
        <label>
          <span>Libras reales</span>
          <input type="number" min="0" step="0.1" data-local-lbs="${order.id}" value="${Number(order.lbs || 0).toFixed(1)}">
        </label>
        <label>
          <span>Observaciones</span>
          <textarea rows="2" data-local-notes="${order.id}" placeholder="Manchas, piezas delicadas, urgencia...">${escapeHtml(order.notes || "")}</textarea>
        </label>
      </div>

      <div class="local-order-meta">
        <span>${escapeHtml(order.phone || "Sin telefono")}</span>
        <span>${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time) || "--")}</span>
        <span>${escapeHtml(latest)}</span>
      </div>

      <div class="local-order-actions">
        ${actionButton}
        <button class="btn btn-small btn-outline" type="button" data-local-save="${order.id}">Guardar datos</button>
        <button class="btn btn-small" type="button" data-factura="${order.id}">Factura</button>
        <button class="btn btn-small btn-outline" type="button" data-detalle="${order.id}">Detalle</button>
      </div>
    </article>
  `;
}

function renderLocalOperationsPanel(container, options = {}) {
  if (!container) return;

  const orders = options.orders || getLocalOperationOrders();
  const buckets = buildLocalStageBuckets(orders);
  const visibleStages = options.compact ? LOCAL_STAGE_CONFIG.slice(1) : LOCAL_STAGE_CONFIG;

  container.innerHTML = `
    <div class="local-ops-top">
      <div>
        <div class="card-eyebrow">Operacion del local</div>
        <div class="card-title">${escapeHtml(options.title || "Centro de produccion")}</div>
        <div class="card-secondary">${escapeHtml(options.subtitle || "Recibe, pesa, procesa y prepara salidas desde una vista unica.")}</div>
      </div>
      <span class="estimate-badge">${orders.length} visibles</span>
    </div>
    <div class="local-ops-metrics">${renderLocalOpsMetrics(buckets)}</div>
    <div class="local-ops-columns">
      ${visibleStages.map((stage) => `
        <section class="local-stage-card local-stage-${stage.key}">
          <div class="local-stage-head">
            <div>
              <span>${escapeHtml(stage.label)}</span>
              <strong>${escapeHtml(stage.title)}</strong>
            </div>
            <em>${buckets[stage.key]?.length || 0}</em>
          </div>
          <div class="local-stage-list">
            ${
              buckets[stage.key]?.length
                ? buckets[stage.key].map((order) => renderLocalOrderOpsCard(order, stage)).join("")
                : `<div class="local-stage-empty">${escapeHtml(stage.empty)}</div>`
            }
          </div>
        </section>
      `).join("")}
    </div>
  `;

  bindLocalOperationEvents(container);
  bindInvoiceAndDetailButtons(container);
}

function bindLocalOperationEvents(scope) {
  if (!scope) return;

  Array.from(scope.querySelectorAll("[data-local-status]")).forEach((btn) => {
    btn.addEventListener("click", updateLocalOperationOrder);
  });
  Array.from(scope.querySelectorAll("[data-local-save]")).forEach((btn) => {
    btn.addEventListener("click", updateLocalOperationOrder);
  });
}

async function updateLocalOperationOrder(ev) {
  const trigger = ev.currentTarget || ev.target;
  const orderId = trigger?.dataset?.localStatus || trigger?.dataset?.localSave;
  const order = getOrderById(orderId);
  if (!order) {
    showWarning("No encontramos ese pedido.");
    return;
  }

  const lbsInput = qs(`[data-local-lbs="${orderId}"]`);
  const notesInput = qs(`[data-local-notes="${orderId}"]`);
  const targetStatus = trigger?.dataset?.targetStatus || getLocalOperationStatus(order);
  const lbs = Number(lbsInput?.value || order.lbs || 0);
  const notes = notesInput?.value ?? order.notes ?? "";

  try {
    setButtonBusy(trigger, true, "Guardando...");
    await apiPut(`/local-orders/${orderId}/status`, { status: targetStatus, lbs, notes });
    showSuccess(`Pedido #${orderId} actualizado en local.`);
    await loadAll({ screenId: getActiveScreenId() });
  } catch (err) {
    showError(err.message || "No pudimos actualizar el pedido del local.");
  } finally {
    setButtonBusy(trigger, false);
  }
}

function renderGestorLocal() {
  const tbody = qs("#localOrdersBody");
  const mobileBoard = qs("#localOrdersMobileBoard");
  const tableWrapper = tbody?.closest(".role-table-wrapper");
  const localCard = tableWrapper?.closest(".card");
  tableWrapper?.classList.add("gestor-desktop-table");
  if (!mobileBoard && localCard) {
    const board = document.createElement("div");
    board.id = "localOrdersMobileBoard";
    board.className = "gestor-mobile-board";
    localCard.appendChild(board);
  }
  if (!tbody) return;

  const screen = qs("#screenLocal");
  let opsCard = qs("#localOperationsCard");
  if (!opsCard && screen) {
    opsCard = document.createElement("div");
    opsCard.id = "localOperationsCard";
    opsCard.className = "card card-spaced local-ops-card";
    localCard ? screen.insertBefore(opsCard, localCard) : screen.appendChild(opsCard);
  }

  const operationOrders = getLocalOperationOrders();
  renderLocalOperationsPanel(opsCard, {
    title: "Centro de produccion",
    subtitle: "Pedidos que llegan al local, estan en tratamiento o ya pueden salir a entrega.",
    orders: operationOrders,
  });

  const localOrders = sortByNewestId(localOrdersCache);
  tbody.innerHTML = localOrders.length ? "" : tableEmptyRow(8, "No hay pedidos registrados en el local.");

  const currentMobileBoard = qs("#localOrdersMobileBoard");
  if (currentMobileBoard) {
    currentMobileBoard.innerHTML = localOrders.length
      ? renderGestorLocalMobileCards(localOrders)
      : renderGestorEmptyMobileBoard("No hay pedidos registrados en el local.");
  }

  localOrders.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${escapeHtml(o.userName)}</td>
      <td>${escapeHtml(o.phone || "--")}</td>
      <td>${Number(o.lbs || 0).toFixed(1)}</td>
      <td>${escapeHtml(getOrderPacks(o).join(", ") || o.pack || "Servicio general")}</td>
      <td>${renderStatusBadge(o.status)}</td>
      <td><button class="btn btn-small" data-factura="${o.id}">Factura</button></td>
      <td><button class="btn btn-small btn-outline" data-detalle="${o.id}">Detalle</button></td>
    `;
    tbody.appendChild(tr);
  });

  bindInvoiceAndDetailButtons(tbody);
  bindInvoiceAndDetailButtons(currentMobileBoard);
}

function getOperationalHistorySource(order, fallbackSource = "") {
  if (fallbackSource) return fallbackSource;
  return order?.channel === "local" ? "local" : "domicilio";
}

function getOperationalHistorySourceLabel(source) {
  return source === "local" ? "Local" : "Domicilio";
}

function getOperationalHistoryRows() {
  const rowsByKey = new Map();
  const addRow = (order, fallbackSource = "") => {
    if (!order) return;
    const source = getOperationalHistorySource(order, fallbackSource);
    const key = `${source}:${order.id}`;
    const breakdown = buildOrderChargeBreakdown(order);
    const flags = source === "domicilio" ? getOrderHighlightFlags(order) : {
      hasGps: false,
      noGps: false,
      delayed: isOrderDelayed(order),
    };
    const sortTime = new Date(`${order.date || "1970-01-01"}T${order.time || "00:00"}`).getTime() || 0;

    rowsByKey.set(key, {
      key,
      order,
      source,
      sourceLabel: getOperationalHistorySourceLabel(source),
      flags,
      total: Number(breakdown.total || 0),
      weightPending: breakdown.weightPending,
      sortTime,
      latest: getOrderLatestMovementText(order),
    });
  };

  ordersCache.forEach((order) => addRow(order));
  localOrdersCache.forEach((order) => addRow(order, "local"));

  return Array.from(rowsByKey.values()).sort((a, b) => {
    if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime;
    return Number(b.order?.id || 0) - Number(a.order?.id || 0);
  });
}

function getOperationalHistoryDateCutoff(filterKey) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (filterKey === "today") return today.getTime();
  if (filterKey === "week") return today.getTime() - 6 * 24 * 60 * 60 * 1000;
  if (filterKey === "month") return today.getTime() - 29 * 24 * 60 * 60 * 1000;
  return null;
}

function matchesOperationalHistoryDate(order, filterKey) {
  if (!filterKey || filterKey === "all") return true;
  const cutoff = getOperationalHistoryDateCutoff(filterKey);
  if (!Number.isFinite(cutoff)) return true;
  const orderDate = new Date(`${order?.date || "1970-01-01"}T00:00`).getTime();
  return Number.isFinite(orderDate) && orderDate >= cutoff;
}

function matchesOperationalHistoryStatus(row, filterKey) {
  const status = normalizeStatusValue(row.order?.status);
  if (!filterKey || filterKey === "all") return true;
  if (filterKey === "active") return !isClosedOrderStatus(status);
  if (filterKey === "pending") return status === "pendiente";
  if (filterKey === "delayed") return Boolean(row.flags.delayed);
  if (filterKey === "no_gps") return row.source === "domicilio" && row.flags.noGps;
  if (filterKey === "treatment") return ["recibido en local", "en tratamiento"].includes(status);
  if (filterKey === "ready") return status === "listo para entrega";
  if (filterKey === "delivered") return isFinalDeliveryStatus(status);
  if (filterKey === "cancelled") return isCancelledStatus(status);
  return true;
}

function getOperationalHistorySearchText(row) {
  const order = row.order || {};
  return [
    order.id,
    row.sourceLabel,
    order.userName,
    order.phone,
    order.email,
    order.address,
    order.zone,
    order.repartidorName,
    order.status,
    getOrderPacks(order).join(" "),
    row.latest,
  ].join(" ").toLowerCase();
}

function getFilteredOperationalHistoryRows() {
  const query = String(operationalHistoryFilters.query || "").trim().toLowerCase();
  const riderFilter = String(operationalHistoryFilters.rider || "all");

  return getOperationalHistoryRows().filter((row) => {
    const order = row.order || {};
    if (query && !getOperationalHistorySearchText(row).includes(query)) return false;
    if (operationalHistoryFilters.source !== "all" && row.source !== operationalHistoryFilters.source) return false;
    if (operationalHistoryFilters.zone !== "all" && normalizeZoneName(order.zone) !== operationalHistoryFilters.zone) return false;
    if (riderFilter !== "all" && String(order.repartidorId || "") !== riderFilter) return false;
    if (!matchesOperationalHistoryStatus(row, operationalHistoryFilters.status)) return false;
    if (!matchesOperationalHistoryDate(order, operationalHistoryFilters.date)) return false;
    return true;
  });
}

function renderHistoryOption(value, label, currentValue) {
  return `<option value="${escapeHtml(value)}" ${String(currentValue) === String(value) ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderOperationalHistoryMetric(label, value, note = "") {
  return `
    <div class="history-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </div>
  `;
}

function renderOperationalHistoryRow(row) {
  const order = row.order || {};
  const charge = row.weightPending && row.total <= 0 ? "Por confirmar" : row.weightPending ? `Desde ${money(row.total)}` : money(row.total);
  const sourceClass = row.source === "local" ? "history-source-local" : "history-source-domicilio";
  return `
    <tr class="${row.flags.delayed ? "gestor-row-delayed" : ""}">
      <td>${escapeHtml(String(order.id || "--"))}</td>
      <td>
        <div class="table-main">${escapeHtml(order.userName || "Cliente")}</div>
        <div class="table-sub">${escapeHtml(getOrderContactPhone(order) || order.email || "Sin contacto")}</div>
      </td>
      <td><span class="history-source-badge ${sourceClass}">${escapeHtml(row.sourceLabel)}</span></td>
      <td>
        <div class="table-main">${escapeHtml(normalizeZoneName(order.zone))}</div>
        <div class="table-sub">${escapeHtml(order.address || (row.source === "local" ? "Entrega en tienda" : "Direccion pendiente"))}</div>
      </td>
      <td>
        <div class="table-main">${escapeHtml(fmtDate(order.date))}</div>
        <div class="table-sub">${escapeHtml(fmtTime(order.time) || "--")}</div>
      </td>
      <td>${renderStatusBadge(order.status)}</td>
      <td>
        <div class="table-main">${escapeHtml(order.repartidorName || "Sin asignar")}</div>
        <div class="table-sub">${escapeHtml(row.latest)}</div>
      </td>
      <td>${escapeHtml(charge)}</td>
      <td>
        <div class="history-actions">
          <button class="btn btn-small" type="button" data-factura="${order.id}" data-order-source="${row.source}">Factura</button>
          <button class="btn btn-small btn-outline" type="button" data-detalle="${order.id}" data-order-source="${row.source}">Detalle</button>
        </div>
      </td>
    </tr>
  `;
}

function renderOperationalHistoryMobileCard(row) {
  const order = row.order || {};
  const charge = row.weightPending && row.total <= 0 ? "Por confirmar" : row.weightPending ? `Desde ${money(row.total)}` : money(row.total);
  const sourceClass = row.source === "local" ? "history-source-local" : "history-source-domicilio";
  return `
    <article class="history-mobile-card ${row.flags.delayed ? "history-mobile-card-alert" : ""}">
      <div class="history-mobile-head">
        <div>
          <span>Pedido #${escapeHtml(String(order.id || "--"))}</span>
          <h4>${escapeHtml(order.userName || "Cliente")}</h4>
        </div>
        ${renderStatusBadge(order.status)}
      </div>
      <div class="history-mobile-meta">
        <span class="history-source-badge ${sourceClass}">${escapeHtml(row.sourceLabel)}</span>
        <span>${escapeHtml(normalizeZoneName(order.zone))}</span>
        <span>${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time) || "--")}</span>
      </div>
      <div class="history-mobile-grid">
        <div><span>Contacto</span><strong>${escapeHtml(getOrderContactPhone(order) || order.email || "--")}</strong></div>
        <div><span>Repartidor</span><strong>${escapeHtml(order.repartidorName || "Sin asignar")}</strong></div>
        <div><span>Total</span><strong>${escapeHtml(charge)}</strong></div>
        <div><span>Movimiento</span><strong>${escapeHtml(row.latest)}</strong></div>
      </div>
      <div class="history-actions">
        <button class="btn btn-small" type="button" data-factura="${order.id}" data-order-source="${row.source}">Factura</button>
        <button class="btn btn-small btn-outline" type="button" data-detalle="${order.id}" data-order-source="${row.source}">Detalle</button>
      </div>
    </article>
  `;
}

function renderOperationalHistoryResults() {
  const rows = getFilteredOperationalHistoryRows();
  const today = new Date().toISOString().slice(0, 10);
  const activeCount = rows.filter((row) => !isClosedOrderStatus(row.order?.status)).length;
  const deliveredCount = rows.filter((row) => isFinalDeliveryStatus(row.order?.status)).length;
  const todayCount = rows.filter((row) => row.order?.date === today).length;
  const revenue = rows.reduce((sum, row) => sum + row.total, 0);

  const metrics = qs("#historyMetrics");
  if (metrics) {
    metrics.innerHTML = [
      renderOperationalHistoryMetric("Resultados", String(rows.length), "Pedidos segun filtros"),
      renderOperationalHistoryMetric("Hoy", String(todayCount), "Agenda del dia"),
      renderOperationalHistoryMetric("Activos", String(activeCount), "Aun en operacion"),
      renderOperationalHistoryMetric("Cerrados", String(deliveredCount), "Entregados al cliente"),
      renderOperationalHistoryMetric("Monto estimado", money(revenue), "Segun pedidos visibles"),
    ].join("");
  }

  const summary = qs("#historyResultsSummary");
  if (summary) {
    summary.textContent = `${rows.length} pedidos visibles | ${activeCount} activos | ${deliveredCount} cerrados`;
  }

  const tbody = qs("#historyTableBody");
  if (tbody) {
    tbody.innerHTML = rows.length
      ? rows.map(renderOperationalHistoryRow).join("")
      : tableEmptyRow(9, "No hay pedidos que coincidan con estos filtros.");
  }

  const mobileBoard = qs("#historyMobileBoard");
  if (mobileBoard) {
    mobileBoard.innerHTML = rows.length
      ? rows.map(renderOperationalHistoryMobileCard).join("")
      : `<div class="gestor-mobile-empty">No hay pedidos que coincidan con estos filtros.</div>`;
  }

  bindInvoiceAndDetailButtons(tbody);
  bindInvoiceAndDetailButtons(mobileBoard);
}

function syncOperationalHistoryFiltersFromDom(panel) {
  Array.from(panel.querySelectorAll("[data-history-filter]")).forEach((field) => {
    operationalHistoryFilters[field.dataset.historyFilter] = field.value;
  });
}

function setOperationalHistoryFilterInputs(panel) {
  Array.from(panel.querySelectorAll("[data-history-filter]")).forEach((field) => {
    const key = field.dataset.historyFilter;
    field.value = key === "query" ? operationalHistoryFilters.query : operationalHistoryFilters[key] || "all";
  });
}

function bindOperationalHistoryFilters(panel) {
  Array.from(panel.querySelectorAll("[data-history-filter]")).forEach((field) => {
    const eventName = field.tagName === "INPUT" ? "input" : "change";
    field.addEventListener(eventName, () => {
      syncOperationalHistoryFiltersFromDom(panel);
      renderOperationalHistoryResults();
    });
  });

  qs("#historyResetFilters")?.addEventListener("click", () => {
    Object.assign(operationalHistoryFilters, {
      query: "",
      status: "all",
      source: "all",
      zone: "all",
      rider: "all",
      date: "all",
    });
    setOperationalHistoryFilterInputs(panel);
    renderOperationalHistoryResults();
  });
}

function renderOperationalHistory() {
  const panel = qs("#operationalHistoryPanel");
  if (!panel) return;

  const rows = getOperationalHistoryRows();
  const zones = Array.from(new Set(rows.map((row) => normalizeZoneName(row.order?.zone)))).sort((a, b) => a.localeCompare(b, "es"));
  const riders = repartidoresCache
    .filter((rider) => rider?.id)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "es"));

  if (!zones.includes(operationalHistoryFilters.zone) && operationalHistoryFilters.zone !== "all") {
    operationalHistoryFilters.zone = "all";
  }
  if (!riders.some((rider) => String(rider.id) === String(operationalHistoryFilters.rider)) && operationalHistoryFilters.rider !== "all") {
    operationalHistoryFilters.rider = "all";
  }

  panel.innerHTML = `
    <div class="card operational-history-hero">
      <div class="executive-head">
        <div>
          <div class="card-eyebrow">Historial operativo</div>
          <div class="card-title">Buscar, filtrar y revisar pedidos</div>
          <div class="card-secondary">Una vista para gestor y caja con domicilio, local, facturas, detalles y movimientos recientes.</div>
        </div>
        <span class="estimate-badge">${rows.length} registrados</span>
      </div>
      <div id="historyMetrics" class="history-metrics"></div>
    </div>

    <div class="card card-spaced history-filter-card">
      <div class="history-filter-grid">
        <label class="history-filter history-filter-search">
          <span>Buscar</span>
          <input type="search" data-history-filter="query" placeholder="Cliente, telefono, pedido, zona..." value="${escapeHtml(operationalHistoryFilters.query)}">
        </label>
        <label class="history-filter">
          <span>Canal</span>
          <select data-history-filter="source">
            ${renderHistoryOption("all", "Todos", operationalHistoryFilters.source)}
            ${renderHistoryOption("domicilio", "Domicilio", operationalHistoryFilters.source)}
            ${renderHistoryOption("local", "Local", operationalHistoryFilters.source)}
          </select>
        </label>
        <label class="history-filter">
          <span>Estado</span>
          <select data-history-filter="status">
            ${renderHistoryOption("all", "Todos", operationalHistoryFilters.status)}
            ${renderHistoryOption("active", "Activos", operationalHistoryFilters.status)}
            ${renderHistoryOption("pending", "Pendientes", operationalHistoryFilters.status)}
            ${renderHistoryOption("delayed", "Atrasados", operationalHistoryFilters.status)}
            ${renderHistoryOption("no_gps", "Sin GPS", operationalHistoryFilters.status)}
            ${renderHistoryOption("treatment", "En local / tratamiento", operationalHistoryFilters.status)}
            ${renderHistoryOption("ready", "Listos", operationalHistoryFilters.status)}
            ${renderHistoryOption("delivered", "Entregados", operationalHistoryFilters.status)}
            ${renderHistoryOption("cancelled", "Cancelados", operationalHistoryFilters.status)}
          </select>
        </label>
        <label class="history-filter">
          <span>Zona</span>
          <select data-history-filter="zone">
            ${renderHistoryOption("all", "Todas", operationalHistoryFilters.zone)}
            ${zones.map((zone) => renderHistoryOption(zone, zone, operationalHistoryFilters.zone)).join("")}
          </select>
        </label>
        <label class="history-filter">
          <span>Repartidor</span>
          <select data-history-filter="rider">
            ${renderHistoryOption("all", "Todos", operationalHistoryFilters.rider)}
            ${riders.map((rider) => renderHistoryOption(String(rider.id), rider.name || `Repartidor ${rider.id}`, operationalHistoryFilters.rider)).join("")}
          </select>
        </label>
        <label class="history-filter">
          <span>Fecha</span>
          <select data-history-filter="date">
            ${renderHistoryOption("all", "Todo el historial", operationalHistoryFilters.date)}
            ${renderHistoryOption("today", "Hoy", operationalHistoryFilters.date)}
            ${renderHistoryOption("week", "Ultimos 7 dias", operationalHistoryFilters.date)}
            ${renderHistoryOption("month", "Ultimos 30 dias", operationalHistoryFilters.date)}
          </select>
        </label>
      </div>
      <div class="history-filter-actions">
        <span id="historyResultsSummary">Preparando resultados...</span>
        <button id="historyResetFilters" class="btn btn-small btn-outline" type="button">Limpiar filtros</button>
      </div>
    </div>

    <div class="card card-spaced history-results-card">
      <div class="executive-head">
        <div>
          <div class="card-title">Pedidos encontrados</div>
          <div class="card-secondary">Tabla para escritorio y tarjetas limpias para telefono.</div>
        </div>
      </div>
      <div class="role-table-wrapper gestor-desktop-table history-table-wrapper">
        <table class="role-table history-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Cliente</th>
              <th>Canal</th>
              <th>Zona / direccion</th>
              <th>Fecha</th>
              <th>Estado</th>
              <th>Repartidor / movimiento</th>
              <th>Total</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody id="historyTableBody"></tbody>
        </table>
      </div>
      <div id="historyMobileBoard" class="history-mobile-board"></div>
    </div>
  `;

  bindOperationalHistoryFilters(panel);
  renderOperationalHistoryResults();
}

function renderRepartidorHome() {
  const assigned = ordersCache.filter((o) => Number(o.repartidorId) === Number(currentUser.id));
  const routePlan = buildRiderRoutePlan(assigned);
  const activeCards = [...routePlan.active, ...routePlan.waiting];
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = assigned.filter((o) => o.date === today).length;
  const delivered = assigned.filter((o) => isFinalDeliveryStatus(o.status));
  const inRoute = assigned.filter((o) => isRiderRouteStatus(o.status));
  const withNotes = assigned.filter((o) => String(o.notes || "").trim()).length;
  const withGps = assigned.filter((o) => getOrderLocation(o)).length;
  const pendingWeight = assigned.filter((o) => getRiderChargeSummary(o).weightPending).length;
  const routeEstimate = assigned.reduce((sum, order) => sum + Number(buildOrderChargeBreakdown(order).total || 0), 0);
  const meta = 30;
  const extra = Math.max(todayCount - meta, 0);
  const comision = extra * 50;
  const nextStop = routePlan.active[0] || null;

  const cards = qsa("#repartidorHomePanel .card");
  const headerCard = cards[0];
  const boardCard = cards[1];
  if (!headerCard || !boardCard) return;

  headerCard.innerHTML = `
    <div class="rider-summary-top">
      <div>
        <div class="card-title">Ruta del dia</div>
        <div class="card-secondary" id="repartidorMetaText">Meta ${todayCount}/${meta}. Comision proyectada: ${money(comision)}</div>
      </div>
      <div class="estimate-badge">${escapeHtml(currentUser.zone || "Ruta activa")}</div>
    </div>
    <div class="rider-metrics-grid">
      <div class="rider-metric-card">
        <span>Asignados</span>
        <strong>${assigned.length}</strong>
      </div>
      <div class="rider-metric-card">
        <span>En curso</span>
        <strong>${inRoute.length}</strong>
      </div>
      <div class="rider-metric-card">
        <span>Entregados</span>
        <strong>${delivered.length}</strong>
      </div>
      <div class="rider-metric-card">
        <span>GPS listos</span>
        <strong>${withGps}</strong>
      </div>
      <div class="rider-metric-card">
        <span>Por pesar</span>
        <strong>${pendingWeight}</strong>
      </div>
      <div class="rider-metric-card">
        <span>Estimado ruta</span>
        <strong>${money(routeEstimate)}</strong>
      </div>
    </div>
    <div class="rider-route-panel">
      <div class="rider-route-panel-top">
        <div>
          <div class="detail-section-title">Punto de partida de la ruta</div>
          <div class="card-secondary">${escapeHtml(routePlan.routeOrigin.label)}</div>
          <div class="rider-route-origin">${escapeHtml(routePlan.routeOrigin.summary)}</div>
        </div>
        <span class="rider-route-mode ${routePlan.routeOrigin.mode === "gps_actual" ? "rider-route-mode-live" : ""}">
          ${escapeHtml(routePlan.routeOrigin.mode === "gps_actual" ? "GPS actual" : routePlan.routeOrigin.mode === "centro_zona" ? "Centro de zona" : "Sin origen")}
        </span>
      </div>
      <div class="rider-inline-tools">
        <button id="riderGeoLocateBtn" class="btn btn-small" type="button">${riderLocation ? "Actualizar mi punto" : "Usar mi ubicacion"}</button>
        <button id="riderGeoClearBtn" class="btn btn-small btn-outline" type="button">Quitar GPS de ruta</button>
        ${
          routePlan.routeOrigin.mapLink
            ? `<a id="riderGeoOpenLink" class="btn btn-small btn-outline" href="${routePlan.routeOrigin.mapLink}" target="_blank" rel="noreferrer">Ver origen</a>`
            : `<span class="btn btn-small btn-outline btn-disabled">Ver origen</span>`
        }
      </div>
      <div class="rider-route-summary">
        ${routePlan.gpsCount} pedidos con GPS | ${routePlan.noGpsCount} pedidos sin GPS | ${withNotes} con notas
      </div>
    </div>
    ${renderRiderNextStopHero(nextStop, routePlan, assigned)}
    ${renderRiderStageOverview(routePlan)}
    ${renderRiderRouteGuide(routePlan)}
    ${renderRiderRouteLog(assigned)}
  `;

  boardCard.innerHTML = `
    <div class="card-title">Panel del repartidor</div>
    <div class="card-secondary">Acciones rapidas, prioridad, direccion, notas y cambio de estado desde una vista pensada para movil.</div>
    <div class="rider-board-head">
      <div>
        <div class="detail-section-title">Ruta activa</div>
        <div class="card-secondary">Pendientes, recogidas y entregas que todavia necesitan movimiento.</div>
      </div>
      <span class="rider-board-count">${activeCards.length}</span>
    </div>
    <div id="repartidorOrdersBoard" class="rider-board"></div>
  `;

  const board = qs("#repartidorOrdersBoard");
  if (!board) return;

  if (!activeCards.length) {
    board.innerHTML = `<div class="attention-empty">Ruta activa limpia. Revisa Entregados en la barra inferior para ver pedidos cerrados.</div>`;
  } else {
    board.innerHTML = activeCards
      .map((entry, index) => {
        const order = entry.order;
        const priority = getRiderPriority(order, index);
        const contactPhone = getOrderContactPhone(order);
        const contactDigits = getOrderContactDigits(order);
        const packs = getOrderPacks(order);
        const garments = getNormalizedGarments(order);
        const notes = String(order.notes || "").trim();
        const location = getOrderLocation(order);
        const zoneDistance = getOrderDistanceFromZone(order);
        const geoLabel = getGeoStatusLabel(order);
        const isFallbackContact = contactPhone === BUSINESS_PROFILE.phone && (!String(order.phone || "").trim() || String(order.phone || "").trim().toLowerCase() === "x");
        const stopBadge = entry.stopNumber ? `Parada ${entry.stopNumber}` : entry.routeType === "interno" ? "Proceso" : "Completado";
        const charge = getRiderChargeSummary(order);
        const nextActionLabel = getRiderNextActionLabel(order);
        const cardClass = [
          "rider-order-card",
          entry.stopNumber === 1 ? "rider-order-card-active" : "",
          entry.routeType === "completado" ? "rider-order-card-done" : "",
          !location ? "rider-order-card-no-gps" : "",
        ].filter(Boolean).join(" ");

        return `
          <article class="${cardClass}">
            <div class="rider-order-head">
              <div class="rider-order-main">
                <div class="rider-order-id">Pedido #${order.id}</div>
                <h4>${escapeHtml(order.userName || "Cliente")}</h4>
                <div class="rider-order-meta">
                  <span>${escapeHtml(order.zone || "--")}</span>
                  <span>${escapeHtml(fmtDate(order.date))}</span>
                  <span>${escapeHtml(fmtTime(order.time) || "--")}</span>
                  <span>${escapeHtml(geoLabel)}</span>
                </div>
              </div>
              <div class="rider-order-side">
                <span class="rider-stop-badge ${entry.stopNumber ? "rider-stop-badge-live" : ""}">${escapeHtml(stopBadge)}</span>
                <span class="rider-priority ${priority.tone}">${escapeHtml(priority.label)}</span>
                ${renderStatusBadge(order.status)}
              </div>
            </div>

            ${renderRiderProgress(order)}
            ${renderRiderReadinessChips(order)}

            <div class="rider-route-distance ${entry.routeType === "sin_gps" ? "rider-route-distance-muted" : ""}">
              ${escapeHtml(entry.distanceLabel)}
            </div>

            <div class="rider-address-block">
              <div class="detail-label">Direccion</div>
              <div class="rider-address">${escapeHtml(order.address || "Por definir")}</div>
              <div class="rider-location-meta">
                ${
                  location
                    ? `${escapeHtml(formatCoordinatePair(location))} | ${escapeHtml(formatAccuracyMeters(location.accuracy))}${Number.isFinite(zoneDistance) ? ` | ${zoneDistance.toFixed(1)} km de referencia en ${escapeHtml(order.zone || "zona")}` : ""}`
                    : "Solo direccion escrita. Aun no hay punto GPS capturado."
                }
              </div>
              <div class="rider-inline-tools">
                <button class="btn btn-small btn-outline" type="button" data-copy-address="${order.id}">Copiar direccion</button>
                ${location ? `<button class="btn btn-small btn-outline" type="button" data-copy-coords="${order.id}">Copiar GPS</button>` : ""}
                ${renderOrderOpsLinks(order, {
                  compact: true,
                  directions: true,
                  origin: routePlan.routeOrigin.point,
                  includeContact: false,
                  mapLabel: "Google Maps",
                })}
              </div>
            </div>

            <div class="rider-info-grid">
              <div>
                <div class="detail-label">Servicio</div>
                <div class="rider-chip-row">
                  ${renderTagList(packs.length ? packs : ["Servicio general"])}
                </div>
              </div>
              <div>
                <div class="detail-label">Cobro</div>
                <div class="detail-value">${escapeHtml(describePricingMode(order.pricingMode))}</div>
              </div>
              <div>
                <div class="detail-label">Estimado</div>
                <div class="detail-value">${escapeHtml(charge.totalText)}</div>
                <div class="rider-fallback-note">${escapeHtml(charge.note)}</div>
              </div>
              <div>
                <div class="detail-label">Telefono</div>
                <div class="detail-value">${escapeHtml(contactPhone)}</div>
                ${isFallbackContact ? `<div class="rider-fallback-note">Numero central configurado por la empresa.</div>` : ""}
              </div>
              <div>
                <div class="detail-label">Libras</div>
                <input class="rider-lbs-input" type="number" min="0" step="0.1" data-lbs="${order.id}" value="${Number(order.lbs || 0).toFixed(1)}">
              </div>
              <div>
                <div class="detail-label">Siguiente</div>
                <div class="detail-value">${escapeHtml(nextActionLabel)}</div>
              </div>
            </div>

            ${
              garments.length
                ? `
                  <div class="rider-extra-block">
                    <div class="detail-label">Prendas</div>
                    <div class="rider-chip-row">
                      ${garments.map((item) => `<span class="detail-tag">${escapeHtml(item.name)} x${item.qty}</span>`).join("")}
                    </div>
                  </div>
                `
                : ""
            }

            ${
              order.extras?.length
                ? `
                  <div class="rider-extra-block">
                    <div class="detail-label">Extras</div>
                    <div class="rider-chip-row">
                      ${order.extras.map((item) => `<span class="detail-tag">${escapeHtml(item)}</span>`).join("")}
                    </div>
                  </div>
                `
                : ""
            }

            <div class="rider-notes-block ${notes ? "" : "rider-notes-empty"}">
              <div class="detail-label">Notas</div>
              <div>${notes ? escapeHtml(notes) : "Sin notas del cliente."}</div>
            </div>

            ${renderDeliveryProofSummary(order, { compact: true })}

            <div class="rider-action-row">
              <a class="btn btn-small" href="tel:+${contactDigits}">Llamar</a>
              <a class="btn btn-small btn-outline" href="https://wa.me/${contactDigits}?text=${encodeURIComponent(getOrderContactMessage(order))}" target="_blank" rel="noreferrer">WhatsApp</a>
              <button class="btn btn-small btn-outline" type="button" data-copy-phone="${order.id}">Copiar telefono</button>
              <button class="btn btn-small" type="button" data-factura="${order.id}">Factura</button>
              <button class="btn btn-small btn-outline" type="button" data-detalle="${order.id}">Detalle</button>
            </div>

            <div class="rider-state-row">
              ${renderRiderStateActions(order)}
            </div>
          </article>
        `;
      })
      .join("");
  }

  qs("#riderGeoLocateBtn")?.addEventListener("click", captureRiderLocation);
  qs("#riderGeoClearBtn")?.addEventListener("click", clearRiderLocation);
  qsa("#repartidorHomePanel [data-state]").forEach((btn) => btn.addEventListener("click", repartidorUpdateStatus));
  Array.from(board.querySelectorAll("[data-copy-address]")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = getOrderById(btn.dataset.copyAddress);
      copyText(order?.address || "", "Direccion copiada.");
    });
  });
  Array.from(board.querySelectorAll("[data-copy-coords]")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = getOrderById(btn.dataset.copyCoords);
      copyText(formatCoordinatePair(order?.location), "Coordenadas copiadas.");
    });
  });
  Array.from(board.querySelectorAll("[data-copy-phone]")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = getOrderById(btn.dataset.copyPhone);
      copyText(getOrderContactPhone(order), "Telefono copiado.");
    });
  });
  bindInvoiceAndDetailButtons(board);
}

function renderRepartidorDelivered() {
  const panel = qs("#repartidorDeliveredPanel");
  if (!panel) return;

  const assigned = ordersCache.filter((o) => Number(o.repartidorId) === Number(currentUser.id));
  const delivered = sortByNewestId(assigned.filter((o) => isFinalDeliveryStatus(o.status)));
  const today = new Date().toISOString().slice(0, 10);
  const deliveredToday = delivered.filter((o) => o.date === today);
  const withProof = delivered.filter((o) => getDeliveryProof(o)).length;
  const deliveredAmount = delivered.reduce((sum, order) => sum + Number(buildOrderChargeBreakdown(order).total || 0), 0);

  panel.innerHTML = `
    <div class="card rider-delivered-hero">
      <div class="rider-delivered-top">
        <div>
          <div class="card-eyebrow">Historial del repartidor</div>
          <div class="card-title">Entregados</div>
          <div class="card-secondary">Pedidos finalizados por ti, separados de la ruta activa.</div>
        </div>
        <span class="estimate-badge">${delivered.length} cerrados</span>
      </div>
      <div class="rider-delivered-metrics">
        <div><span>Hoy</span><strong>${deliveredToday.length}</strong></div>
        <div><span>Con evidencia</span><strong>${withProof}</strong></div>
        <div><span>Total estimado</span><strong>${money(deliveredAmount)}</strong></div>
      </div>
    </div>

    <div class="card card-spaced rider-delivered-card">
      <div class="detail-section-title">Pedidos entregados</div>
      <div class="card-secondary">Consulta factura, detalle y evidencia de cierre cuando exista.</div>
      ${
        delivered.length
          ? `
            <div class="rider-delivered-list">
              ${delivered
                .map((order) => {
                  const proof = getDeliveryProof(order);
                  const charge = getRiderChargeSummary(order);
                  return `
                    <article class="rider-delivered-item">
                      <div class="rider-delivered-mark">OK</div>
                      <div class="rider-delivered-copy">
                        <span>Pedido #${order.id}</span>
                        <strong>${escapeHtml(order.userName || "Cliente")}</strong>
                        <small>${escapeHtml(fmtDate(order.date))} ${escapeHtml(fmtTime(order.time) || "--")} | ${escapeHtml(order.zone || "--")} | ${escapeHtml(charge.totalText)}</small>
                        <small>${escapeHtml(proof ? `Recibido por ${proof.receiverName || "cliente"} | ${formatDeliveryProofDate(proof)}` : getOrderLatestMovementText(order))}</small>
                      </div>
                      <div class="rider-delivered-actions">
                        ${renderStatusBadge(order.status)}
                        <button class="btn btn-small" type="button" data-factura="${order.id}">Factura</button>
                        <button class="btn btn-small btn-outline" type="button" data-detalle="${order.id}">Detalle</button>
                      </div>
                    </article>
                  `;
                })
                .join("")}
            </div>
          `
          : `<div class="attention-empty">Aun no tienes pedidos entregados. Cuando cierres entregas, apareceran aqui.</div>`
      }
    </div>
  `;

  bindInvoiceAndDetailButtons(panel);
}

function openInvoice(ev) {
  const trigger = ev?.currentTarget || ev?.target || {};
  const id = trigger.dataset?.factura || trigger.dataset?.detalle || ev;
  const order = getOrderById(id, trigger.dataset?.orderSource);
  if (!order) {
    alert("Pedido no encontrado");
    return;
  }

  const packs = getOrderPacks(order);
  const breakdown = buildOrderChargeBreakdown(order);
  const garments = breakdown.garments;
  const contactPhone = getOrderContactPhone(order);
  const location = getOrderLocation(order);
  const historyLines = (order.history || [])
    .slice(-5)
    .reverse()
    .map((h) => `&bull; ${escapeHtml(formatStatusLabel(h.status))} (${escapeHtml(formatRoleLabel(h.by))}) ${escapeHtml(fmtDate(h.at))} ${escapeHtml(fmtTime(h.at))}`)
    .join("<br>");
  const deliveryProof = getDeliveryProof(order);

  qs("#invoiceSubtitle").textContent = `Pedido #${order.id} | ${order.channel || "domicilio"}`;
  qs("#invoiceBrandName").textContent = BUSINESS_PROFILE.name;
  qs("#invoiceBusiness").innerHTML = `
    ${escapeHtml(BUSINESS_PROFILE.tagline)}<br>
    ${escapeHtml(BUSINESS_PROFILE.address)}<br>
    ${escapeHtml(BUSINESS_PROFILE.phone)} | ${escapeHtml(BUSINESS_PROFILE.email)}
  `;
  qs("#invoiceMeta").innerHTML = `
    <div class="invoice-meta-row"><span>Factura</span><strong>TX-${String(order.id).padStart(5, "0")}</strong></div>
    <div class="invoice-meta-row"><span>Fecha servicio</span><strong>${escapeHtml(fmtDate(order.date))}</strong></div>
    <div class="invoice-meta-row"><span>Hora</span><strong>${escapeHtml(fmtTime(order.time) || "--")}</strong></div>
    <div class="invoice-meta-row"><span>Estado</span><strong>${escapeHtml(formatStatusLabel(order.status))}</strong></div>
  `;

  qs("#invoiceClient").innerHTML = `
    <strong>${escapeHtml(order.userName || "Cliente")}</strong><br>
    Zona: ${escapeHtml(order.zone || "--")}<br>
    Direccion: ${escapeHtml(order.address || "Entrega en local")}<br>
    Tel: ${escapeHtml(contactPhone || "--")}<br>
    <span style="color:var(--muted); font-size:12.5px;">Ultimos movimientos:</span><br>
    <span style="color:var(--muted); font-size:12.5px;">${historyLines || "--"}</span>
  `;

  qs("#invoiceSummary").innerHTML = `
    <div class="invoice-summary-row"><span>Paquetes</span><strong>${escapeHtml(packs.join(", ") || "Servicio general")}</strong></div>
    <div class="invoice-summary-row"><span>Cobro</span><strong>${escapeHtml(describePricingMode(order.pricingMode))}</strong></div>
    <div class="invoice-summary-row"><span>Repartidor</span><strong>${escapeHtml(order.repartidorName || "Pendiente")}</strong></div>
    <div class="invoice-summary-row"><span>Libras</span><strong>${breakdown.lbs > 0 ? `${escapeHtml(breakdown.lbs.toFixed(1))} lb` : "Pendiente de pesaje"}</strong></div>
    <div class="invoice-summary-row"><span>Ubicacion</span><strong>${escapeHtml(location ? "GPS verificado" : "Direccion manual")}</strong></div>
    ${
      deliveryProof
        ? `
          <div class="invoice-summary-row"><span>Entrega</span><strong>${escapeHtml(formatDeliveryMethodLabel(deliveryProof.deliveryMethod))}</strong></div>
          <div class="invoice-summary-note">Recibido por ${escapeHtml(deliveryProof.receiverName || "Sin nombre")} | ${escapeHtml(formatDeliveryProofDate(deliveryProof))}</div>
          ${deliveryProof.note ? `<div class="invoice-summary-note">Nota entrega: ${escapeHtml(deliveryProof.note)}</div>` : ""}
        `
        : ""
    }
    ${
      garments.length
        ? `<div class="invoice-summary-note">Prendas: ${escapeHtml(garments.map((item) => `${item.name} x${item.qty}`).join(", "))}</div>`
        : ""
    }
    ${
      location
        ? `<div class="invoice-summary-note">Coordenadas: ${escapeHtml(formatCoordinatePair(location))}</div>`
        : ""
    }
    ${
      breakdown.weightPending
        ? `<div class="invoice-summary-note">El monto por libra se confirma luego del pesaje final.</div>`
        : ""
    }
  `;

  qs("#invoiceLines").innerHTML = breakdown.lines
    .map((line) => `
      <tr>
        <td>${escapeHtml(line.label)}</td>
        <td>${escapeHtml(String(line.qty))}</td>
        <td>${money(line.price)}</td>
        <td>${line.total > 0 ? money(line.total) : "Por confirmar"}</td>
      </tr>
    `)
    .join("");

  qs("#invoiceSubtotal").textContent = breakdown.weightPending
    ? breakdown.subtotal > 0
      ? `Desde ${money(breakdown.subtotal)}`
      : "Por confirmar"
    : money(breakdown.subtotal);
  qs("#invoiceItbis").textContent = breakdown.weightPending
    ? breakdown.itbis > 0
      ? `Desde ${money(breakdown.itbis)}`
      : "Por confirmar"
    : money(breakdown.itbis);
  qs("#invoiceTotal").textContent = breakdown.weightPending
    ? breakdown.total > 0
      ? `Desde ${money(breakdown.total)}`
      : "Por confirmar"
    : money(breakdown.total);
  qs("#invoiceFooterText").textContent =
    `${BUSINESS_PROFILE.legalName} | ${BUSINESS_PROFILE.phone} | ${BUSINESS_PROFILE.email}`;

  show(qs("#invoicePrintBtn"));
  qs("#invoiceModal").style.display = "flex";
  qs("#invoicePrintArea").scrollTop = 0;
  qs("#invoiceModal .invoice-body")?.scrollTo(0, 0);
}

function openDetail(ev) {
  const trigger = ev?.currentTarget || ev?.target || {};
  const id = trigger.dataset?.detalle || trigger.dataset?.factura || ev;
  const order = getOrderById(id, trigger.dataset?.orderSource);
  if (!order) {
    alert("Pedido no encontrado");
    return;
  }

  ensureDetailModal();

  const packs = getOrderPacks(order);
  const breakdown = buildOrderChargeBreakdown(order);
  const garments = breakdown.garments;
  const contactPhone = getOrderContactPhone(order);
  const location = getOrderLocation(order);
  const historyItems = (order.history || [])
    .slice()
    .reverse()
    .map(
      (item) =>
        `<li><strong>${escapeHtml(formatStatusLabel(item.status))}</strong> | ${escapeHtml(formatRoleLabel(item.by))} | ${escapeHtml(fmtDate(item.at))} ${escapeHtml(fmtTime(item.at))}</li>`
    )
    .join("");

  qs("#detailSubtitle").textContent = `Pedido #${order.id} | ${formatStatusLabel(order.status)}`;
  qs("#detailBody").innerHTML = `
    <div class="detail-section">
      <div class="detail-section-top">
        <div class="detail-section-title">Resumen rapido</div>
        ${renderStatusBadge(order.status)}
      </div>
      <div class="detail-meta-grid">
        <div><span class="detail-label">Cliente</span><div class="detail-value">${escapeHtml(order.userName || "Cliente")}</div></div>
        <div><span class="detail-label">Canal</span><div class="detail-value">${escapeHtml(order.channel || "domicilio")}</div></div>
        <div><span class="detail-label">Zona</span><div class="detail-value">${escapeHtml(order.zone || "--")}</div></div>
        <div><span class="detail-label">Fecha</span><div class="detail-value">${escapeHtml(fmtDate(order.date))}</div></div>
        <div><span class="detail-label">Hora</span><div class="detail-value">${escapeHtml(fmtTime(order.time) || "--")}</div></div>
        <div><span class="detail-label">Repartidor</span><div class="detail-value">${escapeHtml(order.repartidorName || "Sin asignar")}</div></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Servicio solicitado</div>
      <div class="detail-tag-row">${renderTagList(packs, "Sin paquetes")}</div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Cobro y operacion</div>
      <div class="detail-meta-grid">
        <div><span class="detail-label">Tipo de cobro</span><div class="detail-value">${escapeHtml(describePricingMode(order.pricingMode))}</div></div>
        <div><span class="detail-label">Tipo de servicio</span><div class="detail-value">${escapeHtml(order.serviceType || "--")}</div></div>
        <div><span class="detail-label">Libras registradas</span><div class="detail-value">${escapeHtml(Number(order.lbs || 0).toFixed(1))} lb</div></div>
        <div><span class="detail-label">Telefono</span><div class="detail-value">${escapeHtml(contactPhone || "--")}</div></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Ubicacion del pedido</div>
      <div class="detail-meta-grid">
        <div><span class="detail-label">Modo</span><div class="detail-value">${escapeHtml(location ? "GPS verificado" : "Direccion manual")}</div></div>
        <div><span class="detail-label">Zona sugerida</span><div class="detail-value">${escapeHtml(location?.inferredZone || order.zone || "--")}</div></div>
        <div><span class="detail-label">Coordenadas</span><div class="detail-value">${escapeHtml(location ? formatCoordinatePair(location) : "No registradas")}</div></div>
        <div><span class="detail-label">Precision</span><div class="detail-value">${escapeHtml(location ? formatAccuracyMeters(location.accuracy) : "No disponible")}</div></div>
      </div>
      <div class="rider-inline-tools" style="margin-top:12px;">
        ${renderOrderOpsLinks(order, {
          compact: true,
          directions: currentUser?.role === "repartidor",
          origin: riderLocation,
          mapLabel: currentUser?.role === "repartidor" ? "Ruta Google" : "Google Maps",
        })}
      </div>
    </div>

    ${garments.length ? `
      <div class="detail-section">
        <div class="detail-section-title">Prendas seleccionadas</div>
        <ul class="detail-list">
          ${garments.map((item) => `<li>${escapeHtml(item.name)} | ${item.qty} x ${money(item.price)}</li>`).join("")}
        </ul>
      </div>
    ` : ""}

    ${order.extras?.length ? `
      <div class="detail-section">
        <div class="detail-section-title">Extras</div>
        <div class="detail-tag-row">${renderTagList(order.extras)}</div>
      </div>
    ` : ""}

    ${order.notes ? `
      <div class="detail-section">
        <div class="detail-section-title">Notas</div>
        <div class="detail-note">${escapeHtml(order.notes)}</div>
      </div>
    ` : ""}

    ${currentUser?.role === "cliente" ? renderClientTrackingExperience(order) : ""}

    ${renderDeliveryCodeCard(order)}

    ${renderDeliveryProofSummary(order)}

    <div class="detail-section">
      <div class="detail-section-title">Totales</div>
      <div class="detail-meta-grid">
        <div><span class="detail-label">Subtotal</span><div class="detail-value">${breakdown.weightPending ? (breakdown.subtotal > 0 ? `Desde ${money(breakdown.subtotal)}` : "Por confirmar") : money(breakdown.subtotal)}</div></div>
        <div><span class="detail-label">ITBIS</span><div class="detail-value">${breakdown.weightPending ? (breakdown.itbis > 0 ? `Desde ${money(breakdown.itbis)}` : "Por confirmar") : money(breakdown.itbis)}</div></div>
        <div><span class="detail-label">Total</span><div class="detail-value">${breakdown.weightPending ? (breakdown.total > 0 ? `Desde ${money(breakdown.total)}` : "Por confirmar") : money(breakdown.total)}</div></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Historial</div>
      <ul class="detail-list">${historyItems || "<li>Sin movimientos registrados.</li>"}</ul>
    </div>
  `;

  qs("#detailModal").style.display = "flex";
  qs("#detailBody").scrollTop = 0;
}

function attachAppEvents() {
  qs("#logoutBtn")?.addEventListener("click", logout);
  qs("#darkModeToggle")?.addEventListener("click", toggleTheme);
  qs("#quickOrderForm")?.addEventListener("submit", onCreateOrder);
  qs("#cashierForm")?.addEventListener("submit", onCreateLocalOrder);
  qs("#invoiceCloseBtn")?.addEventListener("click", closeInvoice);
  qs("#invoicePrintBtn")?.addEventListener("click", printInvoice);
  qs("#invoiceModal .invoice-backdrop")?.addEventListener("click", closeInvoice);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeInvoice();
      closeDetail();
      closeConfirmDialog(false);
      closeDeliveryProofDialog(null);
      closeAuthActionPanel();
    }
  });
  qs("#profileForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    showInfo("Perfil revisado. Para cambios sensibles, contacta soporte.");
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  ensureUIEnhancements();
  ensureNoticeStack();
  ensureConfirmDialog();
  ensureDeliveryProofDialog();
  ensureAppLoadingBanner();
  ensureAppEntryOverlay();
  flushPendingNotices();
  loadSavedRiderLocation();
  loadGestorZoneFilter();

  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(savedTheme === "dark" ? "dark" : "light", false);

  setDefaultFormValues();
  syncSessionChrome();

  attachNavEvents();
  attachAuthEvents();
  attachAppEvents();
  attachAutoRefreshEvents();

  const handledAuthLink = await handleAuthLinkState();
  if (handledAuthLink) {
    return;
  }

  const savedToken = getStoredToken();
  if (savedToken) {
    try {
      await restoreSessionFromToken();
      revealAuthenticatedApp("Recuperando tu panel...");
      await loadAll();
      await hideAppEntryOverlay();
    } catch (_error) {
      await hideAppEntryOverlay();
      clearSession();
      show(qs("#authView"));
      hide(qs("#appView"));
      syncSessionChrome();
      warmBackendConnection();
    }
  } else {
    show(qs("#authView"));
    hide(qs("#appView"));
    syncSessionChrome();
    warmBackendConnection();
  }
});
