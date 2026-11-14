# Dashboard data and activity

`GET /api/dashboard?days=7&timeZone=America/New_York` requires the authenticated session cookie. The request cannot select another account. Supported activity ranges are 7, 30 and 90 calendar days, inclusive of today. The browser supplies its IANA timezone. Missing timezone defaults to UTC for API clients; invalid ranges/timezones return 400. Storage failures return 503, never demo values.

The dashboard uses verified document metadata from the existing local/MongoDB/GridFS storage architecture. No worksheet rows are loaded to calculate its totals.

| Value | Meaning |
| --- | --- |
| Uploaded files | Number of current documents owned by the account, including spreadsheets and PDFs. |
| Total records | Sum of data-row counts across every worksheet of every current spreadsheet. The first worksheet is not counted twice. PDF pages are excluded. Separate uploaded copies are separate files. |
| Data columns | Sum of column counts across every worksheet of every current spreadsheet. Identically named columns in different worksheets each contribute to their worksheet's count. PDFs contribute zero. |
| AI questions | All-time count of distinct submitted user questions, including saved historical user messages and accepted direct AI requests. Assistant replies are excluded. |
| Recent files | The five latest current uploads, sorted by their stored upload timestamps, independent of the selected conversation/file. |
| Workspace activity | Daily counts of successful uploads plus submitted questions in the selected date range. These are event counts, not a percentage or generated engagement score. |

The date-range filter applies to the activity chart. The cards show all current files/worksheets and all-time submitted questions. Events store UTC timestamps. Grouping uses calendar dates in the browser's timezone, including 23-hour and 25-hour DST days. The chart uses zero only for verified days with no events. A successful response with no events displays **No activity yet**. Loading, storage errors and an empty workspace each have distinct UI states; errors show unavailable values and a retry action.

New activity is stored in MongoDB's `workspace_activity`, scoped by the server-derived owner hash. Event IDs include the owner and stable upload/question identity; atomic upserts prevent duplicate log records. No question text, document contents or credentials are stored in the activity collection. Events survive logout, refresh and backend restarts. Deleting a file removes it from current file/record/column totals; recorded activity remains historical.

The browser assigns a UUID to each submitted user message. Both conversation stores return the same message on an identical retried submission, reject reuse for different text, and preserve that ID for AI retries. Streaming and JSON fallback requests share it. Activity from saved history and the AI endpoint uses the same conversation/message key, so a single question is not counted twice. API clients sending questions without conversation history may supply `questionId` for request idempotency. Distinct requests without an ID are counted as distinct submissions because the server cannot reliably identify a retry from question text alone.

Existing documents contribute their actual upload timestamps. Existing user messages contribute their saved timestamps and stable IDs without rewriting historical data or running a migration. There is no reliable source for files/conversations deleted before activity logging was added; their missing events are not fabricated. Read-only storage mode does not write new activity.

Dashboard refreshes on entry, successful uploads, saved questions, file changes, window focus and local date/timezone changes. Fetches are canceled when superseded or the account workspace unmounts. The greeting uses browser-local hours: morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–04:59. Its timer updates at minute boundaries and on focus/visibility changes, independently of server timezone.

All six password fields use the shared visibility component. Eye buttons have descriptive Show/Hide labels, pressed state, keyboard support and input associations. Values remain in React memory, hidden by default, and visibility resets when login/signup forms switch or unmount. Hashing, cookies, CSRF, recovery APIs and the existing nonempty-password policy are unchanged.

Run `npm test` in `backend` for all tests, or `node tests/run-tests.js --dashboard-only` for focused dashboard checks. `node tests/run-tests.js --auth-ui` exercises a disposable Edge browser, isolated MongoDB and local servers: empty accounts, actual upload/question activity, refresh/login persistence, six keyboard password toggles, clock boundaries, date-range selection, API loading/failure/retry and a second account's empty private dashboard. The HTTP dashboard test additionally uploads a real two-sheet XLSX and PDF and restarts the server. No production resource is used.

## Changed files

| Files | Change |
| --- | --- |
| `frontend/src/App.jsx` | Real dashboard cards, recent uploads, date-range selection, activity/error/empty states, greeting integration, request IDs and refresh triggers. |
| `frontend/src/dashboard.js`, `frontend/src/useDashboard.jsx` | Dashboard response validation, browser timezone, local greeting, timers, request cancellation and refresh lifecycle. |
| `frontend/src/AuthApp.jsx`, `frontend/src/PasswordInput.jsx`, `frontend/src/auth.css` | Shared accessible show/hide buttons on all six password fields, preserving values and existing form styling. |
| `backend/server.js`, `backend/dashboard.js` | Authenticated summary endpoint, verified worksheet totals, calendar grouping and persistent owner-scoped event logging. |
| `backend/conversation-message.js`, `backend/storage/file-conversation-store.js`, `backend/storage/json-conversation-store.js` | Idempotent user messages, saved retry IDs and owner-scoped historical activity projections. |
| `backend/tests/dashboard.test.js`, `backend/tests/run-tests.js`, `backend/tests/test-suite.js` | Unit and real HTTP/MongoDB regression coverage and focused dashboard test entry point. |
| `backend/auth-ui-smoke.mjs` | Browser checks for toggles, greeting boundaries, real dashboard states, errors, activity, persistence and account isolation. |
| `README.md`, `backend/dashboard.md` | Dashboard semantics, setup-neutral implementation notes, validation and historical-data limitations. |
