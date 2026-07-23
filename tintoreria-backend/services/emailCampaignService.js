const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 40;

const EVENT_FIELDS = {
  launch: {
    sent: "marketingCampaign.launchSentAt",
    claimed: "marketingCampaign.launchClaimedAt",
  },
  reminder: {
    sent: "marketingCampaign.reminderSentAt",
    claimed: "marketingCampaign.reminderClaimedAt",
  },
  referral: {
    sent: "marketingCampaign.referralSentAt",
    claimed: "marketingCampaign.referralClaimedAt",
  },
};

function readEnv(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function readPositiveNumber(name, fallback) {
  const value = Number(readEnv(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getFirstName(name) {
  return String(name || "Cliente").trim().split(/\s+/)[0] || "Cliente";
}

function getReferralCode(user) {
  return `MENTA-${String(user?.id || "").padStart(4, "0")}`;
}

function getWhatsAppDigits(businessInfo) {
  const configured = readEnv("CAMPAIGN_WHATSAPP_DIGITS");
  if (configured) return configured.replace(/\D/g, "");

  const digits = String(businessInfo?.phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

function buildWhatsAppUrl(businessInfo, message) {
  const digits = getWhatsAppDigits(businessInfo);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

function buildOptOutUrl(businessInfo) {
  const email = readEnv("EMAIL_REPLY_TO", businessInfo?.email || "");
  const subject = encodeURIComponent("Cancelar promociones");
  const body = encodeURIComponent("Cancelar");
  return `mailto:${email}?subject=${subject}&body=${body}`;
}

function buildCampaignShell({
  businessInfo,
  eyebrow,
  title,
  greeting,
  bodyHtml,
  actionUrl,
  actionLabel,
  conditions,
  footerTagline = "Tu ropa limpia, cuidada y lista para usar.",
}) {
  const optOutUrl = buildOptOutUrl(businessInfo);
  const safeBusinessName = escapeHtml(businessInfo.name);

  return `
    <div style="margin:0;background:#eef8f5;padding:28px 16px;font-family:Segoe UI,Arial,sans-serif;color:#173442;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #cfe9df;border-radius:18px;overflow:hidden;">
        <div style="height:8px;background:#82cdb0;"></div>
        <div style="padding:30px;">
          <div style="font-size:12px;font-weight:800;text-transform:uppercase;color:#26765d;">${escapeHtml(eyebrow)}</div>
          <h1 style="margin:12px 0 16px;font-size:30px;line-height:1.18;color:#173442;">${escapeHtml(title)}</h1>
          <p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#55707b;">${escapeHtml(greeting)}</p>
          ${bodyHtml}
          <a href="${escapeHtml(actionUrl)}" style="display:inline-block;margin-top:22px;padding:14px 20px;background:#2f82b2;color:#ffffff;text-decoration:none;font-weight:800;border-radius:8px;">
            ${escapeHtml(actionLabel)}
          </a>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b838c;">${escapeHtml(conditions)}</p>
        </div>
        <div style="padding:20px 30px;background:#f5fbf8;border-top:1px solid #d8eee7;">
          <strong style="display:block;color:#173442;">${safeBusinessName}</strong>
          <span style="display:block;margin-top:4px;font-size:13px;color:#55707b;">${escapeHtml(footerTagline)}</span>
          <p style="margin:16px 0 0;font-size:12px;line-height:1.55;color:#718992;">
            Si prefieres no recibir nuestras promociones, responde a este correo con la palabra “Cancelar” o
            <a href="${escapeHtml(optOutUrl)}" style="color:#26765d;">solicita la cancelación aquí</a>.
          </p>
        </div>
      </div>
    </div>
  `;
}

function buildLaunchEmail(user, config, businessInfo) {
  const actionUrl = buildWhatsAppUrl(
    businessInfo,
    `Hola, quiero aprovechar el 25% de descuento con el código ${config.promoCode}.`
  );
  const title = "¡Llegó una nueva forma de cuidar tu ropa!";

  return {
    subject: `25% de descuento en tu primer pedido | ${businessInfo.name}`,
    html: buildCampaignShell({
      businessInfo,
      eyebrow: "Lanzamiento",
      title,
      greeting: `Hola ${getFirstName(user.name)}, en ${businessInfo.name} nos encargamos del lavado, planchado y cuidado de tus prendas para que tengas más tiempo para ti.`,
      bodyHtml: `
        <div style="padding:20px;border:1px solid #bfe4d6;background:#f4fbf8;border-radius:10px;">
          <div style="font-size:21px;font-weight:900;color:#173442;">25% de descuento en tu primer pedido</div>
          <div style="margin-top:8px;font-size:17px;font-weight:800;color:#26765d;">Delivery gratis en órdenes desde RD$1,500</div>
          <div style="margin-top:16px;font-size:14px;color:#55707b;">Utiliza el código</div>
          <div style="margin-top:5px;font-size:24px;font-weight:900;color:#2f82b2;">${escapeHtml(config.promoCode)}</div>
        </div>
        <p style="margin:20px 0 0;font-size:16px;line-height:1.65;color:#55707b;">
          Puedes enviar ropa de uso diario, prendas delicadas, trajes, edredones y mucho más.
        </p>
        <p style="margin:14px 0 0;font-size:16px;line-height:1.65;color:#55707b;">
          Haz tu pedido por WhatsApp: <strong style="color:#173442;">${escapeHtml(businessInfo.phone)}</strong>
        </p>
      `,
      actionUrl,
      actionLabel: "Solicitar mi primer servicio",
      conditions: `Promoción válida hasta el ${config.promoEndDate}, exclusivamente para clientes nuevos. Descuento máximo de RD$750. No acumulable con otras promociones.`,
    }),
    text: [
      title,
      "",
      `Hola ${getFirstName(user.name)}, en ${businessInfo.name} nos encargamos del lavado, planchado y cuidado de tus prendas para que tengas más tiempo para ti.`,
      "",
      "25% de descuento en tu primer pedido",
      "Delivery gratis en órdenes desde RD$1,500",
      "",
      `Utiliza el código ${config.promoCode} al realizar tu pedido.`,
      "",
      "Puedes enviar ropa de uso diario, prendas delicadas, trajes, edredones y mucho más.",
      "",
      `Haz tu pedido por WhatsApp: ${businessInfo.phone}`,
      actionUrl,
      "",
      `La promoción es válida hasta el ${config.promoEndDate}, exclusivamente para clientes nuevos. Descuento máximo de RD$750. No acumulable con otras promociones.`,
      "",
      businessInfo.name,
      "Tu ropa limpia, cuidada y lista para usar.",
      "",
      "Si prefieres no recibir nuestras promociones, responde a este correo con la palabra “Cancelar”.",
    ].join("\n"),
  };
}

function buildReminderEmail(user, config, businessInfo) {
  const actionUrl = buildWhatsAppUrl(
    businessInfo,
    `Hola, quiero usar mi descuento de lanzamiento con el código ${config.promoCode}.`
  );
  const title = "¿Todavía tienes ropa pendiente de lavar o planchar?";

  return {
    subject: `Tu 25% de descuento sigue disponible | ${businessInfo.name}`,
    html: buildCampaignShell({
      businessInfo,
      eyebrow: "Tu beneficio sigue activo",
      title,
      greeting: `Hola ${getFirstName(user.name)}, aprovecha nuestra promoción de lanzamiento antes de que termine.`,
      bodyHtml: `
        <div style="padding:20px;border-left:5px solid #82cdb0;background:#f4fbf8;">
          <div style="font-size:21px;font-weight:900;color:#173442;">25% de descuento en tu primer pedido</div>
          <div style="margin-top:8px;font-size:17px;font-weight:800;color:#26765d;">Delivery gratis desde RD$1,500</div>
          <div style="margin-top:16px;color:#55707b;">Solo utiliza el código <strong style="color:#2f82b2;">${escapeHtml(config.promoCode)}</strong>.</div>
        </div>
        <p style="margin:20px 0 0;font-size:16px;line-height:1.65;color:#55707b;">
          Nosotros recogemos tus prendas, las cuidamos y te las entregamos limpias y listas para usar.
        </p>
        <p style="margin:14px 0 0;font-size:16px;line-height:1.65;color:#55707b;">
          Solicita tu servicio por WhatsApp: <strong style="color:#173442;">${escapeHtml(businessInfo.phone)}</strong>
        </p>
      `,
      actionUrl,
      actionLabel: "Aprovechar mi descuento",
      conditions: `Tu descuento estará disponible hasta el ${config.promoEndDate}. Aplica exclusivamente para clientes nuevos, con un descuento máximo de RD$750.`,
      footerTagline: "Más comodidad. Menos ropa acumulada.",
    }),
    text: [
      title,
      "",
      `Hola ${getFirstName(user.name)}, aprovecha nuestra promoción de lanzamiento antes de que termine:`,
      "",
      "25% de descuento en tu primer pedido",
      "Delivery gratis desde RD$1,500",
      "",
      `Solo utiliza el código ${config.promoCode}.`,
      "",
      "Nosotros recogemos tus prendas, las cuidamos y te las entregamos limpias y listas para usar.",
      "",
      `Solicita tu servicio por WhatsApp: ${businessInfo.phone}`,
      actionUrl,
      "",
      `Tu descuento estará disponible hasta el ${config.promoEndDate}. Aplica exclusivamente para clientes nuevos, con un descuento máximo de RD$750.`,
      "",
      businessInfo.name,
      "Más comodidad. Menos ropa acumulada.",
      "",
      "Si prefieres no recibir nuestras promociones, responde a este correo con la palabra “Cancelar”.",
    ].join("\n"),
  };
}

function buildReferralEmail(user, config, businessInfo) {
  const referralCode = getReferralCode(user);
  const actionUrl = buildWhatsAppUrl(
    businessInfo,
    `Hola, quiero agendar mi próximo servicio. Mi código de referido es ${referralCode}.`
  );
  const title = `¡Gracias por confiar en ${businessInfo.name}!`;

  return {
    subject: `Comparte ${businessInfo.name} y ambos reciben RD$300`,
    html: buildCampaignShell({
      businessInfo,
      eyebrow: "Referidos y recompra",
      title,
      greeting: `Hola ${getFirstName(user.name)}, queremos premiarte por compartir nuestro servicio.`,
      bodyHtml: `
        <div style="padding:20px;border:1px solid #bfe4d6;background:#f4fbf8;border-radius:10px;">
          <div style="font-size:21px;font-weight:900;color:#173442;">Refiere a un amigo y ambos reciben RD$300 de descuento</div>
          <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#55707b;">
            Tu amigo recibirá RD$300 en su primer pedido y tú recibirás RD$300 para utilizar en tu próximo servicio, una vez que complete su primera orden.
          </p>
          <div style="margin-top:16px;font-size:13px;color:#55707b;">Comparte tu código personal</div>
          <div style="margin-top:5px;font-size:24px;font-weight:900;color:#2f82b2;">${escapeHtml(referralCode)}</div>
        </div>
        <div style="margin-top:18px;padding:18px;background:#fff8e8;border-left:5px solid #e1b84a;">
          <strong style="display:block;font-size:17px;color:#173442;">Beneficio adicional</strong>
          <span style="display:block;margin-top:7px;line-height:1.6;color:#55707b;">Realiza tres pedidos durante el mes y recibe RD$500 de crédito para el siguiente.</span>
        </div>
        <p style="margin:18px 0 0;font-size:16px;line-height:1.65;color:#55707b;">
          Agenda tu próxima recogida por WhatsApp: <strong style="color:#173442;">${escapeHtml(businessInfo.phone)}</strong>
        </p>
      `,
      actionUrl,
      actionLabel: "Agendar próxima recogida",
      conditions: "Aplican condiciones. Los descuentos no son canjeables por efectivo ni acumulables con otras promociones.",
      footerTagline: "Cuidamos tu ropa y premiamos tu confianza.",
    }),
    text: [
      title,
      "",
      `Hola ${getFirstName(user.name)}, queremos premiarte por compartir nuestro servicio.`,
      "",
      "Refiere a un amigo y ambos reciben RD$300 de descuento.",
      "",
      "Tu amigo recibirá RD$300 en su primer pedido y tú recibirás RD$300 para utilizar en tu próximo servicio, una vez que complete su primera orden.",
      "",
      `Código personal: ${referralCode}`,
      "",
      "Además, realiza tres pedidos durante el mes y recibe RD$500 de crédito para el siguiente.",
      "",
      `Agenda tu próxima recogida por WhatsApp: ${businessInfo.phone}`,
      actionUrl,
      "",
      "Aplican condiciones. Los descuentos no son canjeables por efectivo ni acumulables con otras promociones.",
      "",
      businessInfo.name,
      "Cuidamos tu ropa y premiamos tu confianza.",
      "",
      "Si prefieres no recibir nuestras promociones, responde a este correo con la palabra “Cancelar”.",
    ].join("\n"),
  };
}

function createEmailCampaignService({ User, Order, sendEmail, businessInfo }) {
  let interval = null;
  let runInFlight = null;

  function getConfig() {
    const enabled = readEnv("EMAIL_CAMPAIGNS_ENABLED", "false").toLowerCase() === "true";
    const promoEndDate = readEnv("CAMPAIGN_PROMO_END_DATE");

    return {
      enabled,
      ready: enabled && Boolean(promoEndDate),
      promoEndDate,
      promoCode: readEnv("CAMPAIGN_PROMO_CODE", "BIENVENIDO25"),
      reminderDelayDays: readPositiveNumber("CAMPAIGN_REMINDER_DELAY_DAYS", 6),
      scanIntervalMinutes: readPositiveNumber("CAMPAIGN_SCAN_INTERVAL_MINUTES", 60),
      batchSize: Math.floor(readPositiveNumber("CAMPAIGN_BATCH_SIZE", DEFAULT_BATCH_SIZE)),
    };
  }

  function getStatus() {
    const config = getConfig();
    return {
      enabled: config.enabled,
      ready: config.ready,
      promoEndDate: config.promoEndDate || null,
      promoCode: config.promoCode,
      reminderDelayDays: config.reminderDelayDays,
      scanIntervalMinutes: config.scanIntervalMinutes,
    };
  }

  async function releaseClaim(userId, event, error = "") {
    const fields = EVENT_FIELDS[event];
    await User.updateOne(
      { id: Number(userId) },
      {
        $set: {
          [fields.claimed]: null,
          "marketingCampaign.lastEvent": event,
          "marketingCampaign.lastError": String(error || "").slice(0, 240),
        },
      }
    );
  }

  async function claimEvent(userId, event) {
    const fields = EVENT_FIELDS[event];
    const now = new Date();
    const staleClaim = new Date(now.getTime() - CLAIM_TTL_MS);

    return User.findOneAndUpdate(
      {
        id: Number(userId),
        role: "cliente",
        emailVerified: true,
        "marketingCampaign.capturedAt": { $ne: null },
        "marketingCampaign.unsubscribedAt": null,
        [fields.sent]: null,
        $or: [
          { [fields.claimed]: null },
          { [fields.claimed]: { $lt: staleClaim } },
        ],
      },
      {
        $set: {
          [fields.claimed]: now,
          "marketingCampaign.lastAttemptAt": now,
          "marketingCampaign.lastEvent": event,
          "marketingCampaign.lastError": "",
        },
      },
      { new: true }
    );
  }

  async function hasPurchased(userId) {
    return Boolean(await Order.exists({
      userId: Number(userId),
      status: { $ne: "cancelado" },
    }));
  }

  async function hasCompletedFirstService(userId) {
    return Boolean(await Order.exists({
      userId: Number(userId),
      status: "entregado al cliente",
    }));
  }

  function buildEmail(event, user, config) {
    if (event === "launch") return buildLaunchEmail(user, config, businessInfo);
    if (event === "reminder") return buildReminderEmail(user, config, businessInfo);
    if (event === "referral") return buildReferralEmail(user, config, businessInfo);
    throw new Error(`Evento de campaña desconocido: ${event}`);
  }

  async function sendEvent(userId, event) {
    const config = getConfig();
    if (!config.ready || !EVENT_FIELDS[event]) {
      return { event, sent: false, reason: config.ready ? "invalid_event" : "campaign_not_ready" };
    }

    const user = await User.findOne({
      id: Number(userId),
      role: "cliente",
      emailVerified: true,
      "marketingCampaign.capturedAt": { $ne: null },
      "marketingCampaign.unsubscribedAt": null,
    });
    if (!user) return { event, sent: false, reason: "not_eligible" };

    if (event === "reminder") {
      const launchSentAt = user.marketingCampaign?.launchSentAt;
      const reminderReadyAt = launchSentAt
        ? new Date(launchSentAt).getTime() + config.reminderDelayDays * DAY_MS
        : Number.POSITIVE_INFINITY;
      if (Date.now() < reminderReadyAt) {
        return { event, sent: false, reason: "too_early" };
      }
      if (await hasPurchased(user.id)) {
        return { event, sent: false, reason: "already_purchased" };
      }
    }

    if (event === "referral" && !(await hasCompletedFirstService(user.id))) {
      return { event, sent: false, reason: "first_service_not_completed" };
    }

    const claimedUser = await claimEvent(user.id, event);
    if (!claimedUser) return { event, sent: false, reason: "already_sent_or_claimed" };

    try {
      if (event === "reminder" && await hasPurchased(claimedUser.id)) {
        await releaseClaim(claimedUser.id, event);
        return { event, sent: false, reason: "already_purchased" };
      }

      const email = buildEmail(event, claimedUser, config);
      const delivery = await sendEmail({
        to: claimedUser.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      const fields = EVENT_FIELDS[event];
      const sentAt = new Date();

      await User.updateOne(
        { id: Number(claimedUser.id) },
        {
          $set: {
            [fields.sent]: sentAt,
            [fields.claimed]: null,
            "marketingCampaign.lastEvent": event,
            "marketingCampaign.lastMessageId": delivery?.messageId || "",
            "marketingCampaign.lastError": "",
          },
        }
      );

      console.log(`Campaña ${event} enviada a ${claimedUser.email}.`);
      return { event, sent: true, mode: delivery?.mode || "", messageId: delivery?.messageId || null };
    } catch (error) {
      await releaseClaim(claimedUser.id, event, error?.message || "campaign_delivery_failed");
      console.warn(`No se pudo enviar campaña ${event} a ${claimedUser.email}:`, error?.message || error);
      return { event, sent: false, reason: "delivery_failed", error: error?.message || String(error) };
    }
  }

  async function processUser(userId, event = null) {
    const events = event ? [event] : ["launch", "reminder", "referral"];
    const results = [];

    for (const item of events) {
      results.push(await sendEvent(userId, item));
    }

    return results;
  }

  async function processBatch() {
    const config = getConfig();
    if (!config.ready) {
      return { skipped: true, reason: config.enabled ? "missing_promo_end_date" : "campaign_disabled" };
    }

    const baseQuery = {
      role: "cliente",
      emailVerified: true,
      "marketingCampaign.capturedAt": { $ne: null },
      "marketingCampaign.unsubscribedAt": null,
    };
    const reminderThreshold = new Date(Date.now() - config.reminderDelayDays * DAY_MS);
    const [purchasedUserIds, completedUserIds] = await Promise.all([
      Order.distinct("userId", {
        userId: { $ne: null },
        status: { $ne: "cancelado" },
      }),
      Order.distinct("userId", {
        userId: { $ne: null },
        status: "entregado al cliente",
      }),
    ]);
    const [launchUsers, reminderUsers, referralUsers] = await Promise.all([
      User.find({
        ...baseQuery,
        "marketingCampaign.launchSentAt": null,
      }).sort({ "marketingCampaign.capturedAt": 1 }).select({ id: 1 }).limit(config.batchSize).lean(),
      User.find({
        ...baseQuery,
        id: { $nin: purchasedUserIds.map(Number) },
        "marketingCampaign.launchSentAt": { $lte: reminderThreshold },
        "marketingCampaign.reminderSentAt": null,
      }).sort({ "marketingCampaign.launchSentAt": 1 }).select({ id: 1 }).limit(config.batchSize).lean(),
      User.find({
        ...baseQuery,
        id: { $in: completedUserIds.map(Number) },
        "marketingCampaign.referralSentAt": null,
      }).sort({ "marketingCampaign.capturedAt": 1 }).select({ id: 1 }).limit(config.batchSize).lean(),
    ]);

    const summary = { launch: 0, reminder: 0, referral: 0 };
    for (const user of launchUsers) {
      const result = await sendEvent(user.id, "launch");
      if (result.sent) summary.launch += 1;
    }
    for (const user of reminderUsers) {
      const result = await sendEvent(user.id, "reminder");
      if (result.sent) summary.reminder += 1;
    }
    for (const user of referralUsers) {
      const result = await sendEvent(user.id, "referral");
      if (result.sent) summary.referral += 1;
    }

    return { skipped: false, ...summary };
  }

  function runNow() {
    if (runInFlight) return runInFlight;

    runInFlight = processBatch()
      .catch((error) => {
        console.error("No se pudo procesar la campaña de email:", error?.message || error);
        return { skipped: true, reason: "unexpected_error" };
      })
      .finally(() => {
        runInFlight = null;
      });

    return runInFlight;
  }

  function queueUser(userId, event = null) {
    if (!getConfig().ready || !Number.isFinite(Number(userId))) return;
    setImmediate(() => {
      processUser(Number(userId), event).catch((error) => {
        console.error(`No se pudo procesar la campaña para usuario ${userId}:`, error?.message || error);
      });
    });
  }

  function startScheduler() {
    const config = getConfig();
    if (!config.ready) {
      console.log(
        config.enabled
          ? "Campañas de email pendientes: configura CAMPAIGN_PROMO_END_DATE."
          : "Campañas de email desactivadas."
      );
      return null;
    }

    const initialRun = setTimeout(() => runNow(), 5000);
    initialRun.unref?.();

    interval = setInterval(
      () => runNow(),
      config.scanIntervalMinutes * 60 * 1000
    );
    interval.unref?.();
    console.log(`Campañas de email activas: revisión cada ${config.scanIntervalMinutes} minutos.`);
    return interval;
  }

  return {
    getStatus,
    processUser,
    queueUser,
    runNow,
    startScheduler,
  };
}

module.exports = createEmailCampaignService;
