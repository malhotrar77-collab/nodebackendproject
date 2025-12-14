// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const dayjs = require("dayjs");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

const router = express.Router();

/* ===============================
   OpenAI (optional, safe)
================================ */
let openai = null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
if (OPENAI_KEY) {
  try {
    const { OpenAI } = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_KEY });
    console.log("✅ OpenAI ready");
  } catch (e) {
    console.warn("⚠️ OpenAI failed:", e.message);
  }
} else {
  console.warn("⚠️ OPENAI_API_KEY missing – AI rewrite disabled.");
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

async function resolveAmazonUrl(url) {
  if (!url) return null;
  try {
    const head = await axios.head(url, { maxRedirects: 5, timeout: 10000 });
    const final =
      head.request?.res?.responseUrl ||
      head.headers?.location ||
      url;
    return stripAmazonTracking(final);
  } catch {
    return stripAmazonTracking(url);
  }
}

function parsePriceValue(raw) {
  if (!raw) return { parsed: null, currency: null };
  const cleaned = raw.toString().replace(/[^\d.,₹$]/g, "");
  const currency = raw.includes("₹") ? "INR" : raw.includes("$") ? "USD" : null;
  const num = parseFloat(cleaned.replace(/,/g, ""));
  return Number.isFinite(num) ? { parsed: num, currency } : { parsed: null, currency };
}

/* ===============================
   AI Rewrite (optional)
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
            "You are an ecommerce copywriter. Respond ONLY with JSON {title, short, description}",
        },
        {
          role: "user",
          content: `Title: ${title}\nShort: ${shortDescription}\nLong: ${longDescription}`,
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

/* ===============================
   Core Create Logic
================================ */
async function createAmazonLink({ originalUrl, title, category, note }) {
  const scraped = await scrapeAmazonProduct(originalUrl);

  const ai = openai
    ? await rewriteWithAI({
        title: scraped.title,
        shortDescription: scraped.shortDescription,
        longDescription: scraped.longDescription,
      })
    : null;

  const priceParsed = parsePriceValue(scraped.priceText);

  return Link.create({
    id: generateId(),
    source: "amazon",
    title: ai?.title || scraped.title || "Amazon Product",
    shortTitle:
      ai?.short ||
      (scraped.title?.length > 80
        ? scraped.title.slice(0, 77) + "…"
        : scraped.title),
    category: category || "other",
    note: note || "",
    originalUrl: stripAmazonTracking(originalUrl),
    affiliateUrl: buildAffiliateUrl(stripAmazonTracking(originalUrl)),
    imageUrl: scraped.imageUrl,
    images: scraped.images || [],
    price: scraped.price || priceParsed.parsed,
    priceCurrency: priceParsed.currency,
    shortDescription: ai?.short || scraped.shortDescription,
    longDescription: ai?.description || scraped.longDescription,
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

// Health check
router.get("/test", (_, res) => {
  res.json({ success: true, message: "Links API OK" });
});

// Get all links
router.get("/all", async (_, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// Create one
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

/* ===============================
   🔥 MAINTENANCE ROUTE
   Refresh ALL products
================================ */
router.post("/refresh-all", async (_, res) => {
  try {
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
            shortDescription: scraped.shortDescription || link.shortDescription,
            longDescription: scraped.longDescription || link.longDescription,
            lastCheckedAt: new Date(),
            lastError: undefined,
          }
        );

        updated++;
      } catch (err) {
        failed++;
        await Link.updateOne(
          { _id: link._id },
          { lastCheckedAt: new Date(), lastError: err.message }
        );
      }
    }

    res.json({
      success: true,
      total: links.length,
      updated,
      failed,
    });
  } catch (err) {
    console.error("Refresh-all error:", err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
