// NodeBackend/db.js
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DBNAME || "alwaysonsale";

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is NOT set in environment variables.");
  // We still export mongoose so the app doesn't crash, but nothing will work.
}

async function connectDB() {
  if (!MONGODB_URI) return;

  try {
    console.log("Connecting to MongoDB Atlas...");
    await mongoose.connect(MONGODB_URI, {
      dbName: DB_NAME,
      // increase timeout a bit so Atlas has time to answer
      serverSelectionTimeoutMS: 20000,
    });
    console.log("✅ Connected to MongoDB Atlas. DB:", DB_NAME);
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
  }
}

connectDB();

module.exports = mongoose;
