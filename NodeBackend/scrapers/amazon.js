// scrapers/amazon.js
const axios = require("axios");
const cheerio = require("cheerio");
const { pickCostume } = require("../userAgents");

function isBotPage(html) {
  return html.includes("To discuss automated access to Amazon data");
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeAmazonProduct(url, retries = 3) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": pickCostume(),
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
      console.warn("Bot protection page detected. Retrying...");
      if (retries > 0) {
        await delay(5000); // Wait for 5 seconds
        return scrapeAmazonProduct(url, retries - 1);
      }
      throw new Error("Amazon bot protection page detected");
    }

    const $ = cheerio.load(html);

    // Your scraping logic here...

  } catch (e) {
    console.error("Failed to scrape Amazon product:", e.message);
    throw e;
  }
}

module.exports = { scrapeAmazonProduct };
