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
let riderLocation = null;
let gestorZoneFilter = "all";

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
  if (!raw) return "Sin estado";
  if (s.includes("cancel")) return "Cancelado";
  if (s.includes("entregado")) return "Entregado";
  if (s.includes("camino")) return "En camino";
  if (s.includes("recibido")) return "Recibido";
  if (s.includes("pendiente")) return "Pendiente";
  if (s.includes("asignado")) return "Asignado";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function getStatusTone(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("cancel")) return "status-cancelled";
  if (s.includes("entregado")) return "status-delivered";
  if (s.includes("camino") || s.includes("recibido") || s.includes("asignado")) return "status-progress";
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
    const active = clientOrders.filter((o) => !["entregado", "cancelado"].includes(o.status));
    const delivered = clientOrders.filter((o) => String(o.status).toLowerCase().includes("entregado"));
    setHeroStat(1, "Pedidos", String(clientOrders.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Entregados", String(delivered.length));
    if (badge) badge.textContent = "Servicio signature";
    return;
  }

  if (currentUser.role === "gestor") {
    const pending = ordersCache.filter((o) => o.channel !== "local" && o.status === "pendiente");
    const active = ordersCache.filter((o) => o.channel !== "local" && !["entregado", "cancelado"].includes(o.status));
    setHeroStat(1, "Pendientes", String(pending.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Rutas", String(repartidoresCache.length));
    if (badge) badge.textContent = "Salon operativo";
    return;
  }

  if (currentUser.role === "repartidor") {
    const assigned = ordersCache.filter((o) => o.repartidorId === currentUser.id);
    const todayCount = assigned.filter((o) => o.date === today);
    const delivered = assigned.filter((o) => String(o.status).toLowerCase().includes("entregado"));
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
  if (!dateInput || !timeInput || dateInput.value) return;

  const now = new Date();
  const hour = String(Math.min(now.getHours() + 1, 22)).padStart(2, "0");
  dateInput.value = now.toISOString().slice(0, 10);
  dateInput.min = dateInput.value;
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
    logo.innerHTML = `<img src="${BUSINESS_ASSETS.icon}" alt="${BUSINESS_PROFILE.name}" />`;
  }
  let favicon = document.querySelector('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.setAttribute("rel", "icon");
    document.head.appendChild(favicon);
  }
  favicon.setAttribute("href", BUSINESS_ASSETS.icon);
  favicon.setAttribute("type", "image/svg+xml");

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
  if (!welcomeBlock || !welcomeText || !roleBadge || welcomeBlock.querySelector(".welcome-main")) return;

  const roleLabel = qs("#roleLabel");

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

  roleBadge.textContent = "Rol activo ";
  if (roleLabel) roleBadge.appendChild(roleLabel);
  side.appendChild(roleBadge);

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
    screenRiders: "RP",
    screenLocal: "LC",
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
  if (quickSubtitle) quickSubtitle.textContent = "Agenda de 8:00 AM a 10:00 PM. Capacidad demo de 20 pedidos por dia.";

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
  if (premiumNote) premiumNote.textContent = "Modo demo sin cobro real.";
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
  if (accountSubtitle) accountSubtitle.textContent = "Administra tu informacion en este entorno demo.";
  const profileLabels = qs("#profileForm")?.querySelectorAll("label") || [];
  const profileTexts = ["Nombre", "Correo", "Rol"];
  profileLabels.forEach((label, index) => {
    if (profileTexts[index]) label.textContent = profileTexts[index];
  });
  const helpItems = qsa(".help-list li");
  const helpTexts = [
    "Soporte: soporte@tintoreria.com",
    "Horario: 8:00 AM - 10:00 PM",
    "Capacidad demo: 20 pedidos por dia",
  ];
  helpItems.forEach((item, index) => {
    if (helpTexts[index]) item.textContent = helpTexts[index];
  });
}

function showScreen(screenId) {
  qsa(".screen").forEach((s) => s.classList.remove("screen-active"));
  const target = qs(`#${screenId}`);
  if (target) target.classList.add("screen-active");

  qsa(".nav-item").forEach((btn) => {
    btn.classList.toggle("nav-item-active", btn.dataset.screenTarget === screenId);
  });
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
function getStatusRank(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("cancelado")) return 99;
  if (s.includes("entregado")) return 4;
  if (s.includes("camino")) return 3;
  if (s.includes("recibido")) return 2;
  if (s.includes("pendiente")) return 1;
  return 0;
}
function canMoveTo(currentStatus, targetStatus) {
  return getStatusRank(targetStatus) >= getStatusRank(currentStatus);
}

/* ============================================================
   CANCEL WINDOW (5 min)
============================================================ */
function canCancel(order) {
  if (!order || !order.createdAt) return false;
  if (order.status === "entregado" || order.status === "cancelado") return false;
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
}

function clearSession() {
  currentUser = null;
  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem(TOKEN_STORAGE_KEY);
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

/* ============================================================
   LOAD DATA
============================================================ */
async function loadAll() {
  ordersCache = await apiGet("/orders");
  repartidoresCache = await apiGet("/repartidores");
  localOrdersCache = await apiGet("/local-orders").catch(() => []);

  updateUIByRole();
  updateDashboardHero();

  if (currentUser.role === "cliente") {
    renderClientHome();
    renderClientActivity();
    renderClientAccount();
  }

  if (currentUser.role === "gestor") {
    renderGestorHome();
    renderGestorRidersActivity();
    renderGestorLocal();
  }

  if (currentUser.role === "repartidor") {
    renderRepartidorHome();
  }

  if (currentUser.role === "cajera") {
    renderCashierHome();
  }
}

/* ============================================================
   UI BY ROLE
============================================================ */
function updateUIByRole() {
  qs("#welcomeTitle").textContent = `Hola, ${currentUser.name}`;
  qs("#roleLabel").textContent = formatRoleLabel(currentUser.role);

  // nav
  const navActivity = qs("[data-screen-target='screenActivity']");
  const navPremium = qs("[data-screen-target='screenPremium']");
  const navRiders = qs("#navRiders");
  const navLocal = qs("#navLocal");

  // cards cliente
  const nextOrderCard = qs("#nextOrderCard");
  const quickOrderCard = qs("#quickOrderCard");
  const serviceCard = qs("#serviceExperienceCard");

  // panels
  const gestorPanel = qs("#gestorHomePanel");
  const repPanel = qs("#repartidorHomePanel");
  const cashierPanel = qs("#cashierHomePanel");

  // reset
  show(navActivity); show(navPremium);
  hide(navRiders); hide(navLocal);

  show(nextOrderCard); show(quickOrderCard); show(serviceCard);
  hide(gestorPanel); hide(repPanel); hide(cashierPanel);
  syncSessionChrome();

  // Perfil
  if (qs("#profileName")) qs("#profileName").value = currentUser.name || "";
  if (qs("#profileEmail")) qs("#profileEmail").value = currentUser.email || "";
  if (qs("#profileRole")) qs("#profileRole").value = formatRoleLabel(currentUser.role);

  // Cliente
  if (currentUser.role === "cliente") {
    qs("#welcomeSubtitle").textContent = "Ordena tu servicio y sigue tu pedido.";
    showScreen("screenHome");
    return;
  }

  // Gestor
  if (currentUser.role === "gestor") {
    hide(navActivity); hide(navPremium);
    show(navRiders); show(navLocal);
    hide(nextOrderCard); hide(quickOrderCard); hide(serviceCard);
    show(gestorPanel);
    qs("#welcomeSubtitle").textContent = "Administra pedidos, asignaciones, local y repartidores.";
    showScreen("screenHome");
    return;
  }

  // Repartidor
  if (currentUser.role === "repartidor") {
    hide(navActivity); hide(navPremium);
    hide(navRiders); hide(navLocal);
    hide(nextOrderCard); hide(quickOrderCard); hide(serviceCard);
    show(repPanel);
    qs("#welcomeSubtitle").textContent = "Gestiona tus pedidos asignados y actualiza estados.";
    showScreen("screenHome");
    return;
  }

  // Cajera
  if (currentUser.role === "cajera") {
    hide(navActivity); hide(navPremium);
    hide(navRiders); hide(navLocal);
    hide(nextOrderCard); hide(quickOrderCard); hide(serviceCard);
    show(cashierPanel);
    qs("#welcomeSubtitle").textContent = "Caja: registra pedidos del local con libras.";
    showScreen("screenHome");
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
  // Nada extra por ahora
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

function buildClientOrderStats(clientOrders) {
  const my = sortByNewestId(clientOrders);
  const activeOrders = my.filter((order) => !["entregado", "cancelado"].includes(String(order.status || "").toLowerCase()));
  const delivered = my.filter((order) => String(order.status || "").toLowerCase().includes("entregado"));
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

function renderClientHome() {
  const stats = buildClientOrderStats(ordersCache.filter((o) => o.userId === currentUser.id));
  const { my, active, activeCount, delivered, cancelled, recentOrder, recentDelivered, favoritePack, gpsReadyCount } = stats;
  const serviceCard = qs("#serviceExperienceCard");
  const quickOrderCard = qs("#quickOrderCard");
  let executiveCard = qs("#clientExecutiveCard");
  const statusNode = qs("#nextOrderStatus");
  const infoNode = qs("#nextOrderInfo");
  const careTier = getClientCareTier(my.length);
  const greetingName = String(currentUser?.name || "Cliente").trim().split(/\s+/)[0] || "Cliente";
  const focusZone = active?.zone || recentOrder?.zone || "Distrito Nacional";
  const supportMessage = encodeURIComponent(`Hola, necesito ayuda con mi cuenta en ${BUSINESS_PROFILE.name}.`);

  if (!executiveCard && quickOrderCard) {
    executiveCard = document.createElement("div");
    executiveCard.id = "clientExecutiveCard";
    executiveCard.className = "card card-spaced client-executive-card";
    quickOrderCard.insertAdjacentElement("afterend", executiveCard);
  }

  if (!active) {
    statusNode.textContent = "Sin pedidos";
    statusNode.className = "status-pill status-empty";
    infoNode.innerHTML = `
      <div class="client-summary-copy">
        Cuando confirmes tu primer servicio, aqui veras estado, zona, horario, detalle y seguimiento de una forma mucho mas clara.
      </div>
      <div class="client-spotlight">
        <div class="client-spotlight-copy">
          <strong>Tu proximo servicio puede verse mucho mejor desde el inicio</strong>
          <span>Agenda recogida, selecciona tus paquetes y mantente al tanto del proceso sin perder contexto.</span>
        </div>
        <div class="client-spotlight-side">
          <small>${careTier}</small>
          <strong>${currentUser?.emailVerified ? "Correo verificado" : "Cuenta lista"}</strong>
        </div>
      </div>
      <div class="brand-pill-row">
        <span class="estimate-tag">Recogida programada</span>
        <span class="estimate-tag">Factura elegante</span>
        <span class="estimate-tag">Seguimiento visible</span>
      </div>
    `;
  } else {
    const activeBreakdown = buildOrderChargeBreakdown(active);
    const activeLocation = getOrderLocation(active);
    const packs = getOrderPacks(active);
    statusNode.textContent = formatStatusLabel(active.status);
    statusNode.className = `status-pill ${getStatusTone(active.status)}`;

    const summary = [fmtDate(active.date), fmtTime(active.time), active.zone];
    if (active.repartidorName) summary.push(`Repartidor: ${active.repartidorName}`);
    const info = summary.filter(Boolean).join(" | ");
    const amountLabel = activeBreakdown.weightPending
      ? activeBreakdown.total > 0
        ? `Desde ${money(activeBreakdown.total)}`
        : "Total por confirmar"
      : money(activeBreakdown.total);
    const serviceMeta = [
      active.serviceType || "Recogida coordinada",
      describePricingMode(active.pricingMode),
      activeLocation ? "GPS verificado" : "Direccion manual",
      amountLabel,
    ].filter(Boolean).join(" | ");

    infoNode.innerHTML = `
      <div class="client-summary-copy">${escapeHtml(info)}</div>
      <div class="client-spotlight">
        <div class="client-spotlight-copy">
          <strong>${escapeHtml(packs.join(" + ") || active.pack || "Servicio general")}</strong>
          <span>${escapeHtml(serviceMeta)}</span>
        </div>
        <div class="client-spotlight-side">
          <small>${active.repartidorName ? "Repartidor asignado" : "Preparando ruta"}</small>
          <strong>${escapeHtml(active.repartidorName || focusZone)}</strong>
        </div>
      </div>
      <div class="brand-pill-row">
        ${(packs.length ? packs : [active.pack || "Servicio general"]).map((pack) => `<span class="estimate-tag">${escapeHtml(pack)}</span>`).join("")}
        <span class="estimate-tag">${escapeHtml(focusZone)}</span>
        <span class="estimate-tag ${activeLocation ? "" : "estimate-tag-muted"}">${activeLocation ? "GPS verificado" : "Direccion manual"}</span>
      </div>
      <div class="client-support-row">
        <button class="btn btn-small" type="button" id="homeInvoiceBtn">Factura</button>
        <button class="btn btn-small btn-outline" type="button" id="homeDetailBtn">Detalle</button>
        <button class="btn btn-small btn-outline" type="button" id="homeActivityBtn">Seguimiento</button>
        ${canCancel(active) ? `<button class="btn btn-small btn-outline" type="button" id="homeCancelBtn">Cancelar (5 min)</button>` : ""}
      </div>
    `;

    qs("#homeInvoiceBtn")?.addEventListener("click", () => openInvoice(active.id));
    qs("#homeDetailBtn")?.addEventListener("click", () => openDetail(active.id));
    qs("#homeActivityBtn")?.addEventListener("click", () => showScreen("screenActivity"));
    qs("#homeCancelBtn")?.addEventListener("click", () => cancelOrder(active.id));
  }

  if (serviceCard) {
    const recentDeliveredLabel = recentDelivered
      ? `${fmtDate(recentDelivered.date)} | ${getOrderPacks(recentDelivered).join(", ") || recentDelivered.pack || "Servicio general"}`
      : "Tu primera entrega confirmada aparecera aqui cuando completes un servicio.";

    serviceCard.innerHTML = `
      <div class="estimate-top">
        <div>
          <div class="estimate-kicker">Experiencia ${escapeHtml(BUSINESS_PROFILE.name)}</div>
          <div class="estimate-title">${escapeHtml(careTier)} con una imagen mas cuidada y profesional</div>
        </div>
        <div class="estimate-badge">${currentUser?.emailVerified ? "Correo verificado" : "Cuenta activa"}</div>
      </div>
      <div class="client-luxury-strip">
        <div class="client-luxury-card">
          <span>Zona de servicio</span>
          <strong>${escapeHtml(focusZone)}</strong>
          <small>Atencion alineada con tu sector y tu direccion registrada.</small>
        </div>
        <div class="client-luxury-card">
          <span>Pedidos con GPS</span>
          <strong>${gpsReadyCount}</strong>
          <small>${gpsReadyCount ? "Ubicaciones validadas para despacho." : "Activa tu ubicacion para una recepcion mas precisa."}</small>
        </div>
        <div class="client-luxury-card">
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
              <span>Te asistimos por WhatsApp, llamada o correo si necesitas mover un servicio o aclarar un detalle.</span>
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

    executiveCard.innerHTML = `
      <div class="client-hero-banner">
        <div class="client-hero-copy">
          <div class="estimate-kicker">Client lounge</div>
          <div class="client-hero-title">${escapeHtml(greetingName)}, tu cuidado textil ya se ve mas premium</div>
          <div class="client-hero-text">
            Sigue tus servicios, revisa detalles y mantente cerca de la siguiente entrega desde un panel mas limpio, serio y confiable.
          </div>
        </div>
        <div class="client-hero-side">
          <span>${escapeHtml(careTier)}</span>
          <strong>${active ? "Servicio activo" : "Agenda abierta"}</strong>
          <small>${currentUser?.emailVerified ? "Cuenta validada para recibir correos" : "Activa tu cuenta desde el correo cuando quieras"}</small>
        </div>
      </div>
      <div class="executive-grid client-executive-grid">
        <div class="executive-metric">
          <span>Pedidos</span>
          <strong>${my.length}</strong>
        </div>
        <div class="executive-metric">
          <span>Activos</span>
          <strong>${activeCount}</strong>
        </div>
        <div class="executive-metric">
          <span>Entregados</span>
          <strong>${delivered.length}</strong>
        </div>
        <div class="executive-metric">
          <span>Zona base</span>
          <strong>${escapeHtml(focusZone)}</strong>
        </div>
      </div>
      <div class="attention-board">
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
        <button class="btn btn-small btn-outline" type="button" id="clientFocusOrderBtn">Nuevo pedido</button>
        <a class="btn btn-small btn-outline" href="https://wa.me/${BUSINESS_PHONE_DIGITS}?text=${supportMessage}" target="_blank" rel="noreferrer">Soporte</a>
      </div>
    `;

    qs("#clientGoActivityBtn")?.addEventListener("click", () => showScreen("screenActivity"));
    qs("#clientFocusOrderBtn")?.addEventListener("click", () => {
      quickOrderCard?.scrollIntoView({ behavior: "smooth", block: "start" });
      qs("#homeZone")?.focus();
    });
  }
}

function renderClientActivity() {
  const timeline = qs("#activityTimeline");
  const screen = qs("#screenActivity");
  let summaryCard = qs("#clientActivitySummaryCard");
  const { my, activeCount, delivered, recentOrder, recentDelivered, favoritePack } =
    buildClientOrderStats(ordersCache.filter((o) => o.userId === currentUser.id));
  if (!summaryCard && screen) {
    summaryCard = document.createElement("div");
    summaryCard.id = "clientActivitySummaryCard";
    summaryCard.className = "card card-spaced client-activity-summary";
    const anchorCard = screen.querySelector(".card");
    if (anchorCard) {
      screen.insertBefore(summaryCard, anchorCard);
    }
  }
  timeline.innerHTML = "";

  if (summaryCard) {
    summaryCard.innerHTML = `
      <div class="executive-head">
        <div>
          <div class="card-title">Actividad y seguimiento</div>
          <div class="card-secondary">Consulta tu historial con una lectura mas limpia: estado, monto estimado, mapa, factura y detalle en un mismo lugar.</div>
        </div>
        <div class="estimate-badge">${currentUser?.emailVerified ? "Cuenta verificada" : "Cliente"}</div>
      </div>
      <div class="executive-grid client-executive-grid">
        <div class="executive-metric">
          <span>Historial</span>
          <strong>${my.length}</strong>
        </div>
        <div class="executive-metric">
          <span>Activos</span>
          <strong>${activeCount}</strong>
        </div>
        <div class="executive-metric">
          <span>Entregados</span>
          <strong>${delivered.length}</strong>
        </div>
        <div class="executive-metric">
          <span>Zona reciente</span>
          <strong>${escapeHtml(recentOrder?.zone || "Sin historial")}</strong>
        </div>
      </div>
      <div class="client-activity-overview">
        <div class="client-luxury-card">
          <span>Paquete favorito</span>
          <strong>${escapeHtml(favoritePack)}</strong>
          <small>La preferencia que mas se repite en tu historial reciente.</small>
        </div>
        <div class="client-luxury-card">
          <span>Ultima entrega</span>
          <strong>${recentDelivered ? fmtDate(recentDelivered.date) : "Pendiente"}</strong>
          <small>${escapeHtml(recentDelivered ? getOrderPacks(recentDelivered).join(", ") || recentDelivered.pack || "Servicio general" : "Tu primera entrega confirmada aparecera aqui.")}</small>
        </div>
      </div>
    `;
  }

  if (!my.length) {
    timeline.innerHTML = `<li class="timeline-empty">Aun no tienes pedidos. Cuando crees uno aparecera aqui.</li>`;
    return;
  }

  my.forEach((o) => {
    const packs = getOrderPacks(o);
    const breakdown = buildOrderChargeBreakdown(o);
    const location = getOrderLocation(o);
    const amountLabel = breakdown.weightPending
      ? breakdown.total > 0
        ? `Desde ${money(breakdown.total)}`
        : "Monto por confirmar"
      : money(breakdown.total);
    const serviceMoment = [fmtDate(o.date), fmtTime(o.time)].filter(Boolean).join(" | ");
    const li = document.createElement("li");
    li.className = "timeline-item";
    li.innerHTML = `
      <div class="timeline-icon">#${String(o.id).padStart(2, "0")}</div>
      <div class="timeline-content">
        <div class="timeline-title">
          <span>Pedido #${o.id}</span>
          ${renderStatusBadge(o.status)}
        </div>
        <div class="timeline-meta">${escapeHtml(serviceMoment)} | ${escapeHtml(o.zone || "--")} | ${escapeHtml(o.repartidorName || "Asignacion pendiente")}</div>
        <div class="timeline-summary-row">
          <div class="timeline-summary-block">
            <strong>${escapeHtml(o.serviceType || "Servicio a domicilio")}</strong>
            <span>${escapeHtml(describePricingMode(o.pricingMode))}</span>
          </div>
          <div class="timeline-summary-block timeline-summary-price">
            <strong>${escapeHtml(amountLabel)}</strong>
            <span>${escapeHtml(location ? "GPS verificado" : "Direccion manual")}</span>
          </div>
        </div>
        <div class="timeline-tag-row">
          ${(packs.length ? packs : [o.pack || "Servicio general"]).map((pack) => `<span class="estimate-tag">${escapeHtml(pack)}</span>`).join("")}
        </div>
        <div class="timeline-extra">${o.notes ? escapeHtml(o.notes) : "Factura, detalle y estado disponibles para cada servicio."}</div>
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

  bindInvoiceAndDetailButtons(timeline);
  Array.from(timeline.querySelectorAll("[data-cancel]")).forEach((btn) => btn.addEventListener("click", (ev) => cancelOrder(ev.target.dataset.cancel)));
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
  const orderId = ev.target.dataset.id;
  const state = ev.target.dataset.state;
  const order = ordersCache.find((o) => o.id == orderId);
  if (!order) return;

  const lbs = parseFloat(qs(`[data-lbs="${orderId}"]`)?.value || "0");
  const map = { recibido: "recibido", camino: "en camino", entregado: "entregado" };
  const targetStatus = map[state];

  if (!canMoveTo(order.status, targetStatus)) {
    alert("No puedes retroceder el estado.");
    return;
  }

  try {
    await apiPut(`/orders/${orderId}/status`, { status: targetStatus, lbs });
    await loadAll();
  } catch (err) {
    alert(err.message || "Error cambiando estado");
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
    alert("Guardado (modo demo).");
  });
}

function attachAuthEvents() {
  qs("#loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearInlineMessage("#loginMessage");
    try {
      await login(qs("#loginEmail").value, qs("#loginPassword").value);
      hide(qs("#authView"));
      show(qs("#appView"));
      syncSessionChrome();
      await loadAll();
    } catch (err) {
      setInlineMessage("#loginMessage", err.message || "Error de inicio de sesion", err.code === "EMAIL_NOT_VERIFIED" ? "warning" : "error");
      if (err.code === "EMAIL_NOT_VERIFIED") {
        openAuthActionPanel("resend", {
          email: err.email || qs("#loginEmail")?.value.trim() || "",
        });
      }
    }
  });

  qs("#registerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearInlineMessage("#registerMessage");
    try {
      const data = await register(
        qs("#registerName").value,
        qs("#registerEmail").value,
        qs("#registerPassword").value
      );
      const tone = data?.emailDeliveryFailed ? "warning" : "success";
      setInlineMessage("#registerMessage", buildAuthResponseHtml(data, data.message), tone, { html: true });
      if (data?.user?.email) qs("#loginEmail").value = data.user.email;
      if (data?.emailDeliveryFailed) {
        showWarning(getFriendlyAuthMessage(data, "La cuenta fue creada, pero el correo no pudo enviarse ahora mismo."));
      } else {
        showSuccess(data.message || "Cuenta creada. Revisa tu correo.");
      }
      qs("#registerForm").reset();
    } catch (err) {
      const friendlyMessage = getFriendlyAuthMessage(err, "Error de registro");
      setInlineMessage("#registerMessage", friendlyMessage, isEmailDeliveryIssue(err) ? "warning" : "error");
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
    alert("Guardado en modo demo.");
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
  rnc: "1-32-45896-2",
  phone: "829-448-7876",
  email: "admin@mentalaundry.com",
  address: "Av. 27 de Febrero 135, Distrito Nacional",
  schedule: "Lunes a sabado | 8:00 AM - 10:00 PM",
};

const BUSINESS_PHONE_DIGITS = "18294487876";
const BUSINESS_ASSETS = {
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

function getOrderById(id) {
  let order = ordersCache.find((item) => item.id == id);
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
            <div id="homeGeoStatus" class="geo-status">Sin ubicacion capturada</div>
            <div id="homeGeoMeta" class="geo-meta">Comparte tu GPS para fijar el punto exacto de recogida y sugerir la zona mas cercana.</div>
          </div>
          <span id="homeGeoZone" class="estimate-tag estimate-tag-muted">Zona manual</span>
        </div>
        <div id="homeGeoCoords" class="geo-coords">Aun no hay coordenadas registradas en este pedido.</div>
        <div class="geo-action-row">
          <button id="homeGeoLocateBtn" class="btn btn-small" type="button">Usar mi ubicacion</button>
          <button id="homeGeoClearBtn" class="btn btn-small btn-outline" type="button">Limpiar GPS</button>
          <a id="homeGeoOpenLink" class="btn btn-small btn-outline btn-disabled" href="#" target="_blank" rel="noreferrer" aria-disabled="true">Ver punto</a>
        </div>
      </div>
      <div class="field-help">La direccion escrita sigue siendo obligatoria como referencia, pero el GPS ayuda al repartidor a llegar con mas precision.</div>
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

  qsa("[data-garment-qty]").forEach((input) => {
    if (input.dataset.quoteBound === "1") return;
    input.dataset.quoteBound = "1";
    input.addEventListener("input", updateOrderEstimatePreview);
    input.addEventListener("change", updateOrderEstimatePreview);
  });

  syncPricingModeUI();
  renderHomeLocationStatus();
  updateOrderEstimatePreview();
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

  const showcase = authView.querySelector(".auth-showcase");
  if (showcase) {
    showcase.innerHTML = `
      <div class="auth-kicker">Recepcion y cuidado textil</div>
      <h1 class="auth-title">Una recepcion premium para una tintoreria que inspira confianza.</h1>
      <p class="auth-copy">
        ${BUSINESS_PROFILE.name} combina recogida, seguimiento, facturacion y atencion
        con una presencia mas sobria, elegante y lista para presentarse ante terceros.
      </p>
      <div class="auth-feature-grid">
        <div class="auth-feature-card"><span class="feature-pill">Seguimiento</span><p>Consulta cada pedido con una lectura clara, limpia y profesional.</p></div>
        <div class="auth-feature-card"><span class="feature-pill">Coordinacion</span><p>Gestiona local, repartidores y clientes desde una misma experiencia.</p></div>
        <div class="auth-feature-card"><span class="feature-pill">Servicio</span><p>Opera por libra, por prendas o con paquetes combinados segun el caso.</p></div>
      </div>
      <div class="auth-preview">
        <div class="preview-header">
          <span class="preview-label">Flujo de servicio</span>
          <span class="preview-note">${BUSINESS_PROFILE.schedule}</span>
        </div>
        <div class="preview-steps">
          <div class="preview-step preview-step-active">Solicitud</div>
          <div class="preview-step">Asignado</div>
          <div class="preview-step">En camino</div>
          <div class="preview-step">Entregado</div>
        </div>
      </div>
    `;
  }

  authView.querySelector(".auth-metrics")?.remove();

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

function getRiderPriority(order, index) {
  const status = String(order?.status || "").toLowerCase();
  if (status.includes("cancel")) return { label: "Cancelado", tone: "rider-priority-base" };
  if (status.includes("entregado")) return { label: "Completado", tone: "rider-priority-done" };
  if (status.includes("camino")) return { label: "Entrega en curso", tone: "rider-priority-live" };
  if (index === 0) return { label: "Siguiente parada", tone: "rider-priority-next" };
  if (status.includes("recibido")) return { label: "Listo para entregar", tone: "rider-priority-soon" };
  return { label: "Pendiente de atender", tone: "rider-priority-base" };
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
  const status = String(order?.status || "").toLowerCase();
  if (["entregado", "cancelado"].some((value) => status.includes(value))) return false;

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

  Array.from(scope.querySelectorAll("[data-zone-filter]")).forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      const zone = event.currentTarget?.dataset?.zoneFilter;
      if (!zone) return;
      saveGestorZoneFilter(zone);
      renderGestorHome();
    });

    node.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      const zone = event.currentTarget?.dataset?.zoneFilter;
      if (!zone) return;
      saveGestorZoneFilter(zone);
      renderGestorHome();
    });
  });

  Array.from(scope.querySelectorAll("[data-zone-clear]")).forEach((node) => {
    node.addEventListener("click", () => {
      saveGestorZoneFilter("all");
      renderGestorHome();
    });
  });
}

function renderHomeLocationStatus() {
  const statusNode = qs("#homeGeoStatus");
  const metaNode = qs("#homeGeoMeta");
  const coordsNode = qs("#homeGeoCoords");
  const zoneNode = qs("#homeGeoZone");
  const openLink = qs("#homeGeoOpenLink");
  if (!statusNode || !metaNode || !coordsNode || !zoneNode || !openLink) return;

  if (!homeLocation) {
    statusNode.textContent = "Sin ubicacion capturada";
    statusNode.className = "geo-status";
    metaNode.textContent = "Comparte tu GPS para fijar el punto exacto de recogida y sugerir la zona mas cercana.";
    coordsNode.textContent = "Aun no hay coordenadas registradas en este pedido.";
    zoneNode.textContent = "Zona manual";
    zoneNode.className = "estimate-tag estimate-tag-muted";
    openLink.removeAttribute("href");
    openLink.setAttribute("aria-disabled", "true");
    openLink.classList.add("btn-disabled");
    updateOrderEstimatePreview();
    return;
  }

  statusNode.textContent = "Ubicacion capturada";
  statusNode.className = "geo-status geo-status-success";
  metaNode.textContent = `${formatAccuracyMeters(homeLocation.accuracy)} | Fuente: GPS del navegador`;
  coordsNode.textContent = formatCoordinatePair(homeLocation);
  zoneNode.textContent = `Zona sugerida: ${homeLocation.inferredZone || "Distrito Nacional"}`;
  zoneNode.className = "estimate-tag";
  openLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${homeLocation.lat},${homeLocation.lng}`)}`;
  openLink.removeAttribute("aria-disabled");
  openLink.classList.remove("btn-disabled");
  updateOrderEstimatePreview();
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
  const active = orders.filter((order) => !["entregado", "cancelado"].some((value) => String(order.status || "").toLowerCase().includes(value)));
  const done = orders.filter((order) => ["entregado", "cancelado"].some((value) => String(order.status || "").toLowerCase().includes(value)));

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
    done: orderedDone,
    gpsCount: withGps.length,
    noGpsCount: withoutGps.length,
  };
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
}

function updateDashboardHero() {
  if (!currentUser) return;

  const badge = qs("#homeContextBadge");
  const today = new Date().toISOString().slice(0, 10);
  const clientOrders = ordersCache.filter((o) => o.userId === currentUser.id);
  const localToday = localOrdersCache.filter((o) => o.date === today);

  if (currentUser.role === "cliente") {
    const active = clientOrders.filter((o) => !["entregado", "cancelado"].includes(o.status));
    const delivered = clientOrders.filter((o) => String(o.status).toLowerCase().includes("entregado"));
    setHeroStat(1, "Pedidos", String(clientOrders.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Entregados", String(delivered.length));
    if (badge) badge.textContent = "Servicio a domicilio";
    return;
  }

  if (currentUser.role === "gestor") {
    const pending = ordersCache.filter((o) => o.channel !== "local" && o.status === "pendiente");
    const active = ordersCache.filter((o) => o.channel !== "local" && !["entregado", "cancelado"].includes(o.status));
    setHeroStat(1, "Pendientes", String(pending.length));
    setHeroStat(2, "Activos", String(active.length));
    setHeroStat(3, "Rutas", String(repartidoresCache.length));
    if (badge) badge.textContent = "Panel de operaciones";
    return;
  }

  if (currentUser.role === "repartidor") {
    const assigned = ordersCache.filter((o) => Number(o.repartidorId) === Number(currentUser.id));
    const todayCount = assigned.filter((o) => o.date === today);
    const delivered = assigned.filter((o) => String(o.status).toLowerCase().includes("entregado"));
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
  if (!welcomeBlock || !welcomeText || !roleBadge) return;

  let main = welcomeBlock.querySelector(".welcome-main");
  let side = welcomeBlock.querySelector(".welcome-side");

  if (!main || !side) {
    const roleLabel = qs("#roleLabel");

    main = document.createElement("div");
    main.className = "welcome-main";
    main.innerHTML = `<div class="card-eyebrow">Centro de control</div>`;
    main.appendChild(welcomeText);

    const tags = document.createElement("div");
    tags.className = "welcome-tags";
    main.appendChild(tags);

    side = document.createElement("div");
    side.className = "welcome-side";

    roleBadge.textContent = "Rol activo ";
    if (roleLabel) roleBadge.appendChild(roleLabel);
    side.appendChild(roleBadge);

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
      "Selecciona varios paquetes si lo necesitas y define si el cobro sera por libra, por prendas o mixto.";
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
  const homeExtrasLabel = qs(".chip-group")?.closest(".field-group")?.querySelector("label");
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

  const extras = Array.from(qs("#quickOrderForm").querySelectorAll(".chip input:checked")).map((i) => i.value);
  const packs = getSelectedPacks();
  const pricingMode = qs("#homePricingMode")?.value || "por_libra";
  const selectedGarments = collectSelectedGarments();
  const lbs = getHomeEstimatedLbs();

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
    await loadAll();
  } catch (err) {
    showError(err.message || "Error creando pedido");
  }
}

function renderGestorHome() {
  const today = new Date().toISOString().slice(0, 10);
  const nonLocal = ordersCache.filter((o) => o.channel !== "local");
  const pendientes = sortByNewestId(nonLocal.filter((o) => o.status === "pendiente"));
  const enProceso = sortByNewestId(nonLocal.filter((o) => !["pendiente", "entregado", "cancelado"].includes(o.status)));
  const sinAsignar = nonLocal.filter((o) => !o.repartidorId && !["entregado", "cancelado"].includes(o.status));
  const enRuta = nonLocal.filter((o) => ["asignado", "recibido", "en camino"].includes(String(o.status).toLowerCase()));
  const entregadosHoy = nonLocal.filter((o) => o.date === today && String(o.status).toLowerCase().includes("entregado"));
  const zoneList = Array.from(new Set([...Object.keys(ZONE_CENTERS), ...nonLocal.map((o) => String(o.zone || "").trim()).filter(Boolean), ...repartidoresCache.map((r) => String(r.zone || "").trim()).filter(Boolean)]));
  const getOrderUrgencyScore = (order) => {
    const flags = getOrderHighlightFlags(order);
    const status = String(order.status || "").toLowerCase();
    let score = 0;
    if (flags.delayed) score += 10;
    if (flags.noGps) score += 4;
    if (!order.repartidorId) score += 3;
    if (status === "pendiente") score += 2;
    if (status === "en camino") score += 1;
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
    const summaryRow = qs("#gestorHomePanel .role-summary-row");
    summaryRow?.insertAdjacentElement("afterend", executiveCard);
  }

  const priorityOrders = [...nonLocal]
    .filter((o) => !["entregado", "cancelado"].includes(String(o.status).toLowerCase()))
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
      return (String(o.zone || "").trim() || "Distrito Nacional") === zone && !["entregado", "cancelado"].includes(status);
    });
    const gpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).hasGps).length;
    const noGpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).noGps).length;
    const delayedCount = activeOrders.filter((o) => getOrderHighlightFlags(o).delayed).length;
    const routeCount = activeOrders.filter((o) => ["asignado", "recibido", "en camino"].includes(String(o.status || "").toLowerCase())).length;
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
  const status = String(order?.status || "").toLowerCase();
  let score = 0;
  if (flags.delayed) score += 10;
  if (flags.noGps) score += 4;
  if (!order?.repartidorId) score += 3;
  if (status === "pendiente") score += 2;
  if (status === "en camino") score += 1;
  return score;
}

function renderGestorHome() {
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
  const pendientes = sortByNewestId(scopedOrders.filter((o) => o.status === "pendiente"));
  const enProceso = sortByNewestId(scopedOrders.filter((o) => !["pendiente", "entregado", "cancelado"].includes(o.status)));
  const sinAsignar = scopedOrders.filter((o) => !o.repartidorId && !["entregado", "cancelado"].includes(o.status));
  const enRuta = scopedOrders.filter((o) => ["asignado", "recibido", "en camino"].includes(String(o.status).toLowerCase()));
  const entregadosHoy = scopedOrders.filter((o) => o.date === today && String(o.status).toLowerCase().includes("entregado"));
  const priorityOrders = [...scopedOrders]
    .filter((o) => !["entregado", "cancelado"].includes(String(o.status).toLowerCase()))
    .sort((a, b) => {
      const scoreDiff = getGestorOrderUrgencyScore(b) - getGestorOrderUrgencyScore(a);
      if (scoreDiff) return scoreDiff;
      return compareByServiceMoment(a, b);
    })
    .slice(0, 3);

  qs("#gestorActiveCount").textContent = String(scopedOrders.length);
  qs("#gestorTodayCount").textContent = String(scopedOrders.filter((o) => o.date === today).length);
  qs("#gestorClientsCount").textContent = String(new Set(scopedOrders.map((o) => o.userId).filter(Boolean)).size);

  renderGestorExecutivePanel({
    activeZoneFilter,
    zoneLabel,
    pendientes,
    sinAsignar,
    enRuta,
    entregadosHoy,
    priorityOrders,
  });
  renderGestorZoneOverviewPanel({
    nonLocal,
    scopedOrders,
    scopedRiders,
    zoneList,
    activeZoneFilter,
    zoneLabel,
  });
  renderGestorRiderCoveragePanel({
    scopedOrders,
    scopedRiders,
    activeZoneFilter,
    zoneLabel,
  });
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
    const summaryRow = qs("#gestorHomePanel .role-summary-row");
    summaryRow?.insertAdjacentElement("afterend", executiveCard);
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
    qs("#gestorExecutiveCard")?.insertAdjacentElement("afterend", geoCard);
  }

  const zoneCards = zoneList
    .map((zone) => {
      const activeOrders = nonLocal.filter((o) => {
        const status = String(o.status || "").toLowerCase();
        return normalizeZoneName(o.zone) === zone && !["entregado", "cancelado"].includes(status);
      });
      const gpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).hasGps).length;
      const noGpsCount = activeOrders.filter((o) => getOrderHighlightFlags(o).noGps).length;
      const delayedCount = activeOrders.filter((o) => getOrderHighlightFlags(o).delayed).length;
      const routeCount = activeOrders.filter((o) => ["asignado", "recibido", "en camino"].includes(String(o.status || "").toLowerCase())).length;
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
      const riderOrders = scopedOrders.filter((order) => Number(order.repartidorId) === Number(rider.id) && !["entregado", "cancelado"].includes(String(order.status || "").toLowerCase()));
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
        ? riderOrders.some((order) => String(order.status || "").toLowerCase().includes("camino"))
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
          <div class="field-group gestor-mobile-field">
            <label>Asignar repartidor</label>
            <select data-assign="${order.id}">
              <option value="">Elegir...</option>
              ${reps.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}${normalizeZoneName(r.zone) === normalizeZoneName(order.zone) ? "" : ` (${escapeHtml(normalizeZoneName(r.zone))})`}</option>`).join("")}
            </select>
          </div>
          <div class="gestor-mobile-actions">
            <button class="btn btn-small" data-factura="${order.id}">Factura</button>
            <button class="btn btn-small btn-outline" data-detalle="${order.id}">Detalle</button>
            <button class="btn btn-primary btn-small" data-save="${order.id}">Asignar</button>
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
        <div class="table-main">${fmtDate(o.date)} ${fmtTime(o.time)}</div>
        <div class="table-sub">${flags.delayed ? "Fuera de hora programada" : "Programacion activa"}</div>
      </td>
      <td>${renderStatusBadge(o.status)}</td>
      <td>
        <select data-assign="${o.id}">
          <option value="">Elegir...</option>
          ${reps.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}${normalizeZoneName(r.zone) === normalizeZoneName(o.zone) ? "" : ` (${escapeHtml(normalizeZoneName(r.zone))})`}</option>`).join("")}
        </select>
      </td>
      <td><button class="btn btn-small" data-factura="${o.id}">Factura</button></td>
      <td><button class="btn btn-small btn-outline" data-detalle="${o.id}">Detalle</button></td>
      <td><button class="btn btn-primary btn-small" data-save="${o.id}">Asignar</button></td>
    `;
    tr.setAttribute("data-assign-scope", o.id);
    tbody.appendChild(tr);
  });

  Array.from(tbody.querySelectorAll("[data-save]")).forEach((btn) => btn.addEventListener("click", gestorAssign));
  Array.from(mobileBoard?.querySelectorAll("[data-save]") || []).forEach((btn) => btn.addEventListener("click", gestorAssign));
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
    const data = await apiPut(`/orders/${orderId}/assign`, { repartidorId: Number(repartidorId) });
    showSuccess(`Pedido asignado a ${data.order?.repartidorName || "repartidor"}.`);
    await loadAll();
  } catch (err) {
    showError(err.message || "Error asignando");
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

function renderRepartidorHome() {
  const assigned = ordersCache.filter((o) => Number(o.repartidorId) === Number(currentUser.id));
  const routePlan = buildRiderRoutePlan(assigned);
  const orderedCards = [...routePlan.active, ...routePlan.done];
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = assigned.filter((o) => o.date === today).length;
  const delivered = assigned.filter((o) => String(o.status).toLowerCase().includes("entregado"));
  const inRoute = assigned.filter((o) => ["asignado", "recibido", "en camino"].includes(String(o.status).toLowerCase()));
  const withNotes = assigned.filter((o) => String(o.notes || "").trim()).length;
  const withGps = assigned.filter((o) => getOrderLocation(o)).length;
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
    <div class="rider-route-hint">
      <div class="detail-section-title">Proxima parada sugerida</div>
      <div class="card-secondary">
        ${
          nextStop
            ? `Parada ${nextStop.stopNumber} | Pedido #${nextStop.order.id} | ${escapeHtml(nextStop.order.userName)} | ${escapeHtml(nextStop.order.zone)} | ${escapeHtml(fmtDate(nextStop.order.date))} ${escapeHtml(fmtTime(nextStop.order.time))} | ${escapeHtml(nextStop.distanceLabel)}`
            : "No hay pedidos activos pendientes en este momento."
        }
      </div>
    </div>
  `;

  boardCard.innerHTML = `
    <div class="card-title">Panel del repartidor</div>
    <div class="card-secondary">Acciones rapidas, prioridad, direccion, notas y cambio de estado desde una vista pensada para movil.</div>
    <div id="repartidorOrdersBoard" class="rider-board"></div>
  `;

  const board = qs("#repartidorOrdersBoard");
  if (!board) return;

  if (!orderedCards.length) {
    board.innerHTML = `<div class="attention-empty">No tienes pedidos asignados en este momento.</div>`;
  } else {
    board.innerHTML = orderedCards
      .map((entry, index) => {
        const order = entry.order;
        const priority = getRiderPriority(order, index);
        const contactPhone = getOrderContactPhone(order);
        const contactDigits = getOrderContactDigits(order);
        const packs = getOrderPacks(order);
        const garments = getNormalizedGarments(order);
        const mapsLink = getOrderMapLink(order);
        const notes = String(order.notes || "").trim();
        const location = getOrderLocation(order);
        const zoneDistance = getOrderDistanceFromZone(order);
        const geoLabel = getGeoStatusLabel(order);
        const isFallbackContact = contactPhone === BUSINESS_PROFILE.phone && (!String(order.phone || "").trim() || String(order.phone || "").trim().toLowerCase() === "x");
        const stopBadge = entry.stopNumber ? `Parada ${entry.stopNumber}` : "Completado";

        return `
          <article class="rider-order-card">
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
                <a class="btn btn-small btn-outline" href="${mapsLink}" target="_blank" rel="noreferrer">Abrir mapa</a>
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
                <div class="detail-label">Telefono</div>
                <div class="detail-value">${escapeHtml(contactPhone)}</div>
                ${isFallbackContact ? `<div class="rider-fallback-note">Numero central configurado para demo.</div>` : ""}
              </div>
              <div>
                <div class="detail-label">Libras</div>
                <input class="rider-lbs-input" type="number" min="0" step="0.1" data-lbs="${order.id}" value="${Number(order.lbs || 0).toFixed(1)}">
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

            <div class="rider-action-row">
              <a class="btn btn-small" href="tel:+${contactDigits}">Llamar</a>
              <a class="btn btn-small btn-outline" href="https://wa.me/${contactDigits}?text=${encodeURIComponent(`Hola, te contactamos por tu pedido #${order.id} de ${BUSINESS_PROFILE.name}.`)}" target="_blank" rel="noreferrer">WhatsApp</a>
              <button class="btn btn-small btn-outline" type="button" data-copy-phone="${order.id}">Copiar telefono</button>
              <button class="btn btn-small" type="button" data-factura="${order.id}">Factura</button>
              <button class="btn btn-small btn-outline" type="button" data-detalle="${order.id}">Detalle</button>
            </div>

            <div class="rider-state-row">
              <button class="btn btn-small" data-state="recibido" data-id="${order.id}" ${!canMoveTo(order.status, "recibido") ? "disabled" : ""}>Recibido</button>
              <button class="btn btn-small" data-state="camino" data-id="${order.id}" ${!canMoveTo(order.status, "en camino") ? "disabled" : ""}>En camino</button>
              <button class="btn btn-primary btn-small" data-state="entregado" data-id="${order.id}" ${!canMoveTo(order.status, "entregado") ? "disabled" : ""}>Entregado</button>
            </div>
          </article>
        `;
      })
      .join("");
  }
  qs("#riderGeoLocateBtn")?.addEventListener("click", captureRiderLocation);
  qs("#riderGeoClearBtn")?.addEventListener("click", clearRiderLocation);
  Array.from(board.querySelectorAll("[data-state]")).forEach((btn) => btn.addEventListener("click", repartidorUpdateStatus));
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

function openInvoice(ev) {
  const trigger = ev?.currentTarget || ev?.target || {};
  const id = trigger.dataset?.factura || trigger.dataset?.detalle || ev;
  const order = getOrderById(id);
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

  qs("#invoiceSubtitle").textContent = `Pedido #${order.id} | ${order.channel || "domicilio"}`;
  qs("#invoiceBrandName").textContent = BUSINESS_PROFILE.name;
  qs("#invoiceBusiness").innerHTML = `
    ${escapeHtml(BUSINESS_PROFILE.tagline)}<br>
    ${escapeHtml(BUSINESS_PROFILE.address)}<br>
    RNC ${escapeHtml(BUSINESS_PROFILE.rnc)} | ${escapeHtml(BUSINESS_PROFILE.phone)} | ${escapeHtml(BUSINESS_PROFILE.email)}
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
    `${BUSINESS_PROFILE.legalName} | RNC ${BUSINESS_PROFILE.rnc} | ${BUSINESS_PROFILE.phone} | ${BUSINESS_PROFILE.email}`;

  show(qs("#invoicePrintBtn"));
  qs("#invoiceModal").style.display = "flex";
  qs("#invoicePrintArea").scrollTop = 0;
  qs("#invoiceModal .invoice-body")?.scrollTo(0, 0);
}

function openDetail(ev) {
  const trigger = ev?.currentTarget || ev?.target || {};
  const id = trigger.dataset?.detalle || trigger.dataset?.factura || ev;
  const order = getOrderById(id);
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
  const mapsLink = getOrderMapLink(order);
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
        <a class="btn btn-small btn-outline" href="${mapsLink}" target="_blank" rel="noreferrer">Abrir punto en mapa</a>
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
      closeAuthActionPanel();
    }
  });
  qs("#profileForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    showInfo("Guardado en modo demo.");
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  ensureUIEnhancements();
  ensureNoticeStack();
  ensureConfirmDialog();
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

  const handledAuthLink = await handleAuthLinkState();
  if (handledAuthLink) {
    return;
  }

  const savedToken = getStoredToken();
  if (savedToken) {
    try {
      await restoreSessionFromToken();
      hide(qs("#authView"));
      show(qs("#appView"));
      syncSessionChrome();
      await loadAll();
    } catch (_error) {
      clearSession();
      show(qs("#authView"));
      hide(qs("#appView"));
      syncSessionChrome();
    }
  } else {
    show(qs("#authView"));
    hide(qs("#appView"));
    syncSessionChrome();
  }
});
