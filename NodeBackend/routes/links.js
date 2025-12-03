// NodeBackend/routes/links.js

const { createAdmitadDeeplink } = require("./admitadClient");
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

// -------------------- Admitad programs --------------------
// TODO: Replace campaignId with your REAL Myntra program ID
// (and add more objects for Ajio, etc. later)
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456, // <-- put your real Myntra campaign ID here
  },
];

// -------------------- Simple JSON "database" --------------------

const dbPath = path.join(__dirname, "..", "data", "links.json");

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
  try {
    fs.writeFileSync(dbPath, JSON.stringify(links, null, 2));
  } catch (err) {
    console.error("Error saving database:", err);
  }
}

// -------------------- Helpers --------------------

function requireUrlParam(req, res) {
  const originalUrl = req.query.url;
  if (!originalUrl) {
    res.status(400).json({
      ok: false,
      error: "Please provide url query param: ?url=...",
    });
    return null;
  }
  return originalUrl;
}

// -------------------- ROUTES --------------------

// Quick test route
router.get("/test", (req, res) => {
  res.json({ status: "links router working" });
});

// Get all saved links
router.get("/all", (req, res) => {
  res.json({ ok: true, count: links.length, links });
});

// ---------- AMAZON ----------

router.get("/amazon", (req, res) => {
  const originalUrl = requireUrlParam(req, res);
  if (!originalUrl) return;

  const tag = "alwaysonsal08-21"; // your Amazon tag
  const joinChar = originalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${originalUrl}${joinChar}tag=${tag}`;

  const link = {
    id: String(nextId++),
    source: "amazon",
    originalUrl,
    affiliateUrl,
    tag,
    clicks: 0,
    createdAt: new Date().toISOString(),
  };

  links.push(link);
  saveDB();

  res.json({ ok: true, id: link.id, originalUrl, affiliateUrl });
});

// ---------- FLIPKART ----------

router.get("/flipkart", (req, res) => {
  const originalUrl = requireUrlParam(req, res);
  if (!originalUrl) return;

  const flipkartTag = "alwaysonsale"; // your Flipkart affiliate ID
  const joinChar = originalUrl.includes("?") ? "&" : "?";
  const affiliateUrl = `${originalUrl}${joinChar}affid=${flipkartTag}`;

  const link = {
    id: String(nextId++),
    source: "flipkart",
    originalUrl,
    affiliateUrl,
    tag: flipkartTag,
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

// ---------- ADMITAD (Myntra, Ajio, …) ----------

router.get("/admitad", async (req, res) => {
  const originalUrl = requireUrlParam(req, res);
  if (!originalUrl) return;

  const lower = originalUrl.toLowerCase();

  // Find a matching program by domain pattern
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
    const details = err.response?.data || err.message;
    console.error("Admitad API ERROR →", details);

    // TEMP: expose details so we understand what's wrong
    res.status(500).json({
      ok: false,
      error: details,
    });
  }
});

// ---------- GET SINGLE LINK ----------

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

// ---------- REDIRECT & COUNT CLICK ----------

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

// ---------- DELETE LINK ----------

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
