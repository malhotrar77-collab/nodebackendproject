// NodeBackend/routes/links.js
const express = require("express");
const router = express.Router();
const dayjs = require("dayjs");

const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

// ---------- Helpers ----------

// Generate a short random id for links like "c07f71"
function generateId() {
  return Math.random().toString(36).substring(2, 8);
}

// Normalize and extract ASIN from an Amazon URL
function extractAsin(url) {
  // Very simple ASIN matcher
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/i) ||
    url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (!asinMatch) return null;
  return asinMatch[1];
}

function buildCanonicalAmazonUrl(url) {
  const asin = extractAsin(url);
  if (!asin) return url.trim();
  // Force to a simple canonical dp URL (India by default)
  return `https://www.amazon.in/dp/${asin}`;
}

function buildAffiliateUrl(canonicalUrl) {
  const asin = extractAsin(canonicalUrl);
  if (!asin) return canonicalUrl;
  const tag = process.env.AMAZON_ASSOC_TAG || "alwaysonsale-21";
  return `https://www.amazon.in/dp/${asin}?tag=${encodeURIComponent(tag)}`;
}

// Parse a price string like "₹2,149" into { price, priceCurrency, priceRaw }
function parsePrice(priceText) {
  if (!priceText || typeof priceText !== "string") {
    return { price: null, priceCurrency: null, priceRaw: null };
  }

  const raw = priceText.trim();
  // Remove spaces and commas for numeric extraction
  const numericPart = raw.replace(/,/g, "").match(/([\d.]+)/);
  const price = numericPart ? parseFloat(numericPart[1]) : null;

  let currency = null;
  if (/₹|rs\.?/i.test(raw)) currency = "INR";
  else if (/\$/i.test(raw)) currency = "USD";
  else if (/€/.test(raw)) currency = "EUR";

  if (!price || Number.isNaN(price)) {
    return { price: null, priceCurrency: currency, priceRaw: raw };
  }

  return { price, priceCurrency: currency || "INR", priceRaw: raw };
}

// Auto category from scraped category path or title
function guessCategory(scraped, fallbackTitle) {
  const path = (scraped?.categoryPath || []).map((p) => p.toLowerCase());
  const title = (scraped?.title || fallbackTitle || "").toLowerCase();

  const text = [...path, title].join(" ");

  if (text.includes("shoe") || text.includes("sneaker")) return "shoes";
  if (text.includes("t-shirt") || text.includes("t shirt") || text.includes("shirt"))
    return "tshirts";
  if (text.includes("jean") || text.includes("trouser") || text.includes("pant"))
    return "jeans";
  if (text.includes("bag") || text.includes("backpack")) return "bags";
  if (text.includes("laptop") || text.includes("headphone") || text.includes("speaker"))
    return "electronics";
  if (text.includes("home") || text.includes("kitchen")) return "home & living";

  return "other";
}

// ---------- Routes ----------

// Simple test
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Affiliate links API is alive" });
});

// Quick DB test
router.get("/dbtest", async (req, res) => {
  try {
    const count = await Link.countDocuments();
    res.json({ success: true, count });
  } catch (err) {
    console.error("DB test error:", err);
    res.status(500).json({ success: false, message: "DB error", error: err.message });
  }
});

// Get all links (for dashboard + store)
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 });
    res.json({ success: true, links });
  } catch (err) {
    console.error("Error fetching links:", err);
    res.status(500).json({ success: false, message: "Failed to fetch links" });
  }
});

// Create a single Amazon affiliate link
router.post("/create", async (req, res) => {
  try {
    const { originalUrl, category: manualCategory, note } = req.body || {};

    if (!originalUrl || typeof originalUrl !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "originalUrl is required" });
    }

    const rawOriginalUrl = originalUrl.trim();
    const canonicalUrl = buildCanonicalAmazonUrl(rawOriginalUrl);

    if (!canonicalUrl.includes("amazon.")) {
      return res
        .status(400)
        .json({ success: false, message: "Only Amazon product URLs are supported right now." });
    }

    const id = generateId();
    const affiliateUrl = buildAffiliateUrl(canonicalUrl);

    let scraped = null;
    try {
      scraped = await scrapeAmazonProduct(canonicalUrl);
    } catch (err) {
      console.warn("Scrape error on create:", err.message);
      if (err.isBotProtection) {
        console.warn("Amazon bot protection hit. Creating minimal link.");
      }
      // We'll still create a basic record below
    }

    const title = scraped?.title || "Product";
    const shortTitle = scraped?.shortTitle || title;
    const brand = scraped?.brand || null;
    const slug = scraped?.slug || null;
    const shortDescription =
      scraped?.shortDescription ||
      "This product is a simple, useful pick for daily life. Easy to add into your routine or lifestyle.";
    const longDescription = scraped?.longDescription || null;

    const cat =
      manualCategory && manualCategory.trim() !== ""
        ? manualCategory.trim().toLowerCase()
        : guessCategory(scraped, title);

    const { price, priceCurrency, priceRaw } = parsePrice(scraped?.priceText);

    const link = new Link({
      id,
      source: "amazon",
      title,
      shortTitle,
      brand,
      category: cat,
      categoryPath: scraped?.categoryPath || [],
      note: note || "",
      originalUrl: canonicalUrl,
      rawOriginalUrl,
      affiliateUrl,
      tag: process.env.AMAZON_ASSOC_TAG || "alwaysonsale-21",
      imageUrl: scraped?.primaryImage || null,
      images: scraped?.images || [],
      price,
      priceCurrency,
      priceRaw,
      rating: scraped?.rating || null,
      reviewsCount: scraped?.reviewsCount || null,
      shortDescription,
      longDescription,
      slug,
      isActive: true,
      lastCheckedAt: new Date(),
      lastError: scraped ? null : "scrape_failed_on_create",
    });

    await link.save();
    res.json({ success: true, link });
  } catch (err) {
    console.error("Error creating link:", err);
    res.status(500).json({ success: false, message: "Failed to create link" });
  }
});

// Bulk create (10 URLs) – still Amazon-only
router.post("/bulk-create", async (req, res) => {
  try {
    const { urls, category: manualCategory, note } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "urls must be a non-empty array" });
    }

    const results = [];
    for (const url of urls) {
      if (!url || typeof url !== "string") continue;

      const rawOriginalUrl = url.trim();
      const canonicalUrl = buildCanonicalAmazonUrl(rawOriginalUrl);

      if (!canonicalUrl.includes("amazon.")) {
        results.push({
          success: false,
          url: rawOriginalUrl,
          message: "Not an Amazon URL",
        });
        continue;
      }

      const id = generateId();
      const affiliateUrl = buildAffiliateUrl(canonicalUrl);

      let scraped = null;
      try {
        scraped = await scrapeAmazonProduct(canonicalUrl);
      } catch (err) {
        console.warn("Scrape error in bulk-create:", err.message);
      }

      const title = scraped?.title || "Product";
      const shortTitle = scraped?.shortTitle || title;
      const brand = scraped?.brand || null;
      const slug = scraped?.slug || null;
      const shortDescription =
        scraped?.shortDescription ||
        "This product is a simple, useful pick for daily life. Easy to add into your routine or lifestyle.";
      const longDescription = scraped?.longDescription || null;

      const cat =
        manualCategory && manualCategory.trim() !== ""
          ? manualCategory.trim().toLowerCase()
          : guessCategory(scraped, title);

      const { price, priceCurrency, priceRaw } = parsePrice(scraped?.priceText);

      const link = new Link({
        id,
        source: "amazon",
        title,
        shortTitle,
        brand,
        category: cat,
        categoryPath: scraped?.categoryPath || [],
        note: note || "",
        originalUrl: canonicalUrl,
        rawOriginalUrl,
        affiliateUrl,
        tag: process.env.AMAZON_ASSOC_TAG || "alwaysonsale-21",
        imageUrl: scraped?.primaryImage || null,
        images: scraped?.images || [],
        price,
        priceCurrency,
        priceRaw,
        rating: scraped?.rating || null,
        reviewsCount: scraped?.reviewsCount || null,
        shortDescription,
        longDescription,
        slug,
        isActive: true,
        lastCheckedAt: new Date(),
        lastError: scraped ? null : "scrape_failed_on_bulk_create",
      });

      await link.save();
      results.push({ success: true, url: rawOriginalUrl, link });
    }

    res.json({
      success: true,
      created: results.filter((r) => r.success).length,
      results,
    });
  } catch (err) {
    console.error("Error in bulk-create:", err);
    res.status(500).json({ success: false, message: "Bulk create failed" });
  }
});

// Redirect + click tracking
router.get("/go/:id", async (req, res) => {
  try {
    const link = await Link.findOne({ id: req.params.id });
    if (!link) return res.status(404).send("Link not found");

    link.clicks = (link.clicks || 0) + 1;
    await link.save();

    res.redirect(link.affiliateUrl || link.originalUrl);
  } catch (err) {
    console.error("Error in redirect:", err);
    res.status(500).send("Error redirecting");
  }
});

// Delete link
router.delete("/delete/:id", async (req, res) => {
  try {
    const link = await Link.findOneAndDelete({ id: req.params.id });
    if (!link) {
      return res.status(404).json({ success: false, message: "Link not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting link:", err);
    res.status(500).json({ success: false, message: "Failed to delete link" });
  }
});

// Daily maintenance: refresh prices & fill missing metadata
router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find({ source: "amazon", isActive: true });
    let updatedCount = 0;

    for (const link of links) {
      const lastChecked = link.lastCheckedAt
        ? dayjs(link.lastCheckedAt)
        : null;
      const tooOld =
        !lastChecked || dayjs().diff(lastChecked, "hour") >= 24;

      const needsMetadata =
        !link.title ||
        !link.imageUrl ||
        !link.shortDescription ||
        !link.priceRaw;

      if (!tooOld && !needsMetadata) {
        continue; // skip fresh links
      }

      let scraped = null;
      try {
        scraped = await scrapeAmazonProduct(link.originalUrl);
      } catch (err) {
        console.warn(`Maintenance scrape error for ${link.id}:`, err.message);
        link.lastError = err.message;
        link.lastCheckedAt = new Date();
        await link.save();
        continue;
      }

      const { price, priceCurrency, priceRaw } = parsePrice(scraped.priceText);

      // Handle price change bookkeeping
      if (
        price != null &&
        (link.price == null || price !== link.price)
      ) {
        link.prevPrice = link.price;
        link.prevPriceCurrency = link.priceCurrency;
        link.priceChangeReason = "maintenance_update";
      }

      if (price != null) {
        link.price = price;
        link.priceCurrency = priceCurrency;
      }
      if (priceRaw) link.priceRaw = priceRaw;

      if (scraped.title) link.title = scraped.title;
      if (scraped.shortTitle) link.shortTitle = scraped.shortTitle;
      if (scraped.brand) link.brand = scraped.brand;
      if (scraped.primaryImage && !link.imageUrl)
        link.imageUrl = scraped.primaryImage;
      if (scraped.images && scraped.images.length > 0 && link.images.length === 0)
        link.images = scraped.images;

      if (!link.shortDescription && scraped.shortDescription) {
        link.shortDescription = scraped.shortDescription;
      }
      if (!link.longDescription && scraped.longDescription) {
        link.longDescription = scraped.longDescription;
      }
      if (!link.slug && scraped.slug) link.slug = scraped.slug;

      if (scraped.rating != null) link.rating = scraped.rating;
      if (scraped.reviewsCount != null)
        link.reviewsCount = scraped.reviewsCount;

      if (!link.category || link.category === "other") {
        link.category = guessCategory(scraped, scraped.title);
      }
      if (
        (!link.categoryPath || link.categoryPath.length === 0) &&
        scraped.categoryPath &&
        scraped.categoryPath.length > 0
      ) {
        link.categoryPath = scraped.categoryPath;
      }

      link.lastCheckedAt = new Date();
      link.lastError = null;

      await link.save();
      updatedCount++;
    }

    res.json({
      success: true,
      processed: links.length,
      updated: updatedCount,
    });
  } catch (err) {
    console.error("Error in maintenance/daily:", err);
    res.status(500).json({ success: false, message: "Maintenance failed" });
  }
});

// Placeholder for future Admitad integration (keep existing route shape)
router.post("/admitad", (req, res) => {
  res.json({
    success: false,
    message:
      "Admitad integration not implemented yet. We'll plug it in once programs are approved.",
  });
});

module.exports = router;