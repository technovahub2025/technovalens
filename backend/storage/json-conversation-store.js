
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDB } from "../config/db.js";

const ANSWER_SOURCES = new Set([
  "gemini-primary",
  "gemini-fallback",
  "local-pdf",
  "local-spreadsheet",
  "gemini",
  "local"
]);

export class JsonConversationStore {
  constructor(directory) {
    this.directory = directory;
    this.collectionName = "conversations";
    this.collection = null;
  }

  async initialize() {
    const db = getDB();
    this.collection = db.collection(this.collectionName);

    await this.collection.createIndex({ fileId: 1 });
    await this.collection.createIndex({ updatedAt: -1 });

    // Migrate existing conversations.json records into MongoDB.
    // Existing records are preserved and duplicate IDs are not inserted twice.
    const filePath = path.join(this.directory, "conversations.json");

    try {
      const persisted = JSON.parse(
        fs.readFileSync(filePath, "utf8")
      );

      if (Array.isArray(persisted)) {
        for (const conversation of persisted) {
          if (
            typeof conversation.id === "string" &&
            typeof conversation.fileId === "string" &&
            Array.isArray(conversation.messages)
          ) {
            await this.collection.updateOne(
              { _id: conversation.id },
              {
                $setOnInsert: {
                  ...conversation,
                  _id: conversation.id
                }
              },
              { upsert: true }
            );
          }
        }
      }

      console.log("Existing conversations migration checked.");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("Conversation migration warning:", error.message);
      }
    }

    console.log("MongoDB conversation store initialized.");
  }

  getCollection() {
    if (!this.collection) {
      throw new Error("Conversation store has not been initialized.");
    }

    return this.collection;
  }

  async create(fileId, title) {
    const now = new Date().toISOString();

    const conversation = {
      id: crypto.randomUUID(),
      fileId,
      title: String(title || "Conversation").slice(0, 200),
      createdAt: now,
      updatedAt: now,
      messages: []
    };

    await this.getCollection().insertOne({
      ...conversation,
      _id: conversation.id
    });

    return conversation;
  }

  async get(id) {
    const conversation = await this.getCollection().findOne({
      _id: id
    });

    if (!conversation) return null;

    const { _id, ...result } = conversation;
    return result;
  }

  async list() {
    const conversations = await this.getCollection()
      .find({})
      .sort({ updatedAt: -1 })
      .toArray();

    return conversations.map((conversation) => ({
      id: conversation.id,
      fileId: conversation.fileId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      lastMessage:
        conversation.messages.at(-1)?.text?.slice(0, 180) || ""
    }));
  }

  async append(id, input) {
    const collection = this.getCollection();

    const conversation = await this.get(id);
    if (!conversation) return null;

    const message = {
      id: crypto.randomUUID(),
      role: input.role,
      text: input.text,
      createdAt: new Date().toISOString(),

      ...(input.source && ANSWER_SOURCES.has(input.source)
        ? { source: input.source }
        : {}),

      ...(input.cached === true
        ? { cached: true }
        : {}),

      ...(input.retryRequest &&
      typeof input.retryRequest.question === "string"
        ? {
            retryRequest: {
              fileId: conversation.fileId,
              question: input.retryRequest.question.slice(0, 4000),
              retryCount: Math.max(
                0,
                Math.min(
                  2,
                  Number(input.retryRequest.retryCount) || 0
                )
              )
            }
          }
        : {})
    };

    const result = await collection.updateOne(
      {
        _id: id,
        updatedAt: conversation.updatedAt
      },
      {
        $push: { messages: message },
        $set: { updatedAt: message.createdAt }
      }
    );

    if (result.modifiedCount === 0) {
      throw new Error(
        "Conversation changed during message save. Please retry."
      );
    }

    return message;
  }

  async delete(id) {
    const result = await this.getCollection().deleteOne({
      _id: id
    });

    return result.deletedCount > 0;
  }

  async deleteForFile(fileId) {
    await this.getCollection().deleteMany({
      fileId
    });
  }
}
