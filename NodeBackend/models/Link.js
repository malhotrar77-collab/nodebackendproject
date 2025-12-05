// NodeBackend/models/Link.js

const mongoose = require("mongoose");

const linkSchema = new mongoose.Schema(
  {
    source: { type: String, required: true },        // "amazon", "flipkart", "admitad-myntra", etc.
    originalUrl: { type: String, required: true },   // cleaned / canonical URL
    rawOriginalUrl: { type: String },                // what user pasted
    affiliateUrl: { type: String, required: true },
    tag: { type: String },

    // Extra metadata
    title: { type: String },
    category: { type: String },
    note: { type: String },

    // Future: images, prices, etc.
    images: [{ type: String }],
    price: { type: Number }, // optional, for later

    clicks: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
  },
  {
    versionKey: false
  }
);

// Transform _id -> id for API responses
linkSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  }
});

const Link = mongoose.model("Link", linkSchema);

module.exports = Link;
