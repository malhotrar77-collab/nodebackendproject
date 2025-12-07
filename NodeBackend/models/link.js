// NodeBackend/models/link.js
const mongoose = require("../db");

const linkSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true }, // short human id (e.g. "447a01")
    source: { type: String, default: "amazon" },

    title: { type: String, default: null },
    category: { type: String, default: null },
    note: { type: String, default: null },

    // NEW: short marketing description for storefront cards
    description: { type: String, default: null },

    originalUrl: { type: String, required: true },
    rawOriginalUrl: { type: String, default: null },
    affiliateUrl: { type: String, required: true },
    tag: { type: String, default: null },

    imageUrl: { type: String, default: null }, // main image
    images: { type: [String], default: [] },   // extra images later
    price: { type: String, default: null },

    clicks: { type: Number, default: 0 },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

module.exports = mongoose.model("Link", linkSchema);
