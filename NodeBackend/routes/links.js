// NodeBackend/routes/links.js

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const Link = require("../models/link");

const router = express.Router();

// ---------- Helpers ----------

// Generate short-ish random id (not Mongo _id)
function generateId() {
  return Math.random().toString(16).slice(2, 8);
}

// Very simple Amazon URL check
function isAmazonUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return u.includes("amazon.") || u.includes("amzn.to");
}

// Follow amzn.to short links etc. to get final URL
async function resolveRedirect(url) {
  try {
    const resp = await axios.get(url, {
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (resp.request && resp.request.res && resp.request.res.responseUrl) {
      return resp.request.res.responseUrl;
    }
    return url;
  } catch (err) {
    console.error("resolveRedirect error:", err.message);
    return url;
  }
}

// Extract ASIN from full Amazon URL
function extractAsin(url) {
  if (!url) return null;
  const m =
    url.match(/\/dp\/([A-Z0-9]{8,12})/) ||
    url.match(/\/gp\/product\/([A-Z0-9]{8,12})/);
  return m ? m[1] : null;
}

// Build a clean canonical Amazon product URL (without tag)
function buildCanonicalAmazonUrl(url) {
  const asin = extractAsin(url);
  if (!asin) return url;
  // You can change .in to .com if needed later
  return `https://www.amazon.in/dp/${asin}`;
}

// Add our associate tag to URL
function addAffiliateTag(url) {
  const tag = "alwaysonsale0-21"; // change if you want a different tag
  try {
    const u = new URL(url);
    u.searchParams.set("tag", tag);
    return u.toString();
  } catch (e) {
    return url;
  }
}

// Convert a raw scraped price string into Number or null
// Examples:
//  "₹2,149" -> 2149
//  "Rs. 349" -> 349
//  "rs," or "₹ " -> null
function extractNumericPrice(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Auto-category V3: map title text -> category key
function autoCategoryFromTitle(title) {
  if (!title) return "";

  const t = title.toLowerCase();

  // Shoes / sneakers
  if (
    t.includes("shoe") ||
    t.includes("sneaker") ||
    t.includes("running shoes") ||
    t.includes("loafers") ||
    t.includes("sandals") ||
    t.includes("flip flops")
  ) {
    return "shoes";
  }

  // Clothing
  if (
    t.includes("t-shirt") ||
    t.includes("t shirt") ||
    t.includes("shirt") ||
    t.includes("jeans") ||
    t.includes("trouser") ||
    t.includes("pant") ||
    t.includes("jogger") ||
    t.includes("kurta") ||
    t.includes("saree") ||
    t.includes("hoodie") ||
    t.includes("jacket")
  ) {
    return "clothing";
  }

  // Bags / backpacks / wallets
  if (
    t.includes("bag") ||
    t.includes("backpack") ||
    t.includes("tote") ||
    t.includes("duffel") ||
    t.includes("sling") ||
    t.includes("wallet")
  ) {
    return "bags";
  }

  // Beauty & hair
  if (
    t.includes("shampoo") ||
    t.includes("conditioner") ||
    t.includes("hair oil") ||
    t.includes("face wash") ||
    t.includes("serum") ||
    t.includes("cream") ||
    t.includes("lotion") ||
    t.includes("spf") ||
    t.includes("sunscreen")
  ) {
    return "beauty";
  }

  // Personal care
  if (
    t.includes("body wash") ||
    t.includes("soap") ||
    t.includes("face gel") ||
    t.includes("deodorant") ||
    t.includes("trimmer") ||
    t.includes("grooming kit")
  ) {
    return "personal";
  }

  // Electronics
  if (
    t.includes("laptop") ||
    t.includes("mobile") ||
    t.includes("smartphone") ||
    t.includes("earbuds") ||
    t.includes("headphone") ||
    t.includes("soundbar") ||
    t.includes("speaker") ||
    t.includes("tv ") ||
    t.includes("smart tv") ||
    t.includes("monitor")
  ) {
    return "electronics";
  }

  // Home & living
  if (
    t.includes("bedsheet") ||
    t.includes("pillow") ||
    t.includes("blanket") ||
    t.includes("curtain") ||
    t.includes("sofa") ||
    t.includes("decor") ||
    t.includes("kitchen")
  ) {
    return "home";
  }

  return "other";
}

// Scrape Amazon product page: title, image URL, price string
async function scrapeAmazonProduct(url) {
  if (!url) throw new Error("No URL provided to scraper");

  const resolved = await resolveRedirect(url);
  const canonical = buildCanonicalAmazonUrl(resolved);

  try {
    const resp = await axios.get(canonical, {
      headers: {
        // Very lightweight headers (we already hit bot wall sometimes)
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
    });

    const html = resp.data || "";
    if (html.includes("To discuss automated access to Amazon data")) {
      console.warn("Amazon bot page detected for URL", canonical);
      return {
        title: null,
        imageUrl: null,
        priceText: null,
        canonicalUrl: canonical,
      };
    }

    const $ = cheerio.load(html);

    // Title
    let title =
      $("#productTitle").text().trim() ||
      $("h1 span#title").text().trim() ||
      null;

    // Image – main product image
    let imageUrl =
      $("#imgTagWrapperId img").attr("src") ||
      $("#landingImage").attr("src") ||
      $("img#imgBlkFront").attr("src") ||
      null;

    // Price – we only care about the first visible price block
    let priceText =
      $("#priceblock_ourprice").text().trim() ||
      $("#priceblock_dealprice").text().trim() ||
      $("#priceblock_saleprice").text().trim() ||
      $("span.a-price span.a-offscreen").first().text().trim() ||
      null;

    return {
      title,
      imageUrl,
      priceText, // raw
      canonicalUrl: canonical,
    };
  } catch (err) {
    console.error("scrapeAmazonProduct error:", err.message);
    return {
      title: null,
      imageUrl: null,
      priceText: null,
      canonicalUrl: canonical,
    };
  }
}

// Central helper: create one link (used by /create and /bulk)
async function createSingleLink({ url, title, category, note, autoTitle }) {
  if (!url || !isAmazonUrl(url)) {
    throw new Error("Please provide a valid Amazon product URL.");
  }

  const rawOriginalUrl = url.trim();
  const resolved = await resolveRedirect(rawOriginalUrl);
  const canonical = buildCanonicalAmazonUrl(resolved);
  const affiliateUrl = addAffiliateTag(canonical);

  let scraped = {
    title: null,
    imageUrl: null,
    priceText: null,
    canonicalUrl: canonical,
  };

  try {
    scraped = await scrapeAmazonProduct(canonical);
  } catch (e) {
    console.error("Amazon scrape failed:", e.message || e);
  }

  const finalTitle =
    (autoTitle && scraped.title) || title || scraped.title || "Product";

  const finalCategory =
    category ||
    autoCategoryFromTitle(finalTitle) ||
    "other";

  const numericPrice = extractNumericPrice(scraped.priceText);

  const link = new Link({
    id: generateId(),
    source: "amazon",
    title: finalTitle,
    category: finalCategory,
    note: note || "",
    originalUrl: canonical,
    rawOriginalUrl,
    affiliateUrl,
    imageUrl: scraped.imageUrl || null,
    price: numericPrice,
    clicks: 0,
  });

  await link.save();
  return link;
}

// ---------- Routes ----------

// Simple test route
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Links API is alive" });
});

// Get all links (newest first)
router.get("/all", async (req, res) => {
  try {
    const links = await Link.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, links });
  } catch (err) {
    console.error("GET /all error:", err);
    res.status(500).json({ success: false, message: "Failed to load links." });
  }
});

// Create single affiliate link
router.post("/create", async (req, res) => {
  try {
    const { url, title, category, note, autoTitle } = req.body || {};
    if (!url) {
      return res
        .status(400)
        .json({ success: false, message: "URL is required." });
    }

    const link = await createSingleLink({
      url,
      title,
      category,
      note,
      autoTitle: autoTitle !== false,
    });

    res.json({ success: true, link });
  } catch (err) {
    console.error("POST /create error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Create failed." });
  }
});

// Bulk create (up to 10 URLs)
router.post("/bulk", async (req, res) => {
  try {
    const { urls, title, category, note, autoTitle } = req.body || {};
    if (!Array.isArray(urls) || !urls.length) {
      return res.status(400).json({
        success: false,
        message: "Please provide an array of URLs.",
      });
    }

    const cleanUrls = urls
      .map((u) => String(u || "").trim())
      .filter(Boolean)
      .slice(0, 10);

    const created = [];
    for (const url of cleanUrls) {
      try {
        const link = await createSingleLink({
          url,
          title,
          category,
          note,
          autoTitle: autoTitle !== false,
        });
        created.push(link);
      } catch (innerErr) {
        console.error("Bulk create single error:", innerErr.message || innerErr);
        // Skip bad ones, continue others
      }
    }

    res.json({
      success: true,
      createdCount: created.length,
      links: created,
    });
  } catch (err) {
    console.error("POST /bulk error:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Bulk create failed." });
  }
});

// Redirect + count click
router.get("/go/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const link = await Link.findOne({ id });

    if (!link) {
      return res.status(404).send("Link not found");
    }

    link.clicks = (link.clicks || 0) + 1;
    await link.save();

    const target =
      link.affiliateUrl || link.originalUrl || link.rawOriginalUrl;

    if (!target) {
      return res.status(500).send("No target URL configured.");
    }

    res.redirect(target);
  } catch (err) {
    console.error("GET /go/:id error:", err);
    res.status(500).send("Error redirecting.");
  }
});

// Delete link
router.delete("/delete/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const result = await Link.findOneAndDelete({ id });

    if (!result) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }

    res.json({ success: true, message: "Link deleted." });
  } catch (err) {
    console.error("DELETE /delete/:id error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to delete link." });
  }
});

// Update link (title, category, note)
router.put("/update/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { title, category, note } = req.body || {};

    const link = await Link.findOne({ id });
    if (!link) {
      return res
        .status(404)
        .json({ success: false, message: "Link not found." });
    }

    if (typeof title === "string" && title.trim()) {
      link.title = title.trim();
    }
    if (typeof category === "string" && category.trim()) {
      link.category = category.trim();
    }
    if (typeof note === "string") {
      link.note = note;
    }

    await link.save();
    res.json({ success: true, link });
  } catch (err) {
    console.error("PUT /update/:id error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to update link." });
  }
});

// Daily maintenance: refresh info (title, image, price) for recent links
router.post("/maintenance/daily", async (req, res) => {
  try {
    // Limit to latest 50 links for safety; can adjust later
    const links = await Link.find({})
      .sort({ createdAt: -1 })
      .limit(50);

    let processed = 0;
    let updated = 0;

    for (const link of links) {
      processed += 1;

      try {
        if (!link.originalUrl && link.rawOriginalUrl) {
          link.originalUrl = buildCanonicalAmazonUrl(link.rawOriginalUrl);
        }

        if (!link.originalUrl) continue;

        const scraped = await scrapeAmazonProduct(link.originalUrl);

        let changed = false;

        if (!link.title && scraped.title) {
          link.title = scraped.title;
          changed = true;
        }

        if (!link.imageUrl && scraped.imageUrl) {
          link.imageUrl = scraped.imageUrl;
          changed = true;
        }

        const newNumericPrice = extractNumericPrice(scraped.priceText);
        if (newNumericPrice !== null && newNumericPrice !== link.price) {
          link.price = newNumericPrice;
          changed = true;
        }

        if (changed) {
          await link.save();
          updated += 1;
        }
      } catch (innerErr) {
        console.error(
          "maintenance/daily per-link error:",
          innerErr.message || innerErr
        );
        // continue with next link
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

// Simple analytics summary for dashboard
router.get("/analytics/summary", async (req, res) => {
  try {
    const links = await Link.find().lean();
    const totalLinks = links.length;
    const totalClicks = links.reduce((sum, l) => sum + (l.clicks || 0), 0);

    const top = [...links]
      .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
      .slice(0, 3)
      .map((l) => ({
        id: l.id,
        title: l.title || "(no title)",
        clicks: l.clicks || 0,
      }));

    res.json({
      success: true,
      totalLinks,
      totalClicks,
      topProducts: top,
    });
  } catch (err) {
    console.error("GET /analytics/summary error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load analytics.",
    });
  }
});

module.exports = router;