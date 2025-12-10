// NodeBackend/routes/links.js
//
// Main API for links:
//  - /api/links/create
//  - /api/links/bulk1
//  - /api/links/all
//  - /api/links/go/:id
//  - /api/links/update/:id
//  - /api/links/delete/:id
//  - /api/links/maintenance/daily

const express = require("express");
const axios = require("axios");
const Link = require("../models/link");
const { scrapeAmazonProduct } = require("../scrapers/amazon");

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

// Build affiliate URL (very simple for now – you can upgrade to Admitad later)
const DEFAULT_AMAZON_TAG = process.env.AMAZON_TAG || null;
function buildAffiliateUrl(canonicalUrl) {
  if (!canonicalUrl) return null;
  if (!DEFAULT_AMAZON_TAG) return canonicalUrl;

  // If URL already has a tag, keep it
  if (/[?&]tag=/.test(canonicalUrl)) return canonicalUrl;

  const sep = canonicalUrl.includes("?") ? "&" : "?";
  return `${canonicalUrl}${sep}tag=${DEFAULT_AMAZON_TAG}`;
}

// Common creator used by /create and /bulk1
async function createAmazonLink({ originalUrl, title, category, note, autoTitle }) {
  if (!originalUrl) {
    throw new Error("originalUrl is required");
  }

  const source = "amazon";
  const categoryInput = category && category.trim() ? category.trim() : "";

  const noteSafe = note && note.trim() ? note.trim() : "";

  let normalizedUrl = await resolveAmazonUrl(originalUrl);
  if (!normalizedUrl) normalizedUrl = originalUrl;

  let scraped = null;
  let scrapeError = null;

  // Scrape always if autoTitle, or if we need details
  if (autoTitle || !title || !title.trim()) {
    try {
      scraped = await scrapeAmazonProduct(normalizedUrl);
    } catch (err) {
      console.error("Scrape error for", normalizedUrl, err.message);
      scrapeError = err.isBotProtection
        ? "Amazon bot protection page detected"
        : err.message;
    }
  }

  // Title logic
  let finalTitle =
    (title && title.trim()) ||
    (scraped && scraped.title) ||
    "Amazon product";

  const shortTitle =
    (scraped && scraped.shortTitle) ||
    (finalTitle.length > 80
      ? finalTitle.slice(0, 77).trimEnd() + "…"
      : finalTitle);

  // Category logic
  let topCategory = "other";
  if (categoryInput) {
    topCategory = categoryInput;
  } else if (scraped && scraped.topCategory) {
    topCategory = scraped.topCategory;
  }

  // Images
  const primaryImage = scraped && scraped.primaryImage;
  const images = (scraped && scraped.images) || [];

  // Price
  const priceNum = scraped && scraped.price != null ? scraped.price : null;
  const priceCurrency = scraped && scraped.priceCurrency;
  const priceRaw = scraped && scraped.priceText;

  // SEO descriptions
  const shortDescription =
    (scraped && scraped.shortDescription) ||
    "This product is a simple, useful pick for daily life. Easy to add into your routine or lifestyle.";

  const longDescription =
    (scraped && scraped.longDescription) || shortDescription;

  // Rating
  const rating = scraped && scraped.rating;
  const reviewsCount = scraped && scraped.reviewsCount;

  // Category path + slug
  const categoryPath = (scraped && scraped.categoryPath) || [];
  const slug = (scraped && scraped.slug) || null;

  // Affiliate URL
  const affiliateUrl = buildAffiliateUrl(normalizedUrl);

  // ensure we always set id because schema requires it
  const id = generateId(5);

  const linkDoc = await Link.create({
    id,
    source,
    title: finalTitle,
    shortTitle,
    brand: scraped && scraped.brand ? scraped.brand : undefined,

    category: topCategory,
    categoryPath,

    note: noteSafe,

    originalUrl: normalizedUrl,
    rawOriginalUrl: originalUrl,
    affiliateUrl,
    tag: DEFAULT_AMAZON_TAG || undefined,

    imageUrl: primaryImage || undefined,
    images,

    price: priceNum != null ? priceNum : undefined,
    priceCurrency: priceCurrency || undefined,
    priceRaw: priceRaw || undefined,

    rating: rating != null ? rating : undefined,
    reviewsCount: reviewsCount != null ? reviewsCount : undefined,

    shortDescription,
    longDescription,
    slug: slug || undefined,

    isActive: true,
    clicks: 0,

    lastCheckedAt: scraped ? new Date() : undefined,
    lastError: scrapeError || undefined,
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
    const { originalUrl, title, category, note, autoTitle = true } =
      req.body || {};

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
    res.status(500).json({
      success: false,
      message: err.message || "Failed to create link.",
    });
  }
});

// Bulk create (new endpoint used by updated dashboard with urlsText)
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
    res.status(500).json({
      success: false,
      message: err.message || "Bulk create failed.",
    });
  }
});

// Legacy bulk endpoint (old frontend) — supports { urls: [...] }
router.post("/bulk", async (req, res) => {
  try {
    const { urls, category, note, autoTitle = true } = req.body || {};
    if (!Array.isArray(urls) || !urls.length) {
      return res
        .status(400)
        .json({ success: false, message: "urls array is required" });
    }

    const created = [];
    const errors = [];

    for (const url of urls) {
      try {
        const doc = await createAmazonLink({
          originalUrl: url,
          title: "",
          category,
          note,
          autoTitle,
        });
        created.push(doc);
      } catch (err) {
        console.error("Bulk create (legacy) error for", url, err.message);
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
    console.error("POST /bulk alias error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Bulk create failed.",
    });
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
    if (typeof price === "string" || typeof price === "number") {
      const num = Number(price);
      if (!Number.isNaN(num)) update.price = num;
    }
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
    res.status(500).json({
      success: false,
      message: err.message || "Failed to update link.",
    });
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
    res.status(500).json({
      success: false,
      message: err.message || "Failed to delete link.",
    });
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

// Simple maintenance endpoint – refresh price & image
router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find({ source: "amazon", isActive: { $ne: false } }).lean();
    let processed = 0;
    let updated = 0;

    for (const link of links) {
      processed++;
      try {
        const urlToUse = link.originalUrl || link.rawOriginalUrl;
        if (!urlToUse) continue;

        const info = await scrapeAmazonProduct(urlToUse);

        const update = {
          lastCheckedAt: new Date(),
          lastError: undefined,
        };

        // price changes
        if (info.price != null) {
          if (link.price != null && link.price !== info.price) {
            update.prevPrice = link.price;
            update.prevPriceCurrency = link.priceCurrency || info.priceCurrency;
            update.priceChangeReason = "maintenance_refresh";
          }
          update.price = info.price;
          update.priceCurrency = info.priceCurrency || link.priceCurrency;
          update.priceRaw = info.priceText || link.priceRaw;
        }

        if (info.primaryImage) {
          update.imageUrl = info.primaryImage;
        }
        if (info.images && info.images.length) {
          update.images = info.images;
        }
        if (info.rating != null) {
          update.rating = info.rating;
        }
        if (info.reviewsCount != null) {
          update.reviewsCount = info.reviewsCount;
        }
        if (info.shortDescription) {
          update.shortDescription = info.shortDescription;
        }
        if (info.longDescription) {
          update.longDescription = info.longDescription;
        }
        if (info.categoryPath && info.categoryPath.length) {
          update.categoryPath = info.categoryPath;
        }

        await Link.updateOne({ _id: link._id }, { $set: update });
        updated++;
      } catch (err) {
        console.error("maintenance scrape error for", link.id, err.message);
        await Link.updateOne(
          { _id: link._id },
          {
            $set: {
              lastCheckedAt: new Date(),
              lastError: err.message || "maintenance_error",
            },
          }
        );
      }
    }

    res.json({ success: true, processed, updated });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Maintenance failed.",
    });
  }
});

module.exports = router;