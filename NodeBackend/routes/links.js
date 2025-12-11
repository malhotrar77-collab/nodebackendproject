// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const Link = require("../models/link");
const { scrapeAmazonProduct: legacyScrape } = require("../scrapers/amazon");

// OpenAI client
const { OpenAI } = require("openai");
const openaiKey = process.env.OPENAI_API_KEY || "";
let openai = null;
if (openaiKey) {
  openai = new OpenAI({ apiKey: openaiKey });
} else {
  console.warn("OPENAI_API_KEY is not set; AI rewriting will be disabled.");
}

const router = express.Router();

// ---------- Helpers ----------

// Simple random id, 5 chars like "a2f9x"
function generateId(length = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// Remove obvious tracking params so URLs are stable
function stripAmazonTracking(url) {
  try {
    const u = new URL(url);
    // Keep protocol + origin + pathname only (strip search params)
    const clean = `${u.origin}${u.pathname}`;
    return clean;
  } catch {
    return url;
  }
}

// Try to resolve short amzn.to links (best effort)
async function resolveAmazonUrl(url) {
  if (!url) return null;
  if (/amazon\./i.test(url)) return stripAmazonTracking(url);

  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });

    // axios stores final URL differently depending on environment; try both
    const finalUrl =
      (res.request && res.request.res && res.request.res.responseUrl) ||
      (res.request && res.request._redirectable && res.request._redirectable._currentUrl) ||
      url;

    return stripAmazonTracking(finalUrl);
  } catch (err) {
    console.warn("resolveAmazonUrl failed, returning original:", err.message);
    return stripAmazonTracking(url);
  }
}

// Robustly extract text from OpenAI responses
function extractTextFromAIResponse(resp) {
  try {
    // new SDK often gives `output` (array) and sometimes `output_text`
    if (!resp) return "";
    if (typeof resp.output_text === "string" && resp.output_text.trim()) {
      return resp.output_text.trim();
    }
    if (Array.isArray(resp.output) && resp.output.length) {
      // join content pieces
      return resp.output
        .map((o) => {
          if (!o) return "";
          if (typeof o === "string") return o;
          if (Array.isArray(o.content)) {
            return o.content
              .map((c) => (typeof c === "string" ? c : c.text || ""))
              .join("");
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

// Ask OpenAI to rewrite title & descriptions for SEO + short card copy
async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;

  // Build a compact prompt that returns JSON we can parse easily
  const prompt = `
You are an expert ecommerce copywriter. Given the product title and descriptions from an Amazon product page, return a JSON object (no extra text) with three properties:
- "title": an SEO-friendly product title (keep it <= 120 chars).
- "short": a short 1-line card title / hook (<= 80 chars).
- "description": a 2-3 sentence, user-focused description suitable for product listing (<= 220 chars).

Input:
Title: ${title || ""}
ShortDescription: ${shortDescription || ""}
LongDescription: ${longDescription || ""}

Output only valid JSON.
`;

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini", // if your account doesn't have this, change to a model available to you
      input: prompt,
      max_output_tokens: 400,
    });

    const aiText = extractTextFromAIResponse(resp);
    // resp often returns one string containing JSON; try to parse
    let parsed = null;
    try {
      parsed = JSON.parse(aiText);
    } catch (e) {
      // If there is extra text before/after JSON, try to locate JSON substring
      const start = aiText.indexOf("{");
      const end = aiText.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const jsonSub = aiText.slice(start, end + 1);
        try {
          parsed = JSON.parse(jsonSub);
        } catch (ee) {
          parsed = null;
        }
      }
    }

    if (!parsed) {
      // As a final fallback, return the plain text in fields
      return {
        title: title,
        short: shortDescription || title,
        description: longDescription || shortDescription || title,
        rawAI: aiText,
      };
    }

    return {
      title: parsed.title || title,
      short: parsed.short || (parsed.title || "").slice(0, 80),
      description:
        parsed.description ||
        parsed.longDescription ||
        parsed.short ||
        shortDescription ||
        title,
      rawAI: aiText,
    };
  } catch (err) {
    console.error("OpenAI rewrite failed:", err.message || err);
    return null;
  }
}

// Scrape Amazon product page for core data (re-using your scraper)
async function scrapeAmazonProduct(url) {
  // First resolve/normalize to canonical URL
  const finalUrl = await resolveAmazonUrl(url);

  // Use existing scraper module if it is present (keeps logic central)
  try {
    // legacyScrape returns many fields (title, shortTitle, priceText, images etc.)
    const scraped = await legacyScrape(finalUrl);
    // Ensure fields
    return {
      finalUrl: finalUrl,
      title: scraped.title || scraped.shortTitle || "Amazon product",
      price: scraped.priceText || null,
      imageUrl: scraped.primaryImage || (scraped.images && scraped.images[0]) || null,
      shortDescription: scraped.shortDescription || null,
      longDescription: scraped.longDescription || null,
    };
  } catch (err) {
    // fallback simple fetch + cheerio attempt (best-effort)
    try {
      const res = await axios.get(finalUrl, {
        maxRedirects: 5,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9",
        },
      });
      const $ = cheerio.load(res.data);
      const title = $("#productTitle").text().trim() || $("title").text().trim();
      const price =
        $("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen").first().text().trim() ||
        $(".a-price .a-offscreen").first().text().trim() ||
        null;
      let image =
        $("#landingImage").attr("src") ||
        $('img[data-old-hires]').attr("data-old-hires") ||
        $('meta[property="og:image"]').attr("content") ||
        null;
      if (image && image.startsWith("//")) image = "https:" + image;
      return {
        finalUrl,
        title: title || "Amazon product",
        price,
        imageUrl: image,
        shortDescription: null,
        longDescription: null,
      };
    } catch (err2) {
      console.error("Fallback scrape failed:", err2.message || err2);
      throw err2;
    }
  }
}

// Common creation logic used by /create and /bulk1
async function createAmazonLink({ originalUrl, title, category, note, autoTitle }) {
  if (!originalUrl) throw new Error("originalUrl is required");

  const source = "amazon";
  const categorySafe = category && category.trim() ? category.trim() : "other";
  const noteSafe = note && note.trim() ? note.trim() : "";

  let finalTitle = title && title.trim() ? title.trim() : "";
  let price = null;
  let imageUrl = null;
  let normalizedUrl = originalUrl;
  let scrapeError = null;
  let shortDescription = "";
  let longDescription = "";

  // Scrape if autoTitle is on OR we don't have a manual title
  if (autoTitle || !finalTitle) {
    try {
      const scraped = await scrapeAmazonProduct(originalUrl);
      normalizedUrl = scraped.finalUrl || originalUrl;
      if (!finalTitle && scraped.title) finalTitle = scraped.title;
      price = scraped.price || null;
      imageUrl = scraped.imageUrl || null;
      shortDescription = scraped.shortDescription || "";
      longDescription = scraped.longDescription || "";
    } catch (err) {
      console.error("Scrape error for", originalUrl, err.message || err);
      scrapeError = err.message || String(err);
    }
  } else {
    // still normalize URL
    normalizedUrl = await resolveAmazonUrl(originalUrl);
  }

  if (!finalTitle) finalTitle = "Amazon product";

  // Attempt AI rewrite (if OpenAI configured)
  let aiFields = null;
  if (openai) {
    try {
      const aiResp = await rewriteWithAI({
        title: finalTitle,
        shortDescription,
        longDescription,
      });
      if (aiResp) {
        aiFields = aiResp;
        // prefer AI title if provided
        if (aiResp.title) finalTitle = aiResp.title;
      }
    } catch (e) {
      console.error("AI rewrite failed:", e.message || e);
    }
  }

  // ensure we always set id because schema requires it
  const id = generateId(5);

  const linkDoc = await Link.create({
    id,
    source,
    title: finalTitle,
    shortTitle: (aiFields && aiFields.short) || (finalTitle.length > 80 ? finalTitle.slice(0, 77) + "…" : finalTitle),
    category: categorySafe,
    note: noteSafe,
    price: price || undefined,
    originalUrl: normalizedUrl,
    rawOriginalUrl: originalUrl,
    affiliateUrl: normalizedUrl, // until Admitad/other deeplink is wired in
    imageUrl: imageUrl || undefined,
    shortDescription: (aiFields && aiFields.short) || shortDescription || undefined,
    longDescription: (aiFields && aiFields.description) || longDescription || undefined,
    clicks: 0,
    lastCheckedAt: aiFields ? new Date() : null,
    lastError: scrapeError || undefined,
  });

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

// Bulk create (new endpoint used by updated dashboard)
router.post("/bulk1", async (req, res) => {
  try {
    const { urlsText, category, note, autoTitle = true } = req.body || {};
    if (!urlsText || !urlsText.trim()) {
      return res.status(400).json({ success: false, message: "urlsText is required" });
    }

    const lines = urlsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (!lines.length) {
      return res.status(400).json({ success: false, message: "No valid URLs found." });
    }

    if (lines.length > 10) {
      return res.status(400).json({ success: false, message: "Please limit to 10 URLs at once." });
    }

    const created = [];
    const errors = [];

    for (const url of lines) {
      try {
        const doc = await createAmazonLink({
          originalUrl: url,
          title: "",
          category,
          note,
          autoTitle,
        });
        created.push(doc);
      } catch (err) {
        console.error("Bulk create error for", url, err.message || err);
        errors.push({ url, error: err.message || String(err) });
      }
    }

    res.json({
      success: true,
      created: created.length,
      errors,
      links: created,
    });
  } catch (err) {
    console.error("POST /bulk1 error:", err);
    res.status(500).json({ success: false, message: err.message || "Bulk create failed." });
  }
});

// alias /bulk -> forward to bulk1
router.post("/bulk", async (req, res, next) => {
  // transform urls array to urlsText if needed
  try {
    const { urls } = req.body || {};
    if (Array.isArray(urls)) {
      req.body.urlsText = urls.join("\n");
    }
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
    if (typeof price === "string" || typeof price === "number") update.price = price;
    if (typeof note === "string") update.note = note;

    const updated = await Link.findOneAndUpdate({ id }, update, { new: true }).lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: "Link not found." });
    }

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
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Link not found." });
    }
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

// Maintenance: refresh info for all amazon links
router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find({ source: "amazon" }).lean();
    let processed = 0;
    let updated = 0;

    for (const link of links) {
      processed++;
      try {
        const info = await scrapeAmazonProduct(link.originalUrl || link.rawOriginalUrl);
        await Link.updateOne(
          { _id: link._id },
          {
            $set: {
              price: info.price || link.price,
              imageUrl: info.imageUrl || link.imageUrl,
              lastCheckedAt: new Date(),
            },
          }
        );
        updated++;
      } catch (err) {
        console.error("maintenance scrape error for", link.id, err.message || err);
        await Link.updateOne({ _id: link._id }, { $set: { lastCheckedAt: new Date() } });
      }
    }

    res.json({ success: true, processed, updated });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res.status(500).json({ success: false, message: err.message || "Maintenance failed." });
  }
});

module.exports = router;