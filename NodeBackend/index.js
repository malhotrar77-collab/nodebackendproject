// NodeBackend/index.js

const express = require("express");
const cors = require("cors");
const path = require("path");

require("./db"); // connect to MongoDB (db.js handles connection)

const linksRoute = require("./routes/links");

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// API routes
app.use("/api/links", linksRoute);

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// IMPORTANT for Render: use their PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
