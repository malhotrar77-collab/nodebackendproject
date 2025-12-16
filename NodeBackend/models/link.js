// NodeBackend/models/link.js
const mongoose = require("mongoose");

const LinkSchema = new mongoose.Schema(
  {
    /* -------------------------
       Identity & source
    -------------------------- */
    id: { type: String, required: true, unique: true },
    source: { type: String, required: true }, // amazon | admitad (future)

    /* -------------------------
       Core product info
    -------------------------- */
    title: { type: String },
    shortTitle: { type: String },
    brand: { type: String },

    /* -------------------------
       🔒 Controlled categorisation
    -------------------------- */
    category: {
      type: String,
      default: "other", // canonical category key
      index: true,
    },

    subcategory: {
      type: String,
      default: "other", // canonical subcategory key
      index: true,
    },

    tags: {
      type: [String],
      default: [],
      index: true,
    },

    // Raw Amazon breadcrumbs (for audit / fallback only)
    categoryPath: {
      type: [String],
      default: [],
    },

    /* -------------------------
       Descriptions & SEO
    -------------------------- */
    shortDescription: { type: String },
    longDescription: { type: String },
    slug: { type: String, index: true },

    note: { type: String },

    /* -------------------------
       URLs
    -------------------------- */
    originalUrl: { type: String },
    rawOriginalUrl: { type: String },
    affiliateUrl: { type: String },
    tag: { type: String },

    /* -------------------------
       Media
    -------------------------- */
    imageUrl: { type: String },
    images: { type: [String], default: [] },

    /* -------------------------
       Pricing & reviews
    -------------------------- */
    price: { type: Number },        // numeric
    priceRaw: { type: String },     // e.g. "₹57,990"
    priceCurrency: { type: String },

    rating: { type: Number },
    reviewsCount: { type: Number },

    /* -------------------------
       Status & analytics
    -------------------------- */
    isActive: { type: Boolean, default: true },
    clicks: { type: Number, default: 0 },

    lastCheckedAt: { type: Date },
    lastError: { type: String },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.Link || mongoose.model("Link", LinkSchema);
