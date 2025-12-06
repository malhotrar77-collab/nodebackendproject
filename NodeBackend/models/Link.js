// NodeBackend/models/link.js

const mongoose = require("mongoose");

const linkSchema = new mongoose.Schema(
  {
    // amazon / flipkart / admitad-...
    source: { type: String, required: true },

    // cleaned Amazon dp URL or original Flipkart URL
    originalUrl: { type: String, required: true },

    // what we actually send users to (with tag / affid)
    affiliateUrl: { type: String, required: true },

    // e.g. alwaysonsal08-21 or flipkart ID
    tag: { type: String },

    // product title (can be null if not fetched)
    title: { type: String },

    // optional manual or auto category (e.g. "shoes")
    category: { type: String },

    // your internal note (e.g. “Instagram reel group A”)
    note: { type: String },

    // **for history**: what user originally pasted
    rawOriginalUrl: { type: String },

    // main image URL (for card / thumbnail)
    imageUrl: { type: String },

    // if we later store multiple images
    images: [{ type: String }],

    // for later when we scrape price
    price: { type: Number },

    // click counter
    clicks: { type: Number, default: 0 },
  },
  {
    timestamps: true, // adds createdAt + updatedAt
  }
);

module.exports = mongoose.model("Link", linkSchema);
