const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

const { createAdmitadDeeplink } = require("./admitadClient");

// Map Admitad programs here
const ADMITAD_PROGRAMS = [
  {
    key: "myntra",
    pattern: "myntra.com",
    campaignId: 123456 // replace when approved
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

// TEST
router.get("/test", (req, res) => {
  res.json({ status: "links router working" });
});

// GET ALL
router.get("/all", (req, res) => {
  res.json({ ok: true, count: links.length, links });
});


// ---------------------------
// AMAZON LINK CREATOR
// ---------------------------
router.get("/amazon", (req, res) => {
  const originalUrl = req.query.url;
  const title = req.query.title || "";
  const category = req.query.category || "";
  const note = req.query.note || "";

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Missing ?url parameter",
    });
  }

  const tag = "alwaysonsal08-21";
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
    title,
    category,
    note,
  };

  links.push(link);
  saveDB();

  return res.json({ ok: true, link });
});


// ---------------------------
// FLIPKART (manual for now)
// ---------------------------
router.get("/flipkart", (req, res) => {
  const originalUrl = req.query.url;
  const title = req.query.title || "";
  const category = req.query.category || "";
  const note = req.query.note || "";

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Missing ?url parameter",
    });
  }

  const flipkartTag = "alwaysonsale";
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
    title,
    category,
    note,
  };

  links.push(link);
  saveDB();

  return res.json({ ok: true, link });
});


// ---------------------------
// ADMITAD GENERATOR (auto)
// ---------------------------
router.get("/admitad", async (req, res) => {
  const originalUrl = req.query.url;
  const title = req.query.title || "";
  const category = req.query.category || "";
  const note = req.query.note || "";

  if (!originalUrl) {
    return res.status(400).json({
      ok: false,
      error: "Missing ?url parameter",
    });
  }

  const lower = originalUrl.toLowerCase();
  const program = ADMITAD_PROGRAMS.find((p) =>
    lower.includes(p.pattern)
  );

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
      title,
      category,
      note,
    };

    links.push(link);
    saveDB();

    res.json({ ok: true, link });

  } catch (err) {
    console.error("Admitad Deeplink ERROR →", err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate Admitad deeplink",
    });
  }
});


// ---------------------------
// GET ONE
// ---------------------------
router.get("/:id", (req, res) => {
  const link = links.find((l) => l.id === req.params.id);

  if (!link) {
    return res.status(404).json({
      ok: false,
      error: "Link not found",
    });
  }

  res.json({ ok: true, link });
});


// ---------------------------
// REDIRECT + COUNT CLICK
// ---------------------------
router.get("/go/:id", (req, res) => {
  const link = links.find((l) => l.id === req.params.id);

  if (!link) {
    return res.status(404).json({ ok: false, error: "Link not found" });
  }

  link.clicks++;
  saveDB();
  res.redirect(link.affiliateUrl);
});


// ---------------------------
// DELETE
// ---------------------------
router.delete("/:id", (req, res) => {
  const index = links.findIndex((l) => l.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({
      ok: false,
      error: "Link not found",
    });
  }

  links.splice(index, 1);
  saveDB();

  res.json({ ok: true, message: "Deleted" });
});

module.exports = router;
