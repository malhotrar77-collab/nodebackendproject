// NodeBackend/models/link.js
const mongoose = require("mongoose");

const linkSchema = new mongoose.Schema(
  {
    // short human id, e.g. "3db5e0"
    id: { type: String, required: true, unique: true },

    source: { type: String, default: "amazon" },

    title: { type: String },
    category: { type: String },
    note: { type: String },

    originalUrl: { type: String },
    rawOriginalUrl: { type: String },

    affiliateUrl: { type: String },
    tag: { type: String },

    imageUrl: { type: String },
    images: [{ type: String }],

    // pricing
    price: { type: Number, default: null },        // latest price
    prevPrice: { type: Number, default: null },    // previous price (for "price dropped")
    priceCurrency: { type: String, default: "INR" },

    clicks: { type: Number, default: 0 },

    // health / status
    isActive: { type: Boolean, default: true },    // false = hide from store
    statusReason: { type: String, default: null }, // e.g. "expired", "404", "unavailable"
    lastCheckedAt: { type: Date, default: null },  // last time daily refresh touched it
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

module.exports = mongoose.model("Link", linkSchema);
