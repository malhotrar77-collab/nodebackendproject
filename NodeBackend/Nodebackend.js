// NodeBackend/db.js
// Simple MongoDB (Mongoose) connection helper

const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DBNAME = process.env.MONGODB_DBNAME || "alwaysonsale";

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is not set in environment variables.");
  throw new Error("MONGODB_URI missing");
}

let isConnected = false;

async function connectDB() {
  if (isConnected) {
    return mongoose.connection;
  }

  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: MONGODB_DBNAME,
    });

    isConnected = true;
    console.log("✅ MongoDB connected:", MONGODB_DBNAME);
    return mongoose.connection;
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    throw err;
  }
}

module.exports = connectDB;
