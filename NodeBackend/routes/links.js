// NodeBackend/routes/links.js

const express = require("express");
const router = express.Router();
const { createAdmitadDeeplink } = require("./admitadClient"); // kept for future
const Link = require("../models/Link");

// ---------- SMALL HELPERS ----------

// Turn Mongo doc into plain object that frontend likes
function mapLink(doc) {
  const obj = doc.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
}

// Clean amazon URL -> canonical https://www.amazon.in/dp/ASIN
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

function boolFromQuery(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Very lightweight Amazon scraper (title + main image)
async function fetchAmazonDetails(productUrl) {
  try {
    const res = await fetch(productUrl, {
      headers: {
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
    // Try JSON blobs with hiRes / large images
    let imgMatch = html.match(
      /"hiRes"\s*:\s*"(https:\\/\\/m\.media-amazon\.com[^"]+)"/
    );
    if (!imgMatch) {
      imgMatch = html.match(
        /"large"\s*:\s*"(https:\\/\\/m\.media-amazon\.com[^"]+)"/
      );
    }
    if (imgMatch && imgMatch[1]) {
      imageUrl = imgMatch[1].replace(/\\\//g, "/");
    }

    return { title, imageUrl };
  } catch (err) {
    console.error("Error fetching Amazon details:", err.message);
    return {};
  }
}

// ---------- ROUTES ----------

// health test
router.get("/test", (req, res) => {
  res.json({ ok: true, message: "links router working with Mongo" });
});

// get all links (newest first)
router.get("/all", async (req, res) => {
  try {
    const docs = await Link.find().sort({ createdAt: -1 });
    const links = docs.map(mapLink);
    res.json({ ok: true, count: links.length, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ ok: false, error: "Failed to load links." });
  }
});

// create Amazon link (with auto title + image)
router.get("/amazon", async (req, res) => {
  try {
    const originalUrlRaw = (req.query.url || "").trim();
    if (!originalUrlRaw) {
      return res.status(400).json({
        ok: false,
        error: "Please provide url query param: ?url=...",
      });
    }

    const manualTitle = (req.query.title || "").trim();
    const category = (req.query.category || "").trim();
    const note = (req.query.note || "").trim();
    const autoTitle = boolFromQuery(req.query.autoTitle);

    const canonicalUrl = normalizeAmazonUrl(originalUrlRaw);
    const joinChar = canonicalUrl.includes("?") ? "&" : "?";
    const AMAZON_TAG = "alwaysonsal08-21";
    const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

    let finalTitle = manualTitle;
    let imageUrl = null;

    if (autoTitle || !manualTitle) {
      const scraped = await fetchAmazonDetails(canonicalUrl);
      if (scraped.title && !manualTitle) finalTitle = scraped.title;
      if (scraped.imageUrl) imageUrl = scraped.imageUrl;
    }

    const linkDoc = await Link.create({
      source: "amazon",
      originalUrl: canonicalUrl,
      rawOriginalUrl: originalUrlRaw,
      affiliateUrl,
      tag: AMAZON_TAG,
      title: finalTitle || null,
      category: category || null,
      note: note || null,
      imageUrl: imageUrl || null,
      clicks: 0,
    });

    const link = mapLink(linkDoc);
    res.json({ ok: true, id: link.id, link });
  } catch (err) {
    console.error("CREATE /amazon error:", err);
    res.status(500).json({ ok: false, error: "Failed to create Amazon link." });
  }
});

// delete link
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ ok: false, error: "Missing link id." });
  }

  try {
    const deleted = await Link.findByIdAndDelete(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ ok: false, error: "No link found with that ID." });
    }
    res.json({ ok: true, message: `Link ${id} deleted successfully.` });
  } catch (err) {
    console.error("DELETE /:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete link." });
  }
});

// redirect + count click
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
    console.error("GO /go/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to open tracked link." });
  }
});

// ----- Admitad route kept for later (will still return invalid_scope for now) -----
router.get("/admitad", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Missing ?url parameter",
    });
  }

  // when we really use this, we’ll plug in campaign config here
  try {
    const affiliateUrl = await createAdmitadDeeplink({
      campaignId: 123456,
      url: originalUrl,
    });

    const linkDoc = await Link.create({
      source: "admitad",
      originalUrl,
      affiliateUrl,
    });

    const link = mapLink(linkDoc);
    res.json({ ok: true, id: link.id, link });
  } catch (err) {
    console.error("Admitad API ERROR →", err.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: err.response?.data || "Failed to generate Admitad deeplink.",
    });
  }
});

module.exports = router;
