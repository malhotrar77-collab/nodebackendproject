// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const Link = require("../models/link");
const { scrapeAmazonProduct: legacyScrape } = require("../scrapers/amazon");

// OpenAI client (official SDK)
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
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

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
      timeout: 15000,
    });

    const finalUrl =
      (res.request && res.request.res && res.request.res.responseUrl) ||
      (res.request && res.request._redirectable && res.request._redirectable._currentUrl) ||
      url;

    return stripAmazonTracking(finalUrl);
  } catch (err) {
    console.warn("resolveAmazonUrl failed, returning original:", err && err.message ? err.message : err);
    return stripAmazonTracking(url);
  }
}

// Price parser - returns number (or null)
function parsePriceValue(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;

  let s = String(raw).trim();

  // Empty
  if (!s) return null;

  // Remove currency symbols and non-digit except . and ,
  // But keep both . and , to attempt international formats
  s = s.replace(/\u00A0/g, " "); // non-breaking spaces
  // Common currency symbols
  s = s.replace(/[₹$€£¥¢฿₨₩]/g, "");
  // Remove any letters
  s = s.replace(/[A-Za-z]/g, "");
  s = s.replace(/^\s*-/g, ""); // strip leading dash

  // If string contains both '.' and ',' assume '.' is decimal only when '.' appears after comma? heuristic:
  // Common formats:
  //  - "1,234.56" -> remove commas -> 1234.56
  //  - "1.234,56" -> european -> replace '.' (thousand) with '' and replace ',' with '.' -> 1234.56
  //  - "₹57,990.00" -> remove ₹ and commas -> 57990.00

  const hasDot = s.indexOf(".") >= 0;
  const hasComma = s.indexOf(",") >= 0;

  try {
    if (hasDot && hasComma) {
      // Determine which is decimal by last separator
      const lastDot = s.lastIndexOf(".");
      const lastComma = s.lastIndexOf(",");
      if (lastDot > lastComma) {
        // dot is decimal separator, commas are thousands
        s = s.replace(/,/g, "");
      } else {
        // comma is decimal separator, dots are thousands
        s = s.replace(/\./g, "").replace(/,/g, ".");
      }
    } else if (hasComma && !hasDot) {
      // Could be "1,234" (thousands) or "1234,56" (decimal)
      // If there are multiple commas or length of part after comma == 2 assume decimal
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length === 2) {
        s = parts.join(".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else {
      // only dot or neither -> remove commas (already none)
      s = s.replace(/,/g, "");
    }

    // Remove whitespace leftover
    s = s.replace(/\s+/g, "");

    const num = Number(s);
    if (!Number.isFinite(num)) return null;
    return num;
  } catch (err) {
    console.warn("parsePriceValue error for raw:", raw, err && err.message ? err.message : err);
    return null;
  }
}

// Robustly extract text from OpenAI responses
function extractTextFromAIResponse(resp) {
  try {
    if (!resp) return "";
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
    // Newer SDK: resp.output?.[0]?.content?.[0]?.text
    if (resp?.output?.length && resp.output[0]?.content?.length) {
      return resp.output[0].content.map((c) => c.text || "").join("\n").trim();
    }
    return "";
  } catch (err) {
    return "";
  }
}

// Ask OpenAI to rewrite title & descriptions for SEO + short card copy
async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;

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
      model: "gpt-4o-mini", // if not available change to a model you have access to
      input: prompt,
      max_output_tokens: 400,
    });

    const aiText = extractTextFromAIResponse(resp);
    let parsed = null;
    try {
      parsed = JSON.parse(aiText);
    } catch (e) {
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
    console.error("OpenAI rewrite failed:", err && err.message ? err.message : err);
    return null;
  }
}

// Scrape Amazon product page for core data (re-using your scraper if present)
async function scrapeAmazonProduct(url) {
  const finalUrl = await resolveAmazonUrl(url);

  try {
    // attempt legacy scraper module (if exists)
    const scraped = await legacyScrape(finalUrl);
    return {
      finalUrl,
      title: scraped.title || scraped.shortTitle || "Amazon product",
      priceText: scraped.priceText || scraped.price || null,
      price: scraped.price || scraped.priceText || null,
      imageUrl: scraped.primaryImage || (scraped.images && scraped.images[0]) || null,
      shortDescription: scraped.shortDescription || null,
      longDescription: scraped.longDescription || null,
    };
  } catch (err) {
    // fallback simple fetch
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
        timeout: 15000,
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
        priceText: price,
        price: price,
        imageUrl: image,
        shortDescription: null,
        longDescription: null,
      };
    } catch (err2) {
      console.error("Fallback scrape failed:", err2 && err2.message ? err2.message : err2);
      throw err2;
    }
  }
}

// ---------- Core creation logic ----------
async function createAmazonLink({ originalUrl, title, category, note, autoTitle }) {
  if (!originalUrl) throw new Error("originalUrl is required");

  const source = "amazon";
  const categorySafe = category && category.trim() ? category.trim() : "other";
  const noteSafe = note && note.trim() ? note.trim() : "";

  let finalTitle = title && title.trim() ? title.trim() : "";
  let imageUrl = null;
  let normalizedUrl = originalUrl;
  let scrapeError = null;
  let shortDescription = "";
  let longDescription = "";
  let priceRaw = null;
  let parsedPrice = null;

  if (autoTitle || !finalTitle) {
    try {
      const scraped = await scrapeAmazonProduct(originalUrl);
      normalizedUrl = scraped.finalUrl || originalUrl;
      if (!finalTitle && scraped.title) finalTitle = scraped.title;
      imageUrl = scraped.imageUrl || null;
      shortDescription = scraped.shortDescription || "";
      longDescription = scraped.longDescription || "";
      priceRaw = scraped.priceText || scraped.price || null;
    } catch (err) {
      console.error("Scrape error for", originalUrl, err && err.message ? err.message : err);
      scrapeError = err && err.message ? err.message : String(err);
    }
  } else {
    normalizedUrl = await resolveAmazonUrl(originalUrl);
  }

  if (!finalTitle) finalTitle = "Amazon product";

  // parse price safely
  if (priceRaw != null) {
    parsedPrice = parsePriceValue(priceRaw);
    console.debug("Price parse:", { raw: priceRaw, parsed: parsedPrice });
    if (parsedPrice == null) {
      console.warn("Price present but failed to parse. raw price:", priceRaw);
    }
  } else {
    console.debug("Price parse: { raw: null, parsed: null }");
  }

  // AI rewrite
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
        if (aiResp.title) finalTitle = aiResp.title;
      }
    } catch (e) {
      console.error("AI rewrite failed:", e && e.message ? e.message : e);
    }
  }

  const id = generateId(5);

  const linkDoc = await Link.create({
    id,
    source,
    title: finalTitle,
    shortTitle: (aiFields && aiFields.short) || (finalTitle.length > 80 ? finalTitle.slice(0, 77) + "…" : finalTitle),
    category: categorySafe,
    note: noteSafe,
    price: parsedPrice != null ? parsedPrice : undefined,
    priceRaw: priceRaw || undefined,        // <-- stored raw string for debugging & display
    originalUrl: normalizedUrl,
    rawOriginalUrl: originalUrl,
    affiliateUrl: normalizedUrl, // placeholder until deeplinking
    imageUrl: imageUrl || undefined,
    shortDescription: (aiFields && aiFields.short) || shortDescription || undefined,
    longDescription: (aiFields && aiFields.description) || longDescription || undefined,
    clicks: 0,
    lastCheckedAt: new Date(),
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
    console.error("POST /create error:", err && err.message ? err.message : err);
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
        console.error("Bulk create error for", url, err && err.message ? err.message : err);
        errors.push({ url, error: err && err.message ? err.message : String(err) });
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
    if (typeof price === "string" || typeof price === "number") {
      const num = Number(price);
      if (!Number.isNaN(num)) update.price = num;
    }
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
        // set raw and parsed
        const rawFound = info.priceText || info.price || null;
        const maybePrice = parsePriceValue(rawFound);

        const update = {
          lastCheckedAt: new Date(),
          priceRaw: rawFound != null ? rawFound : undefined,
        };
        if (maybePrice != null) update.price = maybePrice;
        if (info.imageUrl) update.imageUrl = info.imageUrl;

        await Link.updateOne({ _id: link._id }, { $set: update });
        updated++;
      } catch (err) {
        console.error("maintenance scrape error for", link.id, err && err.message ? err.message : err);
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