// NodeBackend/routes/links.js
// Full replacement for your previous file — improved scraping, price parsing, AI rewrite support.

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const Link = require("../models/link");

// Try to reuse your scraper module (if present)
let legacyScraper = null;
try {
  legacyScraper = require("../scrapers/amazon").scrapeAmazonProduct;
} catch (e) {
  legacyScraper = null;
  console.warn("No legacy scraper module found or failed to load:", e.message || e);
}

// OpenAI client (optional)
let openai = null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (OPENAI_API_KEY) {
  try {
    const { OpenAI } = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log("OpenAI client configured.");
  } catch (err) {
    console.warn("Failed to initialize OpenAI client:", err.message || err);
    openai = null;
  }
} else {
  console.log("OPENAI_API_KEY not set; AI rewriting disabled.");
}

const router = express.Router();

// ---------- Helpers ----------

function generateId(length = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Normalize canonical Amazon urls by stripping search params
function stripAmazonTracking(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// Resolve short amzn.to style redirects -> canonical URL (best-effort).
async function resolveAmazonUrl(url) {
  if (!url) return null;
  if (/amazon\./i.test(url)) return stripAmazonTracking(url);

  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });

    // axios stores final URL differently across envs. Try common places.
    const finalUrl =
      (res.request && res.request.res && res.request.res.responseUrl) ||
      (res.request && res.request._redirectable && res.request._redirectable._currentUrl) ||
      url;

    return stripAmazonTracking(finalUrl);
  } catch (err) {
    console.warn("resolveAmazonUrl failed, returning original (error):", err.message || err);
    return stripAmazonTracking(url);
  }
}

// Price parsing: accepts strings like "₹57,990.00", "Rs. 4,599", "₹1,299", "$29.99" etc.
// Returns { raw: originalStringOrNull, parsed: numericOrNull, currency: stringOrNull }
function parsePriceValue(priceRaw) {
  if (!priceRaw) return { raw: null, parsed: null, currency: null };
  try {
    const s = priceRaw.toString().trim();

    // capture currency symbol / text
    const currencyMatch = s.match(/(₹|Rs\.?|INR|\$|USD|£|€)/i);
    const currency = currencyMatch ? currencyMatch[0].replace(/\./g, "") : null;

    // remove all non-digit, non-dot, non-comma characters (keep decimal)
    // Then remove commas -> standardize -> parseFloat
    // Examples: "₹57,990.00" -> "57990.00"
    let digits = s.replace(/[^\d.,]/g, "");
    if (!digits) return { raw: s, parsed: null, currency };

    // If string contains both commas and dots, assume comma is thousand sep (Indian style)
    // Heuristic: if digits has a dot after last 3 digits it's decimal; otherwise treat commas as thousand separators
    // Replace commas, keep dot, then parseFloat
    digits = digits.replace(/,/g, "");
    const val = parseFloat(digits);
    if (Number.isFinite(val)) {
      return { raw: s, parsed: val, currency };
    }

    return { raw: s, parsed: null, currency };
  } catch (err) {
    return { raw: priceRaw.toString(), parsed: null, currency: null };
  }
}

// Try to extract core product fields from an Amazon product URL.
// Uses legacyScraper (if loaded) else falls back to a minimal cheerio-based extractor.
async function scrapeAmazonProduct(finalUrlOrInput) {
  const resolved = await resolveAmazonUrl(finalUrlOrInput);
  const finalUrl = resolved || finalUrlOrInput;

  // First try legacy scraper if available (keeps your existing logic)
  if (legacyScraper) {
    try {
      const legacy = await legacyScraper(finalUrl);
      // legacy may return priceText or price; normalize
      const priceText = legacy.priceText || legacy.price || null;
      const priceParsed = parsePriceValue(priceText);
      return {
        finalUrl,
        title: legacy.title || legacy.shortTitle || "Amazon product",
        priceRaw: priceText || null,
        price: priceParsed.parsed,
        priceCurrency: priceParsed.currency || null,
        imageUrl: legacy.primaryImage || (legacy.images && legacy.images[0]) || null,
        images: legacy.images || [],
        shortDescription: legacy.shortDescription || null,
        longDescription: legacy.longDescription || null,
        slug: legacy.slug || null,
        rating: legacy.rating || null,
        reviewsCount: legacy.reviewsCount || null,
      };
    } catch (err) {
      console.warn("legacy scraper failed, falling back:", err.message || err);
      // fall through to fallback
    }
  }

  // Fallback simple >= cheerio extractor with extra debugging & regex fallback for price
  try {
    const res = await axios.get(finalUrl, {
      maxRedirects: 5,
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    console.log("Fallback scrape HTTP status:", res.status);
    console.log("Response HTML length:", (res.data || "").length);

    // small snippet to quickly see whether page contains bot protection text
    const snippet = (res.data || "").slice(0, 2000).replace(/\n/g, " ");
    console.log("HTML snippet (first 2k chars):", snippet);

    const $ = cheerio.load(res.data);

    const title = $("#productTitle").text().trim() || $("title").text().trim() || null;

    // Common places for Indian prices
    let priceText =
      $("#priceblock_ourprice").text().trim() ||
      $("#priceblock_dealprice").text().trim() ||
      $("#corePrice_feature_div .a-offscreen").first().text().trim() ||
      $("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen").first().text().trim() ||
      $(".a-price .a-offscreen").first().text().trim() ||
      null;

    // If price not found, try searching page with regex for currency-looking strings
    let regexFallback = null;
    if (!priceText) {
      const pageText = (res.data || "").replace(/\s+/g, " ");
      const match = pageText.match(/(₹|Rs\.?|INR|\$|USD|£|€)\s?[0-9\.,]{2,}/i);
      if (match) {
        regexFallback = match[0];
        console.log("Price regex fallback found:", regexFallback);
      }
    }

    priceText = priceText || regexFallback || null;

    // image extraction
    let image =
      $("#landingImage").attr("src") ||
      $("#imgTagWrapperId img").attr("data-old-hires") ||
      $("#imgTagWrapperId img").attr("src") ||
      $('img[data-a-dynamic-image]').attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      null;

    if (image && image.startsWith("//")) image = "https:" + image;

    const images = [];
    $("#altImages img").each((_, img) => {
      let src = $(img).attr("src");
      if (!src) return;
      src = src.replace(/\._.*?_\./, "._SL800_.");
      if (src && src.startsWith("//")) src = "https:" + src;
      images.push(src);
    });
    if (image && images.indexOf(image) === -1) images.unshift(image);

    // Short / long descriptions
    const bullets = [];
    $("#feature-bullets li").each((_, li) => {
      const t = $(li).text().replace(/\s+/g, " ").trim();
      if (t) bullets.push(t);
    });
    const shortDescription = bullets[0] || null;
    const longDescription = bullets.slice(0, 5).join(" ") || null;

    const priceParsed = parsePriceValue(priceText);

    return {
      finalUrl,
      title: title || "Amazon product",
      priceRaw: priceText,
      price: priceParsed.parsed,
      priceCurrency: priceParsed.currency,
      imageUrl: image,
      images,
      shortDescription,
      longDescription,
      slug: title ? title.toString().slice(0, 120).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() : null,
      rating: null,
      reviewsCount: null,
    };
  } catch (err) {
    console.error("Fallback scrape failed:", err.message || err);
    // bubble up so caller can mark lastError
    throw err;
  }
}

// Compose affiliate URL (simple tag param). Use AMAZON_TAG env var if present.
const DEFAULT_AMAZON_TAG = process.env.AMAZON_TAG || null;
function buildAffiliateUrl(canonicalUrl) {
  if (!canonicalUrl) return null;
  if (!DEFAULT_AMAZON_TAG) return canonicalUrl;
  if (/[?&]tag=/.test(canonicalUrl)) return canonicalUrl;
  const sep = canonicalUrl.includes("?") ? "&" : "?";
  return `${canonicalUrl}${sep}tag=${DEFAULT_AMAZON_TAG}`;
}

// --- OpenAI rewrite helper (returns { title, short, description, rawAI } or null)
async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;

  // Compact JSON-output prompt
  const prompt = `
You are an expert ecommerce copywriter. Given the product title and descriptions, return ONLY a JSON object (no extra text) with properties:
- "title": SEO-friendly name (<= 120 chars).
- "short": a 1-line card hook (<= 80 chars).
- "description": a 2-3 sentence listing description (<= 220 chars).

Input:
Title: ${title || ""}
ShortDescription: ${shortDescription || ""}
LongDescription: ${longDescription || ""}

Output only valid JSON.
`;

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini", // change if your account doesn't have this model
      input: prompt,
      max_output_tokens: 400,
    });

    // Extract text robustly
    let aiText = "";
    try {
      if (typeof resp.output_text === "string") aiText = resp.output_text;
      else if (Array.isArray(resp.output) && resp.output.length) {
        aiText = resp.output.map((o) => (o && (o.content || o.text) ? (o.content || o.text) : "")).join("");
      } else if (resp.data && resp.data[0] && resp.data[0].text) {
        aiText = resp.data[0].text;
      } else {
        aiText = JSON.stringify(resp, null, 2);
      }
    } catch (e) {
      aiText = String(resp);
    }

    // try parse JSON from aiText
    let parsed = null;
    try {
      parsed = JSON.parse(aiText);
    } catch (e) {
      // attempt to extract JSON substring
      const start = aiText.indexOf("{");
      const end = aiText.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          parsed = JSON.parse(aiText.slice(start, end + 1));
        } catch (ee) {
          parsed = null;
        }
      }
    }

    if (!parsed) {
      // fallback: return safe values
      return {
        title: title,
        short: (shortDescription && shortDescription.slice(0, 80)) || (title && title.slice(0, 80)) || "",
        description: (longDescription && longDescription.slice(0, 220)) || (shortDescription && shortDescription.slice(0, 220)) || title,
        rawAI: aiText,
      };
    }

    return {
      title: parsed.title || title,
      short: parsed.short || (parsed.title || "").slice(0, 80),
      description: parsed.description || parsed.longDescription || parsed.short || shortDescription || title,
      rawAI: aiText,
    };
  } catch (err) {
    console.error("OpenAI rewrite failed:", err.message || err);
    return null;
  }
}

// Create link logic used by POST /create and bulk
async function createAmazonLink({ originalUrl, title, category, note, autoTitle = true }) {
  if (!originalUrl) throw new Error("originalUrl is required");

  const source = "amazon";
  const categorySafe = category && category.trim() ? category.trim() : "other";
  const noteSafe = note && note.trim() ? note.trim() : "";

  let normalizedUrl = originalUrl;
  try {
    normalizedUrl = (await resolveAmazonUrl(originalUrl)) || originalUrl;
  } catch (e) {
    normalizedUrl = originalUrl;
  }

  let scraped = null;
  let scrapeError = null;

  if (autoTitle || !title || !title.trim()) {
    try {
      scraped = await scrapeAmazonProduct(normalizedUrl);
    } catch (err) {
      scrapeError = err.message || String(err);
      console.warn("Scrape error (createAmazonLink):", scrapeError);
    }
  }

  let finalTitle = (title && title.trim()) || (scraped && scraped.title) || "Amazon product";

  // parse price from scraped
  const priceNum = scraped && scraped.price != null ? scraped.price : undefined;
  const priceCurrency = scraped && scraped.priceCurrency ? scraped.priceCurrency : undefined;
  const priceRaw = scraped && scraped.priceRaw ? scraped.priceRaw : undefined;

  // images
  const primaryImage = scraped && scraped.imageUrl ? scraped.imageUrl : undefined;
  const images = scraped && scraped.images ? scraped.images : [];

  // short/long description
  let shortDescription = (scraped && scraped.shortDescription) || "";
  let longDescription = (scraped && scraped.longDescription) || "";

  // Try AI rewrite if available
  let aiFields = null;
  if (openai) {
    try {
      aiFields = await rewriteWithAI({ title: finalTitle, shortDescription, longDescription });
      if (aiFields && aiFields.title) finalTitle = aiFields.title;
    } catch (e) {
      console.warn("AI rewrite attempt failed:", e.message || e);
      aiFields = null;
    }
  }

  const id = generateId(6);

  // Build affiliate url (tag param) if AMAZON_TAG set, otherwise use canonical
  const affiliateUrl = buildAffiliateUrl(normalizedUrl);

  // Prepare document for create — ensure numeric price or omitted
  const doc = {
    id,
    source,
    title: finalTitle,
    shortTitle:
      (aiFields && aiFields.short) ||
      (finalTitle && finalTitle.length > 80 ? finalTitle.slice(0, 77).trimEnd() + "…" : finalTitle),
    brand: undefined,
    category: categorySafe,
    categoryPath: scraped && scraped.categoryPath ? scraped.categoryPath : undefined,
    note: noteSafe,
    originalUrl: normalizedUrl,
    rawOriginalUrl: originalUrl,
    affiliateUrl,
    tag: DEFAULT_AMAZON_TAG || undefined,
    imageUrl: primaryImage,
    images: images && images.length ? images : undefined,
    price: typeof priceNum === "number" ? priceNum : undefined,
    priceCurrency: priceCurrency || undefined,
    priceRaw: priceRaw || undefined,
    rating: scraped && scraped.rating ? scraped.rating : undefined,
    reviewsCount: scraped && scraped.reviewsCount ? scraped.reviewsCount : undefined,
    shortDescription: (aiFields && aiFields.short) || shortDescription || undefined,
    longDescription: (aiFields && aiFields.description) || longDescription || undefined,
    slug: scraped && scraped.slug ? scraped.slug : undefined,
    isActive: true,
    clicks: 0,
    lastCheckedAt: scraped ? new Date() : undefined,
    lastError: scrapeError || undefined,
  };

  // create in DB
  const created = await Link.create(doc);
  return created;
}

// ---------- Routes ----------

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
    if (!originalUrl || !originalUrl.trim()) {
      return res.status(400).json({ success: false, message: "originalUrl is required" });
    }

    const linkDoc = await createAmazonLink({
      originalUrl: originalUrl.trim(),
      title,
      category,
      note,
      autoTitle,
    });

    res.json({ success: true, link: linkDoc });
  } catch (err) {
    console.error("POST /create error:", err && err.message ? err.message : err);
    res.status(500).json({ success: false, message: err.message || "Failed to create link." });
  }
});

router.post("/bulk1", async (req, res) => {
  try {
    const { urlsText, category, note, autoTitle = true } = req.body || {};
    if (!urlsText || !urlsText.trim()) {
      return res.status(400).json({ success: false, message: "urlsText is required" });
    }

    const lines = urlsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return res.status(400).json({ success: false, message: "No valid URLs found." });
    if (lines.length > 20) return res.status(400).json({ success: false, message: "Please limit to 20 URLs at once." });

    const created = [];
    const errors = [];

    for (const url of lines) {
      try {
        const doc = await createAmazonLink({ originalUrl: url, title: "", category, note, autoTitle });
        created.push(doc);
      } catch (err) {
        console.error("Bulk create error for", url, err && err.message ? err.message : err);
        errors.push({ url, error: err && err.message ? err.message : String(err) });
      }
    }

    res.json({ success: true, created: created.length, errors, links: created });
  } catch (err) {
    console.error("POST /bulk1 error:", err && err.message ? err.message : err);
    res.status(500).json({ success: false, message: err.message || "Bulk create failed." });
  }
});

// Legacy alias: allow { urls: [...] }
router.post("/bulk", async (req, res, next) => {
  try {
    const { urls } = req.body || {};
    if (Array.isArray(urls)) {
      req.body.urlsText = urls.join("\n");
    }
    return router.handle(req, res, next);
  } catch (err) {
    console.error("POST /bulk alias error:", err);
    res.status(500).json({ success: false, message: "Bulk create failed." });
  }
});

router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, price, note } = req.body || {};

    const update = {};
    if (typeof title === "string") update.title = title;
    if (typeof category === "string") update.category = category;
    if (price !== undefined && price !== null) {
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

// Maintenance job — refresh price + image + metadata for active amazon links
router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find({ source: "amazon", isActive: { $ne: false } }).lean();
    let processed = 0;
    let updated = 0;

    for (const link of links) {
      processed++;
      try {
        const urlToUse = link.originalUrl || link.rawOriginalUrl;
        if (!urlToUse) continue;
        const info = await scrapeAmazonProduct(urlToUse);

        const update = {
          lastCheckedAt: new Date(),
          lastError: undefined,
        };

        if (info.price != null) {
          if (link.price != null && link.price !== info.price) {
            update.prevPrice = link.price;
            update.prevPriceCurrency = link.priceCurrency || info.priceCurrency;
            update.priceChangeReason = "maintenance_refresh";
          }
          update.price = info.price;
          update.priceCurrency = info.priceCurrency || link.priceCurrency;
          update.priceRaw = info.priceRaw || link.priceRaw;
        }

        if (info.imageUrl) update.imageUrl = info.imageUrl;
        if (info.images && info.images.length) update.images = info.images;
        if (info.shortDescription) update.shortDescription = info.shortDescription;
        if (info.longDescription) update.longDescription = info.longDescription;
        if (info.rating != null) update.rating = info.rating;
        if (info.reviewsCount != null) update.reviewsCount = info.reviewsCount;

        await Link.updateOne({ _id: link._id }, { $set: update });
        updated++;
      } catch (err) {
        console.error("maintenance scrape error for", link.id, err && err.message ? err.message : err);
        await Link.updateOne({ _id: link._id }, { $set: { lastCheckedAt: new Date(), lastError: err.message || String(err) } });
      }
    }

    res.json({ success: true, processed, updated });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res.status(500).json({ success: false, message: err.message || "Maintenance failed." });
  }
});

module.exports = router;