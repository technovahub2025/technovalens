
import { MongoClient } from "mongodb";

let client;
let db;

export async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is missing from environment variables");
  }

  client = new MongoClient(uri);

  await client.connect();

  db = client.db("technovalens");

  console.log("MongoDB connected successfully!");

  return db;
}

export function getDB() {
  if (!db) {
    throw new Error("MongoDB is not connected");
  }

  return db;
}
