# TECHNOVALENS

AI-assisted spreadsheet and PDF analysis built with React, Vite, Node.js, Express, ExcelJS, and the Google Gemini API.

## Requirements

- Node.js 22 or later (verified on Node.js 24.21.0)
- MongoDB for accounts and server-side sessions
- A Gemini API key for Gemini-backed answers (local spreadsheet calculations work without provider calls)

## Configure the backend

```powershell
cd backend
npm install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run auth:configure
```

Set `MONGODB_URI` in `backend/.env` and start MongoDB. `auth:configure` appends a random signing secret to the ignored local `.env` without printing it or replacing an existing secret. Set `GEMINI_API_KEY` for provider-backed answers. The default application safety controls are a maximum of 15 provider requests per UTC day, one active provider request per backend process, and at least 15 seconds between requests. These are application-side controls and do not change Google project quotas.

Run the backend:

```powershell
npm run dev
```

## Run the frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173/technovalens/. The Vite development server forwards `/api` requests to `http://localhost:5000`, or the `VITE_API_URL` configured in `frontend/.env`.

## Analytics and Reports

The existing Dashboard layout and chart components are preserved. Upload XLSX or UTF-8 CSV through the existing upload control. Every worksheet is analyzed locally on upload. Analytics and Reports share a workbook, worksheet, search and exact category filter; these choices persist in browser storage. No Gemini requests are needed for these pages.

- Analytics includes real row/column/sheet counts, missing and duplicate values, numeric KPIs, category charts, monthly trends, column profiles and server-paginated sortable rows.
- Reports includes deterministic findings and downloads genuine PDF and XLSX files. PDFs render vector charts and paginate column-profile tables with repeated headings and page numbers. Excel exports contain Dataset Overview, Column Statistics, Findings, Chart Data and Selected Data worksheets. Both exports apply current filters.
- Dates are recognized as native Excel dates or ISO date text (`YYYY-MM-DD`). Ambiguous date text stays text. Numeric strings support standard thousands separators, currency prefixes, scientific notation and percentage suffixes. Percentages retain displayed percentage-point units. Mixed numeric/date columns use an 80% nonblank threshold; invalid values are counted and excluded from numeric calculations. Missing cells are blank/null/whitespace. Duplicates count occurrences beyond the first.
- Formulas use cached results only. Missing formula caches and Excel error cells become missing values; formulas are never recalculated. Fully empty physical Excel rows are excluded. Duplicate/blank headers receive unique names rather than overwriting columns.
- Each request is capped at 50 MB; workbooks at 32 worksheets, 100,000 rows, 256 columns and 2,000,000 cells. Expanded XLSX archives are capped at 128 MB. Parsing runs in a worker with a 256 MB heap limit and 30 second timeout. Larger files receive an actionable error. Preview pages contain at most 100 rows.

### Backend and local setup

Install dependencies with `npm install` in both `backend` and `frontend`. MongoDB is required for accounts and sessions. The default also stores conversations and document backups in MongoDB/GridFS. `CONVERSATION_STORAGE=file` may still select local document/conversation storage, but does not disable authentication or replace the MongoDB account/session store. Gemini is optional for Analytics, Reports and local chat calculations.

In a second terminal run `npm run dev` in `frontend`. Production verification: `npm run build` in `frontend`; tests: `npm test` in `backend`. Tests start their own temporary local MongoDB and mock Gemini service; your configured database and API key are not used. The first test run downloads an isolated MongoDB binary into ignored local test storage.

### Accounts, sessions and existing uploads

The frontend opens on a centered Welcome Back card with username/password login and a Sign Up link. Signup requires a unique username, a nonempty password and confirmation, then opens a private workspace. Accounts use MongoDB and Argon2id; cookies, CSRF, rate limits and ownership checks remain enforced. Settings > Account Security supports credential changes with current-password verification. Recovery links and pages are absent from the UI; the protected recovery APIs remain available internally. Existing accounts and documents are preserved. Optional first-admin provisioning remains available through `npm run admin:setup` in a private interactive terminal after reviewing the intended database; its permanent singleton lock is unchanged. See [authentication setup and verification](backend/authentication.md).

All document, upload/progress, chat, history, analytics and report endpoints require an authenticated account. The frontend Axios client and streaming fetch wrapper send credentials; session/CSRF secrets are never stored in localStorage or download URLs. Browser preferences are scoped by account ID. Logging out or changing accounts unmounts the old workspace.

Existing anonymous documents and conversations are preserved with their original ownership. They are not automatically assigned to new accounts, and presenting a legacy X-Workspace-Token does not grant access. There is no self-service claim or username-only reset path. Historical ownership changes require a separately reviewed administrator process; do not run the old workspace-assignment helper to claim account data.

#### HTTPS hosting configuration

Set NODE_ENV=production and provide a separate random SESSION_SECRET. Proxy trust defaults to one hop when Render sets RENDER=true, and zero elsewhere. AUTH_TRUST_PROXY_HOPS overrides that default: use the exact trusted hop count; an explicit zero on Render will reject TLS-terminated requests. The Render default allows Express req.secure to recognize the trusted proxy's X-Forwarded-Proto=https without disabling HTTPS checks. Production rejects insecure authentication requests. Cookies are Secure and HttpOnly, with SameSite=None for the existing cross-site frontend/backend origins; same-site deployments may use Lax. Production CORS permits the exact https://technovahub.in and https://www.technovahub.in origins with credentials and X-CSRF-Token. Add only exact additional trusted origins using AUTH_ALLOWED_ORIGINS (no /technovalens path).

The existing frontend API build URL and routes are unchanged. For the documented backend use VITE_API_URL=https://technovalens.onrender.com during the frontend build. Cross-site cookies can be blocked by browser privacy settings: host the API on the same site or behind a same-origin HTTPS reverse proxy if necessary; do not weaken cookie or CSRF protection. No deployment was performed by this implementation.

GET /api/health is public and advertises workspaceAuth: { version: 2, method: "session-cookie" }. GET /api/auth/session initializes a CSRF-protected browser session and returns the current public user or null. Unauthenticated protected requests return 401 with code AUTH_REQUIRED. Another account's documents return 404. See the authentication guide for the remaining account routes and recovery behavior.

### Analytics and report APIs

All routes require an authenticated HttpOnly session cookie. Mutating requests also require `X-CSRF-Token`. Missing sessions return 401; another account's file returns 404. JSON errors use `{ "error": "message" }`.

| Endpoint | Response |
| --- | --- |
| `GET /api/analytics/:id` | Workbook metadata, generation date, sheet counts, inferred types, KPIs, numeric/quality statistics, charts, findings, warnings |
| `GET /api/analytics/:id/preview` | `{ columns, rows, page, pageSize, total, totalPages }` |
| `GET /api/reports/:id.pdf` | Paginated PDF report |
| `GET /api/reports/:id.xlsx` | Excel report with six dashboard/summary/data worksheets |

All accept optional `sheet`, `search`, `categoryColumn` and `categoryValue`. Preview also accepts `sort`, `direction=asc|desc`, `page` and `pageSize` (1–100). Invalid sheet names return 400. Existing `/api/files`, `/api/files/upload`, `/api/excel/upload`, preview and conversation endpoints remain available under the same workspace protection.

Implementation: `frontend/src/AnalyticsReports.jsx`, `frontend/src/workspace.js` and scoped additions in `styles.css`; integration in `App.jsx` and the local proxy default in `vite.config.js`. Backend changes are in `analytics.js`, `spreadsheet-parser.js`, `reports.js`, `server.js`, the optional `storage/file-conversation-store.js`, and `migrate-workspace.js`. Coverage lives in `backend/tests/analytics-reports.test.js`; the API suite uses isolated authenticated accounts.

Run `node tests/run-tests.js --auth-ui` from `backend` for the isolated authenticated Edge browser smoke test, including centered desktop/mobile login and signup, Account Security, username/password changes, upload, refresh/session persistence, logout and restored document access. See the authentication guide for requirements. The older optional `tests/browser-smoke.mjs` predates account authentication.

### Local upload diagnostics

For ownership-checked backups, snapshot reconciliation and recoverable local cache management, read [storage management](backend/storage-management.md). `npm run audit:storage` in `backend` is read-only by default. Do not use the older broad workspace-assignment helper on mixed-owner historical data. Cache expiration remains disabled until deletion is explicitly approved.

`node --watch` enables Node dependency-reporting messages on worker threads. Spreadsheet parsing uses a typed result message and ignores those notifications; the first worker message is not necessarily a parsed workbook. This prevents a valid workbook from being incorrectly rejected as having no worksheets during `npm run dev`.

Parser logs contain stages, archive byte size, normalization counts, worksheet row/column counts and error codes, without cell values, raw XML, filenames or workspace tokens. Standard Microsoft Excel OOXML bypasses normalization unchanged; only affected prefixed parts are rewritten. Upload/list/detail responses include additive `worksheets: [{ name, rowCount, columnCount }]` metadata, while existing first-sheet `rowCount` and `columnCount` fields keep their meanings.

To inspect a workbook and perform an authenticated multipart upload through the local Vite proxy, run from `backend`:

```powershell
node diagnose-spreadsheet.mjs 'C:/Users/Admin/Downloads/TECHNOVALENS_Sample_Business_Data.xlsx' http://localhost:5173
```

HTTP diagnostics now require a dedicated existing account through `TECHNOVALENS_DIAGNOSTIC_USERNAME` and `TECHNOVALENS_DIAGNOSTIC_PASSWORD` in private terminal environment variables. Credentials are never printed; only files created by the diagnostic are cleaned up. The command compares raw ExcelJS loading, compatibility preparation, direct parsing and worker parsing. It reports upload status, worksheet counts, Analytics for every sheet and both report downloads. It logs in with a separate diagnostic session, never prints credentials and removes its test upload afterward. Both backend (`npm run dev`, port 5000) and frontend (`npm run dev`, port 5173) must be running. The development proxy defaults to `http://localhost:5000`; a frontend `.env` setting can override it.

## AI usage controls

### Large production workbooks

XLSX uploads now read ZIP entries and worksheet XML incrementally. The parser reads values and cached formula results without constructing ExcelJS workbook/cell/style objects. Shared strings use a temporary disk index with a bounded cache; number formats needed for dates are retained, and decorative styles/media are skipped. Namespace-aware XML parsing supports prefixed OOXML directly, without rebuilding worksheet XML. Fully formatted empty rows/cells do not become data. Headers are detected among the first 25 populated rows, with title rows excluded and date/subheader combinations retained; each worksheet records its selected `headerRow` for review. Automatic header detection is heuristic, so review the selected headers for unfamiliar layouts.

New uploads use `storageVersion: 2` metadata and a sibling `<fileId>.sheets` directory of normalized NDJSON files. Parsing and analysis process one worksheet at a time and cache exact unfiltered summaries. Only metadata, summaries and ten preview rows per sheet cross the worker boundary. Filtering, paginated previews and exports run in bounded workers using normalized data, without reparsing the XLSX. XLSX exports commit rows to the output ZIP incrementally. Temporary exports are removed after download. Original JSON uploads remain readable; back up both metadata files and their sibling sheet directories for new uploads.

The original **256 MiB old-generation worker heap**, **30-second timeout**, **50 MiB upload limit**, **128 MiB expanded ZIP limit**, **32 sheets**, **100,000 data rows**, **256 populated columns** and **2,000,000 cells** remain enforced. `SPREADSHEET_WORKER_HEAP_MB` is clamped to 128–512 MiB (default 256), `SPREADSHEET_WORKERS` to 1–2 (default 1), and `SPREADSHEET_TIMEOUT_MS` to 1,000–120,000 ms (default 30,000). The same worker admission limit covers parsing and worksheet queries; at most eight lightweight worksheet queries may wait. Excess uploads receive 429. Timeouts, browser cancellation and disconnects terminate workers and clean up incomplete uploads. A worker heap cap is not a cap on total process RSS: buffers, native ZIP memory and the Express process also consume memory.

The existing upload UI polls private `/api/files/upload-status/:job` status for worksheet discovery, processing and analysis, and offers cancellation. Job identifiers are not credentials; an authenticated session cookie is required for every status request. Completed jobs include parser elapsed time and sampled peak heap/RSS measurements. Logs contain counts/stages rather than cell contents or tokens.

Local validation (no deployment):

```powershell
cd backend
node benchmark-parser.mjs 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx' --disk
node validate-large-workbook.mjs 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx' http://localhost:5173
```

The real-workbook validator compares worksheet row counts and numeric sums against an independent XML reader, checks filters/pagination and exports the largest worksheet, then repeats authenticated uploads three times. It removes its private diagnostic uploads afterward. Use `diagnose-spreadsheet.mjs` for small workbooks only: its raw ExcelJS comparison intentionally exercises the old full-document loading path.

- Deterministic spreadsheet operations (totals, averages, extrema, row/column counts, missing and duplicate values, category totals, basic trends, and IQR outlier flags) are calculated locally.
- Gemini receives compact column statistics and up to 30 relevant rows per selected sheet instead of the full workbook. Broad recommendations requests return one structured analysis response.
- Gemini answers are cached by normalized workbook hash, sheet, normalized question, model, and prompt version. Cache entries and usage counters survive restarts in `backend/.data/`.
- Identical simultaneous questions share one in-flight analysis. Provider calls are queued and paced; transient errors receive bounded retries.
- `/api/usage` reports daily budget consumption, cache activity, provider outcomes, token usage, pacing, and model without exposing document contents or credentials.
- The chat identifies whether an answer was calculated locally, generated by Gemini, or served from cache.
- PDF summaries automatically try `FALLBACK_GEMINI_MODEL` only after the primary returns 503 through its bounded retries. Failed answers retain the PDF and can be retried from chat without uploading again.
- Verify configured models against the current API key and actual text generation with `npm run verify:models`. A model appearing in `models.list` alone does not establish that generation is enabled for the project.
- The dashboard does not issue automatic Gemini requests when opened or when its display controls change.

## Configuration

See `backend/.env.example` for the supported settings. In particular:

- `GEMINI_DAILY_BUDGET` (default `15`)
- `PRIMARY_GEMINI_MODEL` (defaults to legacy `GEMINI_MODEL`, then `gemini-flash-latest`)
- `FALLBACK_GEMINI_MODEL` (optional; set only to a model verified for the configured key)
- `GEMINI_USAGE_TIME_ZONE` (default `UTC`)
- `GEMINI_MIN_INTERVAL_MS` (default `15000`)
- `GEMINI_QUEUE_TIMEOUT_MS` (default `180000`)
- `ANALYSIS_CACHE_TTL_MS` (default `86400000`)
- `DOCUMENT_STORE_DIR` (optional shared filesystem location)
- `GEMINI_API_BASE_URL` (optional API-compatible proxy/testing endpoint)

Never put `GEMINI_API_KEY` in a frontend environment variable or commit `.env`.

## Test

```powershell
cd backend
npm test
node --check server.js
npm run verify:models
```

The integration suite uses a local Gemini-compatible mock and does not make paid or quota-consuming Google API calls. `npm run verify:models` makes a small real text-generation request for each configured model and consumes applicable project quota.
