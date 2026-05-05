const mongoose = require("mongoose");

const cashCloseSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    orderCount: {
      type: Number,
      default: 0,
    },
    paidOrderCount: {
      type: Number,
      default: 0,
    },
    partialOrderCount: {
      type: Number,
      default: 0,
    },
    pendingOrderCount: {
      type: Number,
      default: 0,
    },
    expectedTotal: {
      type: Number,
      default: 0,
    },
    paidTotal: {
      type: Number,
      default: 0,
    },
    pendingTotal: {
      type: Number,
      default: 0,
    },
    byMethod: {
      type: Map,
      of: Number,
      default: {},
    },
    orderIds: {
      type: [Number],
      default: [],
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    createdByUserId: {
      type: Number,
      default: null,
    },
    createdByName: {
      type: String,
      default: "",
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
);

module.exports = mongoose.model("CashClose", cashCloseSchema);
