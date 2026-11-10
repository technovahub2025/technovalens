import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
import { answerLocally, buildCompactSheetContext, hashWorkbook, normalizeQuestion } from "./analytics.js";
import { answerPdfLocally, localLimitation } from "./local-document.js";
import { connectDB } from "./config/db.js";
import { JsonConversationStore } from "./storage/json-conversation-store.js";

// Resolve the backend .env from this file, regardless of the directory used to start Node.
const envPath = fileURLToPath(new URL("./.env", import.meta.url));
const envResult = dotenv.config({ path: envPath });
const PRIMARY_GEMINI_MODEL = process.env.PRIMARY_GEMINI_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
const FALLBACK_GEMINI_MODEL = process.env.FALLBACK_GEMINI_MODEL?.trim() || "";
const GEMINI_API_BASE_URL = process.env.GEMINI_API_BASE_URL?.trim();
if (envResult.error && envResult.error.code !== "ENOENT") {
  console.error("Could not load backend/.env:", envResult.error.message);
}
console.info("Gemini configuration:", {
  apiKeyLoaded: Boolean(process.env.GEMINI_API_KEY?.trim()),
  primaryModel: PRIMARY_GEMINI_MODEL,
  fallbackModelConfigured: Boolean(FALLBACK_GEMINI_MODEL),
  envFileLoaded: !envResult.error
});

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://technovalens.vercel.app"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options(/.*/, cors());

app.use(express.json({ limit: "2mb" }));

const MAX_UPLOAD = 20 * 1024 * 1024;
const acceptedMimeTypes = {
  pdf: new Set(["application/pdf"]),
  xlsx: new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]),
  csv: new Set(["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"])
};
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase().split(".").pop();
    const allowed = ["pdf", "xlsx", "csv"].includes(ext);
    if (!allowed) return cb(Object.assign(new Error("Only PDF, XLSX and CSV files are supported."), { code: "UNSUPPORTED_FILE_TYPE" }));
    const mime = (file.mimetype || "").toLowerCase();
    // Browsers and some desktop clients send application/octet-stream; validate
    // the extension and file signature in the parser for those uploads.
    if (mime && mime !== "application/octet-stream" && !acceptedMimeTypes[ext].has(mime)) {
      return cb(Object.assign(new Error("The file type does not match its extension."), { code: "MIME_TYPE_MISMATCH" }));
    }
    cb(null, true);
  }
});
const documents = new Map();
// Keep parsed documents across backend restarts. Every instance on the same
// host reads and writes the same per-file record, while `documents` remains
// the fast in-memory index used by the upload and AI routes.
const documentStorePath = process.env.DOCUMENT_STORE_DIR
  ? path.resolve(process.env.DOCUMENT_STORE_DIR)
  : fileURLToPath(new URL("./.data/uploads/", import.meta.url));
fs.mkdirSync(documentStorePath, { recursive: true });
const DATA_DIR = path.dirname(documentStorePath.replace(/[\\/]$/, ""));
let conversationStore;
const CACHE_PATH = path.join(DATA_DIR, "analysis-cache.json");
const USAGE_PATH = path.join(DATA_DIR, "gemini-usage.json");
const PROMPT_VERSION = "2026-11-05-v2";
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.ANALYSIS_CACHE_TTL_MS) || 24 * 60 * 60 * 1000);
const requestedDailyBudget = Number.parseInt(process.env.GEMINI_DAILY_BUDGET, 10);
const DAILY_GEMINI_BUDGET = Number.isInteger(requestedDailyBudget) ? Math.max(0, requestedDailyBudget) : 15;
const USAGE_TIME_ZONE = process.env.GEMINI_USAGE_TIME_ZONE?.trim() || "UTC";
const requestedMinInterval = Number.parseInt(process.env.GEMINI_MIN_INTERVAL_MS, 10);
const GEMINI_MIN_INTERVAL_MS = Number.isInteger(requestedMinInterval) ? Math.max(0, requestedMinInterval) : 15_000;
const requestedQueueTimeout = Number.parseInt(process.env.GEMINI_QUEUE_TIMEOUT_MS, 10);
const GEMINI_QUEUE_TIMEOUT_MS = Number.isInteger(requestedQueueTimeout) ? Math.max(1000, requestedQueueTimeout) : 180_000;
for (const entry of fs.readdirSync(documentStorePath, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
  try {
    const document = JSON.parse(fs.readFileSync(path.join(documentStorePath, entry.name), "utf8"));
    if (typeof document.fileId === "string") documents.set(document.fileId, document);
  } catch (error) {
    console.warn("Skipping unreadable persisted document:", { file: entry.name, errorName: error?.name || "Error" });
  }
}
const backendInstanceId = crypto.randomUUID();
console.info("Uploaded document store ready:", { backendInstanceId, mapSize: documents.size, store: documentStorePath });

function getDocument(fileId, { reload = false } = {}) {
  let document = reload ? null : documents.get(fileId);
  if ((!document || reload) && typeof fileId === "string") {
    try {
      document = JSON.parse(fs.readFileSync(path.join(documentStorePath, `${fileId}.json`), "utf8"));
      if (document.fileId === fileId) documents.set(fileId, document);
      else document = undefined;
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn("Persisted document lookup failed:", { fileId, errorName: error?.name || "Error" });
    }
  }
  return document;
}

function describeDocument(document) {
  if (!document) return null;
  if (document.kind === "pdf") {
    const preview = document.chunks.join("\n\n").slice(0, 24000);
    return {
      fileId: document.fileId, name: document.name, fileName: document.name,
      type: document.type, size: document.size, uploadedAt: document.uploadedAt,
      kind: document.kind, pageCount: document.pageCount, textLength: document.textLength,
      nonEmptyPages: document.nonEmptyPages, potentiallyScanned: document.potentiallyScanned,
      extractionStatus: document.extractionStatus, extractionWarning: document.extractionWarning,
      preview, previewTruncated: document.textLength > preview.length
    };
  }
  const primarySheet = document.sheets[0];
  const preview = primarySheet?.rows.slice(0, 10) || [];
  return {
    fileId: document.fileId, name: document.name, fileName: document.name,
    type: document.type, size: document.size, uploadedAt: document.uploadedAt,
    kind: document.kind, sheetName: document.sheetName,
    sheetNames: document.sheets.map(sheet => sheet.name),
    rowCount: document.rows.length, columnCount: document.columns.length,
    columns: document.columns, preview
  };
}

function listDocumentMetadata(document) {
  if (document.kind === "pdf") return {
    fileId: document.fileId, fileName: document.name, name: document.name,
    type: document.type, size: document.size, uploadedAt: document.uploadedAt,
    kind: document.kind, pageCount: document.pageCount, textLength: document.textLength,
    nonEmptyPages: document.nonEmptyPages, potentiallyScanned: document.potentiallyScanned,
    extractionStatus: document.extractionStatus
  };
  return {
    fileId: document.fileId, fileName: document.name, name: document.name,
    type: document.type, size: document.size, uploadedAt: document.uploadedAt,
    kind: document.kind, sheetName: document.sheetName,
    sheetNames: document.sheets.map(sheet => sheet.name),
    rowCount: document.rows.length, columnCount: document.columns.length
  };
}
function readJsonFile(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") console.warn("Persistent state could not be read:", { file: path.basename(filePath), errorName: error?.name || "Error" }); return fallback; }
}

function writeJsonFile(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function getUsageDay() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: USAGE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

const storedUsage = readJsonFile(USAGE_PATH, {});
const geminiUsage = {
  day: getUsageDay(), dailyRequests: 0, totalRequests: 0, successfulRequests: 0,
  primaryRequests: 0, fallbackRequests: 0, primarySuccesses: 0, fallbackSuccesses: 0,
  cacheHits: 0, cacheMisses: 0, rateLimitErrors: 0, unavailableErrors: 0,
  reportedInputTokens: 0, reportedOutputTokens: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0,
  ...storedUsage
};
if (geminiUsage.day !== getUsageDay()) geminiUsage.dailyRequests = 0;
const analysisCache = new Map(Object.entries(readJsonFile(CACHE_PATH, {})).filter(([, entry]) => entry.expiresAt > Date.now()));
const analysisInFlight = new Map();
const GEMINI_TIMEOUT_MS = 90000;
const SUMMARY_DIRECT_LIMIT = 18000;
const SUMMARY_CHUNK_SIZE = 6000;
const SUMMARY_CHUNKS_PER_REQUEST = 2;
const MAX_CONTEXT_CHUNKS = 6;
const MAX_GEMINI_RETRIES = 2;
const MAX_GEMINI_CONCURRENCY = 1;
let activeGeminiRequests = 0;
let lastGeminiRequestAt = 0;
const geminiWaiters = [];
app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "TECHNOVALENS API" }));
app.get("/api/usage", (_req, res) => {
  rollUsageDay();
  res.json({
    model: PRIMARY_GEMINI_MODEL,
    fallbackModel: FALLBACK_GEMINI_MODEL || null,
    day: geminiUsage.day,
    timezone: USAGE_TIME_ZONE,
    dailyBudget: DAILY_GEMINI_BUDGET,
    dailyRequests: geminiUsage.dailyRequests,
    remainingToday: Math.max(0, DAILY_GEMINI_BUDGET - geminiUsage.dailyRequests),
    minimumIntervalMs: GEMINI_MIN_INTERVAL_MS,
    maxConcurrentRequests: MAX_GEMINI_CONCURRENCY,
    ...geminiUsage
  });
});

function splitPdfIntoChunks(pages, maxChars = SUMMARY_CHUNK_SIZE) {
  const chunks = [];
  let current = "";
  for (const page of pages) {
    const pageText = `Page ${page.num}\n${page.text || ""}`.trim();
    if (pageText.length > maxChars) {
      if (current) { chunks.push(current); current = ""; }
      const body = page.text || "";
      for (let offset = 0; offset < body.length; offset += maxChars - 32) {
        chunks.push(`Page ${page.num} (continued)\n${body.slice(offset, offset + maxChars - 32)}`);
      }
      continue;
    }
    if (current && current.length + pageText.length + 2 > maxChars) {
      chunks.push(current);
      current = pageText;
    } else current += `${current ? "\n\n" : ""}${pageText}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildSpreadsheetAiContext(sheets, maxChars = 90000, maxRowsPerSheet = 4000) {
  const serializedSheets = [];
  let usedChars = 2;
  let truncated = false;
  for (const sheet of sheets) {
    const prefix = `{"sheet":${JSON.stringify(sheet.name)},"rows":[`;
    const rows = [];
    let rowChars = 0;
    for (const row of sheet.rows.slice(0, maxRowsPerSheet)) {
      const serializedRow = JSON.stringify(row);
      const projectedSize = usedChars + (serializedSheets.length ? 1 : 0) + prefix.length + rowChars + (rows.length ? 1 : 0) + serializedRow.length + 2;
      if (projectedSize > maxChars) { truncated = true; break; }
      rows.push(serializedRow);
      rowChars += serializedRow.length + (rows.length > 1 ? 1 : 0);
    }
    if (rows.length < sheet.rows.length) truncated = true;
    const serialized = `${prefix}${rows.join(",")}]}`;
    if (usedChars + (serializedSheets.length ? 1 : 0) + serialized.length > maxChars) { truncated = true; break; }
    serializedSheets.push(serialized);
    usedChars += (serializedSheets.length > 1 ? 1 : 0) + serialized.length;
  }
  return { text: `[${serializedSheets.join(",")}]`, truncated };
}

function selectRelevantChunks(chunks, question, limit = MAX_CONTEXT_CHUNKS) {
  const terms = question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  if (!terms.length) return chunks.slice(0, limit);
  const ranked = chunks.map((text, index) => {
    const lower = text.toLowerCase();
    const score = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
    return { text, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked[0]?.score === 0) {
    const count = Math.min(limit, chunks.length);
    return Array.from({ length: count }, (_, i) => chunks[Math.floor(i * (chunks.length - 1) / Math.max(1, count - 1))]);
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).sort((a, b) => a.index - b.index).map(x => x.text);
}

function isSummaryQuestion(question) {
  return /\b(summar(y|ize|ise)|overview|main points|key points|important points|executive summary)\b/i.test(question);
}

function sendSse(res, event, data) {
  if (res.destroyed || res.writableEnded || !res.writable) return false;
  try { return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch { return false; }
}

function acquireGeminiSlot(signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Analysis was cancelled."), { name: "AbortError", status: 499 }));
  if (activeGeminiRequests < MAX_GEMINI_CONCURRENCY) {
    activeGeminiRequests++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      timer: null,
      grant() { clearTimeout(this.timer); signal?.removeEventListener("abort", cancel); resolve(); },
      cancel
    };
    function cancel() {
      clearTimeout(waiter.timer);
      const index = geminiWaiters.indexOf(waiter);
      if (index >= 0) geminiWaiters.splice(index, 1);
      reject(Object.assign(new Error("Analysis was cancelled."), { name: "AbortError", status: 499 }));
    }
    geminiWaiters.push(waiter);
    waiter.timer = setTimeout(() => {
      const index = geminiWaiters.indexOf(waiter);
      if (index >= 0) geminiWaiters.splice(index, 1);
      signal?.removeEventListener("abort", cancel);
      reject(Object.assign(new Error("Gemini request queue timed out. Please try again."), { status: 503, geminiQueueTimeout: true }));
    }, GEMINI_QUEUE_TIMEOUT_MS);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function releaseGeminiSlot() {
  const waiter = geminiWaiters.shift();
  if (waiter) waiter.grant();
  else activeGeminiRequests = Math.max(0, activeGeminiRequests - 1);
}

async function withGeminiSlot(operation, signal) {
  await acquireGeminiSlot(signal);
  try {
    const waitMs = Math.max(0, lastGeminiRequestAt + GEMINI_MIN_INTERVAL_MS - Date.now());
    if (waitMs) await waitBeforeRetry(waitMs, signal);
    return await operation();
  }
  finally { releaseGeminiSlot(); }
}

function persistUsage() {
  writeJsonFile(USAGE_PATH, geminiUsage);
}

function rollUsageDay() {
  const currentDay = getUsageDay();
  if (geminiUsage.day !== currentDay) {
    geminiUsage.day = currentDay;
    geminiUsage.dailyRequests = 0;
    persistUsage();
  }
}

function reserveGeminiRequest(prompt, model) {
  rollUsageDay();
  if (geminiUsage.dailyRequests >= DAILY_GEMINI_BUDGET) {
    throw Object.assign(new Error("The application's daily Gemini request budget is exhausted."), { status: 429, appBudgetExceeded: true });
  }
  geminiUsage.dailyRequests++;
  geminiUsage.totalRequests++;
  if (model === FALLBACK_GEMINI_MODEL) geminiUsage.fallbackRequests++;
  else geminiUsage.primaryRequests++;
  geminiUsage.estimatedInputTokens += Math.ceil(prompt.length / 4);
  lastGeminiRequestAt = Date.now();
  persistUsage();
}

function recordGeminiSuccess(response, model) {
  geminiUsage.successfulRequests++;
  if (model === FALLBACK_GEMINI_MODEL) geminiUsage.fallbackSuccesses++;
  else geminiUsage.primarySuccesses++;
  const metadata = response?.usageMetadata || {};
  geminiUsage.reportedInputTokens += Number(metadata.promptTokenCount || 0);
  geminiUsage.reportedOutputTokens += Number(metadata.candidatesTokenCount || 0);
  if (!metadata.candidatesTokenCount && response?.text) geminiUsage.estimatedOutputTokens += Math.ceil(response.text.length / 4);
  persistUsage();
}

function waitBeforeRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Analysis was cancelled."), { name: "AbortError", status: 499 }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
    function abort() {
      clearTimeout(timer);
      reject(Object.assign(new Error("Analysis was cancelled."), { name: "AbortError", status: 499 }));
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function receiveFile(req, res) {
  if (!req.file) return res.status(400).json({ error: "Please choose a PDF, XLSX or CSV file." });
  const ext = req.file.originalname.toLowerCase().split(".").pop();
  let processingStage = ext === "pdf" ? "pdf-extraction" : "spreadsheet-parsing";
  try {
    if (ext === "pdf" && req.file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return res.status(400).json({ error: "This file is not a valid PDF. Check the file and try again." });
    }
    if (ext === "xlsx" && !(req.file.buffer[0] === 0x50 && req.file.buffer[1] === 0x4b)) {
      return res.status(400).json({ error: "This file is not a valid XLSX workbook. Check the file and try again." });
    }
    const fileId = crypto.randomUUID();
    const common = { fileId, name: req.file.originalname, type: ext.toUpperCase(), size: req.file.size, uploadedAt: new Date().toISOString() };
    let record, response;
    if (ext === "pdf") {
      let PDFParse;
      try { ({ PDFParse } = await import("pdf-parse")); }
      catch { return res.status(503).json({ error: "PDF extraction is unavailable because the pdf-parse dependency is not installed. Install backend dependencies and restart the server." }); }
      let parser;
      try {
        parser = new PDFParse({ data: req.file.buffer });
        const result = await parser.getText();
        const pages = result.pages || [];
        const text = pages.map((page, index) => `Page ${page.num || index + 1}\n${page.text || ""}`.trim()).join("\n\n");
        const pageCount = result.total || pages.length;
        if (!pageCount) return res.status(400).json({ error: "This PDF has no readable pages." });
        const chunks = splitPdfIntoChunks(pages);
      const extractedCharacters = pages.reduce((count, page) => count + String(page.text || "").trim().length, 0);
      const nonEmptyPages = pages.filter(page => String(page.text || "").trim()).length;
      const potentiallyScanned = extractedCharacters < Math.max(30, pageCount * 20);
      const extractionStatus = potentiallyScanned ? "ocr-required" : "text-extracted";
      const extractionWarning = potentiallyScanned
        ? "This PDF appears to be scanned or has too little selectable text. OCR may be required for document analysis."
        : null;
      record = { ...common, kind: "pdf", chunks, textLength: extractedCharacters, pageCount, nonEmptyPages, potentiallyScanned, extractionStatus, extractionWarning };
      response = { ...common, kind: "pdf", pageCount, preview: text.slice(0, 24000), previewTruncated: text.length > 24000, textLength: extractedCharacters, nonEmptyPages, potentiallyScanned, extractionStatus, extractionWarning };
      console.info("PDF extraction completed:", { documentId: fileId, pageCount, extractedCharacters, nonEmptyPages, extractionStatus });
      } catch (error) {
        const message = String(error?.message || "");
        const password = /password|encrypt/i.test(message);
        console.error("Document processing failed:", {
          stage: "pdf-extraction",
          errorName: error?.name || "Error",
          errorCode: error?.code || null
        });
        return res.status(400).json({ error: password ? "This PDF is password-protected. Unlock it and upload it again." : "This PDF is unreadable or damaged. Please upload a valid PDF." });
      } finally { await parser?.destroy?.().catch?.(() => {}); }
    } else {
      let sheets;
      if (ext === "csv") {
        processingStage = "csv-parsing";
        const rows = parse(req.file.buffer.toString("utf8"), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
        sheets = [{ name: "CSV data", rows }];
      } else {
        processingStage = "xlsx-parsing";
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        sheets = workbook.worksheets.map(ws => {
          const headers = ws.getRow(1).values.slice(1).map((v, i) => String(v ?? `Column ${i + 1}`));
          const rows = [];
          ws.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            const values = row.values.slice(1);
            if (!values.some(v => v !== null && v !== undefined && v !== "")) return;
            rows.push(Object.fromEntries(headers.map((header, i) => [header, values[i] ?? null])));
          });
          return { name: ws.name, rows };
        });
      }
      const first = sheets[0];
      if (!first) return res.status(400).json({ error: "No worksheets found in this file." });
      const columns = first.rows.length ? Object.keys(first.rows[0]) : [];
      const { text: aiContext, truncated: aiContextTruncated } = buildSpreadsheetAiContext(sheets);
      record = { ...common, kind: "spreadsheet", sheets, sheetName: first.name, rows: first.rows, columns, aiContext, aiContextTruncated };
      response = { ...common, kind: "spreadsheet", sheetName: first.name, sheetNames: sheets.map(s => s.name), rowCount: first.rows.length, columnCount: columns.length, columns, preview: first.rows.slice(0, 10) };
    }
    record.contentHash = record.kind === "spreadsheet"
      ? hashWorkbook(record.sheets)
      : crypto.createHash("sha256").update(JSON.stringify(record.chunks)).digest("hex");
    const persistedPath = path.join(documentStorePath, `${fileId}.json`);
    const temporaryPath = `${persistedPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, persistedPath);
    documents.set(fileId, record);
    const conversation = await conversationStore.create(
  fileId,
  req.file.originalname
);
    response.conversationId = conversation.id;
    console.info("Uploaded document stored:", { backendInstanceId, fileId, mapSize: documents.size, kind: record.kind });
    res.json(response);
  } catch (error) {
    const invalidDocument = ["pdf-extraction", "csv-parsing", "xlsx-parsing"].includes(processingStage);
    console.error("Upload processing failed:", {
      stage: processingStage,
      fileType: ext,
      fileSize: req.file.size,
      errorName: error?.name || "Error",
      errorCode: error?.code || null
    });
    res.status(invalidDocument ? 400 : 500).json({
      error: invalidDocument
        ? (ext === "pdf" ? "Could not extract text from this PDF. Check that it is readable and try again." : "Could not read this spreadsheet. Check that it is a valid XLSX or CSV file.")
        : "The server could not process this upload. Check the backend logs and try again."
    });
  }
}
app.post("/api/files/upload", upload.single("file"), receiveFile);
// Keep the original Excel upload URL working for existing clients; it now accepts CSV too.
app.post("/api/excel/upload", upload.single("file"), receiveFile);
app.get("/api/files", (_req, res) => {
  const list = [...documents.values()].map(listDocumentMetadata).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  res.json(list);
});
app.get("/api/files/:id", (req, res) => {
  const document = getDocument(req.params.id);
  if (!document) return res.status(404).json({ error: "Uploaded file not found." });
  res.json(describeDocument(document));
});

app.get("/api/conversations", async (_req, res) => {
  try {
    const conversations = await conversationStore.list();
    res.json(conversations.filter(item => documents.has(item.fileId)));
  } catch (error) {
    console.error("Conversation list error:", error);
    res.status(500).json({ error: "Could not load conversations." });
  }
});

app.post("/api/conversations", async (req, res) => {
  try {
    const fileId = req.body?.fileId;
    const document = getDocument(fileId);

    if (!document) {
      return res.status(404).json({ error: "Uploaded file not found." });
    }

    const conversation = await conversationStore.create(
      fileId,
      req.body?.title || document.name
    );

    res.status(201).json(conversation);
  } catch (error) {
    console.error("Conversation creation error:", error);
    res.status(500).json({ error: "Could not create conversation." });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const conversation = await conversationStore.get(req.params.id);

    if (!conversation || !getDocument(conversation.fileId)) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    res.json(conversation);
  } catch (error) {
    console.error("Conversation retrieval error:", error);
    res.status(500).json({ error: "Could not load conversation." });
  }
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  try {
    const conversation = await conversationStore.get(req.params.id);

    if (!conversation || !getDocument(conversation.fileId)) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    const { role, text } = req.body || {};

    if (
      !["user", "assistant"].includes(role) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 30000
    ) {
      return res.status(400).json({
        error: "A valid user or assistant message is required (up to 30,000 characters)."
      });
    }

    const message = await conversationStore.append(
      req.params.id,
      { ...req.body, role, text: text.trim() }
    );

    if (!message) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    res.status(201).json(message);
  } catch (error) {
    console.error("Conversation message error:", error);
    res.status(500).json({ error: "Could not save conversation message." });
  }
});

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    const deleted = await conversationStore.delete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    res.json({ status: "removed" });
  } catch (error) {
    console.error("Conversation deletion error:", error);
    res.status(500).json({ error: "Could not delete conversation." });
  }
});

app.get("/api/conversations/:id", (req, res) => {
  const conversation = conversationStore.get(req.params.id);
  if (!conversation || !getDocument(conversation.fileId)) return res.status(404).json({ error: "Conversation not found." });
  res.json(conversation);
});
app.post("/api/conversations/:id/messages", (req, res) => {
  const conversation = conversationStore.get(req.params.id);
  if (!conversation || !getDocument(conversation.fileId)) return res.status(404).json({ error: "Conversation not found." });
  const { role, text } = req.body || {};
  if (!["user", "assistant"].includes(role) || typeof text !== "string" || !text.trim() || text.length > 30000) {
    return res.status(400).json({ error: "A valid user or assistant message is required (up to 30,000 characters)." });
  }
  res.status(201).json(conversationStore.append(req.params.id, { ...req.body, role, text: text.trim() }));
});
app.delete("/api/conversations/:id", (req, res) => {
  if (!conversationStore.delete(req.params.id)) return res.status(404).json({ error: "Conversation not found." });
  res.json({ status: "removed" });
});
app.get("/api/excel/files", (_req, res) => res.json([...documents.values()].filter(d => d.kind === "spreadsheet").map(d => ({ fileId: d.fileId, fileName: d.name, sheetName: d.sheetName, rowCount: d.rows.length, columnCount: d.columns.length }))));
app.get("/api/excel/:id/preview", (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc || doc.kind !== "spreadsheet") return res.status(404).json({ error: "Workbook not found. Please upload it again." });
  res.json({ columns: doc.columns, preview: doc.rows.slice(0, 100), rowCount: doc.rows.length, sheetNames: doc.sheets.map(s => s.name) });
});
app.delete("/api/files/:id", async (req, res) => {
  const document = getDocument(req.params.id);
  if (!document) return res.status(404).json({ error: "Uploaded file not found." });
  try { fs.unlinkSync(path.join(documentStorePath, `${req.params.id}.json`)); }
  catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("Could not remove persisted document:", { fileId: req.params.id, errorCode: error?.code || null });
      return res.status(500).json({ error: "The uploaded file could not be safely removed. Please try again." });
    }
  }
  documents.delete(req.params.id);
  await conversationStore.deleteForFile(req.params.id);
  res.json({ status: "removed" });
});
const gemini = process.env.GEMINI_API_KEY?.trim()
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        timeout: GEMINI_TIMEOUT_MS,
        retryOptions: { attempts: 1 },
        ...(GEMINI_API_BASE_URL ? { baseUrl: GEMINI_API_BASE_URL } : {})
      }
    })
  : null;

function getHttpStatus(error) {
  const providerError = getProviderErrorDetails(error).body;
  const directStatus = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? providerError?.code);
  if (directStatus >= 400 && directStatus <= 599) return directStatus;
  const errorText = `${providerError?.status || ""} ${error?.message || ""} ${error?.code || ""}`;
  const match = errorText.match(/(?:HTTP\s*|status[:= ]+)?(400|401|403|404|408|409|413|422|429|500|501|502|503|504)\b/i);
  if (match) return Number(match[1]);
  if (error?.name === "RequestTimeoutError" || /deadline[_ ]exceeded|deadline expired|request timed? ?out|timeout/i.test(errorText)) return 504;
  return null;
}

function getProviderErrorDetails(error) {
  let body;
  try { body = JSON.parse(error?.message || ""); } catch { /* SDK/network errors may not contain a JSON body. */ }
  const providerError = body?.error && typeof body.error === "object" ? body.error : null;
  const code = Number(providerError?.code ?? error?.status ?? error?.statusCode);
  return {
    body: providerError,
    code: Number.isInteger(code) && code >= 400 && code <= 599 ? code : null,
    status: typeof providerError?.status === "string" ? providerError.status : null,
    message: typeof providerError?.message === "string" ? providerError.message : null,
    retryDelay: providerError?.details?.find?.(detail => /RetryInfo/.test(detail?.["@type"] || ""))?.retryDelay || null
  };
}

function safeProviderMessage(message, prompt) {
  if (!message) return null;
  let safe = message;
  // Provider diagnostics must not accidentally echo submitted document/question text.
  const safeTerms = new Set(prompt.match(/[\p{L}\p{N}]{3,}/gu) || []);
  const genericTerms = new Set(["the", "and", "for", "you", "are", "this", "that", "with", "from", "only", "use", "not", "add", "facts", "source", "question", "answer", "please", "try", "again"]);
  for (const term of safeTerms) {
    if (genericTerms.has(term.toLocaleLowerCase())) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    safe = safe.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), "[request content redacted]");
  }
  const promptFragments = new Set();
  for (let i = 0; i <= prompt.length - 48; i += 16) promptFragments.add(prompt.slice(i, i + 48));
  for (const fragment of promptFragments) safe = safe.replaceAll(fragment, "[request text redacted]");
  return safe.replace(/(?:AIza[\w-]{30,}|Bearer\s+\S+)/gi, "[credential redacted]").slice(0, 500);
}

function shouldRetryGeminiError(status, providerError, error) {
  if (error?.geminiQueueTimeout || error?.appBudgetExceeded) return false;
  if ([500, 503, 504].includes(status)) return true;
  if (status !== 429) return false;
  const message = providerError.message || "";
  const details = JSON.stringify(providerError.body?.details || []);
  if (/daily|per day|billing|quota exceeded/i.test(message)) return false;
  return /retryDelay|rate.?limit|requests per|tokens per|too many requests/i.test(`${message} ${details}`);
}

function classifyGeminiQuota(providerError) {
  if (providerError?.code !== 429) return null;
  const message = providerError.message || "";
  const details = providerError.body?.details || [];
  const info = details.find(detail => /ErrorInfo/.test(detail?.["@type"] || "")) || {};
  const metadata = info.metadata || {};
  const quotaId = String(metadata.quotaId || metadata.quota_id || "");
  const quotaMetric = String(metadata.quotaMetric || metadata.quota_metric || "");
  const resourceNames = [metadata.model, metadata.modelId, metadata.model_id, metadata.consumer].filter(Boolean).join(" ");
  const text = `${message} ${quotaId} ${quotaMetric} ${resourceNames}`;
  if (!/daily|per.?day|requestsperday|quota.*exhaust|exhaust.*quota/i.test(text)) return null;
  // Google quota errors commonly include a quota ID / metric scoped per model.
  // If the provider gives no scope, fail closed as project-wide.
  if (/per.?model|model.*(request|quota|limit)|(?:^|\s)model(?:\s|$)/i.test(`${quotaId} ${quotaMetric} ${resourceNames}`)) return "model-daily";
  if (/project.?wide|per.?project(?!.*model)|project.*(request|quota|limit)/i.test(`${quotaId} ${quotaMetric} ${resourceNames} ${message}`)) return "project-wide";
  return "project-wide";
}

async function askGemini(prompt, doc, options = {}) {
  try {
    return await askGeminiWithModel(prompt, doc, options, PRIMARY_GEMINI_MODEL);
  } catch (primaryError) {
    const providerError = getProviderErrorDetails(primaryError);
    const quotaKind = classifyGeminiQuota(providerError);
    const fallbackReason = getHttpStatus(primaryError) === 503
      ? "primary model returned 503 UNAVAILABLE after bounded retries"
      : quotaKind === "model-daily" ? "primary model-specific daily quota exhausted (429 RESOURCE_EXHAUSTED)" : null;
    const canFallback = Boolean(fallbackReason)
      && FALLBACK_GEMINI_MODEL
      && FALLBACK_GEMINI_MODEL !== PRIMARY_GEMINI_MODEL
      && !primaryError.appBudgetExceeded
      && !primaryError.geminiQueueTimeout;
    if (!canFallback) throw primaryError;
    options.onProgress?.("Primary Gemini model unavailable; trying fallback", {
      primaryModel: PRIMARY_GEMINI_MODEL,
      fallbackModel: FALLBACK_GEMINI_MODEL,
      reason: fallbackReason,
      operationStage: options.stage
    });
    console.warn("Switching Gemini models:", {
      primaryModel: PRIMARY_GEMINI_MODEL,
      fallbackModel: FALLBACK_GEMINI_MODEL,
      reason: fallbackReason,
      operation: options.stage
    });
    try {
      return await askGeminiWithModel(prompt, doc, options, FALLBACK_GEMINI_MODEL);
    } catch (fallbackError) {
      const fallbackQuota = classifyGeminiQuota(getProviderErrorDetails(fallbackError));
      if (quotaKind === "model-daily" && fallbackQuota === "model-daily") {
        fallbackError.geminiBothModelQuotasExhausted = true;
        fallbackError.geminiFallbackReason = "both configured models have exhausted model-specific daily quotas";
      }
      throw fallbackError;
    }
  }
}

async function askGeminiWithModel(prompt, doc, { abortSignal, onProgress = () => {}, stage, chunkNumber, totalChunks, maxOutputTokens = 1024, responseMimeType, modelTracker } = {}, model) {
  if (!gemini) throw Object.assign(new Error("AI is not configured. Add GEMINI_API_KEY to backend/.env and restart the server."), { status: 503, geminiNotConfigured: true });
  if (abortSignal?.aborted) throw Object.assign(new Error("Progress client disconnected."), { name: "AbortError", status: 499 });
  for (let attempt = 0; attempt <= MAX_GEMINI_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await withGeminiSlot(() => {
        reserveGeminiRequest(prompt, model);
        return gemini.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            httpOptions: { timeout: GEMINI_TIMEOUT_MS, retryOptions: { attempts: 1 } },
            maxOutputTokens,
            ...(responseMimeType ? { responseMimeType } : {}),
            ...(abortSignal ? { abortSignal } : {})
          }
        });
      }, abortSignal);
      recordGeminiSuccess(response, model);
      if (modelTracker) modelTracker.model = model;
      console.info("Gemini request completed:", {
        model: response.modelVersion || model,
        requestedModel: model,
        stage, chunkNumber, totalChunks, attempt: attempt + 1,
        requestDurationMs: Date.now() - startedAt,
        responseStatus: response.sdkHttpResponse?.responseInternal?.status ?? 200,
        finishReason: response.candidates?.[0]?.finishReason ?? null,
        promptCharacters: prompt.length
      });
      return response.text || "I could not find a supported answer in this file.";
    } catch (error) {
      const status = getHttpStatus(error);
      const providerError = getProviderErrorDetails(error);
      const retryable = shouldRetryGeminiError(status, providerError, error);
      if (!error?.appBudgetExceeded && !error?.geminiQueueTimeout) {
        if (status === 429) geminiUsage.rateLimitErrors++;
        if (status === 503) geminiUsage.unavailableErrors++;
        persistUsage();
      }
      console.warn("Gemini request failed:", {
        model, operation: stage, chunkNumber, totalChunks, attempt: attempt + 1,
        requestDurationMs: Date.now() - startedAt,
        responseStatus: status,
        providerCode: providerError.body?.code ?? null,
        providerStatus: providerError.status,
        providerMessage: safeProviderMessage(providerError.message, prompt),
        errorName: error?.name || "Error",
        errorCode: error?.code || error?.cause?.code || null,
        activeRequests: activeGeminiRequests,
        queuedRequests: geminiWaiters.length
      });
      error.geminiProviderMessage = safeProviderMessage(providerError.message, prompt);
      if (!retryable || attempt >= MAX_GEMINI_RETRIES || abortSignal?.aborted) {
        error.status = status || error.status;
        error.geminiStage = stage;
        error.geminiChunkNumber = chunkNumber;
        error.geminiModel = model;
        throw error;
      }
      const retryAfterMs = Number.parseFloat(providerError.retryDelay) * 1000 || 0;
      const retryHeader = Number.parseFloat(error?.response?.headers?.get?.("retry-after") || error?.headers?.["retry-after"]) * 1000 || 0;
      const delayMs = Math.max(retryAfterMs, retryHeader, 1000 * (2 ** attempt)) + Math.floor(Math.random() * 500);
      onProgress("Retrying analysis", { operationStage: stage, chunkNumber, totalChunks, retry: attempt + 1, maxRetries: MAX_GEMINI_RETRIES, delayMs });
      await waitBeforeRetry(delayMs, abortSignal);
    }
  }
}

async function summarizePdfParts(parts, doc, { abortSignal, onProgress, chunkNumber, totalChunks, depth = 0, modelTracker }) {
  const prompt = `Summarize each page-numbered excerpt below in at most 70 words. Preserve key claims, names, dates, figures, caveats, and page references. Label each excerpt in the summary. Do not add information.\n\n${parts.map(part => `EXCERPT ${part.number}\n${part.text}`).join("\n\n")}`;
  try {
    return await askGemini(prompt, doc, {
      abortSignal, onProgress, stage: "chunk-summarization", chunkNumber, totalChunks, maxOutputTokens: 512, modelTracker
    });
  } catch (error) {
    const sourceLength = parts.reduce((size, part) => size + part.text.length, 0);
    if (getHttpStatus(error) !== 504 || depth >= 2 || sourceLength < 2400 || abortSignal?.aborted) throw error;

    onProgress("Splitting timed-out PDF chunk", { chunkNumber, totalChunks, retryDepth: depth + 1 });
    console.warn("Splitting timed-out Gemini PDF request:", { stage: "chunk-summarization", chunkNumber, retryDepth: depth + 1, sourceCharacters: sourceLength });
    let smallerParts;
    if (parts.length > 1) {
      const midpoint = Math.ceil(parts.length / 2);
      smallerParts = [parts.slice(0, midpoint), parts.slice(midpoint)];
    } else {
      const source = parts[0].text;
      const splitAt = source.lastIndexOf(" ", Math.floor(source.length / 2));
      const boundary = splitAt > source.length * 0.35 ? splitAt : Math.floor(source.length / 2);
      const pageHeader = source.match(/^Page \d+[^\n]*/)?.[0] || `Excerpt ${parts[0].number}`;
      smallerParts = [
        [{ ...parts[0], text: `${pageHeader}\n${source.slice(0, boundary).trim()}` }],
        [{ ...parts[0], text: `${pageHeader} (continued)\n${source.slice(boundary).trim()}` }]
      ];
    }
    const childSummaries = [];
    for (let index = 0; index < smallerParts.length; index++) {
      childSummaries.push(await summarizePdfParts(smallerParts[index], doc, {
        abortSignal, onProgress, chunkNumber: `${chunkNumber}.${index + 1}`, totalChunks, depth: depth + 1, modelTracker
      }));
    }
    return childSummaries.join("\n");
  }
}

function buildAnswerPrompt(doc, question, context) {
  return `Answer using only the source content below. Do not invent facts, values, or calculations. For spreadsheet calculations, state when the supplied context may be incomplete. Cite PDF page numbers when available. If the answer is absent from the supplied content, say so.\n\nSOURCE:\n${context}\n\nQUESTION: ${question}`;
}

function buildStructuredSpreadsheetPrompt(doc, question, context) {
  return `You are analyzing spreadsheet ${doc.name}. Use only the compact statistics and relevant rows in SOURCE. Return valid JSON only with exactly these keys: summary (string), keyInsights (array of strings), trends (array of strings), anomalies (array of strings), recommendations (array of strings). Use exact supplied statistics for calculations, distinguish observations from suggestions, and use empty arrays where unsupported. Do not infer values omitted from the context.\n\nSOURCE:\n${context}\n\nUSER REQUEST: ${question}`;
}

function formatStructuredSpreadsheetAnswer(text) {
  try {
    const data = JSON.parse(text);
    const list = values => Array.isArray(values) && values.length ? values.map(value => `• ${value}`).join("\n") : "• None identified from the available data.";
    return `Summary\n${data.summary || "No summary available."}\n\nKey insights\n${list(data.keyInsights)}\n\nTrends\n${list(data.trends)}\n\nAnomalies\n${list(data.anomalies)}\n\nRecommendations\n${list(data.recommendations)}`;
  } catch { return text; }
}

async function analyzeDocument(doc, question, onProgress = () => {}, abortSignal) {
  const normalizedQuestion = question.trim().replace(/\s+/g, " ");
  let localFailureReason = null;
  const localAnswer = doc.kind === "pdf"
    ? answerPdfLocally(doc, normalizedQuestion, { onDiagnostic: info => { localFailureReason = info.failureReason; } })
    : answerLocally(doc.sheets, normalizedQuestion);
  if (localAnswer) {
    const source = doc.kind === "pdf" ? "local-pdf" : "local-spreadsheet";
    onProgress("Completed", { source });
    return { answer: localAnswer, source, cached: false };
  }
  if (doc.kind === "pdf" && (doc.extractionStatus === "ocr-required" || localFailureReason === "insufficient-extracted-text-ocr-required")) {
    const answer = localLimitation(doc, localFailureReason);
    onProgress("Completed", { source: "local-pdf", reason: localFailureReason });
    return { answer, source: "local-pdf", cached: false, retryable: false };
  }
  const sheetKey = doc.kind === "spreadsheet" ? buildCompactSheetContext(doc.sheets, normalizedQuestion).sheetKey : "document";
  const cacheKey = crypto.createHash("sha256").update(JSON.stringify({
    contentHash: doc.contentHash || doc.fileId,
    sheetKey,
    question: normalizeQuestion(normalizedQuestion),
    models: [PRIMARY_GEMINI_MODEL, FALLBACK_GEMINI_MODEL || null],
    promptVersion: PROMPT_VERSION
  })).digest("hex");
  const cached = analysisCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    geminiUsage.cacheHits++;
    persistUsage();
    onProgress("Completed", { cached: true });
    return { answer: cached.answer, source: cached.source || "gemini", cached: true };
  }
  if (cached) analysisCache.delete(cacheKey);
  geminiUsage.cacheMisses++;
  persistUsage();
  const existingAnalysis = analysisInFlight.get(cacheKey);
  if (existingAnalysis) {
    console.info("Joining in-flight analysis:", { fileId: doc.fileId, questionCharacters: normalizedQuestion.length });
    onProgress("Waiting for matching analysis");
    const result = await existingAnalysis;
    return { ...result, cached: true };
  }
  const analysisPromise = performDocumentAnalysis(doc, normalizedQuestion, cacheKey, onProgress, abortSignal);
  analysisInFlight.set(cacheKey, analysisPromise);
  try { return await analysisPromise; }
  finally { if (analysisInFlight.get(cacheKey) === analysisPromise) analysisInFlight.delete(cacheKey); }
}

async function performDocumentAnalysis(doc, normalizedQuestion, cacheKey, onProgress, abortSignal) {
  try {
    return await performGeminiDocumentAnalysis(doc, normalizedQuestion, cacheKey, onProgress, abortSignal);
  } catch (error) {
    if (!isDailyGeminiQuotaError(error)) throw error;
    let localFailureReason = null;
    const answer = doc.kind === "pdf"
      ? answerPdfLocally(doc, normalizedQuestion, { forceSummary: true, onDiagnostic: info => { localFailureReason = info.failureReason; } })
      : answerLocally(doc.sheets, normalizedQuestion);
    const source = doc.kind === "pdf" ? "local-pdf" : "local-spreadsheet";
    const message = answer
      ? `${answer}\n\nGemini daily limit reached; answered using local ${doc.kind === "pdf" ? "document analysis" : "spreadsheet calculations"}.`
      : localLimitation(doc, localFailureReason);
    onProgress("Completed", { source, reason: "gemini-daily-limit" });
    const deterministicFailure = doc.kind === "pdf" && (doc.extractionStatus === "ocr-required" || /insufficient-extracted-text|requested-page-has-no-extracted-text/.test(localFailureReason || ""));
    return { answer: message, source, cached: false, retryable: !answer && !deterministicFailure };
  }
}

function isDailyGeminiQuotaError(error) {
  if (error?.appBudgetExceeded) return true;
  if (getHttpStatus(error) !== 429) return false;
  const details = getProviderErrorDetails(error);
  const metadata = details.body?.details?.map(item => item?.metadata || {}).flat() || [];
  const diagnostic = `${details.message || ""} ${JSON.stringify(metadata)}`;
  return /daily|per.?day|requestsperday|quota exceeded/i.test(diagnostic);
}

async function performGeminiDocumentAnalysis(doc, normalizedQuestion, cacheKey, onProgress, abortSignal) {
  const modelTracker = { model: null };
  onProgress("Analysing document");
  let answer;
  if (doc.kind === "pdf" && isSummaryQuestion(normalizedQuestion) && doc.textLength > SUMMARY_DIRECT_LIMIT) {
    const chunks = doc.chunks;
    const batchCount = Math.ceil(chunks.length / SUMMARY_CHUNKS_PER_REQUEST);
    const summaries = new Array(batchCount);
    let nextIndex = 0;
    let stopped = false;
    const worker = async () => {
      while (!stopped && nextIndex < batchCount) {
        const index = nextIndex++;
        const batch = chunks.slice(index * SUMMARY_CHUNKS_PER_REQUEST, (index + 1) * SUMMARY_CHUNKS_PER_REQUEST);
        onProgress("Generating summary", { completedChunks: index, totalChunks: batchCount });
        const parts = batch.map((text, offset) => ({ number: index * SUMMARY_CHUNKS_PER_REQUEST + offset + 1, text }));
        try {
          summaries[index] = await summarizePdfParts(parts, doc, {
            abortSignal, onProgress, chunkNumber: index + 1, totalChunks: batchCount, modelTracker
          });
        }
        catch (error) { stopped = true; throw error; }
        onProgress("Generating summary", { completedChunks: index + 1, totalChunks: batchCount });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_GEMINI_CONCURRENCY, batchCount) }, worker));
    let summaryParts = summaries.map((summary, index) => `Summary group ${index + 1}: ${summary}`);
    while (summaryParts.join("\n\n").length > 16000) {
      const compacted = new Array(Math.ceil(summaryParts.length / 8));
      let compactIndex = 0;
      const compactWorker = async () => {
        while (compactIndex < compacted.length) {
          const index = compactIndex++;
          const group = summaryParts.slice(index * 8, (index + 1) * 8);
          compacted[index] = await askGemini(
            `Condense these excerpt summaries into a concise factual summary. Keep important names, figures, dates, page references and caveats. Do not add facts.\n\n${group.join("\n\n")}`,
            doc,
            { abortSignal, onProgress, stage: "summary-compaction", chunkNumber: index + 1, totalChunks: compacted.length, maxOutputTokens: 512, modelTracker }
          );
        }
      };
      onProgress("Combining section summaries", { totalGroups: compacted.length });
      await Promise.all(Array.from({ length: Math.min(MAX_GEMINI_CONCURRENCY, compacted.length) }, compactWorker));
      summaryParts = compacted;
    }
    const combined = summaryParts.join("\n\n");
    onProgress("Generating summary", { final: true });
    answer = await askGemini(
      `Create a clear, concise overall summary of this document from the excerpt summaries below. Combine repeated points, retain important names, dates, figures and caveats, and do not introduce facts that are not stated.\n\n${combined}`,
      doc,
      { abortSignal, onProgress, stage: "final-synthesis", chunkNumber: 1, totalChunks: 1, maxOutputTokens: 1024, modelTracker }
    );
  } else if (doc.kind === "pdf") {
    const chunks = doc.chunks;
    if (isSummaryQuestion(normalizedQuestion)) onProgress("Generating summary");
    let selected;
    if (doc.textLength <= SUMMARY_DIRECT_LIMIT) selected = [doc.chunks.join("\n\n").slice(0, SUMMARY_DIRECT_LIMIT)];
    else selected = selectRelevantChunks(chunks, normalizedQuestion);
    const context = `PDF ${doc.name}, ${doc.pageCount} pages. ${doc.textLength > SUMMARY_DIRECT_LIMIT ? "Relevant page excerpts are selected from the full extracted document." : ""}\n${selected.join("\n\n[... omitted pages ...]\n\n")}`;
    answer = await askGemini(buildAnswerPrompt(doc, normalizedQuestion, context), doc, {
      abortSignal, onProgress, stage: isSummaryQuestion(normalizedQuestion) ? "direct-pdf-summary" : "pdf-question", chunkNumber: 1, totalChunks: 1, modelTracker
    });
  } else {
    const { context: compactContext } = buildCompactSheetContext(doc.sheets, normalizedQuestion);
    const sheets = doc.sheets.map(sheet => `${sheet.name}: ${sheet.rows.length} rows`).join(", ");
    const context = `Spreadsheet ${doc.name}; ${sheets}. The complete sheets were summarized locally; compact column statistics and up to 30 relevant rows follow.\n${compactContext}`;
    const structured = /\b(comprehensive analysis|recommendations?|key insights|trends and anomalies|full analysis)\b/i.test(normalizedQuestion);
    answer = await askGemini(
      structured ? buildStructuredSpreadsheetPrompt(doc, normalizedQuestion, context) : buildAnswerPrompt(doc, normalizedQuestion, context),
      doc,
      { abortSignal, onProgress, stage: "spreadsheet-question", chunkNumber: 1, totalChunks: 1, maxOutputTokens: structured ? 900 : 600, modelTracker, ...(structured ? { responseMimeType: "application/json" } : {}) }
    );
    if (structured) answer = formatStructuredSpreadsheetAnswer(answer);
  }
  const source = modelTracker.model === FALLBACK_GEMINI_MODEL && FALLBACK_GEMINI_MODEL
    ? "gemini-fallback" : "gemini-primary";
  analysisCache.set(cacheKey, { answer, source, expiresAt: Date.now() + CACHE_TTL_MS });
  if (analysisCache.size > 250) {
    for (const [key, value] of analysisCache) if (value.expiresAt <= Date.now()) analysisCache.delete(key);
    while (analysisCache.size > 250) analysisCache.delete(analysisCache.keys().next().value);
  }
  writeJsonFile(CACHE_PATH, Object.fromEntries(analysisCache));
  onProgress("Completed");
  return { answer, source, cached: false };
}

function logGeminiError(error) {
  const status = getHttpStatus(error);
  const providerError = getProviderErrorDetails(error);
  console.error("Gemini API Error:", {
    model: error?.geminiModel || PRIMARY_GEMINI_MODEL,
    operation: error?.geminiStage || null,
    httpStatus: status,
    providerCode: providerError.body?.code ?? null,
    providerStatus: providerError.status,
    providerMessage: error?.geminiProviderMessage || safeProviderMessage(providerError.message, ""),
    chunkNumber: error?.geminiChunkNumber || null,
    errorName: error?.name || "GeminiError"
  });
}

function userFacingGeminiError(error) {
  const status = getHttpStatus(error);
  if (error?.geminiNotConfigured) return error.message;
  if (error?.appBudgetExceeded) return "TECHNOVALENS has reached its daily Gemini safety budget. Try a locally calculated question or continue tomorrow.";
  if (error?.geminiQueueTimeout) return "The AI request waited too long in the Gemini queue. Please try again shortly.";
  if (status === 504) return "Gemini timed out. Try a shorter PDF or ask for a more focused question.";
  if (status === 503) return "Gemini is temporarily unavailable. Google reports high demand or service capacity issues; please try again shortly.";
  if (status === 429) {
    if (error?.geminiBothModelQuotasExhausted) return "The daily Gemini request quotas for both configured models are exhausted. Try again after the quota resets or use a project with available model quota.";
    const providerMessage = getProviderErrorDetails(error).message || "";
    return /daily|per day|billing|quota exceeded/i.test(providerMessage)
      ? "The Gemini project quota is exhausted. Check the project's quota or billing settings before trying again."
      : "Gemini is rate-limited. Please wait a moment and try again.";
  }
  if (status === 500) return "Gemini encountered an internal error. Please try again shortly.";
  if (status === 401) return "Gemini authentication failed. Check the backend API key configuration.";
  if (status === 403) return "Gemini access is forbidden. Check the API key permissions and model access.";
  if (status === 400 || status === 404 || status === 422) return "Gemini rejected this request. Try a shorter question or document, and check that the configured model supports this request.";
  return "Gemini could not analyse this file after retries. Please try again.";
}

function validateQuestionRequest(req, res) {
  const { fileId, question } = req.body || {};
  const doc = getDocument(fileId, { reload: true });
  console.info("AI document lookup:", { backendInstanceId, fileId: typeof fileId === "string" ? fileId : null, mapSize: documents.size, found: Boolean(doc) });
  if (!doc) { res.status(404).json({ error: "Uploaded file not found. Please upload it again." }); return null; }
  if (typeof question !== "string" || !question.trim()) { res.status(400).json({ error: "Please enter a question." }); return null; }
  return { doc, question: question.trim() };
}

app.post("/api/ai/ask", async (req, res) => {
  const request = validateQuestionRequest(req, res);
  if (!request) return;
  res.setTimeout(0);
  try {
    const result = await analyzeDocument(request.doc, request.question);
    res.json({ answer: result.answer, source: result.source, cached: Boolean(result.cached), retryable: Boolean(result.retryable) });
  }
  catch (error) {
    logGeminiError(error);
    const geminiStatus = getHttpStatus(error);
    const responseStatus = [400, 401, 403, 404, 408, 413, 422, 429, 500, 503, 504].includes(geminiStatus) ? geminiStatus : 502;
    res.status(responseStatus).json({ error: userFacingGeminiError(error) });
  }
});

// Streaming progress endpoint used by the UI; the original JSON endpoint remains compatible.
app.post("/api/ai/ask/progress", async (req, res) => {
  const request = validateQuestionRequest(req, res);
  if (!request) return;
  const controller = new AbortController();
  let clientConnected = true;
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.setTimeout(0);
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (clientConnected && !res.destroyed && !res.writableEnded && res.writable) {
      try { res.write(": keep-alive\n\n"); }
      catch { controller.abort(); }
    }
  }, 15000);
  res.on("close", () => {
    clientConnected = false;
    clearInterval(heartbeat);
    if (!res.writableEnded && !controller.signal.aborted) controller.abort();
  });
  res.on("error", error => {
    clientConnected = false;
    clearInterval(heartbeat);
    if (!controller.signal.aborted) controller.abort();
    console.warn("Progress response closed with a transport error:", error.message);
  });
  try {
    const result = await analyzeDocument(
      request.doc,
      request.question,
      (stage, detail = {}) => sendSse(res, "progress", { stage, ...detail }),
      controller.signal
    );
    if (clientConnected) sendSse(res, "complete", { answer: result.answer, source: result.source, cached: Boolean(result.cached), retryable: Boolean(result.retryable) });
  } catch (error) {
    if (!controller.signal.aborted) {
      logGeminiError(error);
      if (clientConnected) sendSse(res, "failure", { error: userFacingGeminiError(error), status: getHttpStatus(error) });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
});
app.use((err, _req, res, _next) => {
  const fileSizeLimit = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
  const unsupportedType = err.code === "UNSUPPORTED_FILE_TYPE";
  const mimeMismatch = err.code === "MIME_TYPE_MISMATCH";
  console.error("Upload request rejected:", {
    stage: "multer-validation",
    errorName: err?.name || "Error",
    errorCode: err?.code || null
  });
  const status = fileSizeLimit ? 413 : mimeMismatch ? 415 : 400;
  const message = fileSizeLimit ? "File exceeds the 20 MB upload limit."
    : unsupportedType ? "Only PDF, XLSX and CSV files are supported."
      : mimeMismatch ? "The file type does not match its extension."
        : "The upload request could not be processed.";
  res.status(status).json({ error: message });
});
const configuredPort = (process.env.PORT || "5000").trim();
const port = Number(configuredPort);
if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT configuration: expected an integer from 1 to 65535, received ${JSON.stringify(configuredPort)}.`);
  process.exit(1);
}
async function startServer() {
  try {
    // Connect to MongoDB first
    await connectDB();

    // Initialize MongoDB conversation storage
    conversationStore = new JsonConversationStore(DATA_DIR);
    await conversationStore.initialize();

    // Recreate conversations for existing documents that don't have one
    const existingConversations = await conversationStore.list();

    for (const document of documents.values()) {
      const exists = existingConversations.some(
        conversation => conversation.fileId === document.fileId
      );

      if (!exists) {
        await conversationStore.create(
          document.fileId,
          document.name
        );
      }
    }

    console.log("Conversation storage initialized successfully.");

    // Start Express server
    app.listen(port, () => {
      console.log(
        `TECHNOVALENS API running at http://localhost:${port}`
      );
    });

  } catch (error) {
    console.error("Failed to start TechnovaLens:", error);
    process.exit(1);
  }
}

startServer();