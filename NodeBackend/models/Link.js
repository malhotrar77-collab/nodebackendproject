// NodeBackend/models/Link.js

const mongoose = require("mongoose");

const priceSchema = new mongoose.Schema(
  {
    current: Number,          // current selling price
    original: Number,         // MRP / original price, if found
    currency: String,         // e.g. "₹"
    discountPercent: Number,  // computed if we have both prices
  },
  { _id: false }
);

const linkSchema = new mongoose.Schema(
  {
    // Basic source info
    source: { type: String, required: true }, // "amazon", "flipkart", "admitad-myntra", etc.

    // URLs
    originalUrl: { type: String, required: true },  // what user pasted
    canonicalUrl: String,                           // cleaned dp URL
    affiliateUrl: { type: String, required: true }, // with tag/affid
    tag: String,                                    // our tag (amazon / flipkart)

    // Product info
    title: String,
    category: String,
    note: String,           // user note from UI (e.g. "Insta reel group A")

    // Images
    imageUrl: String,       // main image
    imageUrls: [String],    // extra images

    // Price + ratings
    price: priceSchema,
    rating: Number,         // e.g. 4.3
    ratingCount: Number,    // e.g. 11811

    // Analytics
    clicks: { type: Number, default: 0 },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

module.exports = mongoose.model("Link", linkSchema);
