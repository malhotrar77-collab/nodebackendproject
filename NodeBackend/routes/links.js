// NodeBackend/routes/links.js
const express = require("express");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");
const {
  isValidCategory,
  isValidSubcategory,
} = require("../taxonomy/categories");

const router = express.Router();

/* ===============================
   Helpers
================================ */
function generateId(len = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function stripAmazonTracking(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/* ===============================
   CATEGORY RESOLVER (SAFE)
================================ */
function resolveCategory({ categoryPath = [], topCategory = "", title = "" }) {
  const text = [...categoryPath, topCategory, title]
    .join(" ")
    .toLowerCase();

  if (/shoe|sneaker|footwear/.test(text))
    return ["fashion", "footwear"];

  if (/shirt|t-shirt|jeans|clothing/.test(text))
    return ["fashion", "clothing"];

  if (/headphone|earbud|speaker/.test(text))
    return ["electronics", "audio"];

  if (/laptop|computer|keyboard|mouse/.test(text))
    return ["electronics", "computers"];

  if (/watch/.test(text))
    return ["fashion", "watches"];

  if (/tv|television/.test(text))
    return ["electronics", "smart_devices"];

  return ["other", "other"];
}

/* ===============================
   CREATE AMAZON LINK (STABLE)
================================ */
async function createAmazonLink({
  originalUrl,
  category,
  subcategory,
  tags,
  note,
}) {
  if (!originalUrl) {
    throw new Error("Amazon URL is required");
  }

  const scraped = await scrapeAmazonProduct(originalUrl);

  const [autoCat, autoSub] = resolveCategory({
    categoryPath: scraped.categoryPath,
    topCategory: scraped.topCategory,
    title: scraped.title,
  });

  const finalCategory = isValidCategory(category)
    ? category
    : autoCat;

  const finalSubcategory = isValidSubcategory(finalCategory, subcategory)
    ? subcategory
    : autoSub;

  const primaryImage =
    scraped.primaryImage ||
    (Array.isArray(scraped.images) && scraped.images[0]) ||
    null;

  return Link.create({
    id: generateId(),
    source: "amazon",

    title: scraped.title || "Amazon Product",
    shortTitle: scraped.shortTitle,
    brand: scraped.brand,

    category: finalCategory,
    subcategory: finalSubcategory,
    tags: Array.isArray(tags) ? tags : [],

    categoryPath: scraped.categoryPath || [],

    shortDescription: scraped.shortDescription || "",
    longDescription: scraped.longDescription || "",

    originalUrl: stripAmazonTracking(originalUrl),
    affiliateUrl: stripAmazonTracking(originalUrl),

    imageUrl: primaryImage,
    images: scraped.images || [],

    price: scraped.price || null,
    priceRaw: scraped.priceText || null,
    priceCurrency: scraped.priceCurrency || null,

    rating: scraped.rating || null,
    reviewsCount: scraped.reviewsCount || null,

    clicks: 0,
    isActive: true,
    lastCheckedAt: new Date(),
  });
}

/* ===============================
   ROUTES
================================ */

router.get("/all", async (_, res) => {
  const links = await Link.find({ isActive: true })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, links });
});

router.post("/create", async (req, res) => {
  try {
    const link = await createAmazonLink(req.body);
    res.json({ success: true, link });
  } catch (e) {
    console.error("CREATE FAILED:", e);
    res.status(500).json({
      success: false,
      message: e.message || "Product creation failed",
    });
  }
});

router.get("/go/:id", async (req, res) => {
  const link = await Link.findOneAndUpdate(
    { id: req.params.id },
    { $inc: { clicks: 1 } },
    { new: true }
  );
  if (!link) return res.status(404).send("Not found");
  res.redirect(link.affiliateUrl || link.originalUrl);
});

module.exports = router;
