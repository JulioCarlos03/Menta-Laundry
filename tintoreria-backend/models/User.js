const mongoose = require("mongoose");

const marketingCampaignSchema = new mongoose.Schema(
  {
    capturedAt: {
      type: Date,
      default: null,
      index: true,
    },
    unsubscribedAt: {
      type: Date,
      default: null,
      index: true,
    },
    launchSentAt: {
      type: Date,
      default: null,
    },
    launchClaimedAt: {
      type: Date,
      default: null,
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
    reminderClaimedAt: {
      type: Date,
      default: null,
    },
    referralSentAt: {
      type: Date,
      default: null,
    },
    referralClaimedAt: {
      type: Date,
      default: null,
    },
    lastAttemptAt: {
      type: Date,
      default: null,
    },
    lastEvent: {
      type: String,
      default: "",
      trim: true,
    },
    lastMessageId: {
      type: String,
      default: "",
      trim: true,
    },
    lastError: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      required: true,
      enum: ["cliente", "gestor", "repartidor", "cajera"],
    },
    emailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
    emailVerificationToken: {
      type: String,
      default: null,
    },
    emailVerificationExpiresAt: {
      type: Date,
      default: null,
    },
    passwordResetToken: {
      type: String,
      default: null,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
    },
    zone: {
      type: String,
      default: null,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    marketingCampaign: {
      type: marketingCampaignSchema,
      default: () => ({}),
    },
  },
  {
    versionKey: false,
  }
);

module.exports = mongoose.model("User", userSchema);
