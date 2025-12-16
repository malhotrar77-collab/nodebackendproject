// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");
const {
  TAXONOMY,
  isValidCategory,
  isValidSubcategory,
} = require("../taxonomy/categories");

const router = express.Router();

/* ===============================
   OpenAI (SAFE + MINIMAL)
================================ */
let openai = null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

if (OPENAI_KEY) {
  try {
    const { OpenAI } = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_KEY });
    console.log("✅ OpenAI ready");
  } catch (e) {
    console.warn("⚠️ OpenAI init failed:", e.message);
  }
}

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

function isPoorText(txt) {
  if (!txt) return true;
  if (txt.length < 80) return true;
  if (/simple|useful|daily life/i.test(txt)) return true;
  return false;
}

/* ===============================
   CATEGORY RESOLVER (CORE)
================================ */

function resolveCategory({ categoryPath = [], topCategory = "", title = "" }) {
  const text = [...categoryPath, topCategory, title]
    .join(" ")
    .toLowerCase();

  // ---- Electronics ----
  if (/headphone|earbud|speaker|audio/.test(text))
    return ["electronics", "audio"];

  if (/laptop|computer|keyboard|mouse|monitor/.test(text))
    return ["electronics", "computers"];

  if (/smart watch|fitness band|wearable/.test(text))
    return ["electronics", "wearables"];

  if (/router|wifi|network/.test(text))
    return ["electronics", "networking"];

  // ---- Fashion ----
  if (/shoe|sneaker|footwear/.test(text))
    return ["fashion", "footwear"];

  if (/shirt|t-shirt|jeans|trouser|clothing/.test(text))
    return ["fashion", "clothing"];

  if (/bag|backpack|wallet/.test(text))
    return ["fashion", "bags_wallets"];

  // ---- Home & Living ----
  if (/kitchen|cookware|utensil/.test(text))
    return ["home_living", "kitchen"];

  if (/light|lamp|bulb/.test(text))
    return ["home_living", "lighting"];

  if (/bed|mattress|pillow|bath/.test(text))
    return ["home_living", "bedding_bath"];

  // ---- Fitness ----
  if (/gym|fitness|dumbbell|yoga/.test(text))
    return ["fitness_sports", "gym_equipment"];

  // ---- Automotive ----
  if (/car|bike|automotive/.test(text))
    return ["automotive", "car_accessories"];

  // ---- Default ----
  return ["other", "other"];
}

/* ===============================
   AI Rewrite (ONLY IF NEEDED)
================================ */
async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You are an SEO ecommerce copywriter. Return ONLY valid JSON with keys: short, description.",
        },
        {
          role: "user",
          content: `
Product title: ${title}

Original short description:
${shortDescription}

Original long description:
${longDescription}
          `,
        },
      ],
    });

    return JSON.parse(res.choices[0].message.content);
  } catch {
    return null;
  }
}

/* ===============================
   CREATE AMAZON LINK
================================ */
async function createAmazonLink({
  originalUrl,
  category,
  subcategory,
  tags,
  note,
}) {
  const scraped = await scrapeAmazonProduct(originalUrl);

  const [autoCat, autoSub] = resolveCategory({
    categoryPath: scraped.categoryPath,
    topCategory: scraped.topCategory,
    title: scraped.title,
  });

  const finalCategory =
    isValidCategory(category) ? category : autoCat;

  const finalSubcategory =
    isValidSubcategory(finalCategory, subcategory)
      ? subcategory
      : autoSub;

  let shortDesc = scraped.shortDescription || "";
  let longDesc = scraped.longDescription || "";

  let ai = null;
  if (isPoorText(shortDesc) || isPoorText(longDesc)) {
    ai = await rewriteWithAI({
      title: scraped.title,
      shortDescription: shortDesc,
      longDescription: longDesc,
    });
  }

  return Link.create({
    id: generateId(),
    source: "amazon",

    title: scraped.title || "Amazon Product",
    shortTitle: scraped.shortTitle,
    brand: scraped.brand,

    category: finalCategory,
    subcategory: finalSubcategory,
    tags: Array.isArray(tags) ? tags : [],

    categoryPath: scraped.categoryPath,

    shortDescription:
      ai?.short || shortDesc || `Explore ${scraped.title}.`,

    longDescription:
      ai?.description || longDesc || `Discover ${scraped.title}.`,

    originalUrl: stripAmazonTracking(originalUrl),
    affiliateUrl: stripAmazonTracking(originalUrl),

    imageUrl: scraped.primaryImage,
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

router.get("/test", (_, res) => {
  res.json({ success: true });
});

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
