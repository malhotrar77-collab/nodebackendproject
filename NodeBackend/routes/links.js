// NodeBackend/routes/links.js

const express = require("express");
const router = express.Router();
const axios = require("axios");
const Link = require("../models/link");

// ----------------- Helpers -----------------

function generateId() {
  // 6-character short id, good enough for our use
  return Math.random().toString(36).slice(2, 8);
}

function isAmazonUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname.includes("amazon.") ||
      u.hostname === "amzn.to"
    );
  } catch {
    return false;
  }
}

// Follow amzn.to short links → real amazon product URL
async function resolveAmazonUrl(rawUrl) {
  if (!rawUrl) return null;

  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  if (!isAmazonUrl(url)) {
    return url;
  }

  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 8000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return res.request?.res?.responseUrl || url;
  } catch {
    // If redirect fails, just return original
    return url;
  }
}

// Basic Amazon bot-page detection
function looksLikeBotPage(html) {
  if (!html) return true;
  const lower = html.toLowerCase();
  if (lower.includes("automated access") || lower.includes("unusual traffic")) {
    return true;
  }
  if (lower.includes("to discuss automated access") || lower.includes("bot detection")) {
    return true;
  }
  return false;
}

// Extract <meta> tag content
function extractMeta(html, nameOrProperty) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=[\\"']${nameOrProperty}[\\"'][^>]*content=[\\"']([^\\"]+)[\\"'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

// Simple price finder: first “₹1234” or “$12.34” in the page
function extractPrice(html) {
  if (!html) return null;

  // Prefer INR style
  let re = /(₹|Rs\.?\s?)[\s]*([0-9,]+(?:\.[0-9]+)?)/i;
  let m = html.match(re);
  if (m) {
    return `${m[1].replace(/\s+/g, "")}${m[2]}`;
  }

  // Fallback: USD style
  re = /(\$)[\s]*([0-9,]+(?:\.[0-9]+)?)/;
  m = html.match(re);
  if (m) {
    return `${m[1]}${m[2]}`;
  }

  return null;
}

// Clean up crazy long titles a bit
function cleanTitle(raw) {
  if (!raw) return null;
  let t = raw.replace(/\s+/g, " ").trim();

  // Remove trailing “: Buy Online at Amazon”
  t = t.replace(/:\s*buy.*amazon\.?$/i, "").trim();
  t = t.replace(/\|\s*amazon\.in.*$/i, "").trim();
  return t;
}

// Build a safe description from title + price if we couldn't
// get a real description from Amazon
function buildFallbackDescription(title, category, price) {
  const baseName = (title || "This product").trim();
  const cat = (category || "other").toLowerCase();

  const pricePart = price ? ` Priced around ${price} (final price on Amazon page).` : "";
  if (cat.includes("shoe")) {
    return `${baseName} is made for easy, everyday wear – good for walks, travel or casual outings.${pricePart}`;
  }
  if (cat.includes("bag")) {
    return `${baseName} is built to carry your daily essentials in a neat way – useful for work or travel.${pricePart}`;
  }
  if (cat.includes("clothing")) {
    return `${baseName} is designed to be easy to style and wear for daily use, work or going out.${pricePart}`;
  }
  if (cat.includes("electronics")) {
    return `${baseName} is a simple gadget for everyday entertainment or work at home.${pricePart}`;
  }

  return `${baseName} is a simple, useful pick for daily life. Easy to add into your routine or lifestyle.${pricePart}`;
}

// Main Amazon scraper V2 – metadata first
async function scrapeAmazon(url) {
  const result = {
    title: null,
    imageUrl: null,
    price: null,
    description: null,
  };

  if (!url || !isAmazonUrl(url)) {
    return result;
  }

  let finalUrl = await resolveAmazonUrl(url);

  try {
    const res = await axios.get(finalUrl, {
      timeout: 10000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });

    const html = res.data || "";
    if (looksLikeBotPage(html)) {
      console.log("Amazon bot page detected for URL", finalUrl);
      return result;
    }

    // Title
    const ogTitle = extractMeta(html, "og:title");
    const metaTitle = extractMeta(html, "title");
    result.title = cleanTitle(ogTitle || metaTitle);

    // Image
    const ogImage = extractMeta(html, "og:image");
    if (ogImage && ogImage.startsWith("http")) {
      result.imageUrl = ogImage;
    }

    // Description
    const ogDesc = extractMeta(html, "og:description") || extractMeta(html, "description");
    if (ogDesc) {
      result.description = ogDesc.replace(/\s+/g, " ").trim();
    }

    // Price
    result.price = extractPrice(html);

    return result;
  } catch (err) {
    console.log("❌ Amazon scrape failed:", err.message || String(err));
    return result;
  }
}

// ----------------- CRUD helpers -----------------

async function createLinkFromUrl({ url, title, category, note, autoTitle }) {
  const trimmedUrl = (url || "").trim();
  if (!trimmedUrl) {
    throw new Error("URL is required.");
  }

  const id = generateId();
  const source = isAmazonUrl(trimmedUrl) ? "amazon" : "other";

  let finalTitle = (title || "").trim();
  let imageUrl = null;
  let price = null;
  let description = null;

  if (source === "amazon") {
    const scraped = await scrapeAmazon(trimmedUrl);
    if (!finalTitle && autoTitle && scraped.title) {
      finalTitle = scraped.title;
    }
    imageUrl = scraped.imageUrl || null;
    price = scraped.price || null;
    description = scraped.description || null;
  }

  if (!finalTitle) {
    finalTitle = "Product";
  }

  // Fallback description if scraper didn't give us anything
  if (!description) {
    description = buildFallbackDescription(finalTitle, category, price);
  }

  const doc = await Link.create({
    id,
    source,
    title: finalTitle,
    category: category || "-",
    note: note || "-",
    rawOriginalUrl: trimmedUrl,
    originalUrl: trimmedUrl,
    affiliateUrl: trimmedUrl, // you’re already pasting your affiliate links
    imageUrl: imageUrl || null,
    price: price || null,
    description,
    clicks: 0,
  });

  return doc;
}

// ----------------- Routes -----------------

// Simple health check
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Links API is alive." });
});

// DB test
router.get("/dbtest", async (req, res) => {
  try {
    const count = await Link.countDocuments();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get all links
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 });
    res.json({ success: true, links });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create single link
router.post("/create", async (req, res) => {
  try {
    const { url, title, category, note, autoTitle } = req.body || {};
    const doc = await createLinkFromUrl({
      url,
      title,
      category,
      note,
      autoTitle: !!autoTitle,
    });
    res.json({ success: true, link: doc });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Bulk create (up to 10)
router.post("/bulk", async (req, res) => {
  try {
    const { urls, title, category, note, autoTitle } = req.body || {};
    if (!Array.isArray(urls) || !urls.length) {
      return res
        .status(400)
        .json({ success: false, message: "No URLs provided." });
    }
    if (urls.length > 10) {
      return res
        .status(400)
        .json({ success: false, message: "Max 10 URLs at once." });
    }

    const created = [];
    for (const rawUrl of urls) {
      const u = (rawUrl || "").trim();
      if (!u) continue;
      try {
        const doc = await createLinkFromUrl({
          url: u,
          title: title || "",
          category: category || "",
          note: note || "",
          autoTitle: !!autoTitle,
        });
        created.push(doc);
      } catch (err) {
        console.log("Bulk create failed for", u, err.message);
      }
    }

    res.json({
      success: true,
      createdCount: created.length,
      links: created,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update link (title, category, note, price manual tweaks)
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, note, price } = req.body || {};

    const link = await Link.findOneAndUpdate(
      { id },
      {
        ...(title !== undefined ? { title } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(price !== undefined ? { price } : {}),
      },
      { new: true }
    );

    if (!link) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }

    res.json({ success: true, link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete link
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const out = await Link.findOneAndDelete({ id });
    if (!out) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Redirect + click count
router.get("/go/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const link = await Link.findOneAndUpdate(
      { id },
      { $inc: { clicks: 1 } },
      { new: true }
    );
    if (!link) {
      return res.status(404).send("Link not found.");
    }
    const target = link.affiliateUrl || link.originalUrl;
    return res.redirect(target);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error redirecting.");
  }
});

// Daily maintenance endpoint (for cron or manual trigger)
// - re-scrape missing title/image/price for recent links
router.post("/maintenance/daily", async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 7); // last 7 days only (cheap)

    const links = await Link.find({
      createdAt: { $gte: since },
      source: "amazon",
    }).limit(50);

    let processed = 0;
    let updated = 0;

    for (const link of links) {
      processed++;
      const needs =
        !link.imageUrl || !link.price || !link.title || link.title === "Product";

      if (!needs) continue;

      const scraped = await scrapeAmazon(link.originalUrl || link.rawOriginalUrl);
      const update = {};

      if (!link.title || link.title === "Product") {
        if (scraped.title) update.title = scraped.title;
      }
      if (!link.imageUrl && scraped.imageUrl) {
        update.imageUrl = scraped.imageUrl;
      }
      if (!link.price && scraped.price) {
        update.price = scraped.price;
      }
      if (!link.description && scraped.description) {
        update.description = scraped.description;
      }

      if (Object.keys(update).length) {
        await Link.updateOne({ _id: link._id }, { $set: update });
        updated++;
      }
    }

    res.json({ success: true, processed, updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;