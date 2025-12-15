// NodeBackend/routes/links.js
const express = require("express");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

const router = express.Router();

/* ===============================
   OpenAI (SAFE + OPTIONAL)
================================ */
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    const { OpenAI } = require("openai");
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log("✅ OpenAI ready");
  } catch {
    console.log("⚠️ OpenAI disabled");
  }
}

/* ===============================
   Helpers
================================ */
function generateId(len = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: len }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

function stripAmazonTracking(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function isPoorText(txt) {
  if (!txt) return true;
  if (txt.length < 80) return true;
  if (/simple|useful|daily life/i.test(txt)) return true;
  return false;
}

/* ===============================
   AI rewrite (SAFE)
================================ */
async function rewriteWithAI({ title, shortDescription, longDescription }) {
  if (!openai) return null;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "Return JSON only: { short, description }. SEO friendly, rewritten, unique."
        },
        {
          role: "user",
          content: `
Title: ${title}

Short:
${shortDescription}

Long:
${longDescription}
`
        }
      ]
    });

    return JSON.parse(res.choices[0].message.content);
  } catch {
    return null;
  }
}

/* ===============================
   Core create logic (USED EVERYWHERE)
================================ */
async function createAmazonLink({ originalUrl, category, note }) {
  const scraped = await scrapeAmazonProduct(originalUrl);

  let shortDesc = scraped.shortDescription || "";
  let longDesc = scraped.longDescription || "";

  let ai = null;
  if (isPoorText(shortDesc) || isPoorText(longDesc)) {
    ai = await rewriteWithAI({
      title: scraped.title,
      shortDescription: shortDesc,
      longDescription: longDesc
    });
  }

  return Link.create({
    id: generateId(),
    source: "amazon",
    title: scraped.title || "Amazon Product",

    shortDescription:
      ai?.short || shortDesc || `Key features and usage overview.`,
    longDescription:
      ai?.description || longDesc || `Detailed product overview.`,

    category: category || "general",
    note: note || "",

    originalUrl: stripAmazonTracking(originalUrl),
    affiliateUrl: stripAmazonTracking(originalUrl),

    imageUrl: scraped.imageUrl,
    images: scraped.images || [],

    price: scraped.price || null,
    rating: scraped.rating || null,
    reviewsCount: scraped.reviewsCount || null,

    clicks: 0,
    isActive: true,
    lastCheckedAt: new Date()
  });
}

/* ===============================
   ROUTES (COMPATIBLE)
================================ */

// health
router.get("/test", (_, res) => res.json({ success: true }));

// list
router.get("/all", async (_, res) => {
  const links = await Link.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, links });
});

// SINGLE CREATE (dashboard uses this)
router.post("/create", async (req, res) => {
  try {
    const link = await createAmazonLink(req.body);
    res.json({ success: true, link });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// BULK CREATE (RESTORED)
router.post("/bulk1", async (req, res) => {
  try {
    const urls = (req.body.urlsText || "")
      .split(/\r?\n/)
      .map(u => u.trim())
      .filter(Boolean);

    const created = [];

    for (const url of urls) {
      const link = await createAmazonLink({
        originalUrl: url,
        category: req.body.category,
        note: req.body.note
      });
      created.push(link.id);
    }

    res.json({ success: true, created: created.length });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// CLICK TRACK
router.get("/go/:id", async (req, res) => {
  const link = await Link.findOneAndUpdate(
    { id: req.params.id },
    { $inc: { clicks: 1 } },
    { new: true }
  );
  if (!link) return res.status(404).send("Not found");
  res.redirect(link.affiliateUrl || link.originalUrl);
});

// REFRESH (NO AI)
router.post("/refresh-all", async (_, res) => {
  const links = await Link.find({ isActive: true });
  let updated = 0;

  for (const link of links) {
    try {
      const scraped = await scrapeAmazonProduct(link.originalUrl);
      await Link.updateOne(
        { _id: link._id },
        {
          price: scraped.price || link.price,
          imageUrl: scraped.imageUrl || link.imageUrl,
          images: scraped.images || link.images,
          lastCheckedAt: new Date()
        }
      );
      updated++;
    } catch {}
  }

  res.json({ success: true, total: links.length, updated });
});

module.exports = router;