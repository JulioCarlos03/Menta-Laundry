const bcrypt = require("bcryptjs");

const DEMO_USERS = [
  {
    id: 1,
    name: "Admin Gestor",
    email: "admin@tintoreria.com",
    password: "admin123",
    role: "gestor",
  },
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
  {
    id: 900,
    name: "Cajera Local",
    email: "cajera@tintoreria.com",
    password: "cajera123",
    role: "cajera",
  },
  {
    id: 10,
    name: "Cliente Menta",
    email: "cliente@demo.com",
    password: "cliente123",
    role: "cliente",
  },
];

function buildDemoOrder() {
  const now = new Date();
  const pickup = new Date(now.getTime() + 60 * 60 * 1000);
  const date = pickup.toISOString().slice(0, 10);
  const time = pickup.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return {
    id: 1,
    userId: 10,
    userName: "Cliente Menta",
    userEmail: "cliente@demo.com",
    phone: "829-448-7876",
    zone: "Distrito Nacional",
    address: "Av. 27 de Febrero 135",
    serviceType: "Recogida a domicilio",
    date,
    time,
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
      capturedAt: now,
    },
    extras: ["Quitar manchas dificiles"],
    notes: "Llamar al llegar",
    status: "pendiente",
    repartidorId: null,
    repartidorName: null,
    lbs: 0,
    channel: "domicilio",
    createdAt: now,
    history: [{ status: "pendiente", by: "cliente", at: now }],
  };
}

async function seedDemoData({ User, Order }) {
  const usersCount = await User.countDocuments();
  if (usersCount === 0) {
    const users = await Promise.all(
      DEMO_USERS.map(async (user) => ({
        ...user,
        email: user.email.toLowerCase(),
        password: await bcrypt.hash(user.password, 10),
        emailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
      }))
    );
    await User.insertMany(users);
    console.log("Usuarios iniciales sembrados.");
  }

  await User.updateMany(
    { name: "Cliente Demo" },
    { $set: { name: "Cliente Menta" } }
  );

  await User.updateMany(
    { emailVerified: { $exists: false } },
    {
      $set: {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
      },
    }
  );

  const ordersCount = await Order.countDocuments();
  if (ordersCount === 0) {
    await Order.create(buildDemoOrder());
    console.log("Pedido inicial sembrado.");
  }

  await Order.updateMany(
    { userName: "Cliente Demo" },
    { $set: { userName: "Cliente Menta" } }
  );
  await Order.updateMany(
    { address: "Av. Demo #123" },
    { $set: { address: "Av. 27 de Febrero 135" } }
  );
}

module.exports = seedDemoData;
