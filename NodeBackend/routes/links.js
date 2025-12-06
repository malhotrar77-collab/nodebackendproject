// NodeBackend/routes/links.js
//
// Handles all affiliate link creation + metadata scraping + MongoDB storage
// Currently supports:
//   - Amazon (auto title, category, price, images)
//   - Flipkart (simple tag append)
//   - Admitad stub (will work once programmes are approved)

const express = require("express");
const router = express.Router();

const { createAdmitadDeeplink } = require("./admitadClient"); // still here for future
const Link = require("../models/Link");

// -------------------- CONFIG --------------------

const AMAZON_TAG = "alwaysonsal08-21";

// For future Admitad programs
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // TODO: real ID after approval
  },
];

// -------------------- SMALL HELPERS --------------------

// Clean Amazon URL -> canonical dp URL or keep as-is
function normalizeAmazonUrl(originalUrl) {
  try {
    const u = new URL(originalUrl);
    const host = u.hostname.toLowerCase();

    // keep short links as they are
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

function boolFromQuery(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Decode things like &amp; &#39; etc.
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Extract a nice looking category from Amazon HTML
function extractAmazonCategory(html) {
  if (!html) return null;

  // Try breadcrumbs meta tag
  let m = html.match(/"browseRootName"\s*:\s*"([^"]+)"/i);
  if (m && m[1]) return decodeHtmlEntities(m[1].trim());

  // Try simple "in XYZ" pattern near reviews
  m = html.match(/in\s+([^<|]+)\s+on Amazon/i);
  if (m && m[1]) return decodeHtmlEntities(m[1].trim());

  return null;
}

// Extract price info from Amazon HTML (very best-effort)
function extractAmazonPrice(html) {
  if (!html) return null;

  // Current price
  let currMatch =
    html.match(/"priceToPay"[^}]*"value"\s*:\s*"([^"]+)"/i) ||
    html.match(/"displayPrice"\s*:\s*"([^"]+)"/i) ||
    html.match(/"priceAmount"\s*:\s*"([^"]+)"/i);

  // Fallback: ₹1,234 style
  if (!currMatch) {
    currMatch = html.match(/₹\s*([\d,]+)/);
  }

  let current = null;
  if (currMatch && currMatch[1]) {
    const cleaned = currMatch[1].replace(/[^\d.,]/g, "").replace(/,/g, "");
    const n = Number(cleaned);
    if (!Number.isNaN(n)) current = n;
  }

  // Original (striked) price
  let origMatch =
    html.match(/"wasPrice"[^}]*"value"\s*:\s*"([^"]+)"/i) ||
    html.match(/"rrpPrice"[^}]*"value"\s*:\s*"([^"]+)"/i);

  let original = null;
  if (origMatch && origMatch[1]) {
    const cleaned = origMatch[1].replace(/[^\d.,]/g, "").replace(/,/g, "");
    const n = Number(cleaned);
    if (!Number.isNaN(n)) original = n;
  }

  const currency = "₹"; // for amazon.in; later we can parse locale

  if (!current && !original) return null;

  const price = { current: current || null, original: original || null, currency };

  if (current && original && original > current) {
    price.discountPercent = Math.round(((original - current) / original) * 100);
  }

  return price;
}

// Extract product images (best effort)
function extractAmazonImages(html) {
  if (!html) return [];

  // Primary: <img data-a-dynamic-image="{"url":{"...":...}}">
  const dyn = html.match(/data-a-dynamic-image="([^"]+)"/i);
  if (dyn && dyn[1]) {
    try {
      const jsonStr = dyn[1].replace(/&quot;/g, '"');
      const obj = JSON.parse(jsonStr);
      const urls = Object.keys(obj).filter((u) => u.startsWith("http"));
      if (urls.length) return urls;
    } catch {
      // ignore and try fallback
    }
  }

  // Fallback: any .jpg or .jpeg under images/I pattern
  const re = /src="(https:\/\/[^"]+\.jpe?g[^"]*)"/gi;
  const matches = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    matches.push(m[1]);
  }

  // De-dupe
  return [...new Set(matches)];
}

// Fetch HTML + parse metadata (title, category, price, images)
async function fetchAmazonMeta(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      console.warn("Amazon meta fetch failed status:", res.status);
      return {};
    }

    const html = await res.text();

    // productTitle
    let m = html.match(/id="productTitle"[^>]*>([^<]+)</i);
    const titleFromPage = m && m[1] ? m[1].trim().replace(/\s+/g, " ") : null;

    // <title> tag
    m = html.match(/<title>([^<]+)<\/title>/i);
    const titleTag = m && m[1] ? m[1].trim().replace(/\s+/g, " ") : null;

    const category = extractAmazonCategory(html);
    const price = extractAmazonPrice(html);
    const images = extractAmazonImages(html);

    return {
      titleFromPage,
      titleTag,
      category,
      price,
      images,
    };
  } catch (err) {
    console.error("Error fetching Amazon meta:", err.message);
    return {};
  }
}

// -------------------- ROUTES --------------------

// Quick test
router.get("/test", (req, res) => {
  res.json({ status: "links router working" });
});

// Get all links (latest first)
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, count: links.length, links });
  } catch (err) {
    console.error("Error loading links:", err);
    res.status(500).json({ ok: false, error: "Failed to load links" });
  }
});

// ---------- AMAZON CREATOR (auto title + category + price + images) ----------
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

  // 1) Clean the Amazon URL
  const canonicalUrl = normalizeAmazonUrl(originalUrlRaw);

  // 2) Fetch metadata from Amazon (best effort)
  const meta = await fetchAmazonMeta(canonicalUrl);

  // 3) Decide final title
  let finalTitle =
    titleInput ||
    (autoTitle && (meta.titleFromPage || meta.titleTag)) ||
    "";

  finalTitle = decodeHtmlEntities(finalTitle).trim();
  if (!finalTitle) finalTitle = null;

  // 4) Decide final category
  let finalCategory = categoryInput || meta.category || "";
  finalCategory = decodeHtmlEntities(finalCategory).trim();
  if (!finalCategory) finalCategory = null;

  // 5) Build affiliate URL
  const joinChar = canonicalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

  // 6) Decide images + price
  const images = Array.isArray(meta.images) ? meta.images : [];
  const imageUrl = images.length > 0 ? images[0] : null;
  const price = meta.price || null;

  try {
    const link = await Link.create({
      source: "amazon",
      originalUrl: canonicalUrl,
      rawOriginalUrl: originalUrlRaw,
      affiliateUrl,
      tag: AMAZON_TAG,
      title: finalTitle,
      category: finalCategory,
      note: note || null,
      clicks: 0,
      imageUrl,
      images,
      price,
    });

    res.json({
      ok: true,
      id: link.id, // Mongoose virtual string
      link,
    });
  } catch (err) {
    console.error("Error creating Amazon link:", err);
    res.status(500).json({ ok: false, error: "Failed to create Amazon link" });
  }
});

// ---------- FLIPKART CREATOR (simple) ----------
router.get("/flipkart", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=...",
    });
  }

  const flipkartTag = "alwaysonsale"; // your Flipkart affiliate ID
  const joinChar = originalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${originalUrl}${joinChar}affid=${flipkartTag}`;

  const titleInput = (req.query.title || "").trim();
  const categoryInput = (req.query.category || "").trim();
  const note = (req.query.note || "").trim();

  try {
    const link = await Link.create({
      source: "flipkart",
      originalUrl,
      affiliateUrl,
      tag: flipkartTag,
      title: titleInput || null,
      category: categoryInput || null,
      note: note || null,
      clicks: 0,
    });

    res.json({
      ok: true,
      id: link.id,
      link,
    });
  } catch (err) {
    console.error("Error creating Flipkart link:", err);
    res
      .status(500)
      .json({ ok: false, error: "Failed to create Flipkart link" });
  }
});

// ---------- REDIRECT + COUNT CLICK ----------
// NOTE: this MUST be before "/:id" route
router.get("/go/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const link = await Link.findById(id);
    if (!link) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${id}` });
    }

    link.clicks = (link.clicks || 0) + 1;
    await link.save();

    res.redirect(link.affiliateUrl);
  } catch (err) {
    console.error("Error redirecting link:", err);
    res.status(500).json({ ok: false, error: "Failed to redirect link" });
  }
});

// ---------- GET SINGLE ----------
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const link = await Link.findById(id);
    if (!link) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${id}` });
    }

    res.json({ ok: true, link });
  } catch (err) {
    console.error("Error loading link:", err);
    res.status(500).json({ ok: false, error: "Failed to load link" });
  }
});

// ---------- DELETE ----------
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const deleted = await Link.findByIdAndDelete(id);
    if (!deleted) {
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

// ---------- ADMITAD (will return invalid_scope until approved) ----------
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
      affiliateUrl,
      clicks: 0,
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
