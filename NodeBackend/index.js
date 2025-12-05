// NodeBackend/index.js

const express = require("express");
const path = require("path");
const connectDB = require("./db");

const app = express();

// IMPORTANT for Render: use their assigned port
const PORT = process.env.PORT || 3000;

// Serve files from the "public" folder (frontend)
app.use(express.static(path.join(__dirname, "public")));

// Parse JSON body (for future APIs)
app.use(express.json());

// Import links router
const linksRoute = require("./routes/links");

// API Routes
app.use("/api/links", linksRoute);

// Health check (includes simple DB ping)
app.get("/ping", async (req, res) => {
  try {
    await connectDB();
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", db: "disconnected" });
  }
});

// Connect DB then start server
connectDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server because DB connection failed.");
    console.error(err);
    process.exit(1);
  });
