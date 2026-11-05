import crypto from "crypto";
import fs from "fs";
import path from "path";

const ANSWER_SOURCES = new Set([
  "gemini-primary", "gemini-fallback", "local-pdf", "local-spreadsheet", "gemini", "local"
]);

export class JsonConversationStore {
  constructor(directory) {
    this.filePath = path.join(directory, "conversations.json");
    this.records = new Map();
    try {
      const persisted = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      for (const conversation of Array.isArray(persisted) ? persisted : []) {
        if (typeof conversation.id === "string" && typeof conversation.fileId === "string" && Array.isArray(conversation.messages)) {
          this.records.set(conversation.id, conversation);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn("Conversation store could not be loaded:", { errorName: error?.name || "Error" });
    }
  }

  persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify([...this.records.values()]), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  create(fileId, title) {
    const now = new Date().toISOString();
    const conversation = {
      id: crypto.randomUUID(), fileId, title: String(title || "Conversation").slice(0, 200),
      createdAt: now, updatedAt: now, messages: []
    };
    this.records.set(conversation.id, conversation);
    this.persist();
    return conversation;
  }

  get(id) { return this.records.get(id) || null; }

  list() {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(conversation => ({
      id: conversation.id, fileId: conversation.fileId, title: conversation.title,
      createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      lastMessage: conversation.messages.at(-1)?.text?.slice(0, 180) || ""
    }));
  }

  append(id, input) {
    const conversation = this.get(id);
    if (!conversation) return null;
    const message = {
      id: crypto.randomUUID(),
      role: input.role,
      text: input.text,
      createdAt: new Date().toISOString(),
      ...(input.source && ANSWER_SOURCES.has(input.source) ? { source: input.source } : {}),
      ...(input.cached === true ? { cached: true } : {}),
      ...(input.retryRequest && typeof input.retryRequest.question === "string"
        ? { retryRequest: { fileId: conversation.fileId, question: input.retryRequest.question.slice(0, 4000), retryCount: Math.max(0, Math.min(2, Number(input.retryRequest.retryCount) || 0)) } }
        : {})
    };
    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;
    this.persist();
    return message;
  }

  delete(id) {
    if (!this.records.delete(id)) return false;
    this.persist();
    return true;
  }

  deleteForFile(fileId) {
    let changed = false;
    for (const [id, conversation] of this.records) {
      if (conversation.fileId === fileId) { this.records.delete(id); changed = true; }
    }
    if (changed) this.persist();
  }
}
