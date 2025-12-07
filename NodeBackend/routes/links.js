// NodeBackend/routes/links.js

const express = require("express");
const router = express.Router();
const { createAdmitadDeeplink } = require("./admitadClient"); // still future
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

// Canonical Amazon URL: https://www.amazon.in/dp/ASIN  (keep amzn.to as-is)
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

// ---------- AMAZON SCRAPER V3 ----------

// Very simple Amazon page scrape for title + image URL + price + availability
async function scrapeAmazonMeta(productUrl) {
  try {
    const res = await fetch(productUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });

    const statusCode = res.status;

    if (!res.ok) {
      console.warn("Amazon fetch status:", res.status);
      return {
        title: null,
        imageUrl: null,
        price: null,
        priceCurrency: null,
        unavailable: res.status === 404,
        statusCode,
      };
    }

    const html = await res.text();

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
    const imgMatch = html.match(/https:\/\/m\.media-amazon\.com\/images\/[^"]+\.jpg/);
    if (imgMatch && imgMatch[0]) {
      imageUrl = imgMatch[0];
    }

    // Price: try multiple patterns (Option B)
    let price = null;
    let priceCurrency = "INR";

    // common "a-offscreen" pattern
    let priceMatch = html.match(/class="a-offscreen">([^<]+)</i);
    if (priceMatch && priceMatch[1]) {
      const raw = priceMatch[1].replace(/[,₹\s]/g, "");
      const num = parseFloat(raw);
      if (!Number.isNaN(num)) {
        price = num;
      }
    }

    // If still no price, try priceblock
    if (price == null) {
      priceMatch = html.match(/id="priceblock_ourprice"[^>]*>\s*([^<]+)</i);
      if (!priceMatch) {
        priceMatch = html.match(/id="priceblock_dealprice"[^>]*>\s*([^<]+)</i);
      }
      if (priceMatch && priceMatch[1]) {
        const raw = priceMatch[1].replace(/[,₹\s]/g, "");
        const num = parseFloat(raw);
        if (!Number.isNaN(num)) {
          price = num;
        }
      }
    }

    // Very rough "currently unavailable"
    const unavailable =
      /currently unavailable/i.test(html) ||
      /temporarily unavailable/i.test(html) ||
      statusCode === 404;

    return { title, imageUrl, price, priceCurrency, unavailable, statusCode };
  } catch (err) {
    console.error("Error scraping Amazon:", err.message);
    return {
      title: null,
      imageUrl: null,
      price: null,
      priceCurrency: null,
      unavailable: true,
      statusCode: null,
    };
  }
}

// Helper: create Link doc from URL + shared fields
async function createLinkFromUrl({
  rawUrl,
  manualTitle,
  manualCategory,
  note,
  autoTitle,
}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL format.");
  }

  const host = u.hostname.toLowerCase();
  const isAmazon =
    host === "amzn.to" || host.includes("amazon.in") || host.includes("amazon.");

  if (!isAmazon) {
    throw new Error(
      "Right now only Amazon product URLs (including amzn.to) are supported."
    );
  }

  const canonicalUrl = normalizeAmazonUrl(rawUrl);
  const joinChar = canonicalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

  // Scrape page (for title + image + price)
  let scrapedTitle = null;
  let imageUrl = null;
  let price = null;
  let priceCurrency = "INR";
  let unavailable = false;

  try {
    const scraped = await scrapeAmazonMeta(canonicalUrl);
    scrapedTitle = scraped.title;
    imageUrl = scraped.imageUrl;
    price = scraped.price;
    if (scraped.priceCurrency) priceCurrency = scraped.priceCurrency;
    unavailable = scraped.unavailable;
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
    price: price != null ? price : null,
    prevPrice: null,
    priceCurrency,
    clicks: 0,
    isActive: !unavailable,
    statusReason: unavailable ? "unavailable_at_create" : null,
    lastCheckedAt: null,
  });

  return doc;
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

// Analytics summary (for dashboard box)
router.get("/summary", async (req, res) => {
  try {
    const links = await Link.find().lean();
    const totalLinks = links.length;
    const totalClicks = links.reduce((sum, l) => sum + (l.clicks || 0), 0);

    const top = [...links]
      .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
      .slice(0, 5)
      .map((l) => ({
        id: l.id,
        title: l.title || l.originalUrl || "",
        clicks: l.clicks || 0,
      }));

    res.json({
      success: true,
      totalLinks,
      totalClicks,
      top,
    });
  } catch (err) {
    console.error("GET /summary error:", err);
    res.status(500).json({ success: false, message: "Failed to load summary" });
  }
});

// Create (Amazon only for now, including amzn.to short links)
router.post("/create", async (req, res) => {
  try {
    const rawUrl = (req.body.url || "").trim();
    if (!rawUrl) {
      return res.status(400).json({ success: false, message: "Missing url" });
    }

    const manualTitle = (req.body.title || "").trim();
    const manualCategory = (req.body.category || "").trim();
    const note = (req.body.note || "").trim();
    const autoTitle = boolFromQueryOrBody(req.body.autoTitle);

    const doc = await createLinkFromUrl({
      rawUrl,
      manualTitle,
      manualCategory,
      note,
      autoTitle,
    });

    res.json({ success: true, link: doc });
  } catch (err) {
    console.error("POST /create error:", err);
    res
      .status(400)
      .json({ success: false, message: err.message || "Failed to create link" });
  }
});

// Bulk create
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
        .json({ success: false, message: "Limit is 10 URLs at once." });
    }

    const manualTitle = (req.body.title || "").trim();
    const manualCategory = (req.body.category || "").trim();
    const note = (req.body.note || "").trim();
    const autoTitle = boolFromQueryOrBody(req.body.autoTitle);

    const results = [];
    for (const rawUrl of urls) {
      const trimmed = (rawUrl || "").trim();
      if (!trimmed) continue;

      try {
        const doc = await createLinkFromUrl({
          rawUrl: trimmed,
          manualTitle,
          manualCategory,
          note,
          autoTitle,
        });
        results.push({ ok: true, id: doc.id });
      } catch (e) {
        console.warn("Bulk create failed for URL:", trimmed, e.message);
        results.push({ ok: false, url: trimmed, error: e.message });
      }
    }

    const createdCount = results.filter((r) => r.ok).length;

    res.json({
      success: true,
      createdCount,
      results,
    });
  } catch (err) {
    console.error("POST /bulk error:", err);
    res.status(500).json({ success: false, message: "Bulk create failed." });
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

// Edit / update (title, category, note)
router.patch("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    if (req.body.title !== undefined) updates.title = (req.body.title || "").trim();
    if (req.body.category !== undefined)
      updates.category = (req.body.category || "").trim();
    if (req.body.note !== undefined) updates.note = (req.body.note || "").trim();

    const link = await Link.findOneAndUpdate({ id }, updates, {
      new: true,
    }).lean();

    if (!link) {
      return res
        .status(404)
        .json({ success: false, message: "No link with that ID" });
    }

    res.json({ success: true, link });
  } catch (err) {
    console.error("PATCH /update/:id error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to update link" });
  }
});

// ---------- DAILY MAINTENANCE (for cron + manual button) ----------

router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find().lean();

    let checked = 0;
    let updatedPrices = 0;
    let deactivated = 0;

    for (const link of links) {
      if (!link.originalUrl && !link.rawOriginalUrl) continue;

      const urlToCheck = link.originalUrl || link.rawOriginalUrl;

      const scraped = await scrapeAmazonMeta(urlToCheck);

      const updates = {
        lastCheckedAt: new Date(),
      };

      // price update
      if (scraped.price != null) {
        const oldPrice = link.price != null ? link.price : null;
        if (oldPrice === null || oldPrice !== scraped.price) {
          updates.prevPrice = oldPrice;
          updates.price = scraped.price;
          updates.priceCurrency = scraped.priceCurrency || link.priceCurrency || "INR";
          updatedPrices++;
        }
      }

      // availability / active
      if (scraped.unavailable) {
        if (link.isActive !== false) {
          updates.isActive = false;
          updates.statusReason = "unavailable_daily_check";
          deactivated++;
        }
      } else if (link.isActive === false) {
        // became available again
        updates.isActive = true;
        updates.statusReason = null;
      }

      await Link.updateOne({ _id: link._id }, { $set: updates });

      checked++;
    }

    res.json({
      success: true,
      checked,
      updatedPrices,
      deactivated,
      message: `Daily maintenance done. Checked ${checked}, updated prices for ${updatedPrices}, deactivated ${deactivated}.`,
    });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res.status(500).json({
      success: false,
      message: "Daily maintenance failed.",
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
