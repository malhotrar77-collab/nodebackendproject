const { createAdmitadDeeplink } = require("./admitadClient");
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Map Admitad programs (we will use later once approved)
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // TODO: replace with real campaign ID when approved
  },
];

// Path to JSON database
const dbPath = path.join(__dirname, "..", "data", "links.json");

// Load database or start empty
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

// Save database
function saveDB() {
  fs.writeFileSync(dbPath, JSON.stringify(links, null, 2));
}

// -------- Basic test --------
router.get("/test", (req, res) => {
  res.json({ status: "links router working" });
});

// -------- Get all links --------
router.get("/all", (req, res) => {
  res.json({ ok: true, count: links.length, links });
});

// -------- AMAZON LINK (with optional auto-title) --------
router.get("/amazon", async (req, res) => {
  const originalUrl = (req.query.url || "").trim();
  const manualTitle = (req.query.title || "").trim();
  const category = (req.query.category || "").trim();
  const note = (req.query.note || "").trim();
  const autoTitle =
    req.query.autoTitle === "1" || req.query.autoTitle === "true";

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=...",
    });
  }

  // Your Amazon tag
  const tag = "alwaysonsal08-21";
  const joinChar = originalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${originalUrl}${joinChar}tag=${tag}`;

  let finalTitle = manualTitle;

  // Try to auto-fetch title from Amazon HTML
  if (autoTitle && !finalTitle) {
    try {
      const resp = await axios.get(originalUrl, {
        timeout: 8000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
      });

      const html = resp.data;

      // Try og:title first
      const ogMatch = html.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      );
      if (ogMatch && ogMatch[1]) {
        finalTitle = ogMatch[1].trim();
      } else {
        // Fallback: <title>…</title>
        const titleMatch = html.match(
          /<title[^>]*>([^<]+)<\/title>/i,
        );
        if (titleMatch && titleMatch[1]) {
          finalTitle = titleMatch[1].trim();
        }
      }
    } catch (err) {
      console.error("Amazon auto-title fetch failed:", err.message);
      // If it fails, we just continue with empty title
    }
  }

  const link = {
    id: String(nextId++),
    source: "amazon",
    originalUrl,
    affiliateUrl,
    tag,
    title: finalTitle || "",      // stored for UI
    category: category || "",
    note: note || "",
    clicks: 0,
    createdAt: new Date().toISOString(),
  };

  links.push(link);
  saveDB();

  res.json({
    ok: true,
    id: link.id,
    originalUrl,
    affiliateUrl,
    title: link.title,
  });
});

// -------- FLIPKART LINK (simple, manual for now) --------
router.get("/flipkart", (req, res) => {
  const originalUrl = (req.query.url || "").trim();
  const title = (req.query.title || "").trim();
  const category = (req.query.category || "").trim();
  const note = (req.query.note || "").trim();

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
    title: title || "",
    category: category || "",
    note: note || "",
    clicks: 0,
    createdAt: new Date().toISOString(),
  };

  links.push(link);
  saveDB();

  res.json({
    ok: true,
    id: link.id,
    originalUrl,
    affiliateUrl,
  });
});

// -------- Get single link --------
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

// -------- Redirect + count click --------
router.get("/go/:id", (req, res) => {
  const { id } = req.params;
  const link = links.find((l) => l.id === id);

  if (!link) {
    return res
      .status(404)
      .json({ ok: false, error: `No link found with id ${id}` });
  }

  link.clicks++;
  saveDB();

  res.redirect(link.affiliateUrl);
});

// -------- Delete link --------
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

// -------- ADMITAD LINK (for later; currently invalid_scope) --------
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
      originalUrl,
      affiliateUrl,
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
