import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";

const backendDir = path.resolve(import.meta.dirname, "..");
const mock = { mode: "success", calls: 0, callsByModel: {}, active: 0, maxActive: 0, delayMs: 0 };
const providerServer = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.includes(":generateContent")) {
    res.writeHead(404).end();
    return;
  }
  mock.calls++;
  mock.lastModel = req.url?.match(/\/models\/([^:]+)/)?.[1]?.replace(/^models\//, "") || "unknown";
  mock.callsByModel[mock.lastModel] = (mock.callsByModel[mock.lastModel] || 0) + 1;
  mock.active++;
  mock.maxActive = Math.max(mock.maxActive, mock.active);
  const requestParts = [];
  for await (const part of req) requestParts.push(part);
  let requestBody;
  try { requestBody = JSON.parse(Buffer.concat(requestParts).toString("utf8")); mock.lastPrompt = requestBody.contents?.[0]?.parts?.[0]?.text || ""; }
  catch { mock.lastPrompt = ""; }
  mock.lastMime = requestBody?.generationConfig?.responseMimeType || null;
  if (mock.delayMs) await new Promise(resolve => setTimeout(resolve, mock.delayMs));
  const finish = () => { mock.active--; };
  if (mock.mode === "503" || mock.mode === "503-primary" && mock.lastModel === "gemini-flash-latest") {
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "Temporary mock capacity issue." } })); finish();
    return;
  }
  if (mock.mode === "429daily") {
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Daily quota exceeded." } })); finish();
    return;
  }
  if (mock.mode === "429-model-daily" && mock.lastModel === "gemini-flash-latest" || mock.mode === "429-both-daily") {
    const quotaModel = mock.lastModel;
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `Daily request quota exceeded for model ${quotaModel}.`, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXCEEDED", metadata: { quotaId: "GenerateRequestsPerDayPerModel-FreeTier", quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", model: quotaModel } }] } })); finish();
    return;
  }
  if (mock.mode === "429-project-daily") {
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Daily project request quota exceeded.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXCEEDED", metadata: { quotaId: "GenerateRequestsPerDayPerProject-FreeTier", quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests" } }] } })); finish();
    return;
  }
  if (mock.mode === "429rate") {
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Rate limit exceeded; retry after a short delay.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.001s" }] } })); finish();
    return;
  }
  if (mock.mode === "400") {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid mock request." } })); finish();
    return;
  }
  const generatedText = mock.lastMime === "application/json"
    ? JSON.stringify({ summary: "Regional revenues differ.", keyInsights: ["North leads."], trends: [], anomalies: [], recommendations: ["Review the regional mix."] })
    : "The regional data shows two distinct revenue levels.";
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: generatedText }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 12, totalTokenCount: 132 }
  }));
  finish();
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startBackend({ dataDir, budget = 15, apiKey = "test-only-key" }) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      GEMINI_API_KEY: apiKey,
      GEMINI_MODEL: "gemini-flash-latest",
      PRIMARY_GEMINI_MODEL: "gemini-flash-latest",
      FALLBACK_GEMINI_MODEL: "gemini-3.5-flash",
      GEMINI_API_BASE_URL: `http://127.0.0.1:${providerServer.address().port}`,
      GEMINI_MIN_INTERVAL_MS: "0",
      GEMINI_DAILY_BUDGET: String(budget),
      GEMINI_USAGE_TIME_ZONE: "UTC",
      GEMINI_QUEUE_TIMEOUT_MS: "10000",
      DOCUMENT_STORE_DIR: path.join(dataDir, "uploads")
    },
    stdio: "ignore"
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; }
    catch { /* Wait for Express startup. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error("Backend did not start in time.");
}

async function uploadWorkbook(base, rows, extra = [], origin) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sales");
  sheet.addRow(["Region", "Revenue"]);
  for (const row of rows) sheet.addRow(row);
  for (const [name, values] of extra) {
    const other = workbook.addWorksheet(name);
    values.forEach(row => other.addRow(row));
  }
  const form = new FormData();
  form.append("file", new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "sales.xlsx");
  const response = await fetch(`${base}/api/files/upload`, { method: "POST", headers: origin ? { Origin: origin } : {}, body: form });
  assert.equal(response.status, 200);
  return response.json();
}

function makePdf(text) {
  const lines = String(text).match(/.{1,90}(?:\s|$)|.{1,90}/g) || [String(text)];
  const pages = [];
  for (let start = 0; start < lines.length; start += 45) pages.push(lines.slice(start, start + 45));
  const objects = new Map();
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((pageLines, index) => {
    const pageId = 3 + index * 3, contentId = pageId + 1, fontId = pageId + 2;
    const stream = `BT /F1 12 Tf 50 750 Td ${pageLines.map(line => `(${line.replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj 0 -14 Td`).join(" ")} ET`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  });
  const objectCount = objects.size;
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index <= objectCount; index++) {
    offsets.push(Buffer.byteLength(output));
    output += `${index} 0 obj\n${objects.get(index)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

async function uploadPdf(base, text = "Quarterly revenue was 125 units and profit was 25 units.", filename = "quarterly.pdf", origin) {
  const form = new FormData();
  form.append("file", new Blob([makePdf(text)], { type: "application/pdf" }), filename);
  const response = await fetch(`${base}/api/files/upload`, { method: "POST", headers: origin ? { Origin: origin } : {}, body: form });
  assert.equal(response.status, 200);
  return response.json();
}

async function ask(base, fileId, question, route = "/api/ai/ask") {
  return fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileId, question }) });
}

async function stopBackend(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
}

test("Excel API caching, single-flight, 429/503 retries, local answers and persistent usage", { timeout: 120000 }, async t => {
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "technovalens-api-"));
  let running;
  try {
    mock.mode = "success"; mock.calls = 0; mock.maxActive = 0; mock.delayMs = 0;
    running = await startBackend({ dataDir, budget: 50 });
    const approvedOrigins = [
      "http://localhost:5173",
      "https://technovalens.vercel.app",
      "https://technovahub.in",
      "https://www.technovahub.in"
    ];
    for (const origin of approvedOrigins) {
      const response = await fetch(`${running.base}/api/health`, { headers: { Origin: origin } });
      assert.equal(response.headers.get("access-control-allow-origin"), origin, `${origin} should be allowed`);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    }
    const preflight = await fetch(`${running.base}/api/files/upload`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://technovahub.in",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://technovahub.in");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /GET.*POST.*PUT.*PATCH.*DELETE.*OPTIONS/);
    assert.match(preflight.headers.get("access-control-allow-headers") || "", /Content-Type/i);
    assert.match(preflight.headers.get("access-control-allow-headers") || "", /Authorization/i);
    const unauthorized = await fetch(`${running.base}/api/files`, { headers: { Origin: "https://evil.example" } });
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);

    const pdfForm = new FormData();
    pdfForm.append("file", new Blob([makePdf("Quarterly revenue was 125 units and profit was 25 units.")], { type: "application/pdf" }), "quarterly.pdf");
    const uploadResponse = await fetch(`${running.base}/api/files/upload`, { method: "POST", headers: { Origin: "https://technovahub.in" }, body: pdfForm });
    assert.equal(uploadResponse.status, 200);
    assert.equal(uploadResponse.headers.get("access-control-allow-origin"), "https://technovahub.in");
    const pdf = await uploadResponse.json();
    const pdfSummary = await (await ask(running.base, pdf.fileId, "Assess the competitive threats to this company over the next five years.")).json();
    assert.equal(pdfSummary.source, "gemini-primary");
    assert.match(pdfSummary.answer, /regional data/);
    let expectedProviderCalls = 1;
    const costRows = [["Type", "Revenue"], ...Array.from({ length: 100 }, (_, index) => [`ArchiveOnlyRecord${index}`, index])];
    const first = await uploadWorkbook(running.base, [["North", 125], ["South", 90]], [["Costs", costRows]], "https://www.technovahub.in");
    assert.equal(first.sheetNames.length, 2);

    const local = await (await ask(running.base, first.fileId, "What is the total Revenue?")).json();
    assert.equal(local.source, "local-spreadsheet");
    assert.match(local.answer, /215/);
    const otherSheetLocal = await (await ask(running.base, first.fileId, "How many rows are there in Costs?")).json();
    assert.match(otherSheetLocal.answer, /100 data rows in Costs/);
    assert.equal(mock.calls, expectedProviderCalls);

    const aiQuestion = "Explain what the North region data suggests about customer behavior.";
    const response1 = await ask(running.base, first.fileId, aiQuestion);
    const result1 = await response1.json();
    assert.equal(response1.status, 200);
    assert.equal(result1.source, "gemini-primary");
    assert.doesNotMatch(mock.lastPrompt, /ArchiveOnlyRecord99/);
    assert.equal(mock.calls, expectedProviderCalls + 1);
    const result2 = await (await ask(running.base, first.fileId, aiQuestion)).json();
    assert.equal(result2.cached, true);
    assert.equal(mock.calls, expectedProviderCalls + 1);

    const structured = await (await ask(running.base, first.fileId, "Provide a comprehensive analysis with recommendations.")).json();
    assert.equal(mock.lastMime, "application/json");
    assert.match(structured.answer, /Key insights[\s\S]*Recommendations/);
    expectedProviderCalls++;
    assert.equal(mock.calls, expectedProviderCalls + 1);

    const changed = await uploadWorkbook(running.base, [["North", 200], ["South", 90]]);
    const changedAnswer = await (await ask(running.base, changed.fileId, aiQuestion)).json();
    assert.equal(changedAnswer.cached, false);
    expectedProviderCalls++;
    assert.equal(mock.calls, expectedProviderCalls + 1);

    mock.delayMs = 100;
    const concurrentQuestion = "Interpret the regional mix for a business leader.";
    const [parallelA, parallelB] = await Promise.all([
      ask(running.base, changed.fileId, concurrentQuestion),
      ask(running.base, changed.fileId, concurrentQuestion)
    ]);
    assert.equal(parallelA.status, 200);
    assert.equal(parallelB.status, 200);
    expectedProviderCalls++;
    assert.equal(mock.calls, expectedProviderCalls + 1, "identical simultaneous asks should share one provider call");
    assert.equal(mock.maxActive, 1, "only one provider request may be active per process");
    const beforeDistinctConcurrent = mock.calls;
    const differentQuestions = await Promise.all([
      ask(running.base, changed.fileId, "Explain why North contributes to this workbook."),
      ask(running.base, changed.fileId, "Interpret how South affects the business outlook.")
    ]);
    assert.ok(differentQuestions.every(response => response.status === 200));
    assert.equal(mock.calls - beforeDistinctConcurrent, 2);
    assert.equal(mock.maxActive, 1, "different queued provider requests must remain serialized");
    const sseResponse = await ask(running.base, first.fileId, aiQuestion, "/api/ai/ask/progress");
    const sseBody = await sseResponse.text();
    assert.match(sseBody, /event: complete/);
    assert.match(sseBody, /"cached":true/);
    mock.delayMs = 0;

    mock.mode = "429daily";
    const before429 = mock.calls;
    const quotaResponse = await ask(running.base, changed.fileId, "Explain the business implications of the southern region.");
    const quotaBody = await quotaResponse.json();
    assert.equal(quotaResponse.status, 200);
    assert.equal(quotaBody.source, "local-spreadsheet");
    assert.match(quotaBody.answer, /Gemini is unavailable or its daily limit has been reached/i);
    assert.equal(mock.calls - before429, 1, "daily quota errors are not retried");

    mock.mode = "429rate";
    const beforeTransient429 = mock.calls;
    const rateResponse = await ask(running.base, changed.fileId, "Interpret the sales mix by market segment.");
    assert.equal(rateResponse.status, 429);
    assert.equal(mock.calls - beforeTransient429, 3, "transient 429 errors receive at most two retries");

    mock.mode = "400";
    const before400 = mock.calls;
    const invalidResponse = await ask(running.base, changed.fileId, "Explain why this question is rejected by the simulated provider.");
    assert.equal(invalidResponse.status, 400);
    assert.equal(mock.calls - before400, 1, "invalid requests are not retried");

    mock.mode = "503";
    const before503 = mock.calls;
    const unavailableResponse = await ask(running.base, changed.fileId, "Explain the latest regional demand signals.");
    const unavailableBody = await unavailableResponse.json();
    assert.equal(unavailableResponse.status, 503);
    assert.match(unavailableBody.error, /temporarily unavailable/i);
    assert.equal(mock.calls - before503, 6, "primary and fallback each receive at most two retries");

    mock.mode = "success";
    const usageBeforeRestart = await (await fetch(`${running.base}/api/usage`)).json();
    assert.ok(usageBeforeRestart.dailyRequests > 0);
    assert.equal(usageBeforeRestart.maxConcurrentRequests, 1);
    assert.equal(usageBeforeRestart.cacheHits, 2);
    await stopBackend(running.child);
    running = await startBackend({ dataDir, budget: 50 });
    const usageAfterRestart = await (await fetch(`${running.base}/api/usage`)).json();
    assert.equal(usageAfterRestart.dailyRequests, usageBeforeRestart.dailyRequests);
    assert.equal(usageAfterRestart.totalRequests, usageBeforeRestart.totalRequests);
    const persistedCache = await (await ask(running.base, first.fileId, aiQuestion)).json();
    assert.equal(persistedCache.cached, true);
    assert.equal(mock.calls, before503 + 6);
  } finally {
    if (running) await stopBackend(running.child);
    await new Promise(resolve => providerServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("application daily budget blocks provider calls but local analytics continue", { timeout: 30000 }, async () => {
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "technovalens-budget-"));
  let running;
  try {
    mock.mode = "success"; mock.calls = 0; mock.delayMs = 0;
    running = await startBackend({ dataDir, budget: 1 });
    const workbook = await uploadWorkbook(running.base, [["North", 125], ["South", 90]]);
    const first = await ask(running.base, workbook.fileId, "Explain regional purchasing patterns for leadership.");
    assert.equal(first.status, 200);
    assert.equal(mock.calls, 1);
    const exhausted = await ask(running.base, workbook.fileId, "Interpret regional demand and product positioning.");
    const exhaustedBody = await exhausted.json();
    assert.equal(exhausted.status, 200);
    assert.equal(exhaustedBody.source, "local-spreadsheet");
    assert.match(exhaustedBody.answer, /daily limit has been reached|can’t answer it reliably/i);
    assert.equal(exhaustedBody.retryable, true);
    assert.equal(mock.calls, 1);
    const local = await ask(running.base, workbook.fileId, "What is the total Revenue?");
    assert.equal(local.status, 200);
    assert.equal((await local.json()).source, "local-spreadsheet");
    assert.equal(mock.calls, 1);
    const usageBeforeRestart = await (await fetch(`${running.base}/api/usage`)).json();
    await stopBackend(running.child);
    running = await startBackend({ dataDir, budget: 1 });
    const usageAfterRestart = await (await fetch(`${running.base}/api/usage`)).json();
    assert.equal(usageAfterRestart.dailyRequests, usageBeforeRestart.dailyRequests);
  } finally {
    if (running) await stopBackend(running.child);
    await new Promise(resolve => providerServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local PDF summaries, key points, page retrieval, quota recovery, and Excel calculations", { timeout: 60000 }, async () => {
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "technovalens-local-ai-"));
  let running;
  try {
    mock.mode = "success"; mock.calls = 0; mock.callsByModel = {};
    running = await startBackend({ dataDir, budget: 0 });
    const pageOne = `MARKET EXPANSION\n${Array.from({ length: 55 }, (_, index) => `The company expanded its North region market by opening three stores in quarter ${index + 1}. Customer retention improved because local delivery became faster.`).join(" ")}`;
    const pageTwo = `FINANCIAL PERFORMANCE\nProject Cedar reported revenue growth of 42 percent in March 2025. Operating profit increased after distribution costs fell.\nCONCLUSION\nThe report concludes that regional expansion and faster delivery improved customer retention and financial performance.`;
    const pdf = await uploadPdf(running.base, `${pageOne}\n${pageTwo}`, "representative-mult-page-report.pdf");
    assert.ok(pdf.pageCount >= 2, "representative fixture must be multi-page");
    assert.equal(pdf.extractionStatus, "text-extracted");

    for (const question of [
      "What are the important topics discussed in this document?",
      "What are the main topics?",
      "Give me the key topics.",
      "What does this document discuss?",
      "What are the important points?",
      "Explain the main subjects.",
      "Give me an overview of this PDF.",
      "What are the major findings?"
    ]) {
      const topicAnswer = await (await ask(running.base, pdf.fileId, question)).json();
      assert.equal(topicAnswer.source, "local-pdf", question);
      assert.match(topicAnswer.answer, /Page \d+/, question);
    }
    const documentTopics = await (await ask(running.base, pdf.fileId, "What are the important topics discussed in this document?")).json();
    assert.match(documentTopics.answer, /Market|Expansion/i);
    assert.match(documentTopics.answer, /Financial|Performance/i);

    const summary = await (await ask(running.base, pdf.fileId, "Summarise this report.")).json();
    assert.equal(summary.source, "local-pdf");
    assert.match(summary.answer, /Extractive summary/);
    assert.match(summary.answer, /Page \d+/);

    const keyPoints = await (await ask(running.base, pdf.fileId, "What are the key points?")).json();
    assert.equal(keyPoints.source, "local-pdf");
    assert.match(keyPoints.answer, /Key points extracted/);
    assert.match(keyPoints.answer, /Page \d+/);

    const persistedPreview = (await (await fetch(`${running.base}/api/files/${pdf.fileId}`)).json()).preview;
    const reportPosition = persistedPreview.indexOf("Project Cedar");
    const reportPage = [...persistedPreview.slice(0, reportPosition).matchAll(/^Page (\d+)/gm)].at(-1)?.[1];
    assert.ok(reportPage, "page-numbered PDF text should persist for the report section");
    const pageAnswer = await (await ask(running.base, pdf.fileId, `What does the report say about revenue on page ${reportPage}?`)).json();
    assert.equal(pageAnswer.source, "local-pdf");
    assert.match(pageAnswer.answer, new RegExp(`revenue growth of 42 percent.*Page ${reportPage}`, "i"));

    const conclusion = await (await ask(running.base, pdf.fileId, "What are the main conclusions?")).json();
    assert.equal(conclusion.source, "local-pdf");
    assert.match(conclusion.answer, /concludes that regional expansion/i);
    const sectionAnswer = await (await ask(running.base, pdf.fileId, "What does the Financial Performance section say?")).json();
    assert.equal(sectionAnswer.source, "local-pdf");
    assert.match(sectionAnswer.answer, /Financial Performance.*Page \d+/i);
    assert.match(sectionAnswer.answer, /revenue growth/i);
    const datesNames = await (await ask(running.base, pdf.fileId, "What important dates and names are in the document?")).json();
    assert.equal(datesNames.source, "local-pdf");
    assert.match(datesNames.answer, /March 2025/);
    assert.match(datesNames.answer, /Project Cedar/);

    const unknown = await (await ask(running.base, pdf.fileId, "Develop a detailed geopolitical forecast for the next decade.")).json();
    assert.equal(unknown.source, "local-pdf");
    assert.match(unknown.answer, /could not find enough relevant extracted text|couldn’t find enough relevant text/i);
    assert.doesNotMatch(unknown.answer, /geopolitical forecast will/i);
    assert.equal(unknown.retryable, true);

    const workbook = await uploadWorkbook(running.base, [["North", 120], ["South", 80], ["East", 100]]);
    const total = await (await ask(running.base, workbook.fileId, "What is the total Revenue?")).json();
    assert.equal(total.source, "local-spreadsheet");
    assert.match(total.answer, /300/);
    const average = await (await ask(running.base, workbook.fileId, "What is the average Revenue?")).json();
    assert.equal(average.source, "local-spreadsheet");
    assert.match(average.answer, /100/);
    const comparison = await (await ask(running.base, workbook.fileId, "Compare total Revenue by Region.")).json();
    assert.equal(comparison.source, "local-spreadsheet");
    assert.match(comparison.answer, /North: 120.*South: 80.*East: 100/);
    assert.equal(mock.calls, 0, "local summaries, retrieval, and calculations must not call Gemini");

    const sparsePdf = await uploadPdf(running.base, "SCAN");
    assert.equal(sparsePdf.extractionStatus, "ocr-required");
    assert.equal(sparsePdf.potentiallyScanned, true);
    assert.match(sparsePdf.extractionWarning, /OCR/i);
    const scannedQuestion = await (await ask(running.base, sparsePdf.fileId, "What are the important topics?")).json();
    assert.equal(scannedQuestion.source, "local-pdf");
    assert.match(scannedQuestion.answer, /scanned|OCR/i);
    assert.equal(scannedQuestion.retryable, false);

    const unresolvedQuestion = "What future regulatory policy changes will happen in 2035?";
    const unresolved = await (await ask(running.base, pdf.fileId, unresolvedQuestion)).json();
    assert.equal(unresolved.retryable, true);
    const sameDocumentRetry = await (await ask(running.base, pdf.fileId, unresolvedQuestion)).json();
    assert.equal(sameDocumentRetry.source, "local-pdf");
    const savedDocumentPath = path.join(dataDir, "uploads", `${pdf.fileId}.json`);
    const savedDocument = JSON.parse(await readFile(savedDocumentPath, "utf8"));
    savedDocument.chunks = ["Page 1\nFuture regulatory policy changes will take effect in 2035."];
    savedDocument.textLength = savedDocument.chunks[0].length;
    savedDocument.pageCount = 1;
    savedDocument.nonEmptyPages = 1;
    savedDocument.potentiallyScanned = false;
    savedDocument.extractionStatus = "text-extracted";
    savedDocument.extractionWarning = null;
    await writeFile(savedDocumentPath, JSON.stringify(savedDocument), "utf8");
    const retriedWithPersistedText = await (await ask(running.base, pdf.fileId, unresolvedQuestion)).json();
    assert.match(retriedWithPersistedText.answer, /regulatory policy changes.*Page 1/i, "same fileId and question must analyze the latest persisted PDF text");
    assert.equal((await (await fetch(`${running.base}/api/files/${pdf.fileId}`)).json()).fileId, pdf.fileId);
  } finally {
    if (running) await stopBackend(running.child);
    await new Promise(resolve => providerServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("provider daily quota returns grounded local limitation without invented answer", { timeout: 30000 }, async () => {
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "technovalens-provider-quota-local-"));
  let running;
  try {
    mock.mode = "429daily"; mock.calls = 0;
    running = await startBackend({ dataDir, budget: 15 });
    const pdf = await uploadPdf(running.base, "The report records stable annual revenue and moderate operating costs.");
    const response = await ask(running.base, pdf.fileId, "Build a detailed geopolitical forecast about next decade policy changes.");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "local-pdf");
    assert.match(body.answer, /Gemini.*daily limit.*could not find enough relevant extracted text/i);
    assert.equal(body.retryable, true);
    assert.equal(mock.calls, 1);
  } finally {
    if (running) await stopBackend(running.child);
    await new Promise(resolve => providerServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("documents and conversation messages persist across backend restart and remain linked", { timeout: 60000 }, async () => {
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "technovalens-persistence-"));
  let running;
  try {
    mock.mode = "success"; mock.calls = 0;
    running = await startBackend({ dataDir, budget: 15 });
    const pdf = await uploadPdf(running.base, "Page one reports that North revenue was 125 and operating profit was 25.", "persistent-report.pdf");
    const workbook = await uploadWorkbook(running.base, [["North", 125], ["South", 90]]);
    assert.ok(pdf.conversationId);
    assert.ok(workbook.conversationId);

    const fileList = await (await fetch(`${running.base}/api/files`)).json();
    assert.deepEqual(new Set(fileList.map(file => file.fileId)), new Set([pdf.fileId, workbook.fileId]));
    const pdfDetail = await (await fetch(`${running.base}/api/files/${pdf.fileId}`)).json();
    assert.equal(pdfDetail.fileName, "persistent-report.pdf");
    assert.match(pdfDetail.preview, /revenue was 125/);

    for (let index = 1; index <= 5; index++) {
      const question = index === 3
        ? "Summarise the report."
        : index === 5 ? "Assess strategic positioning beyond the report's factual content."
          : `What revenue and profit facts are stated on page one? Question ${index}.`;
      const userMessage = await fetch(`${running.base}/api/conversations/${pdf.conversationId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "user", text: question })
      });
      assert.equal(userMessage.status, 201);
      const answerResponse = await ask(running.base, pdf.fileId, question);
      assert.equal(answerResponse.status, 200);
      const generatedAnswer = await answerResponse.json();
      const assistantMessage = await fetch(`${running.base}/api/conversations/${pdf.conversationId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "assistant", text: generatedAnswer.answer, source: generatedAnswer.source })
      });
      assert.equal(assistantMessage.status, 201);
    }
    const excelAnswer = await ask(running.base, workbook.fileId, "What is the total Revenue?");
    assert.equal(excelAnswer.status, 200);
    const excelBody = await excelAnswer.json();
    await fetch(`${running.base}/api/conversations/${workbook.conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", text: "What is the total Revenue?" })
    });
    await fetch(`${running.base}/api/conversations/${workbook.conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "assistant", text: excelBody.answer, source: excelBody.source })
    });

    const pdfConversation = await (await fetch(`${running.base}/api/conversations/${pdf.conversationId}`)).json();
    assert.equal(pdfConversation.fileId, pdf.fileId);
    assert.equal(pdfConversation.messages.length, 10);
    assert.equal(pdfConversation.messages.at(-1).source, "gemini-primary");

    await stopBackend(running.child);
    running = await startBackend({ dataDir, budget: 15 });
    const restoredFiles = await (await fetch(`${running.base}/api/files`)).json();
    const restoredChats = await (await fetch(`${running.base}/api/conversations`)).json();
    assert.ok(restoredFiles.some(file => file.fileId === pdf.fileId));
    assert.ok(restoredFiles.some(file => file.fileId === workbook.fileId));
    assert.ok(restoredChats.some(chat => chat.id === pdf.conversationId && chat.fileId === pdf.fileId));
    assert.ok(restoredChats.some(chat => chat.id === workbook.conversationId && chat.fileId === workbook.fileId));
    const restoredPdfChat = await (await fetch(`${running.base}/api/conversations/${pdf.conversationId}`)).json();
    assert.equal(restoredPdfChat.messages.length, 10);
    assert.match(restoredPdfChat.messages[0].text, /What revenue and profit facts/);
    assert.equal(restoredPdfChat.messages[1].source, "local-pdf");
    assert.equal(restoredPdfChat.messages.at(-1).source, "gemini-primary");
    assert.equal((await ask(running.base, pdf.fileId, "What page one reports about North revenue?")).status, 200);
    assert.equal((await ask(running.base, workbook.fileId, "What is the total Revenue?")).status, 200);

    const disposable = await (await fetch(`${running.base}/api/conversations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileId: pdf.fileId, title: "Temporary chat" })
    })).json();
    assert.equal((await fetch(`${running.base}/api/conversations/${disposable.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${running.base}/api/files/${pdf.fileId}`)).status, 200, "deleting a conversation should retain its document");
    assert.equal((await fetch(`${running.base}/api/files/${workbook.fileId}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${running.base}/api/conversations/${workbook.conversationId}`)).status, 404, "deleting a document cascades its conversations");
  } finally {
    if (running) await stopBackend(running.child);
    await new Promise(resolve => providerServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local spreadsheet analytics remain available without a Gemini key", { timeout: 30000 }, async () => {
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "technovalens-no-key-"));
  let running;
  try {
    mock.mode = "success"; mock.calls = 0;
    running = await startBackend({ dataDir, apiKey: "", budget: 15 });
    const workbook = await uploadWorkbook(running.base, [["North", 125], ["South", 90]]);
    const local = await ask(running.base, workbook.fileId, "What is the total Revenue?");
    assert.equal(local.status, 200);
    assert.equal((await local.json()).source, "local-spreadsheet");
    const ai = await ask(running.base, workbook.fileId, "Interpret what regional mix suggests for sales strategy.");
    assert.equal(ai.status, 503);
    assert.match((await ai.json()).error, /AI is not configured/i);
    assert.equal(mock.calls, 0);
  } finally {
    if (running) await stopBackend(running.child);
    await new Promise(resolve => providerServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("PDF primary/fallback generation, quota routing, chunking, recovery and Excel answers", { timeout: 120000 }, async () => {
  providerServer.listen(0, "127.0.0.1");
  await once(providerServer, "listening");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "technovalens-fallback-"));
  let running;
  try {
    mock.mode = "success"; mock.calls = 0; mock.callsByModel = {}; mock.maxActive = 0; mock.delayMs = 0;
    running = await startBackend({ dataDir, budget: 50 });

    const pdf = await uploadPdf(running.base);
    const primarySummary = await (await ask(running.base, pdf.fileId, "Evaluate the long term risks and competitive implications described here.")).json();
    assert.equal(primarySummary.source, "gemini-primary");
    assert.equal(mock.callsByModel["gemini-flash-latest"], 1, "primary should answer when available");

    mock.mode = "503-primary";
    const beforeFallback = { ...mock.callsByModel };
    const fallbackSummaryResponse = await ask(running.base, pdf.fileId, "Evaluate the long term opportunities and competitive implications for this report.");
    const fallbackSummary = await fallbackSummaryResponse.json();
    assert.equal(fallbackSummaryResponse.status, 200);
    assert.equal(fallbackSummary.source, "gemini-fallback");
    assert.equal((mock.callsByModel["gemini-flash-latest"] || 0) - (beforeFallback["gemini-flash-latest"] || 0), 3, "primary gets initial attempt plus two retries");
    assert.equal((mock.callsByModel["gemini-3.5-flash"] || 0) - (beforeFallback["gemini-3.5-flash"] || 0), 1, "fallback is attempted after primary 503 exhaustion");

    mock.mode = "429-model-daily";
    const beforeDailyFallback = { ...mock.callsByModel };
    const dailyFallbackResponse = await ask(running.base, pdf.fileId, "Assess long term competitive threats after primary daily quota.");
    assert.equal(dailyFallbackResponse.status, 200, "model-specific daily quota should immediately use fallback");
    assert.equal((mock.callsByModel["gemini-flash-latest"] || 0) - (beforeDailyFallback["gemini-flash-latest"] || 0), 1, "daily quota response should not be retried");
    assert.equal((mock.callsByModel["gemini-3.5-flash"] || 0) - (beforeDailyFallback["gemini-3.5-flash"] || 0), 1);

    mock.mode = "429-project-daily";
    const beforeProjectQuota = mock.calls;
    const projectQuotaResponse = await ask(running.base, pdf.fileId, "Assess strategic risks with project quota exhausted.");
    assert.equal(projectQuotaResponse.status, 200);
    assert.match((await projectQuotaResponse.json()).answer, /Gemini is unavailable or its daily limit has been reached/i);
    assert.equal(mock.calls - beforeProjectQuota, 1, "project-wide quota should not trigger fallback or retries");

    mock.mode = "429-both-daily";
    const beforeBothQuota = mock.calls;
    const bothQuotaResponse = await ask(running.base, pdf.fileId, "Assess strategic risks with both model quotas exhausted.");
    assert.equal(bothQuotaResponse.status, 200);
    assert.match((await bothQuotaResponse.json()).answer, /Gemini is unavailable or its daily limit has been reached/i);
    assert.equal(mock.calls - beforeBothQuota, 2, "each model-specific daily quota is tried once");

    mock.mode = "503-primary";
    const beforeQuestion = { ...mock.callsByModel };
    const pdfQuestion = await ask(running.base, pdf.fileId, "Explain the company's long term risks and opportunities.");
    assert.equal(pdfQuestion.status, 200);
    assert.equal((mock.callsByModel["gemini-3.5-flash"] || 0) - (beforeQuestion["gemini-3.5-flash"] || 0), 1, "PDF questions use the same fallback path");

    mock.mode = "success";
    const longText = `Large report page references. ${"Revenue increased and costs were controlled in the reporting period. ".repeat(900)}`;
    const largePdf = await uploadPdf(running.base, longText, "large-report.pdf");
    assert.equal(largePdf.previewTruncated, true, "fixture must extract as a large PDF");
    const beforeChunkedSummary = mock.calls;
    const longSummary = await ask(running.base, largePdf.fileId, "Summarise the large report with page references.");
    assert.equal(longSummary.status, 200);
    assert.ok(mock.calls - beforeChunkedSummary >= 3, "large PDF should be summarized in chunks and a final synthesis request");
    assert.match(mock.lastPrompt, /Summary group/);

    mock.mode = "503";
    const failedQuestion = "Assess the report's long term strategic implications after both providers are unavailable.";
    const beforeBothFail = mock.calls;
    const bothUnavailable = await ask(running.base, pdf.fileId, failedQuestion);
    assert.equal(bothUnavailable.status, 503);
    assert.match((await bothUnavailable.json()).error, /temporarily unavailable/i);
    assert.equal(mock.calls - beforeBothFail, 6, "primary and fallback each get no more than two retries");

    mock.mode = "success";
    const retried = await ask(running.base, pdf.fileId, failedQuestion);
    assert.equal(retried.status, 200);
    assert.equal(mock.calls - beforeBothFail, 7, "retry reuses the retained fileId without another upload");

    const workbook = await uploadWorkbook(running.base, [["North", 125], ["South", 90]]);
    mock.mode = "503-primary";
    const excelAnswer = await ask(running.base, workbook.fileId, "Explain the regional mix for a business user.");
    assert.equal(excelAnswer.status, 200);
    const excelBody = await excelAnswer.json();
    assert.equal(excelBody.source, "gemini-fallback");
    assert.equal(mock.lastModel, "gemini-3.5-flash", "Excel AI questions also use the configured fallback");
  } finally {
    if (running) await stopBackend(running.child);
    await new Promise(resolve => providerServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
