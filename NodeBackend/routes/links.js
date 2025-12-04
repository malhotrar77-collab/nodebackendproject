// NodeBackend/routes/links.js

const { createAdmitadDeeplink } = require("./admitadClient"); // kept for future
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

// -------------------- CONFIG --------------------

// Map Admitad programs (for later, when approvals come)
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // TODO: replace with real Myntra campaign ID when approved
  },
];

// Amazon tag
const AMAZON_TAG = "alwaysonsal08-21";

// Path to JSON database
const dbPath = path.join(__dirname, "..", "data", "links.json");

// -------------------- DB LOADING --------------------

let links = [];
try {
  if (fs.existsSync(dbPath)) {
    links = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  }
} catch (err) {
  console.error("Error loading database:", err);
}

let nextId =
  links.length > 0 ? Math.max(...links.map((l) => Number(l.id))) + 1 : 1;

function saveDB() {
  fs.writeFileSync(dbPath, JSON.stringify(links, null, 2));
}

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
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
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

// -------------------- ROUTES --------------------

// Quick test
router.get("/test", (req, res) => {
  res.json({ status: "links router working" });
});

// Get all links
router.get("/all", (req, res) => {
  res.json({ ok: true, count: links.length, links });
});

// ---------- AMAZON CREATOR (URL cleaning + ALWAYS try auto-title) ----------
router.get("/amazon", async (req, res) => {
  const originalUrlRaw = (req.query.url || "").trim();

  if (!originalUrlRaw) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=...",
    });
  }

  // optional fields from UI
  const titleInput = (req.query.title || "").trim();
  const category = (req.query.category || "").trim();
  const note = (req.query.note || "").trim();

  // 1) Clean the Amazon URL
  const canonicalUrl = normalizeAmazonUrl(originalUrlRaw);

  // 2) Build affiliate URL on top of CLEAN URL
  const joinChar = canonicalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${canonicalUrl}${joinChar}tag=${AMAZON_TAG}`;

  // 3) Decide final title
  let finalTitle = titleInput;

  // If no custom title → ALWAYS try to fetch from Amazon
  if (!finalTitle) {
    const fetched = await fetchAmazonTitle(canonicalUrl);
    if (fetched) {
      finalTitle = fetched;
    }
  }

  const link = {
    id: String(nextId++),
    source: "amazon",
    // store both raw and clean
    originalUrl: canonicalUrl,
    rawOriginalUrl: originalUrlRaw,
    affiliateUrl,
    tag: AMAZON_TAG,
    title: finalTitle || null,
    category: category || null,
    note: note || null,
    clicks: 0,
    createdAt: new Date().toISOString(),
  };

  links.push(link);
  saveDB();

  res.json({
    ok: true,
    id: link.id,
    link,
  });
});

// ---------- FLIPKART CREATOR (simple) ----------
router.get("/flipkart", (req, res) => {
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

  const link = {
    id: String(nextId++),
    source: "flipkart",
    originalUrl,
    affiliateUrl,
    tag: flipkartTag,
    title: (req.query.title || "").trim() || null,
    category: (req.query.category || "").trim() || null,
    note: (req.query.note || "").trim() || null,
    clicks: 0,
    createdAt: new Date().toISOString(),
  };

  links.push(link);
  saveDB();

  res.json({
    ok: true,
    id: link.id,
    link,
  });
});

// ---------- ADMITAD (will show invalid_scope until programs are approved) ----------
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

    const link = {
      id: String(nextId++),
      source: `admitad-${program.key}`,
      originalUrl,
      affiliateUrl,
      clicks: 0,
      createdAt: new Date().toISOString(),
    };

    links.push(link);
    saveDB();

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

// ---------- GET SINGLE ----------
router.get("/:id", (req, res) => {
  const { id } = req.params;
  const link = links.find((l) => l.id === id);

  if (!link) {
    return res
      .status(404)
      .json({ ok: false, error: `No link found with id ${id}` });
  }

  res.json({ ok: true, link });
});

// ---------- REDIRECT + COUNT CLICK ----------
router.get("/go/:id", (req, res) => {
  const { id } = req.params;
  const link = links.find((l) => l.id === id);

  if (!link) {
    return res
      .status(404)
      .json({ ok: false, error: `No link found with id ${id}` });
  }

  link.clicks = (link.clicks || 0) + 1;
  saveDB();

  res.redirect(link.affiliateUrl);
});

// ---------- DELETE ----------
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  const index = links.findIndex((l) => l.id === id);

  if (index === -1) {
    return res
      .status(404)
      .json({ ok: false, error: "No link found with that ID" });
  }

  links.splice(index, 1);
  saveDB();

  res.json({ ok: true, message: `Link ${id} deleted successfully` });
});

module.exports = router;
