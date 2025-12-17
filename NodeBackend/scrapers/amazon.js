// NodeBackend/scrapers/amazon.js
// Single source of truth for Amazon scraping – now with random costumes
const axios = require("axios");
const cheerio = require("cheerio");
const { pickCostume } = require("../userAgents");   // kid-added costume box

// --------- tiny helpers ----------
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
  return html.includes("To discuss automated access to Amazon data");
}

function parsePriceText(priceText) {
  if (!priceText) return { amount: null, currency: null, raw: null };
  const raw = priceText.trim();
  let currency = null;
  if (raw.includes("₹")) currency = "INR";
  else if (raw.includes("$")) currency = "USD";
  else if (raw.includes("€")) currency = "EUR";

  const digits = raw.replace(/[^\d.]/g, "");
  if (!digits) return { amount: null, currency, raw };
  const num = parseFloat(digits);
  if (!Number.isFinite(num)) return { amount: null, currency, raw };
  return { amount: Math.round(num), currency, raw };
}

function inferTopCategory(categoryPath = []) {
  const txt = categoryPath.join(" ").toLowerCase();
  if (txt.includes("shirt") || txt.includes("t-shirt")) return "tshirts";
  if (txt.includes("jeans")) return "jeans";
  if (txt.includes("shoe")) return "shoes";
  if (txt.includes("bag") || txt.includes("backpack")) return "bags";
  if (txt.includes("laptop") || txt.includes("electronics")) return "electronics";
  if (txt.includes("home") || txt.includes("kitchen")) return "home & living";
  if (txt.includes("clothing")) return "clothing";
  return "other";
}

// --------- main scraper ----------
async function scrapeAmazonProduct(url) {
  const res = await axios.get(url, {
    headers: {
      "User-Agent": pickCostume(),          // 🎭 random costume every time
      "Accept-Encoding": "gzip, deflate, br",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      DNT: "1"
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

  // title
  const title =
    $("#productTitle").text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    "Product";

  // brand
  const brand =
    $("#bylineInfo").text().trim() ||
    $("#brand").text().trim() ||
    null;

  // images
  let primaryImage =
    $("#imgTagWrapperId img").attr("data-old-hires") ||
    $("#imgTagWrapperId img").attr("src") ||
    $("img#landingImage").attr("src") ||
    $('meta[property="og:image"]').attr("content") ||
    null;
  if (primaryImage && primaryImage.startsWith("//")) primaryImage = "https:" + primaryImage;

  const images = [];
  $("#altImages img").each((_, img) => {
    let src = $(img).attr("src");
    if (!src) return;
    src = src.replace(/\._.*?_\./, "._SL800_.");
    images.push(src);
  });
  if (!primaryImage && images.length) primaryImage = images[0];
  else if (primaryImage) images.unshift(primaryImage);

  // price
  const priceText =
    $("#corePriceDisplay_feature_div .a-offscreen").first().text() ||
    $("#desktop_buybox .a-price .a-offscreen").first().text() ||
    $("#priceblock_ourprice").text() ||
    $("#priceblock_dealprice").text() ||
    $(".a-price .a-offscreen").first().text() ||
    null;
  const priceParsed = parsePriceText(priceText);

  // rating
  let rating = null;
  const ratingText = $(".a-icon.a-icon-star span.a-icon-alt").first().text();
  if (ratingText) {
    const m = ratingText.match(/([\d.]+)/);
    if (m) rating = parseFloat(m[1]);
  }

  // reviews count
  let reviewsCount = null;
  const revText = $("#acrCustomerReviewText").text();
  if (revText) {
    const m2 = revText.replace(/,/g, "").match(/([\d]+)/);
    if (m2) reviewsCount = parseInt(m2[1], 10);
  }

  // bullets
  const bullets = [];
  $("#feature-bullets li").each((_, li) => {
    const t = $(li).text().replace(/\s+/g, " ").trim();
    if (t) bullets.push(t);
  });
  const shortDescription = bullets[0] || "This product is a simple, useful pick for daily life.";
  const longDescription = bullets.slice(0, 5).join(" ");

  // category path
  const categoryPath = [];
  $("#wayfinding-breadcrumbs_container ul li a").each((_, a) => {
    const txt = $(a).text().replace(/\s+/g, " ").trim();
    if (txt) categoryPath.push(txt);
  });

  return {
    title,
    shortTitle: title.length > 80 ? title.slice(0, 77) + "…" : title,
    brand,
    primaryImage,
    images,
    priceText: priceParsed.raw || priceText,
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

module.exports = { scrapeAmazonProduct, slugify };
