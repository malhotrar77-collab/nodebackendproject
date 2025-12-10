// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const Link = require("../models/link");

const router = express.Router();

// ---------- Helpers ----------

// Simple random id, 5 chars like "a2f9x"
function generateId(length = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// Normalize and resolve amzn.to → full Amazon URL (best effort)
async function resolveAmazonUrl(url) {
  if (!url) return null;

  // If it's already a long amazon URL, just trim tracking junk
  if (/amazon\./i.test(url)) {
    return stripAmazonTracking(url);
  }

  // If it's amzn.to or other short url, follow redirects
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });

    const finalUrl =
      (res.request &&
        res.request.res &&
        res.request.res.responseUrl) ||
      url;

    return stripAmazonTracking(finalUrl);
  } catch (err) {
    console.warn("resolveAmazonUrl failed, falling back to raw URL:", err.message);
    return stripAmazonTracking(url);
  }
}

// Remove obvious tracking params so URLs are stable
function stripAmazonTracking(url) {
  try {
    const u = new URL(url);
    // Keep only base and path + "dp/ASIN" etc
    const clean = `${u.origin}${u.pathname}`;
    return clean;
  } catch {
    return url;
  }
}

// Scrape Amazon product page for title, price, image
async function scrapeAmazonProduct(url) {
  const finalUrl = await resolveAmazonUrl(url);

  const res = await axios.get(finalUrl, {
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });

  const html = res.data;
  const $ = cheerio.load(html);

  const title =
    $("#productTitle").text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    "Amazon.in";

  const price =
    $("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen")
      .first()
      .text()
      .trim() ||
    $(".a-price .a-offscreen").first().text().trim() ||
    null;

  let imageUrl =
    $("#landingImage").attr("src") ||
    $('img[data-old-hires]').attr("data-old-hires") ||
    $('meta[property="og:image"]').attr("content") ||
    null;

  if (imageUrl && imageUrl.startsWith("//")) {
    imageUrl = "https:" + imageUrl;
  }

  return {
    finalUrl,
    title: title || "Amazon.in",
    price: price || null,
    imageUrl: imageUrl || null,
  };
}

// Common creator used by /create and /bulk1
async function createAmazonLink({ originalUrl, title, category, note, autoTitle }) {
  if (!originalUrl) {
    throw new Error("originalUrl is required");
  }

  const source = "amazon";
  const categorySafe = category && category.trim() ? category.trim() : "other";
  const noteSafe = note && note.trim() ? note.trim() : "";

  let finalTitle = title && title.trim() ? title.trim() : "";
  let price = null;
  let imageUrl = null;
  let normalizedUrl = originalUrl;
  let scrapeError = null;

  // Scrape if autoTitle is on OR we don't have a manual title
  if (autoTitle || !finalTitle) {
    try {
      const scraped = await scrapeAmazonProduct(originalUrl);
      normalizedUrl = scraped.finalUrl || originalUrl;
      if (!finalTitle) finalTitle = scraped.title;
      price = scraped.price;
      imageUrl = scraped.imageUrl;
    } catch (err) {
      console.error("Scrape error for", originalUrl, err.message);
      scrapeError = err.message;
    }
  } else {
    // even if not scraping for title, still normalize URL
    normalizedUrl = await resolveAmazonUrl(originalUrl);
  }

  if (!finalTitle) {
    finalTitle = "Amazon.in";
  }

  // ensure we always set id because schema requires it
  const id = generateId(5);

  const linkDoc = await Link.create({
    id,
    source,
    title: finalTitle,
    category: categorySafe,
    note: noteSafe,
    price: price || undefined,
    originalUrl: normalizedUrl,
    rawOriginalUrl: originalUrl,
    affiliateUrl: normalizedUrl, // until Admitad is wired in
    imageUrl: imageUrl || undefined,
    // safe defaults; your schema may already have defaults
    clicks: 0,
    inactive: false,
    lastCheckedAt: null,
    lastCheckStatus: scrapeError ? "error" : "ok",
  });

  return linkDoc;
}

// ---------- Routes ----------

router.get("/test", (req, res) => {
  res.json({ success: true, message: "Links API OK" });
});

// All links for dashboard + store
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch links." });
  }
});

// Create single link (used by dashboard "Create affiliate link")
router.post("/create", async (req, res) => {
  try {
    const { originalUrl, title, category, note, autoTitle = true } = req.body || {};

    if (!originalUrl || !originalUrl.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "originalUrl is required" });
    }

    const linkDoc = await createAmazonLink({
      originalUrl: originalUrl.trim(),
      title,
      category,
      note,
      autoTitle,
    });

    res.json({ success: true, link: linkDoc });
  } catch (err) {
    console.error("POST /create error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Failed to create link." });
  }
});

// Bulk create (new endpoint used by updated dashboard)
router.post("/bulk1", async (req, res) => {
  try {
    const { urlsText, category, note, autoTitle = true } = req.body || {};
    if (!urlsText || !urlsText.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "urlsText is required" });
    }

    const lines = urlsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (!lines.length) {
      return res
        .status(400)
        .json({ success: false, message: "No valid URLs found." });
    }

    if (lines.length > 10) {
      return res
        .status(400)
        .json({ success: false, message: "Please limit to 10 URLs at once." });
    }

    const created = [];
    const errors = [];

    for (const url of lines) {
      try {
        const doc = await createAmazonLink({
          originalUrl: url,
          title: "", // per-URL title not supported in this simple bulk mode
          category,
          note,
          autoTitle,
        });
        created.push(doc);
      } catch (err) {
        console.error("Bulk create error for", url, err.message);
        errors.push({ url, error: err.message });
      }
    }

    res.json({
      success: true,
      created: created.length,
      errors,
      links: created,
    });
  } catch (err) {
    console.error("POST /bulk1 error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Bulk create failed." });
  }
});

// Legacy bulk endpoint (old frontend) — keep as alias
router.post("/bulk", async (req, res) => {
  try {
    const { urls, category, note, autoTitle = true } = req.body || {};
    if (!Array.isArray(urls) || !urls.length) {
      return res
        .status(400)
        .json({ success: false, message: "urls array is required" });
    }

    const urlsText = urls.join("\n");
    req.body.urlsText = urlsText;
    return router.handle(req, res); // let /bulk1 handler process? (simpler to just call function)
  } catch (err) {
    console.error("POST /bulk alias error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Bulk create failed." });
  }
});

// Update basic fields (used by dashboard Edit)
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, price, note } = req.body || {};

    const update = {};
    if (typeof title === "string") update.title = title;
    if (typeof category === "string") update.category = category;
    if (typeof price === "string" || typeof price === "number")
      update.price = price;
    if (typeof note === "string") update.note = note;

    const updated = await Link.findOneAndUpdate({ id }, update, {
      new: true,
    }).lean();

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }

    res.json({ success: true, link: updated });
  } catch (err) {
    console.error("PUT /update/:id error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Failed to update link." });
  }
});

// Delete link
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Link.findOneAndDelete({ id }).lean();
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }
    res.json({ success: true, deletedId: id });
  } catch (err) {
    console.error("DELETE /delete/:id error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Failed to delete link." });
  }
});

// Redirect + click tracking (used by store + dashboard)
router.get("/go/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const link = await Link.findOneAndUpdate(
      { id },
      { $inc: { clicks: 1 } },
      { new: true }
    );
    if (!link) {
      return res.status(404).send("Link not found");
    }
    res.redirect(link.affiliateUrl || link.originalUrl);
  } catch (err) {
    console.error("GET /go/:id error:", err);
    res.status(500).send("Internal server error");
  }
});

// Simple maintenance endpoint – can be improved later
router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find({ source: "amazon" }).lean();
    let processed = 0;
    let updated = 0;

    for (const link of links) {
      processed++;
      try {
        const info = await scrapeAmazonProduct(link.originalUrl || link.rawOriginalUrl);
        await Link.updateOne(
          { _id: link._id },
          {
            $set: {
              price: info.price || link.price,
              imageUrl: info.imageUrl || link.imageUrl,
              lastCheckedAt: new Date(),
              lastCheckStatus: "ok",
            },
          }
        );
        updated++;
      } catch (err) {
        console.error("maintenance scrape error for", link.id, err.message);
        await Link.updateOne(
          { _id: link._id },
          {
            $set: {
              lastCheckedAt: new Date(),
              lastCheckStatus: "error",
            },
          }
        );
      }
    }

    res.json({ success: true, processed, updated });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Maintenance failed." });
  }
});

module.exports = router;