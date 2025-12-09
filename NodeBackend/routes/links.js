// NodeBackend/routes/links.js

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const client = require("cheerio-httpcli");
const dayjs = require("dayjs");

const Link = require("../models/link");

const router = express.Router();

/**
 * Helper: generate short id like "a2fd9c"
 */
function generateId(length = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Helper: normalise / detect Amazon URLs
 */
function isAmazonUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return u.includes("amazon.in") || u.includes("amazon.com") || u.includes("amzn.to");
}

/**
 * Scrape Amazon product page.
 * Uses cheerio-httpcli so it also follows amzn.to short links.
 */
async function scrapeAmazonProduct(rawUrl) {
  try {
    // Follow redirects (amzn.to etc.)
    const { $, response } = await client.fetch(rawUrl, {});

    const finalUrl =
      (response &&
        response.request &&
        response.request.uri &&
        response.request.uri.href) ||
      rawUrl;

    // Title
    let title =
      $("#productTitle").text().trim() ||
      $("h1 span.a-size-large").first().text().trim() ||
      $("title").text().trim() ||
      "Product";

    // Primary image
    let imageUrl =
      $("#imgTagWrapperId img").attr("src") ||
      $("#landingImage").attr("src") ||
      $("img#main-image").attr("src") ||
      null;

    // Price (best-effort)
    let priceText =
      $('[data-a-color="price"] span.a-offscreen').first().text().trim() ||
      $("#priceblock_ourprice").text().trim() ||
      $("#priceblock_dealprice").text().trim() ||
      null;

    // Category (breadcrumb)
    let category =
      $("#wayfinding-breadcrumbs_container ul li a")
        .last()
        .text()
        .trim()
        .toLowerCase() || "other";

    if (!category) category = "other";

    return {
      title,
      imageUrl,
      priceText,
      finalUrl,
      category,
    };
  } catch (err) {
    console.error("scrapeAmazonProduct error:", err.message || err);
    throw new Error("SCRAPE_FAILED");
  }
}

/**
 * Map raw price text like "₹1,299" to number + currency
 */
function parsePrice(priceText) {
  if (!priceText) return { price: null, priceCurrency: null };
  const currencyMatch = priceText.match(/[₹$€£]/);
  const currency = currencyMatch ? currencyMatch[0] : null;
  const numeric = priceText.replace(/[^\d.]/g, "");
  const price = numeric ? Number(numeric) : null;
  return { price, priceCurrency: currency };
}

// --- Simple test routes ---

router.get("/test", (req, res) => {
  res.json({ ok: true, message: "links API is alive" });
});

// quick DB test
router.get("/dbtest", async (req, res) => {
  try {
    const count = await Link.countDocuments();
    res.json({ ok: true, count });
  } catch (err) {
    console.error("dbtest error:", err);
    res.status(500).json({ ok: false, error: "DB error" });
  }
});

// --- Get all links for dashboard + store ---

router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ success: false, error: "Failed to load links" });
  }
});

// --- Create link (Amazon only, with scraping v2) ---

router.post("/create", async (req, res) => {
  try {
    // Be VERY forgiving about the field name so the dashboard never breaks
    let originalUrlRaw =
      (req.body.originalUrl ||
        req.body.rawOriginalUrl ||
        req.body.url ||
        req.body.affiliateUrl ||
        "").trim();

    const { title: manualTitle, category: manualCategory, note, autoTitle } =
      req.body;

    if (!originalUrlRaw) {
      return res
        .status(400)
        .json({ success: false, error: "originalUrl is required" });
    }

    if (!isAmazonUrl(originalUrlRaw)) {
      return res.status(400).json({
        success: false,
        error: "Only Amazon product links are supported right now.",
      });
    }

    // Scrape Amazon to auto-fill details
    let scraped = null;
    try {
      scraped = await scrapeAmazonProduct(originalUrlRaw);
    } catch (err) {
      if (err.message === "SCRAPE_FAILED") {
        // Don't block creation completely; create minimal link
        scraped = {
          title: manualTitle || "Product",
          imageUrl: null,
          priceText: null,
          finalUrl: originalUrlRaw,
          category: manualCategory || "other",
        };
      } else {
        throw err;
      }
    }

    const finalUrl = scraped.finalUrl || originalUrlRaw;
    const title =
      manualTitle && manualTitle.trim()
        ? manualTitle.trim()
        : autoTitle === false
        ? "Product"
        : scraped.title || "Product";

    const category = (manualCategory || scraped.category || "other").toLowerCase();

    const { price, priceCurrency } = parsePrice(scraped.priceText);

    const newLink = new Link({
      id: generateId(5),
      source: "amazon",
      title,
      category,
      note: note || "",
      // store both raw + canonical
      rawOriginalUrl: originalUrlRaw,
      originalUrl: finalUrl,
      affiliateUrl: finalUrl, // for now we use same – later we can swap to Admitad
      tag: "",
      imageUrl: scraped.imageUrl || null,
      images: scraped.imageUrl ? [scraped.imageUrl] : [],
      price,
      priceCurrency,
      clicks: 0,
      lastCheckedAt: null,
      inactive: false,
      inactiveReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await newLink.save();

    res.json({ success: true, link: newLink });
  } catch (err) {
    console.error("POST /create error:", err);
    res.status(500).json({ success: false, error: "Failed to create link" });
  }
});

// --- Redirect + click tracking ---

router.get("/go/:id", async (req, res) => {
  try {
    const link = await Link.findOne({ id: req.params.id });

    if (!link) {
      return res.status(404).send("Link not found");
    }

    link.clicks = (link.clicks || 0) + 1;
    link.updatedAt = new Date();
    await link.save();

    res.redirect(link.affiliateUrl || link.originalUrl);
  } catch (err) {
    console.error("GET /go/:id error:", err);
    res.status(500).send("Error redirecting");
  }
});

// --- Delete link ---

router.delete("/delete/:id", async (req, res) => {
  try {
    const deleted = await Link.findOneAndDelete({ id: req.params.id });
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, error: "Link not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /delete/:id error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to delete link" });
  }
});

// --- Daily maintenance: re-scrape prices / images for all links ---

router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find({ source: "amazon" });

    let processed = 0;
    let updated = 0;

    for (const link of links) {
      processed++;

      const urlToUse = link.rawOriginalUrl || link.originalUrl;
      if (!isAmazonUrl(urlToUse)) continue;

      try {
        const scraped = await scrapeAmazonProduct(urlToUse);
        const { price, priceCurrency } = parsePrice(scraped.priceText);

        // update fields
        if (scraped.title && (!link.title || link.title === "Product")) {
          link.title = scraped.title;
        }
        if (scraped.imageUrl && !link.imageUrl) {
          link.imageUrl = scraped.imageUrl;
          link.images =
            link.images && link.images.length ? link.images : [scraped.imageUrl];
        }
        if (price != null) {
          link.price = price;
          link.priceCurrency = priceCurrency;
        }

        link.originalUrl = scraped.finalUrl || link.originalUrl;
        link.lastCheckedAt = new Date();
        link.inactive = false;
        link.inactiveReason = null;

        await link.save();
        updated++;
      } catch (err) {
        console.warn(
          `Maintenance scrape error for ${link.id}:`,
          err.message || err
        );
        link.lastCheckedAt = new Date();
        link.inactive = true;
        link.inactiveReason = "SCRAPE_FAILED";
        await link.save();
      }
    }

    res.json({ success: true, processed, updated });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res.status(500).json({ success: false, error: "Maintenance failed" });
  }
});

// --- Placeholder for future Admitad integration ---

router.post("/admitad", (req, res) => {
  res.status(501).json({
    success: false,
    error: "Admitad integration not implemented yet (coming later).",
  });
});

module.exports = router;