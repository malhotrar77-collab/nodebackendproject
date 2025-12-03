const express = require("express");
const path = require("path");
const app = express();

// IMPORTANT for Render: use their assigned port
const PORT = process.env.PORT || 3000;

// Serve files from the "public" folder (frontend)
app.use(express.static(path.join(__dirname, "public")));

// Import links router (includes Amazon, Flipkart, Admitad)
const linksRoute = require("./routes/links");

// API Routes
app.use("/api/links", linksRoute);

// Admitad deep-link route (new)
app.use("/api/links/admitad", linksRoute);  // <-- important line

// Health check
app.get("/ping", (req, res) => {
  res.json({ status: "ok" });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
