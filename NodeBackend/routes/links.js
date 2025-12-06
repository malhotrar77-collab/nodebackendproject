// NodeBackend/routes/links.js
//
// Uses MongoDB (Link model) instead of links.json
// + auto title/category/price/images for Amazon products.

const express = require("express");
const router = express.Router();
const Link = require("../models/Link");

// -------- CONFIG --------

const AMAZON_TAG = "alwaysonsal08-21";

// For future Admitad (kept so we don't lose work)
const { createAdmitadDeeplink } = require("./admitadClient");
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // TODO: real campaign id after approval
  },
];

// -------- SMALL HELPERS --------

function boolFromQuery(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Convert people’s weird Amazon URL → clean dp URL
function normalizeAmazonUrl(originalUrl) {
  try {
    const u = new URL(originalUrl);
    const host = u.hostname.toLowerCase();

    // Keep short links as they are
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
  } catch {
    return originalUrl;
  }
}

// -------- AMAZON SCRAPING HELPERS --------

// NOTE: this is best-effort and may not always find everything.
// If scraping fails, we still save the link – just with less metadata.

async function fetchAmazonHtml(url) {
  const res = await fetch(url, {
    headers: {
      // Pretend to be a normal browser
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });

  if (!res.ok) {
    console.warn("Amazon HTML fetch failed:", res.status);
    return null;
  }
  return await res.text();
}

function extractText(regex, html) {
  const m = html.match(regex);
  if (m && m[1]) {
    return m[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

function extractAmazonTitleAndCategory(html) {
  // Product title
  const productTitle =
    extractText(/id="productTitle"[^>]*>([^<]+)</i, html) || null;

  // <title> tag (often includes category)
  const titleTag = extractText(/<title>([^<]+)<\/title>/i, html) || null;

  // Try to derive category from title tag: "Product Name | Category | Amazon.in"
  let category = null;
  if (titleTag) {
    const parts = titleTag.split("|").map((p) => p.trim());
    // Start from right and take the first part that is not "Amazon..."
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      const low = p.toLowerCase();
      if (!low.includes("amazon")) {
        category = p;
        break;
      }
    }
  }

  return { productTitle, titleTag, category };
}

function extractAmazonPrice(html) {
  // Very rough heuristics – Amazon changes their DOM often.
  let currency = extractText(/class="a-price-symbol">([^<]+)</i, html) || null;

  // Try a few different patterns
  let priceStr =
    extractText(/id="priceblock_ourprice"[^>]*>\s*([^<]+)</i, html) ||
    extractText(/id="priceblock_dealprice"[^>]*>\s*([^<]+)</i, html) ||
    extractText(/class="a-price-whole">([\d,.]+)/i, html);

  if (!priceStr) return null;

  // Normalize numbers: remove commas and currency symbol
  priceStr = priceStr.replace(/[^\d.,]/g, "").replace(/,/g, "");
  const current = parseFloat(priceStr);
  if (Number.isNaN(current)) return null;

  // Try to find "strike-through" original price
  let originalStr = extractText(
    /class="priceBlockStrikePriceString[^"]*"[^>]*>\s*([^<]+)</i,
    html
  );
  let original = null;
  if (originalStr) {
    originalStr = originalStr.replace(/[^\d.,]/g, "").replace(/,/g, "");
    const o = parseFloat(originalStr);
    if (!Number.isNaN(o) && o > current) {
      original = o;
    }
  }

  let discountPercent = null;
  if (original && original > current) {
    discountPercent = Math.round(((original - current) / original) * 100);
  }

  return {
    current,
    original: original || null,
    currency: currency || null,
    discountPercent,
  };
}

function extractAmazonImages(html) {
  // Primary image is usually in img#landingImage with data-a-dynamic-image JSON
  const m = html.match(
    /id="landingImage"[^>]*data-a-dynamic-image="([^"]+)"/i
  );
  if (!m || !m[1]) return [];

  try {
    const jsonStr = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .trim();
    const obj = JSON.parse(jsonStr);
    const urls = Object.keys(obj);
    // Filter to images only
    return urls.filter((u) => u.startsWith("http"));
  } catch (err) {
    console.warn("Failed to parse Amazon image JSON:", err.message);
    return [];
  }
}

function extractAmazonRating(html) {
  // Example: <span class="a-icon-alt">4.3 out of 5 stars</span>
  const ratingStr = extractText(
    /class="a-icon-alt">([\d.,]+)\s+out of 5 stars/i,
    html
  );
  const rating = ratingStr ? parseFloat(ratingStr.replace(",", ".")) : null;

  // Example: <span id="acrCustomerReviewText" ...>11,811 ratings</span>
  const countStr = extractText(
    /id="acrCustomerReviewText"[^>]*>([^<]+)</i,
    html
  );
  let ratingCount = null;
  if (countStr) {
    const num = countStr.replace(/[^\d]/g, "");
    if (num) ratingCount = parseInt(num, 10);
  }

  return { rating, ratingCount };
}

async function scrapeAmazonMeta(url) {
  try {
    const html = await fetchAmazonHtml(url);
    if (!html) return {};

    const { productTitle, titleTag, category } =
      extractAmazonTitleAndCategory(html);
    const price = extractAmazonPrice(html);
    const imageUrls = extractAmazonImages(html);
    const { rating, ratingCount } = extractAmazonRating(html);

    return {
      titleFromPage: productTitle || null,
      titleTag: titleTag || null,
      category: category || null,
      price: price || null,
      imageUrls,
      rating: rating || null,
      ratingCount: ratingCount || null,
    };
  } catch (err) {
    console.error("Error scraping Amazon meta:", err.message);
    return {};
  }
}

// -------- ROUTES --------

// Quick test
router.get("/test", (req, res) => {
  res.json({ status: "links router working" });
});

// Get all links (newest first)
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, count: links.length, links });
  } catch (err) {
    console.error("Error fetching links:", err);
    res.status(500).json({ ok: false, error: "Failed to load links" });
  }
});

// ---------- AMAZON CREATOR (auto title/category/price/images) ----------
router.get("/amazon", async (req, res) => {
  const originalUrlRaw = (req.query.url || "").trim();

  if (!originalUrlRaw) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=...",
    });
  }

  const titleInput = (req.query.title || "").trim();
  const categoryInput = (req.query.category || "").trim();
  const note = (req.query.note || "").trim();
  const autoTitle = boolFromQuery(req.query.autoTitle);

  const canonicalUrl = normalizeAmazonUrl(originalUrlRaw);
  const joinChar = canonicalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

  let meta = {};
  if (autoTitle || !categoryInput) {
    meta = await scrapeAmazonMeta(canonicalUrl);
  }

  const finalTitle =
    titleInput ||
    (autoTitle && (meta.titleFromPage || meta.titleTag)) ||
    null;

  const finalCategory = categoryInput || meta.category || null;

  try {
    const link = await Link.create({
      source: "amazon",
      originalUrl: originalUrlRaw,
      canonicalUrl,
      affiliateUrl,
      tag: AMAZON_TAG,
      title: finalTitle,
      category: finalCategory,
      note: note || null,
      imageUrl: meta.imageUrls && meta.imageUrls[0] ? meta.imageUrls[0] : null,
      imageUrls: meta.imageUrls || [],
      price: meta.price || undefined,
      rating: meta.rating ?? undefined,
      ratingCount: meta.ratingCount ?? undefined,
    });

    res.json({
      ok: true,
      id: link.id, // mongoose virtual string id
      link,
    });
  } catch (err) {
    console.error("Error creating Amazon link:", err);
    res.status(500).json({
      ok: false,
      error: "Failed to save Amazon link.",
    });
  }
});

// ---------- FLIPKART CREATOR (no scraping yet) ----------
router.get("/flipkart", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=...",
    });
  }

  const titleInput = (req.query.title || "").trim();
  const categoryInput = (req.query.category || "").trim();
  const note = (req.query.note || "").trim();

  const flipkartTag = "alwaysonsale"; // your Flipkart affiliate ID
  const joinChar = originalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${originalUrl}${joinChar}affid=${flipkartTag}`;

  try {
    const link = await Link.create({
      source: "flipkart",
      originalUrl,
      canonicalUrl: originalUrl,
      affiliateUrl,
      tag: flipkartTag,
      title: titleInput || null,
      category: categoryInput || null,
      note: note || null,
    });

    res.json({
      ok: true,
      id: link.id,
      link,
    });
  } catch (err) {
    console.error("Error creating Flipkart link:", err);
    res.status(500).json({ ok: false, error: "Failed to create Flipkart link" });
  }
});

// ---------- GET SINGLE ----------
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const link = await Link.findById(id).lean();
    if (!link) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${id}` });
    }
    res.json({ ok: true, link });
  } catch (err) {
    console.error("Error fetching link:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch link" });
  }
});

// ---------- REDIRECT + COUNT CLICK ----------
router.get("/go/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const link = await Link.findByIdAndUpdate(
      id,
      { $inc: { clicks: 1 } },
      { new: true }
    );
    if (!link) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${id}` });
    }
    res.redirect(link.affiliateUrl);
  } catch (err) {
    console.error("Error increasing click + redirect:", err);
    res.status(500).json({ ok: false, error: "Failed to redirect" });
  }
});

// ---------- DELETE ----------
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await Link.findByIdAndDelete(id);
    if (!result) {
      return res
        .status(404)
        .json({ ok: false, error: "No link found with that ID" });
    }
    res.json({ ok: true, message: `Link ${id} deleted successfully` });
  } catch (err) {
    console.error("Error deleting link:", err);
    res.status(500).json({ ok: false, error: "Failed to delete link" });
  }
});

// ---------- ADMITAD (will show invalid_scope until programs approved) ----------
router.get("/admitad", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Missing ?url parameter",
    });
  }

  const lower = originalUrl.toLowerCase();
  const program = ADMITAD_PROGRAMS.find((p) => lower.includes(p.pattern));

  if (!program) {
    return res.status(400).json({
      ok: false,
      error: "No matching Admitad program for this URL.",
    });
  }

  try {
    const affiliateUrl = await createAdmitadDeeplink({
      campaignId: program.campaignId,
      url: originalUrl,
    });

    const link = await Link.create({
      source: `admitad-${program.key}`,
      originalUrl,
      canonicalUrl: originalUrl,
      affiliateUrl,
    });

    res.json({
      ok: true,
      id: link.id,
      link,
    });
  } catch (err) {
    console.error("Admitad API ERROR →", err.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: err.response?.data || "Failed to generate Admitad deeplink.",
    });
  }
});

module.exports = router;
