// NodeBackend/scrapers/amazon.js
//
// Single source of truth for Amazon scraping.
// Pure functions – NO Mongo calls here.

const axios = require("axios");
const cheerio = require("cheerio");

// --------- Small utilities ----------

// Very small slug helper for SEO-friendly URLs
function slugify(text) {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isBotPage(html) {
  // Amazon's bot/robot check page usually contains this text
  return html.includes("To discuss automated access to Amazon data");
}

// Parse things like "₹2,149.00", "$39.99"
function parsePriceText(priceText) {
  if (!priceText) return { amount: null, currency: null, raw: null };

  const raw = priceText.trim();
  let currency = null;

  if (raw.includes("₹")) currency = "INR";
  else if (raw.includes("$")) currency = "USD";
  else if (raw.includes("€")) currency = "EUR";

  // Keep digits and dot only
  const cleaned = raw.replace(/[^\d.]/g, "");
  if (!cleaned) return { amount: null, currency, raw };

  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return { amount: null, currency, raw };

  // Most prices here are whole currency in INR, round for safety
  const amount = Math.round(num);
  return { amount, currency, raw };
}

// Very rough category → top-level mapping for your pills
function inferTopCategory(categoryPath = []) {
  const joined = categoryPath.join(" ").toLowerCase();

  if (joined.includes("shirt") || joined.includes("t-shirt")) return "tshirts";
  if (joined.includes("jeans")) return "jeans";
  if (joined.includes("shoe") || joined.includes("sneaker")) return "shoes";
  if (joined.includes("bag") || joined.includes("backpack")) return "bags";
  if (
    joined.includes("laptop") ||
    joined.includes("computer") ||
    joined.includes("electronics")
  )
    return "electronics";
  if (joined.includes("home") || joined.includes("kitchen"))
    return "home & living";
  if (
    joined.includes("clothing") ||
    joined.includes("apparel") ||
    joined.includes("fashion")
  )
    return "clothing";

  return "other";
}

/**
 * Scrape key product fields from an Amazon product page.
 * Returns a plain object; does NOT talk to Mongo.
 *
 * Throws:
 *  - err.isBotProtection = true  if Amazon shows bot-protection page
 */
async function scrapeAmazonProduct(url) {
  const res = await axios.get(url, {
    headers: {
      // UPDATED HEADERS FOR BOT DETECTION BYPASS
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "en-IN,en;q=0.9",
      "DNT": "1",
    },
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const html = res.data;

  if (isBotPage(html)) {
    const err = new Error("Amazon bot protection page detected");
    err.isBotProtection = true;
    throw err;
  }

  const $ = cheerio.load(html);

  // Title
  const rawTitle = $("#productTitle").text().trim();
  const metaOgTitle = $('meta[property="og:title"]').attr("content");
  const fallbackTitle = $("title").text().trim();

  const title = rawTitle || metaOgTitle || fallbackTitle || "Product";

  // Brand
  const brand =
    $("#bylineInfo").text().trim() ||
    $("#brand").text().trim() ||
    null;

  // Main image + gallery
  let primaryImage =
    $("#imgTagWrapperId img").attr("data-old-hires") ||
    $("#imgTagWrapperId img").attr("src") ||
    $("img#landingImage").attr("src") ||
    $('meta[property="og:image"]').attr("content") ||
    null;

  const images = [];
  $("#altImages img").each((_, img) => {
    let src = $(img).attr("src");
    if (!src) return;
    // Try to remove tiny thumbnail size suffix
    src = src.replace(/\._.*?_\./, "._SL800_.");
    images.push(src);
  });

  if (!primaryImage && images.length > 0) {
    primaryImage = images[0];
  } else if (primaryImage) {
    images.unshift(primaryImage);
  }

  // Price text (we'll parse into number)
  const priceText =
    // Modern high-priority price containers (The Fix)
    $("#corePriceDisplay_feature_div .a-offscreen").first().text() ||
    $("#desktop_buybox .a-price .a-offscreen").first().text() ||
    // Older, but sometimes still valid selectors
    $("#priceblock_ourprice").text() ||
    $("#priceblock_dealprice").text() ||
    $("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen")
      .first()
      .text() ||
    $(".a-price .a-offscreen").first().text() ||
    null;

  const priceParsed = parsePriceText(priceText);

  // Rating
  let rating = null;
  const ratingText = $(".a-icon.a-icon-star span.a-icon-alt").first().text();
  if (ratingText) {
    const match = ratingText.match(/([\d.]+)/);
    if (match) rating = parseFloat(match[1]);
  }

  // Reviews count
  let reviewsCount = null;
  const reviewsText = $("#acrCustomerReviewText").text();
  if (reviewsText) {
    const m = reviewsText.replace(/,/g, "").match(/([\d]+)/);
    if (m) reviewsCount = parseInt(m[1], 10);
  }

  // Bullets for descriptions
  const bullets = [];
  $("#feature-bullets li").each((_, li) => {
    const t = $(li).text().replace(/\s+/g, " ").trim();
    if (t) bullets.push(t);
  });

  const defaultShort =
    "This product is a simple, useful pick for daily life. Easy to add into your routine or lifestyle.";

  const shortDescription = bullets[0] || defaultShort;
  const longDescription = bullets.slice(0, 5).join(" ");

  // Category path (very rough – breadcrumb)
  const categoryPath = [];
  $("#wayfinding-breadcrumbs_container ul li a").each((_, a) => {
    const t = $(a).text().replace(/\s+/g, " ").trim();
    if (t) categoryPath.push(t);
  });

  // Short title for cards
  const shortTitle =
    title.length > 80 ? title.slice(0, 77).trimEnd() + "…" : title;

  return {
    title,
    shortTitle,
    brand,
    primaryImage: primaryImage || null,
    images,
    priceText: priceParsed.raw || priceText || null,
    price: priceParsed.amount,
    priceCurrency: priceParsed.currency,
    rating,
    reviewsCount,
    shortDescription,
    longDescription,
    categoryPath,
    topCategory: inferTopCategory(categoryPath),
    slug: slugify(title),
  };
}

module.exports = {
  scrapeAmazonProduct,
  slugify,
};
