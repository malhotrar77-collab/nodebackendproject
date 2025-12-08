// NodeBackend/routes/links.js
const express = require("express");
const axios = require("axios");
const Link = require("../models/link");

const router = express.Router();

// ------------------------
// Helpers
// ------------------------

function genId() {
  // short, human-friendly ids like "3b4104"
  return Math.random().toString(16).slice(2, 8);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return null;
}

// ---------- Amazon scraping (V2.1 – free, no external API) ---------- //

const AMAZON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "en-IN,en;q=0.9",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
};

/**
 * tiny helper to read <meta ... property="xxx" content="...">
 */
function extractMetaContent(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Extract <title>…</title> and clean the noisy Amazon suffix.
 */
function extractTitleFromHtml(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return null;
  let title = m[1].trim();

  // Remove common Amazon noise
  title = title.replace(/^Amazon\.in:\s*/i, "");
  title = title.replace(/\s*:\s*Buy.*Online.*$/i, "");
  title = title.replace(/\s*:\s*Amazon\.in.*$/i, "");
  return title.trim();
}

/**
 * Try to read product data from JSON-LD blocks.
 */
function extractFromLdJson(html) {
  const results = {};

  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  while ((match = scriptRegex.exec(html))) {
    let jsonText = match[1].trim();
    try {
      const data = JSON.parse(jsonText);
      const arr = Array.isArray(data) ? data : [data];
      const product =
        arr.find((d) => d && d["@type"] === "Product") || arr[0] || null;
      if (!product) continue;

      if (product.name && !results.title) {
        results.title = String(product.name);
      }

      if (product.image && !results.imageUrl) {
        if (Array.isArray(product.image)) {
          results.imageUrl = product.image[0];
        } else if (typeof product.image === "string") {
          results.imageUrl = product.image;
        }
      }

      const offers = Array.isArray(product.offers)
        ? product.offers[0]
        : product.offers;
      if (offers && !results.price) {
        if (offers.price && offers.priceCurrency) {
          results.price = `${offers.priceCurrency} ${offers.price}`;
        } else if (offers.price) {
          results.price = String(offers.price);
        }
      }
    } catch {
      // ignore bad JSON blocks
    }
  }

  return results;
}

/**
 * Fallback: hunt for price in inline JSON or HTML.
 */
function extractPriceFromHtml(html) {
  // JSON pattern: "price":"₹2,149"
  let m = html.match(/"price"\s*:\s*"([^"]+)"/i);
  if (m && m[1]) {
    let p = m[1].trim();
    if (!/[₹$]/.test(p)) p = "₹" + p;
    return p.replace(/\.00$/, "").trim();
  }

  // some pages use "priceAmount":1234 or "priceValue"
  m = html.match(/"price(?:Amount|Value)"\s*:\s*"?(₹?[\d,\.]+)"?/i);
  if (m && m[1]) {
    let p = m[1].trim();
    if (!/[₹$]/.test(p)) p = "₹" + p;
    return p.replace(/\.00$/, "").trim();
  }

  // priceblock_ourprice / dealprice spans
  m = html.match(
    /id="priceblock_[^"]+"[^>]*>\s*<span[^>]*>\s*([^<]+)<\/span>/i
  );
  if (m && m[1]) {
    return m[1].trim();
  }

  return null;
}

/**
 * Fallback: hunt for an image URL in Amazon's image JSON / OG tags.
 */
function extractImageFromHtml(html) {
  // OG first (often most stable)
  let m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["']/i);

  if (m && m[1]) return m[1].trim();

  // hiRes / large / data-old-hires / mainImageUrl patterns
  m =
    html.match(/"hiRes"\s*:\s*"([^"]+)"/i) ||
    html.match(/"large"\s*:\s*"([^"]+)"/i) ||
    html.match(/data-old-hires="([^"]+)"/i) ||
    html.match(/"mainImageUrl"\s*:\s*"([^"]+)"/i);

  if (m && m[1]) return m[1].trim();
  return null;
}

/**
 * Main scraper: returns { title?, imageUrl?, price? }
 */
async function scrapeAmazonMetadata(url) {
  if (!url) return {};

  try {
    const res = await axios.get(url, {
      headers: AMAZON_HEADERS,
      maxRedirects: 5,
      timeout: 15000,
    });

    const html = res.data || "";

    // If Amazon sent us a bot/robot page, just bail
    if (/To discuss automated access to Amazon data/i.test(html)) {
      console.warn("Amazon bot page detected for URL", url);
      return {};
    }

    const ld = extractFromLdJson(html);

    const title = firstNonEmpty(
      ld.title,
      extractMetaContent(html, "og:title"),
      extractTitleFromHtml(html)
    );

    const imageUrl = firstNonEmpty(
      ld.imageUrl,
      extractMetaContent(html, "og:image"),
      extractImageFromHtml(html)
    );

    const price = firstNonEmpty(ld.price, extractPriceFromHtml(html));

    return { title, imageUrl, price };
  } catch (err) {
    console.error("❌ Amazon scrape failed:", err.message);
    return {};
  }
}

// ---------- Auto-category V3 (simple, keyword based) ---------- //

function autoCategoryFromText(title = "", note = "") {
  const text = `${title} ${note}`.toLowerCase();

  // SHOES
  if (
    /\b(shoe|sneaker|sneakers|running shoe|sports shoe|loafer|slipper|flip flop|boots?)\b/.test(
      text
    )
  ) {
    return "shoes";
  }

  // CLOTHING
  if (
    /\b(t\-?shirt|shirt|jeans?|denim|hoodie|sweater|jacket|kurta|trouser|pant|jogger|shorts?|track pant|cargo)\b/.test(
      text
    )
  ) {
    return "clothing";
  }

  // BAGS
  if (
    /\b(bag|backpack|laptop bag|tote|sling bag|handbag|duffel|messenger bag)\b/.test(
      text
    )
  ) {
    return "bags";
  }

  // BEAUTY & HAIR
  if (
    /\b(shampoo|conditioner|face wash|serum|moisturiser|moisturizer|skin cream|sunscreen|lip balm|foundation|makeup)\b/.test(
      text
    )
  ) {
    return "beauty";
  }

  // PERSONAL CARE
  if (
    /\b(body wash|soap|toothpaste|tooth brush|toothbrush|razor|trimmer|deodorant|deo|perfume|sanitizer|sanitiser)\b/.test(
      text
    )
  ) {
    return "personal";
  }

  // ELECTRONICS
  if (
    /\b(tv|smart tv|monitor|laptop|mobile|smartphone|phone|earbud|ear buds|earphones?|headphones?|soundbar|speaker|camera|tablet|router|power bank)\b/.test(
      text
    )
  ) {
    return "electronics";
  }

  // HOME & LIVING
  if (
    /\b(cushion|pillow|blanket|bedsheet|bed sheet|curtain|lamp|light|kitchen|cooker|pan|frying pan|bottle|flask|mattress|storage box)\b/.test(
      text
    )
  ) {
    return "home";
  }

  return "other";
}

// ------------------------
// Routes
// ------------------------

// quick health check
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Links route OK" });
});

// very simple DB check
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
    console.error("GET /all error:", err);
    res.status(500).json({ success: false, message: "Failed to load links." });
  }
});

// Create a single link
router.post("/create", async (req, res) => {
  const { url, title, category, note, autoTitle } = req.body || {};
  const trimmedUrl = (url || "").trim();

  if (!trimmedUrl) {
    return res
      .status(400)
      .json({ success: false, message: "Missing Amazon product URL." });
  }

  try {
    // Always attempt scrape to get image + price (and maybe title)
    const scraped = await scrapeAmazonMetadata(trimmedUrl);

    const finalTitle = firstNonEmpty(
      title,
      autoTitle ? scraped.title : null
    );

    let finalCategory = (category || "").trim().toLowerCase();
    if (!finalCategory) {
      finalCategory = autoCategoryFromText(finalTitle || "", note || "");
    }

    const doc = await Link.create({
      id: genId(),
      source: "amazon",
      title: finalTitle || "-",
      category: finalCategory || "other",
      note: note || "",
      originalUrl: trimmedUrl,
      rawOriginalUrl: trimmedUrl,
      affiliateUrl: trimmedUrl, // you are already pasting affiliate short URL
      imageUrl: scraped.imageUrl || "",
      price: scraped.price || "",
      clicks: 0,
    });

    res.json({ success: true, link: doc });
  } catch (err) {
    console.error("POST /create error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to create affiliate link." });
  }
});

// Bulk create (up to 10)
router.post("/bulk", async (req, res) => {
  const { urls, title, category, note, autoTitle } = req.body || {};
  const list = Array.isArray(urls)
    ? urls.map((u) => String(u || "").trim()).filter(Boolean)
    : [];

  if (!list.length) {
    return res
      .status(400)
      .json({ success: false, message: "No URLs provided for bulk create." });
  }

  if (list.length > 10) {
    return res
      .status(400)
      .json({ success: false, message: "Limit bulk create to 10 URLs." });
  }

  const created = [];

  try {
    for (const url of list) {
      try {
        const scraped = await scrapeAmazonMetadata(url);

        const finalTitle = firstNonEmpty(
          title,
          autoTitle ? scraped.title : null
        );

        let finalCategory = (category || "").trim().toLowerCase();
        if (!finalCategory) {
          finalCategory = autoCategoryFromText(finalTitle || "", note || "");
        }

        const doc = await Link.create({
          id: genId(),
          source: "amazon",
          title: finalTitle || "-",
          category: finalCategory || "other",
          note: note || "",
          originalUrl: url,
          rawOriginalUrl: url,
          affiliateUrl: url,
          imageUrl: scraped.imageUrl || "",
          price: scraped.price || "",
          clicks: 0,
        });

        created.push(doc.id);
      } catch (innerErr) {
        console.error("Bulk create error for URL:", url, innerErr.message);
      }
    }

    res.json({
      success: true,
      createdCount: created.length,
      createdIds: created,
    });
  } catch (err) {
    console.error("POST /bulk error:", err);
    res
      .status(500)
      .json({ success: false, message: "Bulk create failed unexpectedly." });
  }
});

// Redirect + click tracking
router.get("/go/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const link = await Link.findOne({ id });
    if (!link) {
      return res.status(404).send("Link not found.");
    }

    link.clicks = (link.clicks || 0) + 1;
    await link.save();

    const target =
      link.affiliateUrl || link.originalUrl || link.rawOriginalUrl;
    if (!target) {
      return res.status(500).send("No URL configured for this link.");
    }

    res.redirect(target);
  } catch (err) {
    console.error("GET /go/:id error:", err);
    res.status(500).send("Error redirecting.");
  }
});

// Delete a link
router.delete("/delete/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const result = await Link.deleteOne({ id });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error("DELETE /delete error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to delete link." });
  }
});

// -------- Daily maintenance: fix missing image/price/category -------- //

router.post("/maintenance/daily", async (req, res) => {
  try {
    // Limit how many we fix in one run so Render doesn't kill the process
    const candidates = await Link.find({
      $or: [
        { imageUrl: { $in: [null, ""] } },
        { price: { $in: [null, ""] } },
        { category: { $in: [null, "", "other", "-"] } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(15);

    let updatedCount = 0;

    for (const link of candidates) {
      const url =
        link.originalUrl || link.rawOriginalUrl || link.affiliateUrl || "";
      if (!url) continue;

      try {
        const scraped = await scrapeAmazonMetadata(url);

        let changed = false;

        if (!link.imageUrl && scraped.imageUrl) {
          link.imageUrl = scraped.imageUrl;
          changed = true;
        }
        if (!link.price && scraped.price) {
          link.price = scraped.price;
          changed = true;
        }
        if (!link.category || link.category === "other" || link.category === "-") {
          const autoCat = autoCategoryFromText(link.title || "", link.note || "");
          if (autoCat && autoCat !== link.category) {
            link.category = autoCat;
            changed = true;
          }
        }

        if (changed) {
          await link.save();
          updatedCount++;
        }
      } catch (innerErr) {
        console.error(
          "Maintenance scrape failed for",
          link.id,
          innerErr.message
        );
      }
    }

    res.json({
      success: true,
      processed: candidates.length,
      updated: updatedCount,
    });
  } catch (err) {
    console.error("POST /maintenance/daily error:", err);
    res
      .status(500)
      .json({ success: false, message: "Maintenance job failed." });
  }
});

module.exports = router;