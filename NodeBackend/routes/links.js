// NodeBackend/routes/links.js
// Complete, resilient links API (create / bulk / all / go / update / delete / maintenance)

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const Link = require("../models/link");
const { scrapeAmazonProduct: legacyScrape } = require("../scrapers/amazon");

// OpenAI client (optional)
let openai = null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
if (OPENAI_KEY) {
  try {
    // FIX: Ensure OpenAI import is done correctly
    const { OpenAI } = require("openai");
    openai = new OpenAI({ apiKey: OPENAI_KEY });
    console.log("OpenAI client configured.");
  } catch (e) {
    console.warn("OpenAI SDK not installed or failed to init:", e.message || e);
    openai = null;
  }
} else {
  console.warn("OPENAI_API_KEY not set — AI rewriting disabled.");
}

const router = express.Router();

// ---------- Helpers ----------

function generateId(length = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function stripAmazonTracking(url) {
  try {
    const u = new URL(url);
    // Return origin + pathname (strip search params)
    return `${u.origin}${u.pathname}`;
  } catch (e) {
    return url;
  }
}

// ------------ robust resolveAmazonUrl ------------
async function resolveAmazonUrl(url) {
  if (!url) return null;
  if (/amazon\./i.test(url)) return stripAmazonTracking(url);

  const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_KEY || null;
  const tryGet = async (u) => {
    try {
      const res = await axios.get(u, {
        maxRedirects: 5,
        timeout: 15000,
        validateStatus: () => true, // allow non-2xx so we can inspect headers
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
      });
      const finalUrl =
        (res.request && res.request.res && res.request.res.responseUrl) ||
        (res.request &&
          res.request._redirectable &&
          res.request._redirectable._currentUrl) ||
        null;
      if (finalUrl) return stripAmazonTracking(finalUrl);

      const loc = (res.headers && (res.headers.location || res.headers.Location)) || null;
      if (loc) {
        try {
          return stripAmazonTracking(new URL(loc, u).toString());
        } catch {}
      }
      return null;
    } catch (err) {
      return null;
    }
  };

  // If scraper proxy key present, attempt to fetch via proxy which often resolves redirects
  if (SCRAPINGBEE_KEY) {
    try {
      const proxyUrl = `https://app.scrapingbee.com/api/v1?api_key=${encodeURIComponent(
        SCRAPINGBEE_KEY
      )}&url=${encodeURIComponent(url)}&render_js=false&forward_headers=true`;
      const pRes = await axios.get(proxyUrl, {
        timeout: 20000,
        validateStatus: () => true,
      });
      const finalUrl =
        (pRes.request && pRes.request.res && pRes.request.res.responseUrl) ||
        (pRes.request && pRes.request._redirectable && pRes.request._redirectable._currentUrl) ||
        null;
      if (finalUrl) return stripAmazonTracking(finalUrl);
    } catch (err) {
      console.warn("Scraper proxy resolve attempt failed:", err.message || err);
    }
  }

  // 1) tolerant GET
  try {
    const g = await tryGet(url);
    if (g) return g;
  } catch (e) {}

  // 2) HEAD fallback
  try {
    const head = await axios.head(url, {
      maxRedirects: 5,
      timeout: 10000,
      validateStatus: () => true,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const finalUrl =
      (head.request && head.request.res && head.request.res.responseUrl) ||
      (head.headers && (head.headers.location || head.headers.Location)) ||
      null;
    if (finalUrl) {
      try {
        return stripAmazonTracking(new URL(finalUrl, url).toString());
      } catch {}
    }
  } catch (e) {
    // ignore
  }

  // Last resort: return stripped original
  return stripAmazonTracking(url);
}

// ------------ price parsing helper ------------
function parsePriceValue(priceRaw) {
  if (!priceRaw) return { raw: null, parsed: null, currency: null };
  try {
    let s = priceRaw.toString().replace(/\u00A0/g, " ").trim();
    s = s.replace(/\s+/g, " ");
    if (!s) return { raw: priceRaw.toString(), parsed: null, currency: null };

    const currMatch = s.match(/(₹|Rs\.?|INR|USD|\$|£|€)/i);
    const currency = currMatch ? currMatch[0].replace(/\./g, "") : null;

    // Remove everything except digits, dot, comma
    let digits = s.replace(/[^\d.,]/g, "");
    if (!digits) return { raw: s, parsed: null, currency };

    // Remove comma thousand separators, keep the dot for decimals
    digits = digits.replace(/,/g, "");
    const num = parseFloat(digits);

    if (Number.isFinite(num)) return { raw: s, parsed: num, currency };

    // Try fallback regex for number groups
    const m = s.match(/([0-9]{1,3}(?:[.,][0-9]{2,3})+)/);
    if (m) {
      const candidate = m[1].replace(/,/g, "");
      const n2 = parseFloat(candidate);
      if (Number.isFinite(n2)) return { raw: s, parsed: n2, currency };
    }

    return { raw: s, parsed: null, currency };
  } catch (err) {
    return { raw: String(priceRaw), parsed: null, currency: null };
  }
}

// ------------ AI rewrite helper (optional) ------------
async function extractTextFromAIResponse(resp) {
  try {
    if (!resp) return "";
    // Note: OpenAI SDK v4+ uses message content structure
    if (resp.choices && resp.choices.length > 0 && resp.choices[0].message && resp.choices[0].message.content) {
        return resp.choices[0].message.content.trim();
    }
    // Fallback for older/different response structures
    if (typeof resp.output_text === "string" && resp.output_text.trim()) {
      return resp.output_text.trim();
    }
    if (Array.isArray(resp.output) && resp.output.length) {
      return resp.output
        .map((o) => {
          if (!o) return "";
          if (typeof o === "string") return o;
          if (Array.isArray(o.content)) {
            return o.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("");
          }
          return o.text || "";
        })
        .join("\n")
        .trim();
    }
    return "";
  } catch (err) {
    return "";
  }
}

async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;

  const systemPrompt = `You are an expert ecommerce copywriter. Given the product title and descriptions from an Amazon product page, return a JSON object (no extra text) with three properties:
- "title": an SEO-friendly product title (<= 120 chars).
- "short": a short 1-line card hook (<= 80 chars).
- "description": a 2-3 sentence user-focused description (<= 220 chars).
Output only valid JSON.`;
    
    const userMessage = `Input:
Title: ${title || ""}
ShortDescription: ${shortDescription || ""}
LongDescription: ${longDescription || ""}`;

  try {
    const resp = await openai.chat.completions.create({ // Use chat.completions for JSON output
      model: "gpt-4o-mini",
      messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
      ],
      max_tokens: 400,
      response_format: { type: "json_object" } // Request JSON object output
    });
    
    const aiText = await extractTextFromAIResponse(resp);
    // try parse JSON
    let parsed = null;
    try {
      parsed = JSON.parse(aiText);
    } catch (e) {
      const start = aiText.indexOf("{");
      const end = aiText.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          parsed = JSON.parse(aiText.slice(start, end + 1));
        } catch {}
      }
    }
    if (!parsed) {
      return {
        title,
        short: shortDescription || title,
        description: longDescription || shortDescription || title,
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

// ------------ scraping function that uses legacyScrape with safe fallbacks ------------
async function scrapeAmazonProduct(url) {
  // Normalize/resolve
  const finalUrl = await resolveAmazonUrl(url);

  // Try existing scraper module first (from /scrapers/amazon)
  try {
    const scraped = await legacyScrape(finalUrl);
    // legacyScrape returns many fields; unify into required subset
    return {
      finalUrl,
      title: scraped.title || scraped.shortTitle || "Amazon product",
      priceText: scraped.priceText || null,
      price: null, // we'll parse using parsePriceValue below
      priceCurrency: null,
      imageUrl: scraped.primaryImage || (scraped.images && scraped.images[0]) || null,
      primaryImage: scraped.primaryImage || null,
      images: scraped.images || [],
      shortDescription: scraped.shortDescription || null,
      longDescription: scraped.longDescription || null,
      rating: scraped.rating || null,
      reviewsCount: scraped.reviewsCount || null,
      categoryPath: scraped.categoryPath || [],
      slug: scraped.slug || null,
      brand: scraped.brand || null,
    };
  } catch (err) {
    // fallback fetch + cheerio parse
    try {
      const res = await axios.get(finalUrl, {
        maxRedirects: 5,
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9",
        },
        validateStatus: () => true,
      });

      const html = res.data || "";
      const $ = cheerio.load(html);

      const title = $("#productTitle").text().trim() || $("title").text().trim() || "Amazon product";

      // image selectors
      let image =
        $("#landingImage").attr("src") ||
        $("#imgTagWrapperId img").attr("data-old-hires") ||
        $('img[data-old-hires]').attr("data-old-hires") ||
        $('meta[property="og:image"]').attr("content") ||
        null;
      if (image && image.startsWith("//")) image = "https:" + image;

      // primary selectors for price (The Fix applied here too)
      let priceText =
        $("#corePriceDisplay_feature_div .a-offscreen").first().text().trim() || // NEW/UPDATED
        $("#desktop_buybox .a-price .a-offscreen").first().text().trim() || // NEW/UPDATED
        $("#priceblock_ourprice").text().trim() ||
        $("#priceblock_dealprice").text().trim() ||
        $("#corePrice_feature_div .a-offscreen").first().text().trim() ||
        $("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen").first().text().trim() ||
        $(".a-price .a-offscreen").first().text().trim() ||
        null;

      // If not found, try a page-wide regex (captures ₹, Rs, USD, $ etc.)
      if (!priceText || !priceText.trim()) {
        const pageText = (html || "").replace(/\s+/g, " ");
        const match = pageText.match(/(₹|Rs\.?|INR|\$|USD|£|€)\s?[0-9\.,]{1,}/i);
        if (match) {
          priceText = match[0];
          console.log("Price regex fallback found:", priceText);
        }
      }

      const priceParsed = parsePriceValue(priceText);
      if (!priceParsed.parsed && priceParsed.raw) {
        console.warn("Price present but failed to parse. raw price:", priceParsed.raw);
      }

      // bullets
      const bullets = [];
      $("#feature-bullets li").each((_, li) => {
        const t = $(li).text().replace(/\s+/g, " ").trim();
        if (t) bullets.push(t);
      });
      const shortDescription = bullets[0] || null;
      const longDescription = bullets.slice(0, 5).join(" ") || null;

      // rating
      let rating = null;
      const ratingText = $(".a-icon.a-icon-star span.a-icon-alt").first().text();
      if (ratingText) {
        const m = ratingText.match(/([\d.]+)/);
        if (m) rating = parseFloat(m[1]);
      }

      // reviews count
      let reviewsCount = null;
      const reviewsText = $("#acrCustomerReviewText").text();
      if (reviewsText) {
        const m2 = reviewsText.replace(/,/g, "").match(/([\d]+)/);
        if (m2) reviewsCount = parseInt(m2[1], 10);
      }

      // category path
      const categoryPath = [];
      $("#wayfinding-breadcrumbs_container ul li a").each((_, a) => {
        const t = $(a).text().replace(/\s+/g, " ").trim();
        if (t) categoryPath.push(t);
      });

      return {
        finalUrl,
        title,
        priceText: priceParsed.raw || priceText || null,
        price: priceParsed.parsed,
        priceCurrency: priceParsed.currency || null,
        imageUrl: image || null,
        primaryImage: image || null,
        images: image ? [image] : [],
        shortDescription,
        longDescription,
        rating,
        reviewsCount,
        categoryPath,
        slug: null,
        brand: null,
      };
    } catch (err2) {
      console.error("Fallback scrape failed:", err2.message || err2);
      throw err2;
    }
  }
}

// ------------ affiliate URL builder ------------
const DEFAULT_AMAZON_TAG = process.env.AMAZON_TAG || null;
function buildAffiliateUrl(canonicalUrl) {
  if (!canonicalUrl) return null;
  if (!DEFAULT_AMAZON_TAG) return canonicalUrl;
  if (/[?&]tag=/.test(canonicalUrl)) return canonicalUrl;
  const sep = canonicalUrl.includes("?") ? "&" : "?";
  return `${canonicalUrl}${sep}tag=${DEFAULT_AMAZON_TAG}`;
}

// ------------ create logic used by /create and /bulk ------------
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
  let scrapedData = null; // Store scraped data here

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
        priceCurrency = pp.currency || null;
        priceRaw = pp.raw || scrapedData.priceText;
      }
      imageUrl = scrapedData.imageUrl || scrapedData.primaryImage || null;
      shortDescription = scrapedData.shortDescription || "";
      longDescription = scrapedData.longDescription || "";
    } catch (err) {
      console.error("Scrape error for", originalUrl, err.message || err);
      scrapeError = err.message || String(err);
      // still try to resolve canonical URL
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

  // AI rewriting (optional) - Trigger only if we got some description from scraping
  let aiFields = null;
  if (openai && (shortDescription || longDescription)) {
    try {
      aiFields = await rewriteWithAI({
        title: finalTitle,
        shortDescription,
        longDescription,
      });
      if (aiFields && aiFields.title) {
        finalTitle = aiFields.title;
      }
    } catch (e) {
      console.error("AI rewrite failed:", e.message || e);
    }
  }

  // ensure numeric price is either a number or undefined (avoid Mongoose cast errors)
  const priceForDb = typeof priceNum === "number" && Number.isFinite(priceNum) ? priceNum : undefined;

  // affiliate deeplink (simple tag injection for now)
  const affiliateUrl = buildAffiliateUrl(normalizedUrl);

  const id = generateId(5);

  const doc = {
    id,
    source,
    title: finalTitle,
    shortTitle:
      (aiFields && aiFields.short) ||
      (finalTitle.length > 80 ? finalTitle.slice(0, 77).trimEnd() + "…" : finalTitle),
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
    prevPrice: undefined,
    prevPriceCurrency: undefined,
    priceChangeReason: undefined,
    rating: scrapedData?.rating || undefined,
    reviewsCount: scrapedData?.reviewsCount || undefined,
    shortDescription: (aiFields && aiFields.short) || shortDescription || undefined,
    longDescription: (aiFields && aiFields.description) || longDescription || undefined,
    slug: scrapedData?.slug || undefined,
    isActive: true,
    clicks: 0,
    lastCheckedAt: aiFields ? new Date() : undefined,
    lastError: scrapeError || undefined,
  };

  // create document
  const linkDoc = await Link.create(doc);
  return linkDoc;
}

// ---------- Routes ----------

router.get("/test", (req, res) => {
  res.json({ success: true, message: "Links API OK" });
});

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
    console.error("POST /create error:", err);
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
    if (lines.length > 10) return res.status(400).json({ success: false, message: "Please limit to 10 URLs at once." });

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

// legacy bulk that accepts { urls: [...] }
router.post("/bulk", async (req, res, next) => {
  try {
    const { urls } = req.body || {};
    if (Array.isArray(urls)) {
      req.body.urlsText = urls.join("\n");
    }
    // forward to /bulk1 handler
    return router.handle(req, res, next);
  } catch (err) {
    console.error("POST /bulk alias error:", err);
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

// maintenance: refresh info (price/image) for amazon links
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
        const update = { lastCheckedAt: new Date(), lastError: undefined };
        // price logic
        if (info.price != null) {
          if (link.price != null && link.price !== info.price) {
            update.prevPrice = link.price;
            update.prevPriceCurrency = link.priceCurrency || info.priceCurrency;
            update.priceChangeReason = "maintenance_refresh";
          }
          update.price = typeof info.price === "number" && Number.isFinite(info.price) ? info.price : link.price;
          update.priceCurrency = info.priceCurrency || link.priceCurrency;
          update.priceRaw = info.priceText || link.priceRaw;
        }
        if (info.primaryImage || info.imageUrl) update.imageUrl = info.primaryImage || info.imageUrl;
        if (info.images && info.images.length) update.images = info.images;
        if (info.rating != null) update.rating = info.rating;
        if (info.reviewsCount != null) update.reviewsCount = info.reviewsCount;
        if (info.shortDescription) update.shortDescription = info.shortDescription;
        if (info.longDescription) update.longDescription = info.longDescription;
        if (info.categoryPath && info.categoryPath.length) update.categoryPath = info.categoryPath;

        await Link.updateOne({ _id: link._id }, { $set: update });
        updated++;
      } catch (err) {
        console.error("maintenance scrape error for", link.id, err.message || err);
        await Link.updateOne({ _id: link._id }, { $set: { lastCheckedAt: new Date(), lastError: err.message || "maintenance_error" } });
      }
    }
    res.json({ success: true, processed, updated });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res.status(500).json({ success: false, message: err.message || "Maintenance failed." });
  }
});

module.exports = router;
