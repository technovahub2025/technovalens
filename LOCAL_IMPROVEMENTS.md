# Local improvements and validation

Work is local only. No push, deployment, production database access or credential changes were performed. Existing uncommitted changes were preserved and reviewed.

## Changed files

- `frontend/src/App.jsx` and `conversation-client.js`: restore the selected conversation by its ID and authoritative file mapping, reject inconsistent responses, prevent stale requests replacing newer selections, preserve saved messages when their file is unavailable, restore selection on refresh, consolidate navigation under Reports, and redirect legacy Analytics hashes.
- `frontend/src/AnalyticsReports.jsx`: Reports contains worksheet/workbook selection, dynamic metrics, charts, filtering, search, paginated data, and PDF/XLSX downloads.
- `frontend/src/styles.css`: Inter with system fallbacks, readable global text sizes and line heights, clearer labels, responsive controls, focus indicators, and a mobile conversation selector. Dashboard composition is retained.
- `backend/server.js`: validate conversation ownership and file mapping, preserve orphaned history, use deterministic full-worksheet calculations, restore durable document caches, and strengthen grounded Gemini instructions.
- `backend/storage/json-conversation-store.js`, `file-conversation-store.js`, and `mongo-document-store.js`: store ownership, preserve historical IDs, persist conversations, and back up normalized worksheet data and document manifests in MongoDB GridFS. Failed document writes roll back.
- `backend/exact-spreadsheet.js`: deterministic counts, sums, averages, extrema, distinct counts, missing/duplicate counts, grouping, explicit filters, comparisons between named worksheets, and monthly aggregates. Includes worksheet/column/row references and cached-formula caveats. Ambiguities produce clarification requests. Case-distinct columns can be selected with `total column "Qty" in worksheet LATHE`.
- `backend/analytics.js`, `local-document.js`, `spreadsheet-parser.js`, and `xlsx-stream.js`: preserve complete-data statistics, physical spreadsheet row mappings, worker-based large worksheet queries, and verified PDF page markers.
- Regression coverage: `backend/tests/conversation-client.test.js`, `conversation-persistence.test.js`, `exact-spreadsheet.test.js`, `api-optimization.test.js`, `browser-smoke.mjs`, and `run-tests.js`.
- Acceptance utilities: `backend/validate-improvements.mjs` and `validate-large-workbook.mjs`.

## Validation

- `npm test` in backend: 48 passed, zero failures. Includes conversation switching, refresh/restart persistence, file mismatch rejection, missing conversations/files, workspace isolation, GridFS cache restoration/rollback with an in-memory storage double, parsing, progress, cancellation, and AI provider mock behavior.
- `npm run build` in frontend: passes. Vite reports the existing JavaScript bundle exceeding 500 kB; code splitting remains a possible optimization.
- Real workbook HTTP acceptance: sample business workbook and `EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx` passed three uploads each, worksheet counts, independent XML row counts and numeric totals/averages, filtered previews, report exports, and workspace isolation. Eveready cancellation leaves no partial file listed.
- Eveready examples independently verified: PURLIN Qty 1,955; CNC No. 2,473; SETTING No. 14,429; LATHE Qty 6,390. These are raw stored-column sums including duplicates and any workbook subtotal rows, not inferred business totals.
- Browser acceptance covers saved conversation switching/refresh, exact answer display, Reports PDF/XLSX downloads, all primary navigation, legacy Analytics redirect, and responsive layouts at 1440/768/390 pixels.
- Generated validation logs were removed during cleanup. Results are summarized above; the retained tests and acceptance scripts reproduce them.

## Storage and remaining limits

- Default durable mode requires the existing `MONGODB_URI`, permissions to create indexes and write conversation/document collections and GridFS buckets, sufficient database capacity, and backups. No production migration or real MongoDB integration run was performed. Existing local documents are copied into durable storage on startup; ready GridFS documents reconstruct an empty local cache on subsequent deployments.
- `CONVERSATION_STORAGE=file` is intended for isolated tests or standalone local use. It survives restarts on the same disk; deployment durability requires a persistent mounted directory. It is not a shared multi-instance conversation store.
- Data already lost from both the original storage and backups cannot be reconstructed. The UI preserves surviving messages and provides recovery guidance without fabricating history. Clearing the browser's workspace identity removes access until the original identity is restored.
- Formula values use workbook caches; formulas are not recalculated. Missing formula results remain missing. Mixed currencies, unclear metrics, unsupported compound calculations and ambiguous sheet/column selections require clarification. Business definitions such as deduplication and whether subtotal rows should be excluded must be explicit.
- Exact numerical PDF table calculations require a reliable structured source; the app requests the XLSX/CSV source instead of calculating from uncertain prose. Gemini interpretation is tested using provider mocks; no paid/live Gemini call was made. Prompt grounding does not constitute a formal guarantee of model correctness.
- GridFS restoration currently happens at backend startup. A simultaneously running instance does not automatically discover uploads first created on another instance; that would require on-demand shared-store hydration or change-stream synchronization.
- Inter uses Google Fonts when available and falls back to system fonts offline. Workbook acceptance paths are local parameters; source workbooks and credentials are not bundled into the app.
