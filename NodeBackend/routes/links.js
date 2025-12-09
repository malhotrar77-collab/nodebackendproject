// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");

const Link = require("../models/link");

const router = express.Router();

/**
 * Normalize an Amazon URL to canonical /dp/ASIN form.
 * Keeps query params only if they contain "tag=".
 */
function normalizeAmazonUrl(url) {
  try {
    const u = new URL(url.trim());

    // Force https and keep domain as-is (amazon.in / amazon.com etc.)
    u.protocol = "https:";

    const asinMatch =
      u.pathname.match(/\/dp\/([A-Z0-9]{10})/) ||
      u.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/);

    if (asinMatch) {
      u.pathname = `/dp/${asinMatch[1]}`;
    }

    // Keep only the affiliate tag if present
    const tag = u.searchParams.get("tag");
    u.search = "";
    if (tag) {
      u.searchParams.set("tag", tag);
    }

    return u.toString();
  } catch (e) {
    return url;
  }
}

/**
 * Headers to make Amazon a bit happier (avoid instant bot block).
 */
function amazonHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "en-IN,en;q=0.9",
  };
}

/**
 * Phase-3: Upgraded Amazon scraper.
 * - Extracts title
 * - Price & currency
 * - Main image + all images[]
 * - Short raw description pieces (we’ll use later for AI)
 */
async function scrapeAmazonProduct(originalUrl) {
  if (!originalUrl) {
    const err = new Error("originalUrl is required");
    err.code = "NO_URL";
    throw err;
  }

  const normalizedUrl = normalizeAmazonUrl(originalUrl);

  let response;
  try {
    response = await axios.get(normalizedUrl, {
      headers: amazonHeaders(),
      timeout: 15000,
    });
  } catch (err) {
    // Don’t crash maintenance – throw a tagged error
    const e = new Error(
      `Amazon request failed: ${err.response?.status || err.code || err.message}`
    );
    e.code = "AMAZON_HTTP_ERROR";
    e.status = err.response?.status;
    throw e;
  }

  const html = response.data;
  const $ = cheerio.load(html);

  // --- Title ---
  let title =
    $("#productTitle").text().trim() ||
    $('meta[name="title"]').attr("content") ||
    $('meta[property="og:title"]').attr("content") ||
    "";

  // Clean up weird whitespace
  title = title.replace(/\s+/g, " ").trim();

  // --- Price ---
  // We’ll try a few different selectors
  let priceText =
    $("#priceblock_dealprice").text().trim() ||
    $("#priceblock_ourprice").text().trim() ||
    $("#corePriceDisplay_desktop_feature_div span.a-offscreen").first().text().trim() ||
    $("span.a-price span.a-offscreen").first().text().trim() ||
    "";

  priceText = priceText.replace(/\s+/g, " ").trim();

  let price = null;
  let priceCurrency = null;

  // Example formats:
  // ₹1,999.00
  // Rs. 1,499
  if (priceText) {
    const numeric = priceText.replace(/[^\d.]/g, "");
    if (numeric) {
      price = Number(numeric);
      if (Number.isNaN(price)) {
        price = null;
      }
    }

    if (priceText.includes("₹") || priceText.toLowerCase().includes("rs")) {
      priceCurrency = "INR";
    }
  }

  // --- Images ---
  const images = [];

  // 1) data-a-dynamic-image (often contains multiple URLs)
  const dynamicImageJson = $("#landingImage").attr("data-a-dynamic-image");
  if (dynamicImageJson) {
    try {
      const obj = JSON.parse(dynamicImageJson);
      for (const key of Object.keys(obj)) {
        if (!images.includes(key)) {
          images.push(key);
        }
      }
    } catch {
      // ignore
    }
  }

  // 2) Main image by id
  const landingSrc = $("#landingImage").attr("src");
  if (landingSrc && !images.includes(landingSrc)) {
    images.push(landingSrc);
  }

  // 3) Thumbnail strip
  $(".imageThumb img, .imgTagWrapper img").each((_, el) => {
    const src =
      $(el).attr("data-src") || $(el).attr("data-old-hires") || $(el).attr("src");
    if (src && !images.includes(src)) {
      images.push(src);
    }
  });

  // 4) Fallback: og:image
  if (images.length === 0) {
    const og = $('meta[property="og:image"]').attr("content");
    if (og) images.push(og);
  }

  const mainImage = images.length ? images[0] : null;

  // --- Short raw description bits (for AI later) ---
  const bulletTexts = [];
  $("#feature-bullets li span").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) bulletTexts.push(t);
  });

  const description =
    $("#productDescription").text().replace(/\s+/g, " ").trim() || "";

  // --- Quick category guess (very rough, we’ll later use AI) ---
  let category = "other";
  const bodyText = $("body").text().toLowerCase();

  if (bodyText.includes("shoe") || bodyText.includes("sneaker")) category = "shoes";
  else if (bodyText.includes("t-shirt") || bodyText.includes("t shirt")) category = "tshirts";
  else if (bodyText.includes("jeans")) category = "jeans";
  else if (bodyText.includes("laptop")) category = "laptops";
  else if (
    bodyText.includes("shirt") ||
    bodyText.includes("sweater") ||
    bodyText.includes("pullover") ||
    bodyText.includes("hoodie")
  ) {
    category = "clothing";
  } else if (
    bodyText.includes("headphone") ||
    bodyText.includes("speaker") ||
    bodyText.includes("bluetooth") ||
    bodyText.includes("usb") ||
    bodyText.includes("hdmi")
  ) {
    category = "electronics";
  }

  return {
    source: "amazon",
    title: title || "Product",
    category,
    originalUrl: normalizedUrl,
    imageUrl: mainImage,
    images,
    raw: {
      bulletTexts,
      description,
      scrapedAt: new Date(),
    },
    price,
    priceCurrency,
  };
}

// ---------- ROUTES ----------

// Simple health check
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Links API OK" });
});

// DB test
router.get("/dbtest", async (req, res) => {
  try {
    const count = await Link.countDocuments();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get all links
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create a single affiliate link (Amazon only for now)
router.post("/create", async (req, res) => {
  const { originalUrl, category: manualCategory, note } = req.body || {};

  if (!originalUrl || !originalUrl.trim()) {
    return res
      .status(400)
      .json({ success: false, message: "originalUrl is required" });
  }

  try {
    const scrape = await scrapeAmazonProduct(originalUrl);

    const now = new Date();
    const id = Math.random().toString(16).slice(2, 8);

    const affiliateUrl = scrape.originalUrl; // we’ll later inject Admitad here

    const link = await Link.create({
      id,
      source: scrape.source,
      title: scrape.title,
      category: manualCategory || scrape.category || "other",
      note: note || "",
      originalUrl: scrape.originalUrl,
      rawOriginalUrl: originalUrl,
      affiliateUrl,
      tag: "",
      imageUrl: scrape.imageUrl,
      images: scrape.images || [],
      price: scrape.price,
      priceCurrency: scrape.priceCurrency,
      prevPrice: null,
      prevPriceCurrency: null,
      clicks: 0,
      isActive: true,
      createReason: "manual-create",
      lastCheckedAt: now,
      lastUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      extra: scrape.raw || {},
    });

    res.json({ success: true, link });
  } catch (err) {
    console.error("Create link scrape error:", err.message);
    const status = err.code === "NO_URL" ? 400 : 500;
    res
      .status(status)
      .json({ success: false, message: err.message || "Scrape failed" });
  }
});

// Bulk create (up to 10 URLs)
router.post("/create-multiple", async (req, res) => {
  const { urls, category: manualCategory, note } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "urls array is required" });
  }

  const results = [];
  for (const rawUrl of urls) {
    if (!rawUrl || !rawUrl.trim()) continue;
    try {
      const scrape = await scrapeAmazonProduct(rawUrl);
      const now = new Date();
      const id = Math.random().toString(16).slice(2, 8);
      const affiliateUrl = scrape.originalUrl;

      const link = await Link.create({
        id,
        source: scrape.source,
        title: scrape.title,
        category: manualCategory || scrape.category || "other",
        note: note || "",
        originalUrl: scrape.originalUrl,
        rawOriginalUrl: rawUrl,
        affiliateUrl,
        tag: "",
        imageUrl: scrape.imageUrl,
        images: scrape.images || [],
        price: scrape.price,
        priceCurrency: scrape.priceCurrency,
        prevPrice: null,
        prevPriceCurrency: null,
        clicks: 0,
        isActive: true,
        createReason: "bulk-create",
        lastCheckedAt: now,
        lastUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
        extra: scrape.raw || {},
      });

      results.push({ ok: true, id: link.id });
    } catch (err) {
      console.error("Bulk create scrape error:", rawUrl, err.message);
      results.push({ ok: false, url: rawUrl, error: err.message });
    }
  }

  res.json({ success: true, created: results });
});

// Redirect + click track
router.get("/go/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const link = await Link.findOne({ id });
    if (!link) {
      return res.status(404).send("Link not found");
    }

    link.clicks = (link.clicks || 0) + 1;
    link.lastClickedAt = new Date();
    await link.save();

    res.redirect(link.affiliateUrl || link.originalUrl);
  } catch (err) {
    res.status(500).send("Error redirecting");
  }
});

// Delete a link
router.delete("/delete/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await Link.deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Daily maintenance – refresh prices & images
router.post("/maintenance/daily", async (req, res) => {
  const links = await Link.find({ source: "amazon", isActive: true }).lean();

  let processed = 0;
  let updated = 0;

  for (const link of links) {
    processed++;
    try {
      const scrape = await scrapeAmazonProduct(link.originalUrl);

      const update = {
        lastCheckedAt: new Date(),
      };

      // Only update fields if we got something useful
      if (scrape.price != null) {
        update.prevPrice = link.price ?? null;
        update.prevPriceCurrency = link.priceCurrency ?? null;
        update.price = scrape.price;
        update.priceCurrency = scrape.priceCurrency || link.priceCurrency || "INR";
      }

      if (scrape.imageUrl && !link.imageUrl) {
        update.imageUrl = scrape.imageUrl;
      }

      if (Array.isArray(scrape.images) && scrape.images.length) {
        update.images = scrape.images;
      }

      if (scrape.title && scrape.title !== "Product" && !link.title?.trim()) {
        update.title = scrape.title;
      }

      update.lastUpdatedAt = new Date();

      await Link.updateOne({ _id: link._id }, { $set: update });
      updated++;
    } catch (err) {
      // Soft-fail: log but don’t stop the loop
      console.error(
        `Maintenance scrape error for ${link.id}:`,
        err.message
      );
    }
  }

  res.json({ success: true, processed, updated });
});

module.exports = router;