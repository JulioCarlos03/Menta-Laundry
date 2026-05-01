const mongoose = require("mongoose");

const readReceiptSchema = new mongoose.Schema(
  {
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    readAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const notificationSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    recipientRole: {
      type: String,
      required: true,
      enum: ["cliente", "gestor", "repartidor", "cajera"],
      index: true,
    },
    recipientUserId: {
      type: Number,
      default: null,
      index: true,
    },
    orderId: {
      type: Number,
      default: null,
      index: true,
    },
    orderChannel: {
      type: String,
      default: "domicilio",
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    copy: {
      type: String,
      required: true,
      trim: true,
    },
    meta: {
      type: String,
      default: "",
      trim: true,
    },
    tone: {
      type: String,
      default: "info",
      enum: ["info", "success", "warning", "danger"],
      trim: true,
    },
    screen: {
      type: String,
      default: "screenHome",
      trim: true,
    },
    actionLabel: {
      type: String,
      default: "Abrir",
      trim: true,
    },
    priority: {
      type: Number,
      default: 50,
      index: true,
    },
    readReceipts: {
      type: [readReceiptSchema],
      default: [],
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    versionKey: false,
  }
);

notificationSchema.index({ recipientRole: 1, recipientUserId: 1, createdAt: -1 });
notificationSchema.index({ orderId: 1, recipientRole: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
