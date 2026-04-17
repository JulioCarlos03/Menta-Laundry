const mongoose = require("mongoose");

const garmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false }
);

const locationSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: null },
    source: { type: String, default: "browser", trim: true },
    inferredZone: { type: String, default: null, trim: true },
    capturedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    status: { type: String, required: true, trim: true },
    by: { type: String, required: true, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Number,
      default: null,
      index: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
    },
    userEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      default: "",
      trim: true,
    },
    zone: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    serviceType: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: String,
      required: true,
      trim: true,
    },
    time: {
      type: String,
      required: true,
      trim: true,
    },
    pack: {
      type: String,
      required: true,
      trim: true,
    },
    packs: {
      type: [String],
      default: [],
    },
    pricingMode: {
      type: String,
      default: "por_libra",
      trim: true,
    },
    selectedGarments: {
      type: [garmentSchema],
      default: [],
    },
    location: {
      type: locationSchema,
      default: null,
    },
    extras: {
      type: [String],
      default: [],
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      required: true,
      trim: true,
    },
    repartidorId: {
      type: Number,
      default: null,
      index: true,
    },
    repartidorName: {
      type: String,
      default: null,
      trim: true,
    },
    lbs: {
      type: Number,
      default: 0,
      min: 0,
    },
    channel: {
      type: String,
      required: true,
      enum: ["domicilio", "local"],
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  {
    versionKey: false,
  }
);

module.exports = mongoose.model("Order", orderSchema);
