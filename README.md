# TECHNOVALENS

AI-assisted spreadsheet and PDF analysis built with React, Vite, Node.js, Express, ExcelJS, and the Google Gemini API.

## Requirements

- Node.js 20 or later
- A Gemini API key for Gemini-backed answers (local spreadsheet calculations work without provider calls)

## Configure the backend

```powershell
cd backend
npm install
Copy-Item .env.example .env
```

Set `GEMINI_API_KEY` in `backend/.env`. The default application safety controls are a maximum of 15 provider requests per UTC day, one active provider request per backend process, and at least 15 seconds between requests. These are application-side controls and do not change Google project quotas.

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

Install dependencies with `npm install` in both `backend` and `frontend`. The existing MongoDB conversation store remains the default: set `MONGODB_URI` and start MongoDB before `npm run dev` in `backend`. For standalone development without MongoDB, set `CONVERSATION_STORAGE=file` in `backend/.env`. This uses the same file and conversation APIs with persistent local JSON conversations. Gemini is optional for Analytics, Reports and local chat calculations.

In a second terminal run `npm run dev` in `frontend`. Production verification: `npm run build` in `frontend`; tests: `npm test` in `backend`. Integration tests use isolated temporary storage and a mock Gemini service, without a real API key or MongoDB.

### Private workspaces and existing uploads

This application has no account login. File access is isolated by a random private browser workspace token, sent as `X-Workspace-Token`; the backend stores only its SHA-256 hash. File lists, previews, analytics, reports, chat and conversation access all check ownership. Keep the token private. Clearing browser storage loses access to that browser's uploads; this is browser workspace isolation, not account authentication or cross-device sign-in.

Older uploads have no recorded owner, so the server cannot safely show them to every browser. Their stored data is preserved. Re-upload them, or have the server administrator assign legacy uploads from a **single known owner**:

1. Open the app in that owner's browser. In its developer console, read `localStorage.getItem('technovalens.workspaceToken')`.
2. Stop the backend. In the backend PowerShell terminal set `$env:WORKSPACE_TOKEN = '<that private token>'` and run `npm run migrate:workspace`.
3. Remove the temporary variable with `Remove-Item Env:WORKSPACE_TOKEN`, restart the backend, and refresh the app. Existing file IDs and linked conversations are retained.

The migration only assigns currently unowned files. Do not use the bulk migration on legacy storage belonging to multiple people; first separate records by verified ownership. Already owned files are never reassigned.

### Analytics and report APIs

All routes require `X-Workspace-Token: <64 lowercase hexadecimal characters>`. Missing tokens return 401; another workspace's file returns 404. JSON errors use `{ "error": "message" }`.

| Endpoint | Response |
| --- | --- |
| `GET /api/analytics/:id` | Workbook metadata, generation date, sheet counts, inferred types, KPIs, numeric/quality statistics, charts, findings, warnings |
| `GET /api/analytics/:id/preview` | `{ columns, rows, page, pageSize, total, totalPages }` |
| `GET /api/reports/:id.pdf` | Paginated PDF report |
| `GET /api/reports/:id.xlsx` | Excel report with five summary/data worksheets |

All accept optional `sheet`, `search`, `categoryColumn` and `categoryValue`. Preview also accepts `sort`, `direction=asc|desc`, `page` and `pageSize` (1–100). Invalid sheet names return 400. Existing `/api/files`, `/api/files/upload`, `/api/excel/upload`, preview and conversation endpoints remain available under the same workspace protection.

Implementation: `frontend/src/AnalyticsReports.jsx`, `frontend/src/workspace.js` and scoped additions in `styles.css`; integration in `App.jsx` and the local proxy default in `vite.config.js`. Backend changes are in `analytics.js`, `spreadsheet-parser.js`, `reports.js`, `server.js`, the optional `storage/file-conversation-store.js`, and `migrate-workspace.js`. Coverage lives in `backend/tests/analytics-reports.test.js`; the existing API suite now sends workspace credentials.

An optional `backend/tests/browser-smoke.mjs` checks upload, Recharts, filtering, report PDF downloads, selection persistence and mobile overflow. With Playwright installed locally (or `PLAYWRIGHT_MODULE` pointing to an existing installation), run `node backend/tests/browser-smoke.mjs` from the project root. It requires port 5173 to be free, starts isolated servers, and deletes its temporary data afterward.

## AI usage controls

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
