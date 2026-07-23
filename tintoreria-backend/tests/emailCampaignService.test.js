const test = require("node:test");
const assert = require("node:assert/strict");

const createEmailCampaignService = require("../services/emailCampaignService");

function getPath(target, path) {
  return path.split(".").reduce((value, key) => value?.[key], target);
}

function setPath(target, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let cursor = target;

  for (const part of parts) {
    cursor[part] ||= {};
    cursor = cursor[part];
  }

  cursor[last] = value;
}

function createHarness({
  launchSentAt = null,
  reminderSentAt = null,
  referralSentAt = null,
  hasPurchased = false,
  hasCompletedService = false,
} = {}) {
  const user = {
    id: 42,
    name: "Cliente Prueba",
    email: "cliente@example.com",
    role: "cliente",
    emailVerified: true,
    marketingCampaign: {
      capturedAt: new Date("2026-07-01T10:00:00.000Z"),
      unsubscribedAt: null,
      launchSentAt,
      launchClaimedAt: null,
      reminderSentAt,
      reminderClaimedAt: null,
      referralSentAt,
      referralClaimedAt: null,
    },
  };
  const deliveries = [];

  const User = {
    async findOne() {
      return user;
    },
    async findOneAndUpdate(query, update) {
      const sentPath = Object.keys(query).find((key) => key.endsWith("SentAt"));
      if (sentPath && getPath(user, sentPath)) return null;

      Object.entries(update.$set || {}).forEach(([path, value]) => {
        setPath(user, path, value);
      });
      return user;
    },
    async updateOne(_query, update) {
      Object.entries(update.$set || {}).forEach(([path, value]) => {
        setPath(user, path, value);
      });
      return { acknowledged: true };
    },
  };

  const Order = {
    async exists(query) {
      if (query.status === "entregado al cliente") return hasCompletedService;
      return hasPurchased;
    },
  };

  const sendEmail = async (message) => {
    deliveries.push(message);
    return {
      ok: true,
      delivered: true,
      mode: "test",
      messageId: `test-${deliveries.length}`,
    };
  };

  const service = createEmailCampaignService({
    User,
    Order,
    sendEmail,
    businessInfo: {
      name: "Menta Laundry",
      phone: "829-448-7876",
      email: "admin@mentalaundry.com",
    },
  });

  return { service, user, deliveries };
}

test.beforeEach(() => {
  process.env.EMAIL_CAMPAIGNS_ENABLED = "true";
  process.env.CAMPAIGN_PROMO_END_DATE = "31 de agosto de 2026";
  process.env.CAMPAIGN_PROMO_CODE = "BIENVENIDO25";
  process.env.CAMPAIGN_WHATSAPP_DIGITS = "18294487876";
  process.env.CAMPAIGN_REMINDER_DELAY_DAYS = "6";
});

test.after(() => {
  [
    "EMAIL_CAMPAIGNS_ENABLED",
    "CAMPAIGN_PROMO_END_DATE",
    "CAMPAIGN_PROMO_CODE",
    "CAMPAIGN_WHATSAPP_DIGITS",
    "CAMPAIGN_REMINDER_DELAY_DAYS",
  ].forEach((key) => delete process.env[key]);
});

test("envía el correo de lanzamiento una sola vez", async () => {
  const { service, user, deliveries } = createHarness();

  const first = await service.processUser(user.id, "launch");
  const second = await service.processUser(user.id, "launch");

  assert.equal(first[0].sent, true);
  assert.equal(second[0].sent, false);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].subject, /25% de descuento/);
  assert.match(deliveries[0].text, /BIENVENIDO25/);
  assert.ok(user.marketingCampaign.launchSentAt instanceof Date);
});

test("no envía recordatorio cuando el cliente ya creó un pedido", async () => {
  const { service, user, deliveries } = createHarness({
    launchSentAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    hasPurchased: true,
  });

  const result = await service.processUser(user.id, "reminder");

  assert.equal(result[0].sent, false);
  assert.equal(result[0].reason, "already_purchased");
  assert.equal(deliveries.length, 0);
});

test("envía recordatorio después de seis días cuando no hay pedidos", async () => {
  const { service, user, deliveries } = createHarness({
    launchSentAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    hasPurchased: false,
  });

  const result = await service.processUser(user.id, "reminder");

  assert.equal(result[0].sent, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].subject, /sigue disponible/);
  assert.match(deliveries[0].text, /Delivery gratis desde RD\$1,500/);
  assert.ok(user.marketingCampaign.reminderSentAt instanceof Date);
});

test("envía referidos después de completar el primer servicio", async () => {
  const { service, user, deliveries } = createHarness({
    launchSentAt: new Date("2026-07-01T10:00:00.000Z"),
    hasCompletedService: true,
  });

  const result = await service.processUser(user.id, "referral");

  assert.equal(result[0].sent, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].text, /MENTA-0042/);
  assert.match(deliveries[0].text, /RD\$300/);
  assert.ok(user.marketingCampaign.referralSentAt instanceof Date);
});
