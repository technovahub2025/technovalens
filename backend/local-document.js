const STOP_WORDS = new Set((
  "a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours " +
  "document documents file files pdf report reports page pages important main key major discuss discussed topics topic subjects subject points point overall overview summary summarize summarise explained explain tell give question answers answer shows showed according mention says stated found finding findings"
).split(/\s+/));

const TOPIC_QUESTION = /\b(topic|topics|subject|subjects|discuss(?:ed|es|ing)?|major finding|major findings|what.{0,30}document.{0,20}(?:about|discuss)|what.{0,30}pdf.{0,20}(?:about|discuss))\b/i;
const SUMMARY_QUESTION = /\b(summary|summarize|summarise|overview|document-wide summary|executive summary)\b/i;
const KEY_POINT_QUESTION = /\b(key points?|main points?|important points?|highlights?)\b/i;
const CONCLUSION_QUESTION = /\b(conclusion|conclusions|takeaways?|outcomes?)\b/i;
const DATES_NAMES_QUESTION = /\b(dates?|names?|people|organizations|companies|when|who)\b/i;

function splitPages(chunks = []) {
  const pages = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    let page = null;
    for (const line of String(chunk || "").split(/\r?\n/)) {
      const header = line.match(/^Page\s+(\d+)(?:\s*\(continued\))?\s*$/i);
      if (header) { page = Number(header[1]); if (!pages.has(page)) pages.set(page, ""); }
      else if (line.trim()) pages.set(page, `${pages.get(page) || ""}\n${line.trim()}`.trim());
    }
  }
  return [...pages].sort(([a], [b]) => a - b).map(([number, text]) => ({ number, text }));
}

function tokenize(value) {
  return String(value || "").toLocaleLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]{2,}/gu) || [];
}

function termsOf(question) {
  return tokenize(question).filter(term => !STOP_WORDS.has(term));
}

function sentencesFrom(pages) {
  const result = [];
  for (const page of pages) {
    const lines = page.text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const parts = line.match(/[^.!?]+(?:[.!?]+|$)/g) || [line];
      for (const raw of parts) {
        const text = raw.replace(/\s+/g, " ").trim();
        if (text.length >= 20 && !/^Page\s+\d+/i.test(text)) result.push({ page: page.number, text, index: result.length });
      }
    }
  }
  return result;
}

function isHeading(line) {
  const text = String(line || "").trim();
  if (text.length < 3 || text.length > 100 || /[.!?]$/.test(text)) return false;
  if (/^Page\s+\d+/i.test(text)) return false;
  return /^(?:\d+(?:\.\d+)*[.)]?\s+\S.{1,90}|[A-Z][A-Z\s\d:&(),/'’-]{2,90})$/.test(text)
    || (text.split(/\s+/).length <= 8 && text.split(/\s+/).filter(word => /^[A-Z][\p{L}\p{N}'’-]*$/u.test(word)).length >= 2);
}

function headingsFrom(pages) {
  return pages.flatMap(page => page.text.split(/\r?\n/).filter(isHeading).map(text => ({ page: page.number, text: text.trim() })));
}

function extractNamedEntities(text) {
  const months = "January|February|March|April|May|June|July|August|September|October|November|December";
  const dates = new Set();
  const datePatterns = [
    new RegExp(`\\b(?:${months})\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b`, "gi"),
    new RegExp(`\\b\\d{1,2}\\s+(?:${months})\\s+\\d{4}\\b`, "gi"),
    /\b(?:19|20)\d{2}(?:[-/](?:0?[1-9]|1[0-2])(?:[-/](?:0?[1-9]|[12]\d|3[01]))?)?\b/g
  ];
  for (const pattern of datePatterns) for (const match of text.matchAll(pattern)) dates.add(match[0]);
  const names = new Set();
  for (const match of text.matchAll(/\b[A-Z][a-z]{2,}(?:\s+(?:[A-Z][a-z]{2,}|&|of|the)){0,3}\b/g)) {
    const candidate = match[0].trim();
    if (!STOP_WORDS.has(candidate.toLocaleLowerCase()) && !/^(?:The|This|That|These|Those|However|According|Figure|Table|Page|Chapter|Section)\b/.test(candidate)) names.add(candidate);
  }
  return { dates: [...dates], names: [...names] };
}

function documentTerms(sentences, headings) {
  const counts = new Map();
  const pagesByTerm = new Map();
  for (const sentence of sentences) {
    const unique = new Set(tokenize(sentence.text).filter(term => !STOP_WORDS.has(term)));
    for (const term of unique) {
      counts.set(term, (counts.get(term) || 0) + 1);
      if (!pagesByTerm.has(term)) pagesByTerm.set(term, new Set());
      pagesByTerm.get(term).add(sentence.page);
    }
  }
  const headingTerms = new Set(headings.flatMap(item => tokenize(item.text).filter(term => !STOP_WORDS.has(term))));
  return [...counts].map(([term, count]) => ({
    term, count, pageCoverage: pagesByTerm.get(term)?.size || 0,
    score: count * (1 + Math.log1p(pagesByTerm.get(term)?.size || 0)) + (headingTerms.has(term) ? 2 : 0)
  })).sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
}

function rankSentences(sentences, frequentTerms, questionTerms = []) {
  const total = Math.max(1, sentences.length);
  return sentences.map(sentence => {
    const lower = sentence.text.toLocaleLowerCase();
    const termScore = frequentTerms.reduce((score, item) => lower.includes(item.term) ? score + Math.log1p(item.count) : score, 0);
    const questionScore = questionTerms.reduce((score, term) => lower.includes(term) ? score + 4 : score, 0);
    const informationScore = (/[0-9]/.test(sentence.text) ? 1.3 : 0)
      + (/\b(because|therefore|result|conclusion|finding|increased|decreased|grew|declined|approved|launched|reported|total|percent|%|recommendation|risk|led to)\b/i.test(sentence.text) ? 1.5 : 0);
    const positionScore = sentence.index < Math.ceil(total * 0.15) ? 0.5 : 0;
    return { ...sentence, score: termScore + questionScore + informationScore + positionScore };
  });
}

function uniqueSentences(items, limit = 6) {
  const selected = [];
  for (const item of items) {
    const tokens = new Set(tokenize(item.text).filter(term => !STOP_WORDS.has(term)));
    if (!tokens.size) continue;
    const duplicate = selected.some(existing => {
      const existingTokens = new Set(tokenize(existing.text).filter(term => !STOP_WORDS.has(term)));
      const overlap = [...tokens].filter(term => existingTokens.has(term)).length;
      return overlap / Math.max(1, Math.min(tokens.size, existingTokens.size)) > 0.8;
    });
    if (!duplicate) selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function withPages(items) {
  return items.map(item => `${item.text}${item.page ? ` [Page ${item.page}]` : ' [extracted text; page unverified]'}`);
}

function extractionInfo(doc, pages) {
  const retrievedTextLength = pages.reduce((count, page) => count + page.text.length, 0);
  return {
    documentId: doc.fileId || null,
    pageCount: Number(doc.pageCount || pages.length),
    extractedCharacters: Number(doc.textLength ?? retrievedTextLength),
    nonEmptyPages: pages.filter(page => page.text.trim()).length,
    retrievedTextLength,
    potentiallyScanned: Boolean(doc.potentiallyScanned || (pages.length > 0 && retrievedTextLength / pages.length < 20))
  };
}

function getRelevantSection(pages, headings, questionTerms, pageNumber) {
  const matchingHeadings = headings.filter(heading => (!pageNumber || heading.page === pageNumber)
    && questionTerms.some(term => heading.text.toLocaleLowerCase().includes(term)));
  if (!matchingHeadings.length) return null;
  const heading = matchingHeadings[0];
  const page = pages.find(item => item.number === heading.page);
  if (!page) return null;
  const lines = page.text.split(/\r?\n/);
  const index = lines.findIndex(line => line.trim() === heading.text);
  const followingLines = lines.slice(index + 1).filter(line => line.trim() && !isHeading(line));
  const sectionSentences = sentencesFrom([{ number: heading.page, text: followingLines.join("\n") }]);
  return { heading, sectionSentences };
}

function diagnose(info, reason, callback) {
  callback?.({ ...info, failureReason: reason || null });
}

export function answerPdfLocally(doc, question, { forceSummary = false, onDiagnostic } = {}) {
  const pages = splitPages(doc.chunks);
  const info = extractionInfo(doc, pages);
  const sentences = sentencesFrom(pages);
  const headings = headingsFrom(pages);
  const q = String(question || "").trim();
  const queryTerms = termsOf(q);
  const pageMatch = q.match(/\bpage\s+(\d+)\b/i);
  const pageNumber = pageMatch ? Number(pageMatch[1]) : null;
  console.info("Local PDF retrieval:", info);

  const finish = (answer, reason = null) => {
    diagnose(info, reason, onDiagnostic);
    if (reason) console.info("Local PDF analysis could not answer:", { documentId: info.documentId, failureReason: reason });
    return answer;
  };

  if (info.potentiallyScanned || !info.nonEmptyPages || info.retrievedTextLength < 20) {
    return finish(null, "insufficient-extracted-text-ocr-required");
  }
  if (!sentences.length) return finish(null, "no-extractable-sentences");
  const selectedPages = pageNumber ? pages.filter(page => page.number === pageNumber) : pages;
  if (pageNumber && !selectedPages.some(page => page.text.trim())) {
    return finish(`The document has no extracted text for page ${pageNumber}.`, "requested-page-has-no-extracted-text");
  }
  const selectedSentences = pageNumber ? sentences.filter(sentence => sentence.page === pageNumber) : sentences;
  const terms = documentTerms(sentences, headings);
  const ranked = rankSentences(selectedSentences, terms, queryTerms);
  const allText = sentences.map(item => item.text).join("\n");
  const entities = extractNamedEntities(allText);

  if (TOPIC_QUESTION.test(q)) {
    const topicCandidates = terms.filter(item => item.count >= 2 || item.pageCoverage >= 2).slice(0, 8);
    const topicGroups = [];
    const used = new Set();
    for (const heading of headings) {
      if (topicGroups.length >= 5) break;
      const headingTerms = termsOf(heading.text);
      const headingMatches = ranked.filter(item => item.page === heading.page && !used.has(item.index)
        && headingTerms.some(term => item.text.toLocaleLowerCase().includes(term)));
      const related = headingMatches.length ? headingMatches : ranked.filter(item => item.page === heading.page && !used.has(item.index));
      const picked = uniqueSentences(related.sort((a, b) => b.score - a.score), 2);
      if (!picked.length) continue;
      picked.forEach(item => used.add(item.index));
      topicGroups.push(`- ${heading.text}${heading.page ? ` [Page ${heading.page}]` : ''}\n  ${withPages(picked).join("\n  ")}`);
    }
    for (const item of topicCandidates) {
      if (topicGroups.length >= 5) break;
      const related = ranked.filter(sentence => !used.has(sentence.index) && tokenize(sentence.text).includes(item.term));
      const picked = uniqueSentences(related.sort((a, b) => b.score - a.score), 2);
      if (!picked.length) continue;
      picked.forEach(sentence => used.add(sentence.index));
      topicGroups.push(`- ${item.term.charAt(0).toLocaleUpperCase()}${item.term.slice(1)}\n  ${withPages(picked).join("\n  ")}`);
    }
    if (!topicGroups.length) return finish(null, "no-document-wide-topic-evidence");
    return finish(`Important topics discussed in ${doc.name}:\n${topicGroups.join("\n")}`);
  }

  if (SUMMARY_QUESTION.test(q) && (!pageNumber || forceSummary)) {
    if (!forceSummary && doc.textLength > 18000) return finish(null, "large-document-summary-deferred-to-chunked-gemini");
    const selected = uniqueSentences(ranked.sort((a, b) => b.score - a.score || a.index - b.index), 8)
      .sort((a, b) => a.index - b.index);
    if (!selected.length) return finish(null, "no-summary-sentences-ranked");
    return finish(`Extractive summary of ${doc.name}:\n${withPages(selected).map(line => `- ${line}`).join("\n")}`);
  }

  if (KEY_POINT_QUESTION.test(q)) {
    const selected = uniqueSentences(ranked.sort((a, b) => b.score - a.score || a.index - b.index), 6);
    if (!selected.length) return finish(null, "no-key-point-sentences-ranked");
    return finish(`Key points extracted from ${doc.name}:\n${withPages(selected).map(line => `- ${line}`).join("\n")}`);
  }

  if (CONCLUSION_QUESTION.test(q)) {
    const conclusionHeadings = headings.filter(item => /conclusion|finding|result|takeaway|outcome/i.test(item.text));
    const conclusionSentences = conclusionHeadings.length
      ? ranked.filter(item => conclusionHeadings.some(heading => heading.page === item.page))
      : ranked.filter(item => /\b(conclud|finding|result|therefore|overall|in summary|outcome|led to|consequently)\w*/i.test(item.text));
    const selected = uniqueSentences(conclusionSentences.sort((a, b) => b.score - a.score || a.index - b.index), 5);
    if (!selected.length) return finish(null, "no-explicit-conclusion-evidence");
    return finish(`Conclusions stated in ${doc.name}:\n${withPages(selected).map(line => `- ${line}`).join("\n")}`);
  }

  if (DATES_NAMES_QUESTION.test(q)) {
    const chosen = sentences.filter(item => (!pageNumber || item.page === pageNumber)
      && (entities.dates.some(value => item.text.includes(value)) || entities.names.some(value => item.text.includes(value))));
    if (chosen.length) return finish(`Dates and names found in ${doc.name}:\n${withPages(uniqueSentences(chosen, 12)).map(line => `- ${line}`).join("\n")}`);
  }

  if (/\b(section|chapter|part)\b/i.test(q)) {
    const section = getRelevantSection(selectedPages, headings, queryTerms, pageNumber);
    if (section?.sectionSentences.length) {
      return finish(`${section.heading.text}${section.heading.page ? ` [Page ${section.heading.page}]` : ''}:\n${withPages(uniqueSentences(section.sectionSentences, 6)).map(line => `- ${line}`).join("\n")}`);
    }
  }

  const matches = ranked.filter(item => queryTerms.length
    ? queryTerms.filter(term => item.text.toLocaleLowerCase().includes(term)).length > 0
    : false).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = uniqueSentences(matches, 4);
  if (!selected.length) return finish(null, pageNumber ? "no-relevant-text-on-requested-page" : "no-relevant-sentence-match");
  return finish(withPages(selected).join("\n"));
}

export function localLimitation(doc, failureReason = "") {
  if (doc.kind === "pdf" && (doc.extractionStatus === "ocr-required" || /ocr|required|insufficient-extracted-text/.test(failureReason))) {
    return "This PDF appears to be scanned or contains too little selectable text. OCR is required before local document analysis can answer questions; no answer was generated.";
  }
  return doc.kind === "pdf"
    ? "Gemini is unavailable or its daily limit has been reached. Local document analysis could not find enough relevant extracted text to answer reliably. Try a question using terms from the document or retry when Gemini is available."
    : "Gemini is unavailable or its daily limit has been reached. This request needs analysis beyond the spreadsheet calculations available locally, so I can’t answer it reliably right now.";
}
