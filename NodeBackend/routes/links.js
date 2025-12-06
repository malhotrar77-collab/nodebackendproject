// NodeBackend/routes/links.js

const express = require("express");
const router = express.Router();
const { Types } = require("mongoose");

// Admitad client (for later when programs are approved)
const { createAdmitadDeeplink } = require("./admitadClient");

// Mongoose model
const Link = require("../models/link");

// -------------------- CONFIG --------------------

// Map Admitad programs (we’ll use this once you’re approved)
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // TODO: replace with real Myntra campaign ID when approved
  },
];

// Amazon tag
const AMAZON_TAG = "alwaysonsal08-21";

// -------------------- HELPERS --------------------

function boolFromQuery(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Clean Amazon URL -> https://www.amazon.in/dp/ASIN (keep amzn.to links as-is)
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

// Fetch product title + main image from Amazon page (simple scraping)
async function fetchAmazonDetails(productUrl) {
  try {
    const res = await fetch(productUrl, {
      headers: {
        // Pretend to be a real browser
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      console.warn("Amazon fetch failed status:", res.status);
      return {};
    }

    const html = await res.text();

    // ---- title ----
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

    // ---- main image ----
    let imageUrl = null;

    // Use RegExp constructor so Node doesn’t get confused by literal escaping
    const hiResRe = new RegExp(
      '"hiRes"\\s*:\\s*"(https:\\\\/\\\\/m\\.media-amazon\\.com[^"]+)"'
    );
    const largeRe = new RegExp(
      '"large"\\s*:\\s*"(https:\\\\/\\\\/m\\.media-amazon\\.com[^"]+)"'
    );

    let imgMatch = html.match(hiResRe);
    if (!imgMatch) {
      imgMatch = html.match(largeRe);
    }

    if (imgMatch && imgMatch[1]) {
      // convert \"https:\/\/..\" into "https://.."
      imageUrl = imgMatch[1].replace(/\\\//g, "/");
    }

    return { title, imageUrl };
  } catch (err) {
    console.error("Error fetching Amazon details:", err.message);
    return {};
  }
}

// -------------------- ROUTES --------------------

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
    console.error("Error loading links:", err);
    res.status(500).json({ ok: false, error: "Failed to load links." });
  }
});

// ---------- AMAZON CREATOR (with URL cleaning + auto title + image) ----------
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
  const noteInput = (req.query.note || "").trim();
  const autoTitle = boolFromQuery(req.query.autoTitle);

  // 1) Clean the Amazon URL (dp/ASIN)
  const canonicalUrl = normalizeAmazonUrl(originalUrlRaw);

  // 2) Build affiliate URL on top of CLEAN URL
  const joinChar = canonicalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

  // 3) Optionally fetch title + image from Amazon
  let finalTitle = titleInput || null;
  let imageUrl = null;

  if (!finalTitle && autoTitle) {
    const { title, imageUrl: fetchedImage } = await fetchAmazonDetails(
      canonicalUrl
    );
    if (title) finalTitle = title;
    if (fetchedImage) imageUrl = fetchedImage;
  }

  try {
    const doc = await Link.create({
      source: "amazon",
      originalUrl: canonicalUrl,
      rawOriginalUrl: originalUrlRaw,
      affiliateUrl,
      tag: AMAZON_TAG,
      title: finalTitle,
      category: categoryInput || null,
      note: noteInput || null,
      imageUrl: imageUrl || null,
      images: imageUrl ? [imageUrl] : [],
      clicks: 0,
    });

    res.json({
      ok: true,
      id: String(doc._id),
      link: doc,
    });
  } catch (err) {
    console.error("Error creating Amazon link:", err);
    res.status(500).json({ ok: false, error: "Failed to create Amazon link." });
  }
});

// ---------- FLIPKART CREATOR (simple, no scraping yet) ----------
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
  const noteInput = (req.query.note || "").trim();

  const flipkartTag = "alwaysonsale";
  const joinChar = originalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${originalUrl}${joinChar}affid=${flipkartTag}`;

  try {
    const doc = await Link.create({
      source: "flipkart",
      originalUrl,
      affiliateUrl,
      tag: flipkartTag,
      title: titleInput || null,
      category: categoryInput || null,
      note: noteInput || null,
      clicks: 0,
    });

    res.json({
      ok: true,
      id: String(doc._id),
      link: doc,
    });
  } catch (err) {
    console.error("Error creating Flipkart link:", err);
    res.status(500).json({ ok: false, error: "Failed to create Flipkart link." });
  }
});

// ---------- REDIRECT + COUNT CLICK ----------
// (Put this BEFORE "/:id" so it doesn’t get captured by that route)
router.get("/go/:id", async (req, res) => {
  const { id } = req.params;

  if (!Types.ObjectId.isValid(id)) {
    return res
      .status(404)
      .json({ ok: false, error: "No link found with that ID" });
  }

  try {
    const doc = await Link.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ ok: false, error: "No link found with that ID" });
    }

    doc.clicks = (doc.clicks || 0) + 1;
    await doc.save();

    res.redirect(doc.affiliateUrl);
  } catch (err) {
    console.error("Error redirecting link:", err);
    res.status(500).json({ ok: false, error: "Failed to redirect link." });
  }
});

// ---------- GET SINGLE ----------
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!Types.ObjectId.isValid(id)) {
    return res
      .status(404)
      .json({ ok: false, error: `No link found with id ${id}` });
  }

  try {
    const doc = await Link.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ ok: false, error: `No link found with id ${id}` });
    }

    res.json({ ok: true, link: doc });
  } catch (err) {
    console.error("Error fetching link:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch link." });
  }
});

// ---------- DELETE ----------
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  if (!Types.ObjectId.isValid(id)) {
    return res
      .status(404)
      .json({ ok: false, error: "No link found with that ID" });
  }

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
    res.status(500).json({ ok: false, error: "Failed to delete link." });
  }
});

// ---------- ADMITAD (will return invalid_scope until you’re approved) ----------
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

    const doc = await Link.create({
      source: `admitad-${program.key}`,
      originalUrl,
      affiliateUrl,
      clicks: 0,
    });

    res.json({
      ok: true,
      id: String(doc._id),
      link: doc,
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
