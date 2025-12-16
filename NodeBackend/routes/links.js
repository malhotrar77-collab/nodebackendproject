// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

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
            "You are an SEO ecommerce copywriter. Return ONLY valid JSON with keys: short, description. Make content unique, helpful, SEO friendly, and concise.",
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
  } catch (e) {
    console.error("AI rewrite failed:", e.message);
    return null;
  }
}

/* ===============================
   Create Amazon Link (SMART)
================================ */
async function createAmazonLink({ originalUrl, category, note }) {
  const scraped = await scrapeAmazonProduct(originalUrl);

  let shortDesc = scraped.shortDescription || "";
  let longDesc = scraped.longDescription || "";

  let ai = null;

  // 🔥 AI runs ONLY if text is poor
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

    shortDescription:
      ai?.short ||
      shortDesc ||
      `Explore features, design, and everyday usability of ${scraped.title}.`,

    longDescription:
      ai?.description ||
      longDesc ||
      `Discover why ${scraped.title} is popular among Amazon shoppers. This product offers practical value, solid build quality, and everyday usefulness.`,

    category: category || "other",
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

/* ===============================
   🔥 REFRESH ALL (NO AI)
================================ */
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
          price: scraped.price || link.price,
          imageUrl: scraped.imageUrl || link.imageUrl,
          images: scraped.images || link.images,
          lastCheckedAt: new Date(),
        }
      );

      updated++;
    } catch (e) {
      failed++;
    }
  }

  res.json({ success: true, total: links.length, updated, failed });
});

module.exports = router;
