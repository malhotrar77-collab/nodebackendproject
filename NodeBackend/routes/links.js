// NodeBackend/routes/links.js

const { createAdmitadDeeplink } = require("./admitadClient"); // still here for future
const express = require("express");
const router = express.Router();
const Link = require("../models/Link");

// -------------------- CONFIG --------------------

// Map Admitad programs (for later, when approvals come)
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456 // TODO: replace with real Myntra campaign ID when approved
  }
];

// Amazon tag
const AMAZON_TAG = "alwaysonsal08-21";

// -------------------- HELPERS --------------------

// Clean Amazon URL -> https://www.amazon.in/dp/ASIN
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

    if (!asin) {
      return originalUrl;
    }

    return `${u.protocol}//${host}/dp/${asin}`;
  } catch (e) {
    return originalUrl;
  }
}

// Fetch product title from Amazon page (very simple scraping)
async function fetchAmazonTitle(productUrl) {
  try {
    const res = await fetch(productUrl, {
      headers: {
        // Pretend to be a browser
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
      }
    });

    if (!res.ok) {
      console.warn("Amazon title fetch failed status:", res.status);
      return null;
    }

    const html = await res.text();

    // Try productTitle first
    let m = html.match(/id="productTitle"[^>]*>([^<]+)</i);
    if (m && m[1]) {
      return m[1].trim().replace(/\s+/g, " ");
    }

    // Fallback: <title>...</title>
    m = html.match(/<title>([^<]+)<\/title>/i);
    if (m && m[1]) {
      return m[1].trim().replace(/\s+/g, " ");
    }

    return null;
  } catch (err) {
    console.error("Error fetching Amazon title:", err.message);
    return null;
  }
}

function boolFromQuery(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// -------------------- ROUTES --------------------

// Quick test
router.get("/test", async (req, res) => {
  res.json({ status: "links router working" });
});

// Get all links (newest first)
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({
      ok: true,
      count: links.length,
      links: links.map((l) => ({
        ...l,
        id: l.id || String(l._id)
      }))
    });
  } catch (err) {
    console.error("Error loading links from DB:", err.message);
    res.status(500).json({ ok: false, error: "Failed to load links" });
  }
});

// ---------- AMAZON CREATOR (with URL cleaning + auto title) ----------
router.get("/amazon", async (req, res) => {
  const originalUrlRaw = (req.query.url || "").trim();

  if (!originalUrlRaw) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=..."
    });
  }

  // optional fields from UI
  const titleInput = (req.query.title || "").trim();
  const category = (req.query.category || "").trim();
  const note = (req.query.note || "").trim();
  const autoTitle = boolFromQuery(req.query.autoTitle);

  // 1) Clean the Amazon URL
  const canonicalUrl = normalizeAmazonUrl(originalUrlRaw);

  // 2) Build affiliate URL on top of CLEAN URL
  const joinChar = canonicalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

  // 3) Decide final title
  let finalTitle = titleInput;

  if (!finalTitle && autoTitle) {
    // try to fetch from Amazon
    const fetched = await fetchAmazonTitle(canonicalUrl);
    if (fetched) {
      finalTitle = fetched;
    }
  }

  try {
    const linkDoc = await Link.create({
      source: "amazon",
      originalUrl: canonicalUrl,
      rawOriginalUrl: originalUrlRaw,
      affiliateUrl,
      tag: AMAZON_TAG,
      title: finalTitle || null,
      category: category || null,
      note: note || null
    });

    const link = linkDoc.toJSON();

    res.json({
      ok: true,
      id: link.id,
      link
    });
  } catch (err) {
    console.error("Error saving Amazon link:", err.message);
    res.status(500).json({ ok: false, error: "Failed to create Amazon link" });
  }
});

// ---------- FLIPKART CREATOR (still simple, now DB-backed) ----------
router.get("/flipkart", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=..."
    });
  }

  const flipkartTag = "alwaysonsale"; // your Flipkart affiliate ID
  const joinChar = originalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${originalUrl}${joinChar}affid=${flipkartTag}`;

  try {
    const linkDoc = await Link.create({
      source: "flipkart",
      originalUrl,
      rawOriginalUrl: originalUrl,
      affiliateUrl,
      tag: flipkartTag,
      title: (req.query.title || "").trim() || null,
      category: (req.query.category || "").trim() || null,
      note: (req.query.note || "").trim() || null
    });

    const link = linkDoc.toJSON();

    res.json({
      ok: true,
      id: link.id,
      link
    });
  } catch (err) {
    console.error("Error saving Flipkart link:", err.message);
    res.status(500).json({ ok: false, error: "Failed to create Flipkart link" });
  }
});

// ---------- GET SINGLE ----------
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const linkDoc = await Link.findById(id);
    if (!linkDoc) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${id}` });
    }

    const link = linkDoc.toJSON();
    res.json({ ok: true, link });
  } catch (err) {
    console.error("Error fetching link:", err.message);
    res.status(500).json({ ok: false, error: "Failed to load link" });
  }
});

// ---------- REDIRECT + COUNT CLICK ----------
router.get("/go/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const linkDoc = await Link.findById(id);
    if (!linkDoc) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${id}` });
    }

    linkDoc.clicks = (linkDoc.clicks || 0) + 1;
    await linkDoc.save();

    res.redirect(linkDoc.affiliateUrl);
  } catch (err) {
    console.error("Error redirecting link:", err.message);
    res.status(500).json({ ok: false, error: "Failed to redirect link" });
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
    console.error("Error deleting link:", err.message);
    res.status(500).json({ ok: false, error: "Failed to delete link" });
  }
});

// ---------- ADMITAD (still here, but will give invalid_scope until approvals) ----------
router.get("/admitad", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Missing ?url parameter"
    });
  }

  const lower = originalUrl.toLowerCase();
  const program = ADMITAD_PROGRAMS.find((p) => lower.includes(p.pattern));

  if (!program) {
    return res.status(400).json({
      ok: false,
      error: "No matching Admitad program for this URL."
    });
  }

  try {
    const affiliateUrl = await createAdmitadDeeplink({
      campaignId: program.campaignId,
      url: originalUrl
    });

    const linkDoc = await Link.create({
      source: `admitad-${program.key}`,
      originalUrl,
      rawOriginalUrl: originalUrl,
      affiliateUrl,
      clicks: 0
    });

    const link = linkDoc.toJSON();

    res.json({
      ok: true,
      id: link.id,
      link
    });
  } catch (err) {
    console.error("Admitad API ERROR →", err.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: err.response?.data || "Failed to generate Admitad deeplink."
    });
  }
});

module.exports = router;
