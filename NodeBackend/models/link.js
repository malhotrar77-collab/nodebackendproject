// NodeBackend/models/link.js
const mongoose = require("mongoose");

const linkSchema = new mongoose.Schema(
  {
    // Short internal id used in URLs like /api/links/go/:id
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Where this link came from (currently only "amazon")
    source: {
      type: String,
      required: true,
      default: "amazon",
    },

    // Core product info
    title: { type: String },          // full product title from Amazon
    shortTitle: { type: String },     // trimmed title for cards
    brand: { type: String },          // e.g. "Raymond"

    category: { type: String },       // our top-level category (clothing, shoes, etc.)
    categoryPath: [String],           // optional: ["Clothing", "Men", "Sweaters"]

    note: { type: String },           // manual note from dashboard (optional)

    // URLs
    originalUrl: { type: String, required: true }, // cleaned canonical URL (usually /dp/ASIN)
    rawOriginalUrl: { type: String },              // exactly what user pasted
    affiliateUrl: { type: String },                // deeplink with tag
    tag: { type: String },                         // affiliate tag (e.g. alwaysonsale-21)

    // Images
    imageUrl: { type: String },        // main image (used in cards)
    images: [String],                  // gallery images if available

    // Pricing (normalized)
    price: { type: Number },           // numeric price (e.g. 2149)
    priceCurrency: { type: String },   // "INR", "USD", etc.
    priceRaw: { type: String },        // original text, e.g. "₹2,149"

    // Previous price (for change detection later)
    prevPrice: { type: Number },
    prevPriceCurrency: { type: String },
    priceChangeReason: { type: String }, // e.g. "scrape_update"

    // Rating metadata (optional, may be null)
    rating: { type: Number },         // 4.3
    reviewsCount: { type: Number },   // 1234

    // Descriptions
    shortDescription: { type: String }, // 1–2 line description for cards
    longDescription: { type: String },  // longer description for detail page

    // SEO helpers
    slug: { type: String },           // "raymond-men-wool-sweatshirt"
    isActive: { type: Boolean, default: true },

    // Stats
    clicks: { type: Number, default: 0 },

    // Maintenance
    lastCheckedAt: { type: Date },   // when scraper last refreshed this link
    lastError: { type: String },     // last scraping error message (if any)
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

// Helpful compound index for lookups
linkSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.model("Link", linkSchema);