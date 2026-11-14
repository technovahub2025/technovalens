
import crypto from "crypto";
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

  async initialize({readOnly=false}={}) {
    const db = getDB();
    this.collection = db.collection(this.collectionName);
    if(readOnly)return;

    await this.collection.createIndex({ fileId: 1 });
    await this.collection.createIndex({ ownerHash: 1, updatedAt: -1 });
    await this.collection.createIndex({ updatedAt: -1 });

    // Historical imports are handled by audit-storage.mjs after ownership and
    // integrity verification; startup never merges or invents history.
    console.log("MongoDB conversation store initialized.");
  }

  getCollection() {
    if (!this.collection) {
      throw new Error("Conversation store has not been initialized.");
    }

    return this.collection;
  }

  async create(fileId, title, ownerHash) {
    const now = new Date().toISOString();

    const conversation = {
      id: crypto.randomUUID(),
      fileId,
      ...(ownerHash ? { ownerHash } : {}),
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

  async get(id,ownerHash) {
    if(typeof id!=='string'||!id)return null;
    const conversation = await this.getCollection().findOne({
      $or: [{ _id: id }, { id }],...(ownerHash?{ownerHash}:{})
    });

    if (!conversation) return null;

    const { _id, ...result } = conversation;
    return { ...result, id: result.id || String(_id) };
  }

  async list(ownerHash) {
    const conversations = await this.getCollection()
      .find(ownerHash ? { ownerHash } : {})
      .sort({ updatedAt: -1 })
      .toArray();

    return conversations.map((conversation) => ({
      id: conversation.id || String(conversation._id),
      ownerHash: conversation.ownerHash,
      fileId: conversation.fileId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: (conversation.messages || []).length,
      lastMessage:
        conversation.messages?.at(-1)?.text?.slice(0, 180) || ""
    }));
  }

  async append(id, input,ownerHash) {
    const collection = this.getCollection();

    const conversation = await this.get(id,ownerHash);
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
              selectedSheet: typeof input.retryRequest.selectedSheet === 'string' ? input.retryRequest.selectedSheet : null,
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
        $or: [{ _id: id }, { id }],
        ...(ownerHash?{ownerHash}:{}),
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

  async delete(id,ownerHash) {
    const result = await this.getCollection().deleteOne({
      $or: [{ _id: id }, { id }],...(ownerHash?{ownerHash}:{})
    });

    return result.deletedCount > 0;
  }

  async deleteForFile(fileId,ownerHash) {
    await this.getCollection().deleteMany({
      fileId,...(ownerHash?{ownerHash}:{})
    });
  }
  async assignOwner(id, ownerHash) {
    await this.getCollection().updateOne({$or:[{_id:id},{id}],ownerHash:{$exists:false}},{$set:{ownerHash}});
  }
}
