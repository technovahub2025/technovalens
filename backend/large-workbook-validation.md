# Local large-workbook validation — 13 November 2026

Validated on Windows with Node.js 24.21.0 through the running Vite proxy at `http://localhost:5173/api` and Express at `http://localhost:5000`. No deployment was performed.

## Input and root cause

`EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx`: 4,754,390 compressed bytes, 11 worksheets, 981,462 worksheet XML cell elements. The previous parser inflated XML for compatibility inspection, loaded the whole ExcelJS document (including styled empty cells), then built normalized rows and copied them across a worker boundary. Its 256 MiB worker failed during document loading before it could return data.

The replacement parses ZIP entries with a namespace-aware incremental XML reader, indexes shared strings on disk, ignores decorative formatting and writes normalized worksheet rows to NDJSON. Analysis and queries load one worksheet at a time in a bounded worker. The server retains metadata and cached summaries; XLSX export rows are committed incrementally. Existing JSON uploads remain compatible.

## Measured resources

These are measured local runs, not universal capacity guarantees. Heap values are sampled worker heap usage; RSS includes the entire server/benchmark process, all threads, native memory and buffers. V8's old-generation heap limit is not a total-RSS limit.

| Measurement | Previous document parser | New pipeline |
| --- | --- | --- |
| Default worker old-generation cap | 256 MiB | 256 MiB |
| Default concurrent workers | 2 | 1 shared parsing/query worker |
| Default timeout | 30 seconds | 30 seconds |
| Standalone baseline outcome | OOM after 6,955 ms | Successful parsing and analysis |
| Baseline peak process RSS | 411.7 MiB | — |
| Last sampled baseline worker heap | 221.8 MiB before termination | — |
| Three final real HTTP upload times | Failed | 5,681 / 5,715 / 5,689 ms |
| Worker parse + analysis times | Failed | 5,097 / 5,173 / 5,143 ms |
| Sampled worker peak heap | Failed | 51.1 / 42.6 / 46.1 MiB |
| Peak server RSS across uploads, filters and exports | Could not complete | 225.7 MiB |
| Parent heap after repeated uploads | — | 24.5 / 24.0 / 24.1 MiB |

The successful full-flow RSS peak is approximately 45% below the old failed parse peak. The new path does not require a larger heap. Configurable limits remain clamped; all existing file/dataset safety limits remain enforced. Excess simultaneous uploads receive a clear 429 response before multipart buffering begins, and at most eight lightweight worksheet queries may wait.

## Accuracy checks

Row counts and representative numeric totals were compared with an independent XML reader that does not call the production parser. Header discovery and meaningful row counts were inspected against the original XML. Data rows exclude the selected header and preceding title rows; styled empty rows are excluded. Formula-only rows without caches remain missing-value records. Cached formula values are used without recalculation.

| Worksheet | Header row | Data rows | Columns | Independently checked numeric total |
| --- | ---: | ---: | ---: | --- |
| PURLIN | 3 | 123 | 49 | Qty: 1,955 |
| CNC | 3 | 2,550 | 52 | No.: 2,473 |
| PTW & HAND SETTING | 8 | 1,272 | 76 | No.: 1,008 |
| DRILLING & PUNCHING | 3 | 1,248 | 74 | No.: 1,008 |
| STIFFENER (source name retains its trailing space) | 2 | 2,258 | 74 | No.: 12,306 |
| SETTING | 2 | 3,810 | 80 | No.: 14,429 |
| WELDING | 4 | 348 | 89 | Qty: 997 |
| LATHE | 3 | 221 | 56 | Qty: 6,390 |
| CLEANING | 4 | 553 | 33 | Qty: 5,026 |
| PAINTING | 4 | 552 | 37 | Qty: 5,026 |
| DISPACHED | 3 | 675 | 72 | Qty: 6,981 |

Total: **13,610 data rows**. The second header line in PTW includes repeated sublabels; the parser selects row 8 as the main header and combines date headings with those sublabels while retaining row 9's real record fields. Header discovery is heuristic: unfamiliar layouts should be reviewed using `headerRow`, column names and preview data.

Verified through authenticated HTTP:

- All eleven worksheets, cached summaries, worksheet switching, search/category filters and seven-row server pagination.
- Pie-chart counts reconcile with matching records when a category chart is available.
- Largest worksheet SETTING exports valid PDF and XLSX; the Excel Selected Data sheet has 3,811 rows including its header. Exports are removed after streaming.
- Three sequential uploads remain accessible under one private diagnostic workspace, then are removed.
- Private progress reports discovery, processing and analysis. Another workspace cannot read or cancel a job.
- Explicit server-side cancellation during processing terminates the worker, removes partial data and does not list an incomplete upload. A browser connection abort alone is insufficient through some reverse proxies, so cancellation has an authenticated DELETE endpoint.
- The four-sheet sample remains 180 / 55 / 36 / 90 data rows (361 total), with Analytics and both exports working.

## Reproduce locally

Start backend and frontend with their existing `npm run dev` commands. From `backend`:

```powershell
node benchmark-parser.mjs 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx' --legacy
node benchmark-parser.mjs 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx' --disk
node validate-large-workbook.mjs 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx' http://localhost:5173
```

Run workbook validators sequentially: they share the intentionally bounded local worker pool. Do not run the legacy full-document diagnostic outside its protected benchmark worker on large files. The validators use fresh private workspace identities, never print tokens, and remove their own diagnostic uploads.

New persisted workbooks require both `<fileId>.json` metadata and `<fileId>.sheets/` data when backing up or moving local storage. No migration of existing uploads is required.

## Regression checks and changed files

The full backend suite passed all 33 tests. Additional real HTTP regressions verify admission control before multipart buffering, cancellation ownership and removal of partially written data. The frontend production build passed; Vite reported its existing large-chunk warning. Stylesheets were unchanged, and the generated CSS retained its prior asset hash.

Main changes:

- `xlsx-stream.js`, `spreadsheet-parser.js`: incremental XML/CSV parsing, disk shared strings, one-sheet analysis, bounded shared worker admission/queueing, typed watch-compatible messages, metrics and lifecycle cleanup.
- `sheet-storage.js`, `server.js`: persisted manifests, lazy compatibility access, cached summaries, worker-backed filtering/previews/exports, authenticated progress/cancellation and pre-buffer upload admission.
- `analytics.js`, `reports.js`: fewer full-data copies, incremental hashing, reuse of inferred types/categories and streamed Excel export.
- `frontend/src/App.jsx`: worksheet progress polling and explicit authenticated cancellation; Dashboard and Analytics/Reports styling retained.
- `backend/.env.example`, `package.json`, `package-lock.json`: bounded worker configuration and direct declaration of the existing unzipper dependency.
- `tests/streaming-parser.test.js`, `tests/workspace-api.test.js`, `tests/run-tests.js`: formatted blanks, headers, dates, formula caches, disk reload, worker limits, timeout/cancellation, HTTP admission and isolation coverage.
- `benchmark-parser.mjs`, `validate-large-workbook.mjs`, `diagnose-spreadsheet.mjs`, this report and `README.md`: reproducible local measurement and validation.
