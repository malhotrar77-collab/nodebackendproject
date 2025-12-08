// NodeBackend/routes/links.js

const express = require("express");
const router = express.Router();
const { createAdmitadDeeplink } = require("./admitadClient"); // future Admitad use
const Link = require("../models/link");
const mongoose = require("../db");

// ---------- CONFIG ----------

const AMAZON_TAG = "alwaysonsal08-21";

// For later when Admitad programs are approved
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // TODO: real campaign ID later
  },
];

// ---------- HELPERS ----------

// Generate short human-safe ID like "447a01"
function generateId() {
  return Math.random().toString(16).slice(2, 8);
}

// Canonical Amazon URL: https://www.amazon.in/dp/ASIN (keep amzn.to as-is)
function normalizeAmazonUrl(originalUrl) {
  try {
    const u = new URL(originalUrl);
    const host = u.hostname.toLowerCase();

    // keep shortlinks as they are
    if (host === "amzn.to") return originalUrl;

    if (!host.includes("amazon.")) return originalUrl;

    const segments = u.pathname.split("/").filter(Boolean);
    let asin = null;

    for (let i = 0; i < segments.length; i++) {
      const part = segments[i].toLowerCase();

      if (part === "dp" && segments[i + 1]) {
        asin = segments[i + 1];
        break;
      }

      if (
        part === "gp" &&
        segments[i + 1] &&
        segments[i + 1].toLowerCase() === "product" &&
        segments[i + 2]
      ) {
        asin = segments[i + 2];
        break;
      }
    }

    if (!asin) return originalUrl;

    return `${u.protocol}//${host}/dp/${asin}`;
  } catch (e) {
    return originalUrl;
  }
}

// Very simple Amazon page scrape for title + image + price (V2, with bot detection)
async function scrapeAmazonMeta(productUrl) {
  try {
    let u;
    try {
      u = new URL(productUrl);
    } catch {
      console.error("❌ Amazon scrape failed: Invalid URL");
      return { title: null, imageUrl: null, price: null };
    }

    const res = await fetch(u.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) {
      console.warn("Amazon fetch status:", res.status);
      return { title: null, imageUrl: null, price: null };
    }

    const html = await res.text();

    // Detect Amazon bot page
    if (
      html.includes("automated access to Amazon data") ||
      html.includes("/errors/validateCaptcha") ||
      html.toLowerCase().includes("bot detection")
    ) {
      console.warn("Amazon bot page detected for URL", productUrl);
      return { title: null, imageUrl: null, price: null };
    }

    // Title from #productTitle
    let title = null;
    let m = html.match(/id="productTitle"[^>]*>([^<]+)</i);
    if (m && m[1]) {
      title = m[1].trim().replace(/\s+/g, " ");
    } else {
      // Fallback: <title>...</title>
      m = html.match(/<title>([^<]+)<\/title>/i);
      if (m && m[1]) {
        title = m[1].trim().replace(/\s+/g, " ");
      }
    }

    // Image: grab first m.media-amazon.com jpg
    let imageUrl = null;
    const imgMatch = html.match(
      /https:\/\/m\.media-amazon\.com\/images\/[^"]+\.jpg/
    );
    if (imgMatch && imgMatch[0]) {
      imageUrl = imgMatch[0];
    }

    // Price: try a few common patterns
    let price = null;

    // Pattern like ₹1,499 or $29.99 (look near price tags)
    const priceRegexes = [
      /id="priceblock_ourprice"[^>]*>\s*([^<]+)\s*</i,
      /id="priceblock_dealprice"[^>]*>\s*([^<]+)\s*</i,
      /id="sns-base-price"[^>]*>\s*([^<]+)\s*</i,
      /class="a-price-whole"[^>]*>\s*([^<]+)\s*</i,
    ];

    for (const re of priceRegexes) {
      const pm = html.match(re);
      if (pm && pm[1]) {
        price = pm[1].trim().replace(/\s+/g, " ");
        break;
      }
    }

    return { title, imageUrl, price };
  } catch (err) {
    console.error("Error scraping Amazon:", err.message);
    return { title: null, imageUrl: null, price: null };
  }
}

// Convert "true"/"1"/"on" to boolean
function boolFromQueryOrBody(v) {
  if (typeof v === "boolean") return v;
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// ---------- AUTO-CATEGORY v2 ----------

function inferCategoryFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();

  // More specific first
  if (t.includes("sneaker") || t.includes("running shoe") || t.includes("sports shoe"))
    return "shoes";
  if (t.includes("loafer") || t.includes("sandal") || t.includes("flip flop"))
    return "footwear";
  if (t.includes("tote bag") || t.includes("handbag") || t.includes("backpack"))
    return "bags";
  if (t.includes("wallet")) return "wallets";

  if (t.includes("t-shirt") || t.includes("t shirt") || t.includes("tee"))
    return "tshirts";
  if (t.includes("jeans") || t.includes("denim")) return "jeans";
  if (t.includes("hoodie") || t.includes("sweatshirt")) return "hoodies";
  if (
    t.includes("shirt") ||
    t.includes("kurta") ||
    t.includes("trouser") ||
    t.includes("pants") ||
    t.includes("shorts") ||
    t.includes("jogger")
  )
    return "clothing";

  if (t.includes("watch") && !t.includes("smartwatch") && !t.includes("smart watch"))
    return "watches";

  if (t.includes("smartwatch") || t.includes("smart watch")) return "smartwatches";

  if (
    t.includes("phone") ||
    t.includes("iphone") ||
    t.includes("smartphone") ||
    t.includes("mobile")
  )
    return "mobiles";

  if (t.includes("laptop") || t.includes("notebook")) return "laptops";

  if (
    t.includes("headphone") ||
    t.includes("earbud") ||
    t.includes("ear buds") ||
    t.includes("earphone")
  )
    return "audio";

  if (
    t.includes("mixer") ||
    t.includes("blender") ||
    t.includes("cooker") ||
    t.includes("fryer") ||
    t.includes("microwave")
  )
    return "kitchen";

  if (
    t.includes("sofa") ||
    t.includes("bed sheet") ||
    t.includes("bedsheet") ||
    t.includes("pillow") ||
    t.includes("cushion")
  )
    return "home";

  if (t.includes("cream") || t.includes("serum") || t.includes("shampoo"))
    return "beauty";

  // fallback
  return null;
}

// ---------- ROUTES ----------

// DB status helper (for debugging)
router.get("/dbtest", (req, res) => {
  const rs = mongoose.connection.readyState; // 0=disconnected,1=connected,2=connecting,3=disconnecting
  res.json({
    ok: true,
    readyState: rs,
    message:
      rs === 1
        ? "MongoDB connected"
        : rs === 2
        ? "MongoDB connecting"
        : "MongoDB NOT connected",
  });
});

// Simple test
router.get("/test", (req, res) => {
  res.json({ success: true, message: "links router working" });
});

// Get all links
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ success: false, message: "Failed to load links" });
  }
});

// Create (Amazon only for now, including amzn.to short links)
router.post("/create", async (req, res) => {
  try {
    const rawUrl = (req.body.url || "").trim();
    if (!rawUrl) {
      return res.status(400).json({ success: false, message: "Missing url" });
    }

    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return res
        .status(400)
        .json({ success: false, message: "Invalid URL format." });
    }

    const host = u.hostname.toLowerCase();
    const isAmazon =
      host === "amzn.to" || host.includes("amazon.in") || host.includes("amazon.");

    if (!isAmazon) {
      return res.status(400).json({
        success: false,
        message:
          "Right now only Amazon product URLs (including amzn.to) are supported.",
      });
    }

    const manualTitle = (req.body.title || "").trim();
    const manualCategory = (req.body.category || "").trim();
    const note = (req.body.note || "").trim();
    const autoTitle = boolFromQueryOrBody(req.body.autoTitle);

    const canonicalUrl = normalizeAmazonUrl(rawUrl);
    const joinChar = canonicalUrl.includes("?") ? "&" : "?";
    const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

    // Scrape page (for title + image + price)
    let scrapedTitle = null;
    let imageUrl = null;
    let price = null;
    try {
      const scraped = await scrapeAmazonMeta(canonicalUrl);
      scrapedTitle = scraped.title;
      imageUrl = scraped.imageUrl;
      price = scraped.price;
    } catch (_) {
      // ignore scraping failures
    }

    // Decide final title
    let finalTitle = manualTitle || null;
    if (!finalTitle && autoTitle && scrapedTitle) {
      finalTitle = scrapedTitle;
    }

    // Auto-category v2
    let finalCategory = manualCategory || null;
    if (!finalCategory) {
      finalCategory = inferCategoryFromTitle(finalTitle || scrapedTitle);
    }

    const doc = await Link.create({
      id: generateId(),
      source: "amazon",
      title: finalTitle,
      category: finalCategory,
      note: note || null,
      originalUrl: canonicalUrl,
      rawOriginalUrl: rawUrl,
      affiliateUrl,
      tag: AMAZON_TAG,
      imageUrl: imageUrl || null,
      images: imageUrl ? [imageUrl] : [],
      price: price || null,
      clicks: 0,
    });

    res.json({ success: true, link: doc });
  } catch (err) {
    console.error("POST /create error:", err);
    res.status(500).json({ success: false, message: "Failed to create link" });
  }
});

// Bulk-create multiple Amazon links
router.post("/bulk", async (req, res) => {
  try {
    const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
    if (!urls.length) {
      return res
        .status(400)
        .json({ success: false, message: "No URLs provided for bulk create." });
    }
    if (urls.length > 10) {
      return res
        .status(400)
        .json({ success: false, message: "Limit bulk create to 10 URLs." });
    }

    const manualTitle = (req.body.title || "").trim(); // optional shared title
    const manualCategory = (req.body.category || "").trim();
    const note = (req.body.note || "").trim();
    const autoTitle = boolFromQueryOrBody(req.body.autoTitle);

    const createdLinks = [];

    for (const raw of urls) {
      const rawUrl = (raw || "").trim();
      if (!rawUrl) continue;

      let u;
      try {
        u = new URL(rawUrl);
      } catch {
        console.warn("Skipping invalid URL in bulk:", rawUrl);
        continue;
      }

      const host = u.hostname.toLowerCase();
      const isAmazon =
        host === "amzn.to" || host.includes("amazon.in") || host.includes("amazon.");

      if (!isAmazon) {
        console.warn("Skipping non-Amazon URL in bulk:", rawUrl);
        continue;
      }

      const canonicalUrl = normalizeAmazonUrl(rawUrl);
      const joinChar = canonicalUrl.includes("?") ? "&" : "?";
      const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

      let scrapedTitle = null;
      let imageUrl = null;
      let price = null;
      try {
        const scraped = await scrapeAmazonMeta(canonicalUrl);
        scrapedTitle = scraped.title;
        imageUrl = scraped.imageUrl;
        price = scraped.price;
      } catch (_) {
        // ignore
      }

      let finalTitle = manualTitle || null;
      if (!finalTitle && autoTitle && scrapedTitle) {
        finalTitle = scrapedTitle;
      }

      let finalCategory = manualCategory || null;
      if (!finalCategory) {
        finalCategory = inferCategoryFromTitle(finalTitle || scrapedTitle);
      }

      const doc = await Link.create({
        id: generateId(),
        source: "amazon",
        title: finalTitle,
        category: finalCategory,
        note: note || null,
        originalUrl: canonicalUrl,
        rawOriginalUrl: rawUrl,
        affiliateUrl,
        tag: AMAZON_TAG,
        imageUrl: imageUrl || null,
        images: imageUrl ? [imageUrl] : [],
        price: price || null,
        clicks: 0,
      });

      createdLinks.push(doc);
    }

    res.json({
      success: true,
      createdCount: createdLinks.length,
      links: createdLinks,
    });
  } catch (err) {
    console.error("POST /bulk error:", err);
    res
      .status(500)
      .json({ success: false, message: "Bulk create failed." });
  }
});

// Redirect + click count
router.get("/go/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const link = await Link.findOne({ id });

    if (!link) {
      return res.status(404).json({ success: false, message: "Link not found" });
    }

    link.clicks = (link.clicks || 0) + 1;
    await link.save();

    res.redirect(link.affiliateUrl);
  } catch (err) {
    console.error("GET /go/:id error:", err);
    res.status(500).json({ success: false, message: "Redirect failed" });
  }
});

// Delete
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await Link.deleteOne({ id });

    if (!result.deletedCount) {
      return res
        .status(404)
        .json({ success: false, message: "No link with that ID" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /delete/:id error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to delete link" });
  }
});

// UPDATE an existing link (title / category / price / note)
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, price, note } = req.body;

    const link = await Link.findOne({ id });
    if (!link) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }

    if (typeof title === "string") link.title = title.trim();
    if (typeof category === "string") link.category = category.trim();
    if (typeof note === "string") link.note = note.trim();
    if (typeof price === "string") link.price = price.trim();

    await link.save();

    res.json({ success: true, link });
  } catch (err) {
    console.error("Update link failed:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to update link." });
  }
});

// ---------- Maintenance: refresh meta (title/image/price) for some links ----------
// NOTE: You don't have to use this now; it's safe to keep but you can avoid calling it.
router.get("/maintenance/daily", async (req, res) => {
  try {
    const limit = Math.min(
      20,
      Math.max(1, Number(req.query.limit || 15))
    );

    const links = await Link.find({ source: "amazon" })
      .sort({ updatedAt: 1 })
      .limit(limit);

    let updatedCount = 0;

    for (const link of links) {
      const targetUrl = link.originalUrl || link.rawOriginalUrl;
      if (!targetUrl) continue;

      let meta;
      try {
        meta = await scrapeAmazonMeta(targetUrl);
      } catch (e) {
        console.warn("Maintenance scrape failed for", targetUrl);
        continue;
      }

      const { title, imageUrl, price } = meta;

      // Only update if we actually got something
      let changed = false;

      if (title && (!link.title || link.title === "-")) {
        link.title = title;
        changed = true;
      }

      if (imageUrl && !link.imageUrl) {
        link.imageUrl = imageUrl;
        if (!Array.isArray(link.images) || !link.images.length) {
          link.images = [imageUrl];
        }
        changed = true;
      }

      if (price && !link.price) {
        link.price = price;
        changed = true;
      }

      if (changed) {
        await link.save();
        updatedCount++;
      }
    }

    res.json({
      success: true,
      processed: links.length,
      updated: updatedCount,
    });
  } catch (err) {
    console.error("GET /maintenance/daily error:", err);
    res.status(500).json({
      success: false,
      message: "Maintenance job failed.",
    });
  }
});

// ---------- Admitad (will show invalid_scope until approved) ----------

router.get("/admitad", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();

  if (!originalUrl) {
    return res
      .status(400)
      .json({ success: false, message: "Missing ?url parameter" });
  }

  const lower = originalUrl.toLowerCase();
  const program = ADMITAD_PROGRAMS.find((p) => lower.includes(p.pattern));

  if (!program) {
    return res.status(400).json({
      success: false,
      message: "No matching Admitad program for this URL.",
    });
  }

  try {
    const affiliateUrl = await createAdmitadDeeplink({
      campaignId: program.campaignId,
      url: originalUrl,
    });

    const doc = await Link.create({
      id: generateId(),
      source: `admitad-${program.key}`,
      originalUrl,
      affiliateUrl,
      clicks: 0,
    });

    res.json({ success: true, link: doc });
  } catch (err) {
    console.error("Admitad API ERROR →", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message:
        err.response?.data?.error_description ||
        err.response?.data?.error ||
        "Failed to generate Admitad deeplink.",
    });
  }
});

module.exports = router;