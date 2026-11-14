import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Explicit standalone mode for local development and isolated integration tests.
export class FileConversationStore {
  constructor(directory) { this.file = path.join(directory, 'conversations.json'); this.items = []; }
  async initialize() { try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  save() { const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.items), { mode: 0o600 }); fs.renameSync(temp, this.file); }
  async list(ownerHash) { return this.items.filter(item=>!ownerHash||item.ownerHash===ownerHash).map(({ messages, ...item }) => ({ ...item, messageCount: messages.length, lastMessage: messages.at(-1)?.text?.slice(0,180) || '' })).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async get(id,ownerHash) { return this.items.find(item => item.id === id&&(!ownerHash||item.ownerHash===ownerHash)) || null; }
  async create(fileId, title, ownerHash) { const now = new Date().toISOString(); const item = { id: crypto.randomUUID(), fileId, ...(ownerHash?{ownerHash}:{}),title: String(title).slice(0,200), createdAt: now, updatedAt: now, messages: [] }; this.items.push(item); this.save(); return item; }
  async append(id, input,ownerHash) { const item = await this.get(id,ownerHash); if (!item) return null; const message = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() }; item.messages.push(message); item.updatedAt = message.createdAt; this.save(); return message; }
  async delete(id,ownerHash) { const count = this.items.length; this.items = this.items.filter(item => item.id !== id||ownerHash&&item.ownerHash!==ownerHash); if (count === this.items.length) return false; this.save(); return true; }
  async deleteForFile(fileId,ownerHash) { this.items = this.items.filter(item => item.fileId !== fileId||ownerHash&&item.ownerHash!==ownerHash); this.save(); }
  async assignOwner(id,ownerHash) { const item=await this.get(id);if(item&&!item.ownerHash){item.ownerHash=ownerHash;this.save();} }
}
