const express = require("express");
const axios = require("axios");
const dayjs = require("dayjs");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

const router = express.Router();

/* =========================
   OpenAI (optional)
========================= */
let openai = null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
if (OPENAI_KEY) {
  try {
    const { OpenAI } = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_KEY });
    console.log("OpenAI ready");
  } catch (e) {
    console.warn("OpenAI failed:", e.message);
  }
}

/* =========================
   Helpers
========================= */
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
    return stripAmazonTracking(
      head.request?.res?.responseUrl || url
    );
  } catch {
    return stripAmazonTracking(url);
  }
}

function parsePriceValue(priceRaw) {
  if (!priceRaw) return { parsed: null, currency: null };
  const cleaned = priceRaw.replace(/[^\d.,]/g, "").replace(/,/g, "");
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? { parsed, currency: "INR" } : { parsed: null, currency: null };
}

/* =========================
   Affiliate
========================= */
const AMAZON_TAG = process.env.AMAZON_TAG || null;
function buildAffiliateUrl(url) {
  if (!url || !AMAZON_TAG) return url;
  if (url.includes("tag=")) return url;
  return url + (url.includes("?") ? "&" : "?") + `tag=${AMAZON_TAG}`;
}

/* =========================
   CREATE (Amazon)
========================= */
async function createAmazonLink({ originalUrl, title, category, note, autoTitle = true }) {
  const id = generateId();
  let scraped = null;

  try {
    scraped = autoTitle ? await scrapeAmazonProduct(originalUrl) : null;
  } catch (e) {
    console.error("Scrape failed:", e.message);
  }

  const finalUrl = scraped?.finalUrl || (await resolveAmazonUrl(originalUrl));
  const priceParsed = scraped?.priceText ? parsePriceValue(scraped.priceText) : {};

  const doc = {
    id,
    source: "amazon",
    title: title || scraped?.title || "Amazon Product",
    shortTitle: (scraped?.title || "").slice(0, 80),
    category: category || "other",
    note: note || "",
    originalUrl: finalUrl,
    rawOriginalUrl: originalUrl,
    affiliateUrl: buildAffiliateUrl(finalUrl),
    tag: AMAZON_TAG || undefined,
    imageUrl: scraped?.imageUrl,
    images: scraped?.images,
    price: scraped?.price || priceParsed.parsed,
    priceCurrency: priceParsed.currency,
    rating: scraped?.rating,
    reviewsCount: scraped?.reviewsCount,
    shortDescription: scraped?.shortDescription,
    longDescription: scraped?.longDescription,
    isActive: true,
    clicks: 0,
    lastCheckedAt: new Date(),
  };

  return await Link.create(doc);
}

/* =========================
   ROUTES
========================= */

router.get("/test", (req, res) => {
  res.json({ success: true });
});

router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

router.post("/create", async (req, res) => {
  try {
    const link = await createAmazonLink(req.body);
    res.json({ success: true, link });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/bulk1", async (req, res) => {
  const lines = (req.body.urlsText || "").split("\n").map(l => l.trim()).filter(Boolean);
  const created = [];
  for (const url of lines) {
    try {
      const doc = await createAmazonLink({ originalUrl: url });
      created.push(doc);
    } catch {}
  }
  res.json({ success: true, created });
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

/* =========================
   🔧 MAINTENANCE: REFRESH ALL
========================= */
router.post("/refresh-all", async (req, res) => {
  console.log("🔄 CPM Maintenance: refresh-all started");

  const links = await Link.find({});
  let updated = 0;
  let failed = 0;

  for (const link of links) {
    try {
      const scraped = await scrapeAmazonProduct(link.originalUrl);
      if (!scraped) throw new Error("No scrape data");

      link.title = scraped.title || link.title;
      link.price = scraped.price || link.price;
      link.imageUrl = scraped.imageUrl || link.imageUrl;
      link.images = scraped.images || link.images;
      link.shortDescription = scraped.shortDescription || link.shortDescription;
      link.longDescription = scraped.longDescription || link.longDescription;
      link.lastCheckedAt = new Date();
      link.lastError = undefined;

      await link.save();
      updated++;
    } catch (e) {
      link.lastError = e.message;
      await link.save();
      failed++;
    }
  }

  console.log(`✅ Maintenance done: ${updated} updated, ${failed} failed`);
  res.json({ success: true, updated, failed });
});

module.exports = router;
