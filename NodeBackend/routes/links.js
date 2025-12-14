// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

const router = express.Router();

/* ===============================
   OpenAI (DO NOT TOUCH LOGIC)
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
} else {
  console.warn("⚠️ OPENAI_API_KEY missing – AI disabled");
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

function parsePriceValue(raw) {
  if (!raw) return null;
  const num = parseFloat(raw.toString().replace(/[^\d.]/g, ""));
  return Number.isFinite(num) ? num : null;
}

/* ===============================
   AI Rewrite (UNCHANGED LOGIC)
================================ */
async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an ecommerce SEO copywriter. Return ONLY JSON with keys: short, description",
        },
        {
          role: "user",
          content: `
Original title: ${title}
Original short description: ${shortDescription}
Original long description: ${longDescription}

Rewrite both descriptions to be:
- SEO friendly
- Human readable
- Unique
- Not promotional spam
`,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    });

    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error("AI rewrite failed:", err.message);
    return null;
  }
}

/* ===============================
   Affiliate URL
================================ */
const AMAZON_TAG = process.env.AMAZON_TAG || null;

function buildAffiliateUrl(url) {
  if (!url || !AMAZON_TAG) return url;
  if (url.includes("tag=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}tag=${AMAZON_TAG}`;
}

/* ======================================================
   🔥 createAmazonLink() — IMPORTANT PART
====================================================== */
async function createAmazonLink({ originalUrl, category, note }) {
  if (!originalUrl) throw new Error("originalUrl required");

  const scraped = await scrapeAmazonProduct(originalUrl);

  let shortDesc = scraped.shortDescription || "";
  let longDesc = scraped.longDescription || "";

  /* ---------- AI USAGE DECISION ---------- */
  let useAI = false;

  if (
    openai &&
    (
      shortDesc.length < 40 ||
      longDesc.length < 120 ||
      /useful|simple|great|perfect/i.test(shortDesc)
    )
  ) {
    useAI = true;
  }

  let ai = null;
  if (useAI) {
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
    category: category || "other",
    note: note || "",

    originalUrl: stripAmazonTracking(originalUrl),
    affiliateUrl: buildAffiliateUrl(stripAmazonTracking(originalUrl)),

    imageUrl: scraped.imageUrl,
    images: scraped.images || [scraped.imageUrl],

    price: scraped.price || parsePriceValue(scraped.priceText),
    priceCurrency: scraped.priceCurrency || "INR",

    /* ✅ UNIQUE DESCRIPTIONS */
    shortDescription:
      ai?.short ||
      shortDesc ||
      "A practical product selected for everyday use.",

    longDescription:
      ai?.description ||
      longDesc ||
      "This product is carefully selected based on quality, usability, and value for money.",

    rating: scraped.rating,
    reviewsCount: scraped.reviewsCount,

    clicks: 0,
    isActive: true,
    lastCheckedAt: new Date(),
  });
}

/* ===============================
   ROUTES
================================ */

// Health
router.get("/test", (_, res) =>
  res.json({ success: true, message: "Links API OK" })
);

// All
router.get("/all", async (_, res) => {
  const links = await Link.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, links });
});

// Create
router.post("/create", async (req, res) => {
  try {
    const link = await createAmazonLink(req.body);
    res.json({ success: true, link });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Delete
router.delete("/delete/:id", async (req, res) => {
  const deleted = await Link.findOneAndDelete({ id: req.params.id });
  if (!deleted) return res.status(404).json({ success: false });
  res.json({ success: true });
});

// Go + click count
router.get("/go/:id", async (req, res) => {
  const link = await Link.findOneAndUpdate(
    { id: req.params.id },
    { $inc: { clicks: 1 } },
    { new: true }
  );
  if (!link) return res.status(404).send("Not found");
  res.redirect(link.affiliateUrl || link.originalUrl);
});

/* ======================================================
   🔥 /refresh-all — DO NOT TOUCH AI CONTENT
====================================================== */
router.post("/refresh-all", async (_, res) => {
  const links = await Link.find({ isActive: true });
  let updated = 0;
  let failed = 0;

  for (const link of links) {
    try {
      const scraped = await scrapeAmazonProduct(link.originalUrl);

      await Link.updateOne(
        { _id: link._id },
        {
          title: scraped.title || link.title,
          price: scraped.price || link.price,
          imageUrl: scraped.imageUrl || link.imageUrl,
          images: scraped.images || link.images,
          rating: scraped.rating || link.rating,
          reviewsCount: scraped.reviewsCount || link.reviewsCount,
          lastCheckedAt: new Date(),
        }
      );

      updated++;
    } catch (err) {
      failed++;
    }
  }

  res.json({
    success: true,
    total: links.length,
    updated,
    failed,
  });
});

module.exports = router;
