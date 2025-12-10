// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const Link = require("../models/link");

const router = express.Router();

/**
 * Small helpers
 */

function normaliseCategory(raw) {
  if (!raw) return "other";
  const c = String(raw).toLowerCase();

  if (c.includes("shoe")) return "shoes";
  if (c.includes("sneaker")) return "shoes";
  if (c.includes("tshirt") || c.includes("t-shirt")) return "tshirts";
  if (c.includes("shirt") || c.includes("top")) return "clothing";
  if (c.includes("jean") || c.includes("denim")) return "jeans";
  if (c.includes("bag") || c.includes("backpack")) return "bags";
  if (c.includes("laptop") || c.includes("phone") || c.includes("mobile")) {
    return "electronics";
  }

  return "other";
}

function detectSource(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("amazon")) return "amazon";
    if (u.hostname.includes("amzn.to")) return "amazon";
    return "other";
  } catch {
    return "other";
  }
}

// Make axios look like a real browser a bit
const AMAZON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  "Accept-Language": "en-IN,en;q=0.9",
};

/**
 * Scrape Amazon product page (IN) for title, price, image, etc.
 * Works for both long amazon.in links and amzn.to short links.
 */
async function scrapeAmazonMeta(url) {
  const resp = await axios.get(url, {
    headers: AMAZON_HEADERS,
    // let axios follow redirects from amzn.to -> amazon.in
    maxRedirects: 5,
  });

  // Final URL after redirects (if any)
  let finalUrl = url;
  try {
    if (resp.request && resp.request.res && resp.request.res.responseUrl) {
      finalUrl = resp.request.res.responseUrl;
    }
  } catch {
    // ignore
  }

  const html = resp.data;
  const $ = cheerio.load(html);

  // Title
  let title =
    $("#productTitle").text().trim() ||
    $("#title span#productTitle").text().trim();

  if (!title) {
    // fall back to <title> tag (often "Amazon.in: XYZ")
    const rawTitle = $("title").text().trim();
    if (rawTitle) {
      title = rawTitle.replace(/^Amazon\.in:\s*/i, "").trim();
    }
  }

  // Price (very rough; just so we have something)
  let priceText =
    $("#corePrice_feature_div .a-price-whole").first().text().trim() ||
    $("#corePrice_feature_div .a-offscreen").first().text().trim();

  if (!priceText) {
    priceText = $(".a-price .a-offscreen").first().text().trim();
  }

  let price = null;
  let priceCurrency = null;
  if (priceText) {
    // e.g. "₹1,234.00" -> currency "₹", value 1234
    const match = priceText.match(/^([^\d]*)([\d,]+(?:\.\d+)?)/);
    if (match) {
      priceCurrency = match[1].trim() || null;
      const numeric = match[2].replace(/,/g, "");
      const parsed = parseFloat(numeric);
      if (!Number.isNaN(parsed)) {
        price = parsed;
      }
    }
  }

  // Main image
  let imageUrl =
    $("#imgTagWrapperId img").attr("src") ||
    $("img#landingImage").attr("src") ||
    $("img[data-old-hires]").attr("data-old-hires");

  // Category guess from breadcrumbs
  let breadcrumbText = "";
  $("#wayfinding-breadcrumbs_feature_div li a").each((_, el) => {
    const t = $(el).text().trim();
    if (t) {
      breadcrumbText += t + " ";
    }
  });

  const category =
    normaliseCategory(breadcrumbText) ||
    normaliseCategory(title) ||
    "other";

  return {
    title: title || "Product",
    price,
    priceCurrency,
    imageUrl: imageUrl || null,
    category,
    finalUrl,
  };
}

/**
 * Create a Link document from an Amazon URL (or other URL).
 * Shared by single-create and bulk-create routes.
 */
async function createLinkFromUrl(rawUrl, options = {}) {
  const { title: titleInput, category: catInput, note, autoTitle } = options;

  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("originalUrl is required");
  }

  const trimmedUrl = rawUrl.trim();
  const source = detectSource(trimmedUrl);

  let title = titleInput && titleInput.trim();
  let category = catInput && catInput.trim();
  let originalUrl = trimmedUrl;
  let affiliateUrl = trimmedUrl;
  let imageUrl = null;
  let price = null;
  let priceCurrency = null;

  // For now, use the same URL as affiliate URL (you can plug Admitad later)
  affiliateUrl = trimmedUrl;

  if (source === "amazon") {
    try {
      // Scrape all info from Amazon
      const meta = await scrapeAmazonMeta(trimmedUrl);

      originalUrl = meta.finalUrl || trimmedUrl;
      if (!title || autoTitle) title = meta.title;
      if (!category) category = meta.category;
      imageUrl = meta.imageUrl;
      price = meta.price;
      priceCurrency = meta.priceCurrency;
    } catch (err) {
      console.error("Amazon scrape failed:", err.message || err);
      // graceful fallback: just keep whatever title/category we have
      if (!title) title = "Product";
      if (!category) category = "other";
    }
  } else {
    // Non-Amazon – basic fallback
    if (!title) title = "Product";
    if (!category) category = "other";
  }

  // Build document
  const linkDoc = new Link({
    // custom short id will be generated in model if you use nanoid/uuid there,
    // otherwise `_id` will act as id.
    source,
    title,
    category: normaliseCategory(category),
    note: note || "",
    originalUrl,
    rawOriginalUrl: trimmedUrl,
    affiliateUrl,
    imageUrl,
    price,
    priceCurrency,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await linkDoc.save();
  return linkDoc;
}

/**
 * ROUTES
 */

// Simple test
router.get("/test", (req, res) => {
  res.json({ ok: true });
});

// Get all links (for dashboard + store)
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 });
    res.json({ success: true, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ success: false, error: "Failed to load links" });
  }
});

/**
 * POST /api/links/create
 * Create ONE affiliate link from a URL.
 */
router.post("/create", async (req, res) => {
  try {
    const {
      originalUrl, // required
      title,
      category,
      note,
      autoTitle,
    } = req.body || {};

    if (!originalUrl || !String(originalUrl).trim()) {
      return res.status(400).json({ success: false, error: "originalUrl is required" });
    }

    const link = await createLinkFromUrl(String(originalUrl), {
      title,
      category,
      note,
      autoTitle,
    });

    res.json({ success: true, link });
  } catch (err) {
    console.error("POST /create error:", err);
    res
      .status(500)
      .json({ success: false, error: err.message || "Failed to create link" });
  }
});

/**
 * POST /api/links/bulk   (and /bulk1 for backwards compatibility)
 * Body: { urlsText, category, note, autoTitle }
 * urlsText = multiline string, 1 URL per line
 */
async function handleBulkCreate(req, res) {
  try {
    const { urlsText, category, note, autoTitle } = req.body || {};

    if (!urlsText || !String(urlsText).trim()) {
      return res
        .status(400)
        .json({ success: false, error: "urlsText is required" });
    }

    const lines = String(urlsText)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (!lines.length) {
      return res
        .status(400)
        .json({ success: false, error: "No URLs found in input" });
    }

    const results = [];
    for (const u of lines) {
      try {
        const link = await createLinkFromUrl(u, {
          title: null,
          category,
          note,
          autoTitle,
        });
        results.push({ url: u, status: "ok", id: link.id || link._id });
      } catch (err) {
        console.error("Bulk create failed for URL:", u, err.message || err);
        results.push({
          url: u,
          status: "error",
          error: err.message || "Failed to create link",
        });
      }
    }

    res.json({
      success: true,
      total: lines.length,
      created: results.filter((r) => r.status === "ok").length,
      results,
    });
  } catch (err) {
    console.error("POST /bulk error:", err);
    res
      .status(500)
      .json({ success: false, error: "Bulk create failed", details: err.message });
  }
}

router.post("/bulk", handleBulkCreate);
router.post("/bulk1", handleBulkCreate); // keep old JS working

/**
 * Redirect: /api/links/go/:id
 */
router.get("/go/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const link = await Link.findOne({ id }) || (await Link.findById(id));

    if (!link) {
      return res.status(404).send("Link not found");
    }

    // increment click count
    try {
      link.clicks = (link.clicks || 0) + 1;
      link.updatedAt = new Date();
      await link.save();
    } catch (err) {
      console.error("Error incrementing clicks for", id, err);
    }

    res.redirect(link.affiliateUrl || link.originalUrl);
  } catch (err) {
    console.error("GET /go/:id error:", err);
    res.status(500).send("Server error");
  }
});

/**
 * DELETE /api/links/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const link =
      (await Link.findOneAndDelete({ id })) ||
      (await Link.findByIdAndDelete(id));

    if (!link) {
      return res.status(404).json({ success: false, error: "Link not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /:id error:", err);
    res.status(500).json({ success: false, error: "Failed to delete link" });
  }
});

/**
 * Simple daily maintenance stub (so your existing button keeps working).
 * For now it just touches updatedAt and returns counts, so it
 * will not crash or return HTML.
 */
router.post("/maintenance/daily", async (req, res) => {
  try {
    const links = await Link.find();
    let updated = 0;

    for (const link of links) {
      // In future we can re-scrape here using scrapeAmazonMeta(link.originalUrl)
      link.updatedAt = new Date();
      await link.save();
      updated += 1;
    }

    res.json({
      success: true,
      processed: links.length,
      updated,
    });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res.status(500).json({
      success: false,
      error: "Maintenance failed",
      details: err.message,
    });
  }
});

module.exports = router;