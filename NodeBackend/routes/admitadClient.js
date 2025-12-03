// NodeBackend/routes/admitadClient.js

const axios = require("axios");

// Read env vars once
const CLIENT_ID = process.env.ADMITAD_CLIENT_ID;
const CLIENT_SECRET = process.env.ADMITAD_CLIENT_SECRET;
const WEBSITE_ID = process.env.ADMITAD_WEBSITE_ID;

// On boot, log whether env vars are present (but not the full secrets)
console.log("Admitad env check →", {
  hasClientId: !!CLIENT_ID,
  hasClientSecret: !!CLIENT_SECRET,
  hasWebsiteId: !!WEBSITE_ID,
});

if (!CLIENT_ID || !CLIENT_SECRET || !WEBSITE_ID) {
  console.warn(
    "WARNING: Some Admitad env vars are missing. " +
      "Set ADMITAD_CLIENT_ID, ADMITAD_CLIENT_SECRET, ADMITAD_WEBSITE_ID in Render."
  );
}

// Get OAuth token from Admitad
async function getAdmitadToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString();

  const url = "https://api.admitad.com/token/";

  const res = await axios.post(url, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.data || !res.data.access_token) {
    throw new Error("No access_token in Admitad token response");
  }

  return res.data.access_token;
}

// Create deeplink for a given campaign + URL
async function createAdmitadDeeplink({ campaignId, url }) {
  const token = await getAdmitadToken();

  const res = await axios.get("https://api.admitad.com/deeplink/", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    params: {
      website_id: WEBSITE_ID,
      campaign_id: campaignId,
      ulp: url,
    },
  });

  const data = res.data;

  // Shape may differ; adjust when we see real response
  if (!data || !data.deeplink) {
    throw new Error("No deeplink field in Admitad response");
  }

  return data.deeplink;
}

module.exports = { createAdmitadDeeplink };
