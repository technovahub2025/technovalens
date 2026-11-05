import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { fileURLToPath } from "url";

const envPath = fileURLToPath(new URL("./.env", import.meta.url));
dotenv.config({ path: envPath });
const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("GEMINI_API_KEY is not configured in backend/.env.");
  process.exit(1);
}

const primary = process.env.PRIMARY_GEMINI_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
const fallback = process.env.FALLBACK_GEMINI_MODEL?.trim();
const candidates = [...new Set([primary, fallback].filter(Boolean))];
const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 30000, retryOptions: { attempts: 1 } } });

function providerError(error) {
  let body;
  try { body = JSON.parse(error?.message || ""); } catch { /* Network and SDK errors are not always JSON. */ }
  const detail = body?.error || {};
  return {
    httpStatus: error?.status || detail.code || null,
    providerStatus: detail.status || null,
    providerMessage: String(detail.message || error?.message || "Unknown provider error").slice(0, 500)
  };
}

let listed;
try {
  listed = await ai.models.list();
} catch (error) {
  console.error(JSON.stringify({ stage: "list-models", ...providerError(error) }));
  process.exit(1);
}
const modelInfo = new Map();
for await (const item of listed) {
  const name = String(item.name || "").replace(/^models\//, "");
  modelInfo.set(name, item);
}

let allVerified = true;
for (const model of candidates) {
  const info = modelInfo.get(model);
  const methods = info?.supportedActions || info?.supportedGenerationMethods || [];
  const listedForGeneration = methods.includes("generateContent");
  if (!listedForGeneration) {
    allVerified = false;
    console.log(JSON.stringify({ model, listed: Boolean(info), supportsGenerateContent: false, actualTextGeneration: false }));
    continue;
  }
  try {
    const response = await ai.models.generateContent({
      model,
      contents: "Reply with exactly OK.",
      config: { maxOutputTokens: 8, httpOptions: { timeout: 30000, retryOptions: { attempts: 1 } } }
    });
    console.log(JSON.stringify({ model, listed: true, supportsGenerateContent: true, actualTextGeneration: Boolean(response.text?.trim()), httpStatus: 200 }));
    if (!response.text?.trim()) allVerified = false;
  } catch (error) {
    allVerified = false;
    console.log(JSON.stringify({ model, listed: true, supportsGenerateContent: true, actualTextGeneration: false, ...providerError(error) }));
  }
}
if (!allVerified) process.exitCode = 1;
