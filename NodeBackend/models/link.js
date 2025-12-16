// NodeBackend/models/link.js
const mongoose = require("mongoose");

const LinkSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    source: { type: String, required: true }, // e.g., "amazon"
    title: { type: String },
    shortTitle: { type: String },
    brand: { type: String },
    category: { type: String },
    categoryPath: { type: [String], default: [] },
    note: { type: String },

    originalUrl: { type: String },
    rawOriginalUrl: { type: String },
    affiliateUrl: { type: String },
    tag: { type: String },

    imageUrl: { type: String },
    images: { type: [String], default: [] },

    // price fields
    price: { type: Number },         // parsed numeric price (optional)
    priceRaw: { type: String },      // raw scraped string like "₹57,990.00"
    priceCurrency: { type: String },

    rating: { type: Number },
    reviewsCount: { type: Number },

    shortDescription: { type: String },
    longDescription: { type: String },
    slug: { type: String },

    isActive: { type: Boolean, default: true },
    clicks: { type: Number, default: 0 },

    lastCheckedAt: { type: Date },
    lastError: { type: String },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.Link || mongoose.model("Link", LinkSchema);
