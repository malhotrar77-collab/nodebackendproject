// NodeBackend/routes/links.js

const express = require("express");
const router = express.Router();

const { createAdmitadDeeplink } = require("./admitadClient"); // still here for future
const Link = require("../models/link");

// -------------------- CONFIG --------------------

// Map Admitad programs (for later, when approvals come)
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // TODO: replace with real Myntra campaign ID when approved
  },
];

const AMAZON_TAG = "alwaysonsal08-21";

// -------------------- HELPERS --------------------

// Clean Amazon URL -> https://www.amazon.in/dp/ASIN   (or leave amzn.to short links)
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
  } catch {
    return originalUrl;
  }
}

// Very lightweight scraper – title + first image URL
async function fetchAmazonMeta(productUrl) {
  try {
    const res = await fetch(productUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      console.warn("Amazon fetch failed:", res.status);
      return {};
    }

    const html = await res.text();

    // ---- TITLE ----
    let title = null;
    let m = html.match(/id="productTitle"[^>]*>([^<]+)</i);
    if (m && m[1]) {
      title = m[1].trim().replace(/\s+/g, " ");
    } else {
      m = html.match(/<title>([^<]+)<\/title>/i);
      if (m && m[1]) {
        title = m[1].trim().replace(/\s+/g, " ");
      }
    }

    // ---- IMAGE (first https://m.media-amazon.com...) ----
    let imageUrl = null;
    const marker = "https://m.media-amazon.com";
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      let end = idx;
      while (end < html.length && html[end] !== '"' && html[end] !== "'") {
        end++;
      }
      imageUrl = html.slice(idx, end);
    }

    return { title, imageUrl };
  } catch (err) {
    console.error("Error fetching Amazon meta:", err.message);
    return {};
  }
}

// Read boolean from query (?autoTitle=1/true/yes/on)
function boolFromQuery(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Auto-infer category from title keywords
function autoCategory(title) {
  if (!title) return null;
  const t = title.toLowerCase();

  if (t.includes("shoe") || t.includes("sneaker") || t.includes("boot"))
    return "footwear";

  if (t.includes("bag") || t.includes("purse") || t.includes("handbag") || t.includes("tote"))
    return "bags";

  if (
    t.includes("jeans") ||
    t.includes("trouser") ||
    t.includes("shirt") ||
    t.includes("t-shirt") ||
    t.includes("hoodie") ||
    t.includes("jacket")
  )
    return "clothing";

  if (t.includes("watch")) return "accessories";
  if (t.includes("glove")) return "gloves";

  return null;
}

// -------------------- ROUTES --------------------

// Simple health check for this router
router.get("/test", (req, res) => {
  res.json({ status: "links router working" });
});

// Get ALL links (latest first)
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, count: links.length, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ ok: false, error: "Failed to load links." });
  }
});

// ---------- AMAZON CREATOR (with URL cleaning + auto title + image + auto category) ----------
router.get("/amazon", async (req, res) => {
  const originalUrlRaw = (req.query.url || "").trim();

  if (!originalUrlRaw) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=...",
    });
  }

  let titleInput = (req.query.title || "").trim();
  let categoryInput = (req.query.category || "").trim();
  const noteInput = (req.query.note || "").trim();
  const autoTitle = boolFromQuery(req.query.autoTitle);

  const canonicalUrl = normalizeAmazonUrl(originalUrlRaw);
  const joinChar = canonicalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

  let finalTitle = titleInput || null;
  let finalCategory = categoryInput || null;
  let imageUrl = null;

  // Only call Amazon if needed
  if (autoTitle || !finalTitle || !finalCategory || !imageUrl) {
    const meta = await fetchAmazonMeta(canonicalUrl);
    if (!finalTitle && meta.title) finalTitle = meta.title;
    if (!imageUrl && meta.imageUrl) imageUrl = meta.imageUrl;
  }

  // Auto category from title if user did not set one
  if (!finalCategory) {
    finalCategory = autoCategory(finalTitle);
  }

  try {
    const link = new Link({
      source: "amazon",
      originalUrl: canonicalUrl,
      rawOriginalUrl: originalUrlRaw,
      affiliateUrl,
      tag: AMAZON_TAG,
      title: finalTitle,
      category: finalCategory,
      note: noteInput || null,
      imageUrl: imageUrl || null,
      images: imageUrl ? [imageUrl] : [],
      price: null,
      clicks: 0,
    });

    await link.save();
    res.json({ ok: true, id: link._id, link });
  } catch (err) {
    console.error("CREATE /amazon error:", err);
    res.status(500).json({ ok: false, error: "Failed to create Amazon link." });
  }
});

// ---------- FLIPKART CREATOR (basic for now) ----------
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
  const noteInput = (req.query.note || "").trim();

  try {
    const link = new Link({
      source: "flipkart",
      originalUrl,
      rawOriginalUrl: originalUrl,
      affiliateUrl,
      tag: flipkartTag,
      title: titleInput || null,
      category: categoryInput || null,
      note: noteInput || null,
      imageUrl: null,
      images: [],
      price: null,
      clicks: 0,
    });

    await link.save();
    res.json({ ok: true, id: link._id, link });
  } catch (err) {
    console.error("CREATE /flipkart error:", err);
    res.status(500).json({ ok: false, error: "Failed to create Flipkart link." });
  }
});

// ---------- GET SINGLE ----------
router.get("/item/:id", async (req, res) => {
  try {
    const link = await Link.findById(req.params.id).lean();
    if (!link) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${req.params.id}` });
    }
    res.json({ ok: true, link });
  } catch (err) {
    console.error("GET /item/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to load link." });
  }
});

// ---------- REDIRECT + COUNT CLICK ----------
router.get("/go/:id", async (req, res) => {
  try {
    const link = await Link.findById(req.params.id);
    if (!link) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${req.params.id}` });
    }

    link.clicks = (link.clicks || 0) + 1;
    await link.save();

    res.redirect(link.affiliateUrl);
  } catch (err) {
    console.error("GO /go/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to redirect." });
  }
});

// ---------- DELETE ----------
router.delete("/:id", async (req, res) => {
  try {
    const link = await Link.findByIdAndDelete(req.params.id);
    if (!link) {
      return res
        .status(404)
        .json({ ok: false, error: "No link found with that ID" });
    }
    res.json({ ok: true, message: `Link ${req.params.id} deleted successfully` });
  } catch (err) {
    console.error("DELETE /:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete link." });
  }
});

// ---------- ADMITAD (kept for future – still invalid_scope until approvals) ----------
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

    const link = new Link({
      source: `admitad-${program.key}`,
      originalUrl,
      rawOriginalUrl: originalUrl,
      affiliateUrl,
      tag: null,
      title: null,
      category: null,
      note: null,
      imageUrl: null,
      images: [],
      price: null,
      clicks: 0,
    });

    await link.save();
    res.json({ ok: true, id: link._id, link });
  } catch (err) {
    console.error("Admitad API ERROR →", err.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: err.response?.data || "Failed to generate Admitad deeplink.",
    });
  }
});

module.exports = router;
