// NodeBackend/scrapers/amazon.js
const axios = require("axios");
const cheerio = require("cheerio");

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

/**
 * Scrape key product fields from an Amazon product page.
 * Returns a plain object; does NOT talk to Mongo.
 */
async function scrapeAmazonProduct(url) {
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "en-IN,en;q=0.9",
    },
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
  const title = rawTitle || "Product";

  // Brand
  const brand =
    $("#bylineInfo").text().trim() ||
    $("#brand").text().trim() ||
    null;

  // Main image + gallery
  let primaryImage =
    $("#imgTagWrapperId img").attr("data-old-hires") ||
    $("#imgTagWrapperId img").attr("src") ||
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

  // Price text (we'll parse into number later)
  const priceText =
    $("#priceblock_ourprice").text() ||
    $("#priceblock_dealprice").text() ||
    $("#corePrice_feature_div .a-offscreen").first().text() ||
    $("#tp_price_block_total_price_ww .a-offscreen").first().text() ||
    null;

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

  const shortDescription =
    bullets[0] ||
    "This product is a simple, useful pick for daily life. Easy to add into your routine or lifestyle.";

  const longDescription = bullets.slice(0, 5).join(" ");

  // Category path (very rough – can refine later)
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
    primaryImage,
    images,
    priceText: priceText && priceText.trim(),
    rating,
    reviewsCount,
    shortDescription,
    longDescription,
    categoryPath,
    slug: slugify(title),
  };
}

module.exports = {
  scrapeAmazonProduct,
  slugify,
};
