# Chat worksheet selection fix

The chat panel previously displayed the first-sheet metadata without maintaining a worksheet choice or including it in AI requests. The backend correctly found the multi-sheet question ambiguous.

The panel now has a controlled worksheet selector. New uploads visibly initialize it from validated file metadata (Sales in the sample workbook); changes and an explicitly cleared selection are saved per file in browser storage. Streaming requests, JSON fallbacks and retries send an exact `selectedSheet` name or null. Retries retain their original worksheet rather than adopting a later selection.

The API verifies that the worksheet belongs to the authorized document. The deterministic planner and Gemini context use the same scope resolver:

- “This sheet,” “current sheet,” and “selected worksheet” require an explicit selection.
- An explicitly named worksheet takes precedence over the UI default for questions that do not use those relative phrases.
- Clear workbook-wide requests use every worksheet, even with a current selection.
- Multi-sheet questions without a selected or unambiguously named worksheet ask for clarification. No first-sheet fallback is used for ambiguous multi-sheet requests.
- Generic questions about a single-sheet file remain unambiguous; relative phrases still require an explicit selection.
- AI cache keys include worksheet scope, and the prompt version changed to exclude older cached answers.

Changed implementation files: `frontend/src/App.jsx`, `frontend/src/styles.css`, `backend/server.js`, `backend/exact-spreadsheet.js`, `backend/storage/json-conversation-store.js`.

Changed regression/acceptance files: `backend/tests/worksheet-selection.test.js`, `backend/tests/exact-spreadsheet.test.js`, `backend/tests/api-optimization.test.js`, `backend/tests/run-tests.js`, `backend/validate-large-workbook.mjs`, `backend/validate-improvements.mjs`.

Validation:

- Backend full suite: 50 tests; focused exact-spreadsheet suite: 8 tests.
- Production frontend build with the documented HTTPS API origin.
- Real sample workbook: selected-sheet summaries for Sales, Employees, Inventory and Expenses through actual API calls. Browser checks confirm each selection, outgoing streaming payload, displayed summary, refresh restoration and clarification after clearing selection.
- Real Eveready workbook: all 11 worksheets tested with each relative worksheet phrase, worksheet references and row counts checked against an independent XLSX XML reader; existing numerical and report acceptance checks retained.
- API regression covers JSON and SSE, repeated selection changes, invalid names/types, explicit named overrides, workbook-wide summaries and workspace isolation. Provider mock regression verifies separate cached explanation contexts for different selected worksheets.

Tests use isolated local storage and disable Gemini, except mock-provider tests. No real MongoDB writes, deployment, push or live Gemini request was needed for this change. Existing MongoDB conversation persistence and ownership checks remain in place. Vite continues to report a JavaScript chunk above 500 kB.
