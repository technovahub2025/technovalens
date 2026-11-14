
import { MongoClient } from "mongodb";

let client;
let db;

export async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is missing from environment variables");
  }

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

  await client.connect();

  db = client.db(process.env.MONGODB_DB_NAME?.trim() || "technovalens");

  console.log("MongoDB connected successfully!");

  return db;
}

export function getDB() {
  if (!db) {
    throw new Error("MongoDB is not connected");
  }

  return db;
}
