// routes/admitadClient.js
const axios = require("axios");

let cachedToken = null;
let tokenExpiresAt = 0;

// Get an OAuth token from Admitad using client credentials
async function getAdmitadToken() {
  const now = Date.now();

  // Reuse token if still valid for > 60 seconds
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const clientId = process.env.ADMITAD_CLIENT_ID;
  const clientSecret = process.env.ADMITAD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Admitad credentials are not configured. Please set ADMITAD_CLIENT_ID and ADMITAD_CLIENT_SECRET."
    );
  }

  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await axios.post(
    "https://api.admitad.com/token/",
    new URLSearchParams({
      grant_type: "client_credentials",
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const { access_token, expires_in } = resp.data;
  cachedToken = access_token;
  tokenExpiresAt = now + expires_in * 1000;

  return cachedToken;
}

/**
 * Create a deeplink using Admitad API.
 *
 * @param {Object} opts
 * @param {string} opts.campaignId  Admitad campaign (offer) id, e.g. 123456
 * @param {string} opts.url         Original product URL
 */
async function createAdmitadDeeplink({ campaignId, url }) {
  const token = await getAdmitadToken();

  // Some implementations use `/deeplink/{campaignId}/?subid=&ulp=` etc.
  // We'll use the universal deeplink endpoint:
  const websiteId = process.env.ADMITAD_WEBSITE_ID;

  if (!websiteId) {
    throw new Error("Missing ADMITAD_WEBSITE_ID env variable.");
  }

  const params = new URLSearchParams({
    website_id: websiteId,
    campaign_id: String(campaignId),
    ulp: url, // encoded automatically
  });

  const resp = await axios.get("https://api.admitad.com/deeplink/", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    params,
  });

  // Response usually contains "deeplink" or "result" field; adjust when you see real shape
  const data = resp.data;

  const deeplink =
    data.deeplink ||
    data.result?.deeplink ||
    data.results?.[0]?.deeplink ||
    null;

  if (!deeplink) {
    throw new Error("Could not find deeplink in Admitad response.");
  }

  return deeplink;
}

module.exports = {
  createAdmitadDeeplink,
};
