# Grounded PDF chat validation — 14 November 2026

`pdf-questions.js` classifies factual lookup, exact calculation, summarization, comparison, interpretation and recommendations/information-gap analysis. `local-document.js` checks verified table lookups and explicitly bounded recommendation sections before extractive retrieval; complex requests never fall through to loose sentence matches. Generic question verbs no longer count as source evidence.

The server supplies relevant bounded passages to Gemini for qualitative reasoning, using separate source-fact quotations, analysis and analytical-suggestion fields. Source facts must be exact quotations from the supplied page; unsupported figures/page numbers and numerical analytical suggestions are rejected before caching. A final number/page guard also protects generated summaries. New arithmetic still requires verified structured data rather than inferred PDF table relationships. A stated total is a lookup, so the former blanket rejection of questions containing “total” is removed.

Provider 401/403/429/503/504 errors and unavailable/ungrounded responses preserve verified local answers. Missing-information fallback provides an explicitly labeled local business-information checklist when relevant; it does not substitute the report's conclusion. These suggestions do not assert the underlying data is absent or invent numerical outcomes. Unavailable responses remain retryable and are not cached. Spreadsheet calculations, model retry/fallback limits, conversation stores, MongoDB/GridFS and workspace isolation remain covered by the existing tests.

## Actual sample report

Tests use the original **TECHNOVALENS_Sample_Business_Report.pdf** copied into `tests/fixtures/sample-business-report.pdf`, plus its extracted text fixture. The original Downloads file is read only. Verified responses:

| Question | Verified result |
| --- | --- |
| How many total orders were recorded during Q2? | 930 orders, Page 1 |
| Which business division had the highest gross margin? | Professional Services, 48%, Page 1 |
| What information is missing from this report? | Analytical suggestions for retention, product profitability, marketing ROI, regional sales, cash flow and forecasts; not document facts |
| What recommendations does the report provide? | All four actual recommendations from section 6, Page 2; excludes the conclusion |
| Compare Q1 and Q2 net profit | 6,30,000 versus 8,25,000, Page 2; transcribed amounts rather than a newly computed change |

**Currency limitation:** The actual source PDF displays a black square for the currency glyph, extracted as `n`. This was confirmed visually on the rendered source page. The comparison removes that unreadable prefix, retains the exact amounts and explains the extraction issue. It does not silently manufacture a rupee symbol. A source with a readable currency label can preserve that label normally.

## Verification

- Focused classifier/retrieval tests cover the five questions, wrong-quarter rejection, no unrelated factual excerpts, no invented citations for unverified pages, bounded recommendations, and rejection of fabricated quotes/figures/pages.
- Real HTTP upload tests use the actual binary PDF. Verified factual answers make zero provider calls. A mocked Gemini returns structured qualitative analysis; 401, daily 429 and exhausted 503 paths return labeled local suggestions and a clear analysis-unavailable notice. Subsequent retries succeed with the same retained document; another workspace is denied.
- All **74 backend tests pass**, including Excel calculations, PDF/XLSX export, streaming parser, MongoDB/GridFS recovery, private workspace and conversation persistence tests. The frontend production build passes with the existing bundle-size warning.

No live Gemini requests were needed for regression tests. Model output quality beyond the strict grounding checks has been exercised with a local provider stub rather than a live production key. Arbitrary PDF layouts without a recognized unambiguous table/header/period remain conservative: use relevant source quotations or ask for structured data instead of guessing a figure. Qualitative analysis is labeled as inference, not promoted to source truth.

Source page renders are under `.data/pdf-chat-validation/`. `node inspect-pdf-text.mjs path/to/report.pdf` reproduces extraction and renders; the optional `--fixture` explicitly refreshes the local text fixture. No production resources were changed, and nothing was committed, pushed or deployed.
