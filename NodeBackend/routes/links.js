// NodeBackend/routes/links.js
const express = require("express");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

const router = express.Router();

/* ===============================
   CATEGORY REGISTRY (CANONICAL)
================================ */
const CATEGORY_REGISTRY = {
  electronics: {
    label: "Electronics",
    children: {
      mobiles: ["smartphones", "feature-phones"],
      audio: ["headphones", "earbuds", "speakers"],
      computers: ["laptops", "monitors", "accessories"],
    },
  },
  fashion: {
    label: "Fashion",
    children: {
      men: ["tshirts", "shirts", "jeans"],
      women: ["tops", "dresses", "handbags"],
    },
  },
  home: {
    label: "Home & Living",
    children: {
      kitchen: ["cookware", "appliances"],
      decor: ["lighting", "wall-art"],
    },
  },
  beauty: {
    label: "Beauty & Personal Care",
    children: {
      skincare: ["face-care", "body-care"],
      grooming: ["trimmers", "hair-care"],
    },
  },
  other: {
    label: "Other",
    children: {},
  },
};

/* ===============================
   HELPERS
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

function normalizeCategory(input) {
  if (!input) return "other";
  const key = input.toLowerCase().trim();
  return CATEGORY_REGISTRY[key] ? key : "other";
}

function buildCategoryPath(category, path = []) {
  const root = CATEGORY_REGISTRY[category];
  if (!root || !Array.isArray(path)) return [category];

  const safePath = [category];
  let level = root.children;

  for (const p of path) {
    if (!level) break;

    if (Array.isArray(level)) {
      if (level.includes(p)) safePath.push(p);
      break;
    }

    if (level[p]) {
      safePath.push(p);
      level = level[p];
    } else {
      break;
    }
  }

  return safePath;
}

/* ===============================
   CREATE AMAZON LINK
================================ */
async function createAmazonLink({ originalUrl, category, categoryPath, note }) {
  const scraped = await scrapeAmazonProduct(originalUrl);

  const safeCategory = normalizeCategory(category);
  const safeCategoryPath = buildCategoryPath(
    safeCategory,
    categoryPath || []
  );

  return Link.create({
    id: generateId(),
    source: "amazon",
    title: scraped.title || "Amazon Product",

    shortDescription: scraped.shortDescription || "",
    longDescription: scraped.longDescription || "",

    category: safeCategory,
    categoryPath: safeCategoryPath,
    note: note || "",

    originalUrl: stripAmazonTracking(originalUrl),
    affiliateUrl: stripAmazonTracking(originalUrl),

    imageUrl: scraped.imageUrl,
    images: scraped.images || [],

    price: scraped.price || null,
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
router.get("/test", (_, res) => {
  res.json({ success: true });
});

router.get("/all", async (_, res) => {
  const links = await Link.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, links });
});

router.post("/create", async (req, res) => {
  try {
    const link = await createAmazonLink(req.body);
    res.json({ success: true, link });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
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