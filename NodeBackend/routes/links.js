// NodeBackend/routes/links.js  (complete file, kid-patched)
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

// OpenAI stuff (optional)
let openai = null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
if (OPENAI_KEY) {
  try {
    const { OpenAI } = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_KEY });
    console.log("OpenAI ready");
  } catch (e) {
    console.warn("OpenAI failed:", e.message);
    openai = null;
  }
} else {
  console.warn("OPENAI_API_KEY missing – AI rewrite disabled.");
}

const router = express.Router();

// ---------- helpers ----------
function generateId(len = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
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
  if (/amazon\./i.test(url)) return stripAmazonTracking(url);
  // simple HEAD fallback
  try {
    const head = await axios.head(url, { maxRedirects: 5, timeout: 10000 });
    const final = head.request.res.responseUrl || head.headers.location || null;
    if (final) return stripAmazonTracking(final);
  } catch {}
  return stripAmazonTracking(url);
}

function parsePriceValue(priceRaw) {
  if (!priceRaw) return { raw: null, parsed: null, currency: null };
  let s = priceRaw.toString().replace(/\u00A0/g, " ").trim();
  s = s.replace(/\s+/g, " ");
  if (!s) return { raw: priceRaw.toString(), parsed: null, currency: null };
  const currMatch = s.match(/(₹|Rs\.?|INR|USD|\$|£|€)/i);
  const currency = currMatch ? currMatch[0].replace(/\./g, "") : null;
  let digits = s.replace(/[^\d.,]/g, "");
  if (!digits) return { raw: s, parsed: null, currency };
  digits = digits.replace(/,/g, "");
  const num = parseFloat(digits);
  if (Number.isFinite(num)) return { raw: s, parsed: num, currency };
  return { raw: s, parsed: null, currency };
}

async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;
  const sys = `You are an ecommerce copywriter. Return ONLY valid JSON with keys: title (≤120), short (≤80), description (≤220).`;
  const user = `Title: ${title}\nShort: ${shortDescription}\nLong: ${longDescription}`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 400,
      response_format: { type: "json_object" }
    });
    const txt = resp.choices[0].message.content.trim();
    const parsed = JSON.parse(txt);
    return {
      title: parsed.title || title,
      short: parsed.short || shortDescription,
      description: parsed.description || longDescription,
      rawAI: txt,
    };
  } catch (err) {
    console.error("AI rewrite failed:", err.message);
    return null;
  }
}

// ------------ affiliate url builder ------------
const DEFAULT_AMAZON_TAG = process.env.AMAZON_TAG || null;
function buildAffiliateUrl(canonicalUrl) {
  if (!canonicalUrl) return null;
  if (!DEFAULT_AMAZON_TAG) return canonicalUrl;
  if (/[?&]tag=/.test(canonicalUrl)) return canonicalUrl;
  const sep = canonicalUrl.includes("?") ? "&" : "?";
  return `${canonicalUrl}${sep}tag=${DEFAULT_AMAZON_TAG}`;
}

// ------------ core create logic ------------
async function createAmazonLink({ originalUrl, title, category, note, autoTitle = true }) {
  if (!originalUrl) throw new Error("originalUrl is required");

  const source = "amazon";
  const categorySafe = category && category.trim() ? category.trim() : "other";
  const noteSafe = note && note.trim() ? note.trim() : "";

  let finalTitle = title && title.trim() ? title.trim() : "";
  let priceNum = null;
  let priceCurrency = null;
  let priceRaw = null;
  let imageUrl = null;
  let normalizedUrl = originalUrl;
  let scrapeError = null;
  let shortDescription = "";
  let longDescription = "";
  let scrapedData = null;

  if (autoTitle || !finalTitle) {
    try {
      scrapedData = await scrapeAmazonProduct(originalUrl);
      normalizedUrl = scrapedData.finalUrl || originalUrl;
      if (!finalTitle && scrapedData.title) finalTitle = scrapedData.title;
      if (scrapedData.price != null) {
        priceNum = scrapedData.price;
      } else if (scrapedData.priceText) {
        const pp = parsePriceValue(scrapedData.priceText);
        priceNum = pp.parsed;
        priceCurrency = pp.currency;
        priceRaw = pp.raw;
      }
      imageUrl = scrapedData.imageUrl || scrapedData.primaryImage || null;
      shortDescription = scrapedData.shortDescription || "";
      longDescription = scrapedData.longDescription || "";
    } catch (err) {
      console.error("Scrape error for", originalUrl, err.message || err);
      scrapeError = err.message || String(err);
      // ----- kid-proof backup candy -----
      if (!finalTitle) finalTitle = "Cool Amazon Find";
      shortDescription = "A handy product picked for you – makes life easier!";
      longDescription  = "This item is trending on Amazon and loved by many shoppers. Grab it while it’s on sale.";
      imageUrl = "https://via.placeholder.com/600x600.png?text=Amazon+Product";
      // ------------------------------------
      try {
        normalizedUrl = await resolveAmazonUrl(originalUrl);
      } catch {}
    }
  } else {
    try {
      normalizedUrl = await resolveAmazonUrl(originalUrl);
    } catch {}
  }

  if (!finalTitle) finalTitle = "Amazon product";

  // AI rewrite
  let aiFields = null;
  if (openai && (shortDescription || longDescription)) {
    try {
      aiFields = await rewriteWithAI({ title: finalTitle, shortDescription, longDescription });
      if (aiFields && aiFields.title) finalTitle = aiFields.title;
    } catch (e) {
      console.error("AI rewrite failed:", e.message);
    }
  }

  const priceForDb = typeof priceNum === "number" && Number.isFinite(priceNum) ? priceNum : undefined;
  const affiliateUrl = buildAffiliateUrl(normalizedUrl);
  const id = generateId(5);

  const doc = {
    id,
    source,
    title: finalTitle,
    shortTitle: (aiFields && aiFields.short) || (finalTitle.length > 80 ? finalTitle.slice(0, 77) + "…" : finalTitle),
    brand: scrapedData?.brand || undefined,
    category: categorySafe,
    categoryPath: scrapedData?.categoryPath || undefined,
    note: noteSafe,
    originalUrl: normalizedUrl,
    rawOriginalUrl: originalUrl,
    affiliateUrl,
    tag: DEFAULT_AMAZON_TAG || undefined,
    imageUrl: imageUrl || undefined,
    images: imageUrl ? (scrapedData?.images || [imageUrl]) : undefined,
    price: priceForDb,
    priceCurrency: priceCurrency || undefined,
    priceRaw: priceRaw || undefined,
    rating: scrapedData?.rating || undefined,
    reviewsCount: scrapedData?.reviewsCount || undefined,
    shortDescription: (aiFields && aiFields.short) || shortDescription || undefined,
    longDescription: (aiFields && aiFields.description) || longDescription || undefined,
    slug: scrapedData?.slug || undefined,
    isActive: true,
    clicks: 0,
    lastCheckedAt: new Date(),
    lastError: scrapeError || undefined,
  };

  const linkDoc = await Link.create(doc);
  return linkDoc;
}

// ---------- routes ----------
router.get("/test", (req, res) => res.json({ success: true, message: "Links API OK" }));

router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch links." });
  }
});

router.post("/create", async (req, res) => {
  try {
    const { originalUrl, title, category, note, autoTitle = true } = req.body || {};
    if (!originalUrl || !originalUrl.trim()) return res.status(400).json({ success: false, message: "originalUrl is required" });
    const linkDoc = await createAmazonLink({ originalUrl: originalUrl.trim(), title, category, note, autoTitle });
    res.json({ success: true, link: linkDoc });
  } catch (err) {
    console.error("POST /create error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to create link." });
  }
});

router.post("/bulk1", async (req, res) => {
  try {
    const { urlsText, category, note, autoTitle = true } = req.body || {};
    if (!urlsText || !urlsText.trim()) return res.status(400).json({ success: false, message: "urlsText is required" });
    const lines = urlsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return res.status(400).json({ success: false, message: "No valid URLs found." });
    if (lines.length > 10) return res.status(400).json({ success: false, message: "Limit 10 URLs at once." });

    const created = [];
    const errors = [];
    for (const url of lines) {
      try {
        const doc = await createAmazonLink({ originalUrl: url, title: "", category, note, autoTitle });
        created.push(doc);
      } catch (err) {
        console.error("Bulk create error for", url, err.message || err);
        errors.push({ url, error: err.message || String(err) });
      }
    }
    res.json({ success: true, created: created.length, errors, links: created });
  } catch (err) {
    console.error("POST /bulk1 error:", err);
    res.status(500).json({ success: false, message: err.message || "Bulk create failed." });
  }
});

router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, price, note } = req.body || {};
    const update = {};
    if (typeof title === "string") update.title = title;
    if (typeof category === "string") update.category = category;
    if (typeof price === "string" || typeof price === "number") {
      const num = Number(price);
      if (!Number.isNaN(num)) update.price = num;
    }
    if (typeof note === "string") update.note = note;

    const updated = await Link.findOneAndUpdate({ id }, update, { new: true }).lean();
    if (!updated) return res.status(404).json({ success: false, message: "Link not found." });
    res.json({ success: true, link: updated });
  } catch (err) {
    console.error("PUT /update/:id error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to update link." });
  }
});

router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Link.findOneAndDelete({ id }).lean();
    if (!deleted) return res.status(404).json({ success: false, message: "Link not found." });
    res.json({ success: true, deletedId: id });
  } catch (err) {
    console.error("DELETE /delete/:id error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to delete link." });
  }
});

router.get("/go/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const link = await Link.findOneAndUpdate({ id }, { $inc: { clicks: 1 } }, { new: true });
    if (!link) return res.status(404).send("Link not found");
    res.redirect(link.affiliateUrl || link.originalUrl);
  } catch (err) {
    console.error("GET /go/:id error:", err);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;
