# Safe local cleanup — 13 November 2026

No commit, push, deployment, production-resource changes or live integration probes were performed. Existing Git modifications and staged removals were preserved.

## Inspection and classification

Inspected the project file inventory excluding Git internals, installed dependencies, generated build output and protected runtime contents; reviewed npm entry points, source imports, dynamic imports, worker paths, script invocations, documentation references, ignore rules and Git status. The source reference audit checked 76 local references with no unresolved paths. No identical non-artifact source files were found.

### KEEP

- All frontend source/components, backend source, streaming parser, compatibility helpers, exact calculation engine, Reports, MongoDB/GridFS and conversation storage.
- All tests and fixtures, including optional browser tests and real integration checks.
- Every `.env`, `.env.example`, local upload, `.data` directory and storage directory. The two actual environment files were hash-checked before/after deletion and were unchanged; hashes and values were not printed.
- Package manifests and backend/frontend lockfiles; installed dependencies; current frontend build output.
- Validation scripts, which have distinct purposes: `benchmark-parser.mjs` measures performance; `diagnose-spreadsheet.mjs` diagnoses small-workbook structure/compatibility; `validate-large-workbook.mjs` checks real HTTP behavior against an independent XML oracle; `validate-improvements.mjs` orchestrates local API/browser acceptance; `verify-local-integration.mjs` tests disposable MongoDB/GridFS and optional Gemini; `verify-models.js` checks model availability. No script was proven redundant.
- Validation results remain in the written reports. The six generated logs initially retained as evidence were removed in the follow-up cleanup; no test reads these logs as input, and their generating scripts remain.
- README, implementation reports, `backend/large-workbook-validation.md`, and `backend/production-parser-diagnostics.md`.

### SAFE TO DELETE — removed

| File | Evidence |
| --- | --- |
| `backend/validation-reports-1440.png` | Browser-generated screenshot; script writes it, no test/docs consume it. |
| `backend/validation-reports-390.png` | Same output-only browser screenshot purpose. |
| `backend/validation-reports-768.png` | Same output-only browser screenshot purpose. |
| `backend/validation-worksheet-browser.log` | Unreferenced redirected output from an earlier browser run. |
| `backend/validation-live-integration.json` | Generated summary written by the integration runner; no consumer or documentation depends on the existing file. |

Initial cleanup: five files, 1,057,265 bytes. Follow-up cleanup also removed `backend/test-results.log`, `backend/validation-acceptance.log`, `backend/validation-sample.log`, `backend/validation-eveready.log`, `backend/validation-mongo-browser.log`, `backend/validation-browser-final.log`, and the empty root `package-lock.json`. Documentation references to the retired logs were updated. The root lockfile had no package entries, no accompanying root package manifest and no referencing executable script; backend/frontend lockfiles remain.

Deletion used exact resolved paths within this workspace; no recursive directory deletion was used. The generating scripts are retained and can recreate test outputs.

### NEEDS REVIEW — retained

- 7,830 dependency files are already tracked in Git despite `node_modules` ignore rules. No dependency files were deleted or untracked by this cleanup. A separate reviewed repository-index cleanup can address this.
- Historical written validation reports contain dated test counts and remain as records. Their raw generated logs were explicitly retired in the follow-up cleanup.

## Ignore rules and protected files

`.gitignore` already excludes `.env`, `.env.*`, `node_modules`, `dist`, and `backend/.data`, while preserving `.env.example`. Broadened backend log exclusions to `backend/*.log` and generated JSON exclusions to `backend/validation-*.json`; existing `backend/validation-*.png` remains. Production assets and regression fixtures are not covered by those artifact patterns.

Both actual `.env` files are ignored and absent from Git's index. Only their example files are indexed. Earlier staged removals of `backend/.env` and runtime data are index-only changes from prior work: their on-disk copies remain, and this cleanup did not restore them to Git. Ignore rules do not retroactively untrack the existing indexed dependency files or remove older secrets from Git history.

## Vite proxy investigation

- Configured backend port: 5000. The local frontend target is loopback port 5000; ports match.
- Direct TCP connections succeeded over `localhost`, `127.0.0.1` and `::1`.
- `http://localhost:5000/api/health`: 200, healthy, expected workspace-auth contract.
- `http://localhost:5173/api/health`: 200 through the existing Vite proxy, same health contract.
- `ECONNREFUSED` was not reproducible. It means the target refused the connection at that time, typically because the backend was stopped, restarting or not yet listening. Current checks establish reachability now, not the exact cause of older errors. No server was started, stopped or reconfigured for this investigation.

## Post-cleanup verification

- Frontend production build: PASS using the documented public HTTPS API origin passed only to the build process; environment files were not changed. Existing warning: a JavaScript chunk exceeds 500 kB.
- Backend regression suite: PASS, 50 tests, zero failures after the initial cleanup. The generated test log was subsequently removed; application code was unchanged in the follow-up cleanup.
- `git diff --check`: PASS.

No application source code was changed for this cleanup. Remaining release concerns from prior verification, including historical credential exposure and the Gemini authentication failure, were not re-tested or modified here.

## Storage-aware follow-up cleanup

The follow-up audit examined all 20 local uploaded-document manifests and their 33 normalized worksheet data files (53 files total). MongoDB was accessed with raw read-only queries and GridFS download/restore operations; no store initialization, index creation, upload, ownership migration, record deletion or production write was performed.

### Deleted in this follow-up

- `backend/.data/analysis-cache.json`: 1,410 bytes containing exactly two expired AI analysis-cache entries. Expiry was checked immediately before removal. This file is a derived response cache, not conversation storage; it can be regenerated. The `.data` directory itself remains.
- No additional validation logs, screenshots or abandoned upload temporary files existed after the preceding cleanup. Regression-test output for this run was redirected to an OS temporary file and removed afterward, leaving no new test log in the project.

### Verified backups retained as required runtime files

16 local documents have ready MongoDB manifests with matching ownership. Downloaded GridFS manifests and all their normalized worksheet blobs matched local bytes exactly. A second check used the actual `MongoDocumentStore.restore()` method, without `initialize()`, to restore these 16 documents into a newly created OS temporary directory. All 49 restored files matched the current local files, and all 37 restored worksheets loaded correctly. Only the temporary restore directory was removed afterward.

These 49 files are regenerable **at backend startup**, but are not unnecessary while the application is running. `sheet-storage.js` opens normalized worksheet files directly, and AI requests reload the local document manifest. `getDocument()` does not retrieve a missing local manifest from GridFS on demand. Deleting these files would break current file/AI/Reports requests until restoration; starting or restarting the normal MongoDB backend also performs initialization/migration writes, so that was not used as a cleanup workaround. All 49 runtime files remain intact. No application behavior was changed to enable cache eviction.

The verified backed document manifests retained under `backend/.data/uploads/` are:

```text
1c811ee9-1c1e-4e7c-b587-f008fad96b0c.json
205c2c62-ffd5-4b5e-bf7a-bd293ba7e6fd.json
34cfbac9-ff3c-4479-84cb-49f85e4770a8.json
46f04217-b5ce-4e1c-bf83-ea29757b56c4.json
532d20b3-e940-450a-9459-0599e033c732.json
57e1dd76-332e-41cc-a620-dede5fad9412.json
6c7294e0-77dd-47f3-bf7c-da6bef65787f.json
878ef8ab-50e0-47d4-995c-1cdac5440656.json
8e29d497-a6f2-4581-bf86-4da86ade65f1.json
a6da1c0c-cb28-4599-b044-81b929a5d84d.json
af621bbd-2c9b-4178-b846-92b35d21c948.json
b4f1c164-b614-4794-b384-d498b6211fbe.json
c0d731f8-bc0c-4a2b-b1d1-d85525a3f34a.json
c59b57dd-492d-410e-9afc-09eb0459aa3d.json
df624477-c4af-45fa-99c5-7a148dc3e42d.json
ee81bb8d-5d81-4b4e-9f2e-d9ce0ba6d56d.json
```

Their referenced `.sheets/sheet-*.ndjson` files are also retained. Equal worksheet content under different document IDs does not prove a file is dispensable: each ID remains associated with its own conversation. There were no unreferenced files in the upload directory.

### Unbacked uploads — retained, manual review required

These four local PDF manifests have no ready durable backup in the configured MongoDB/GridFS store, and each is associated with an existing MongoDB conversation:

```text
backend/.data/uploads/3c8e88b7-6666-4eaf-9f6d-d217d11e8f1d.json
backend/.data/uploads/50797dbb-b003-4296-9a04-961a5850e857.json
backend/.data/uploads/5c9fd026-5c39-4548-8e44-1012a738df7a.json
backend/.data/uploads/909966c6-538f-4e28-811c-b50d90649d12.json
```

They may be the only surviving parsed document copies. They were not deleted, migrated or assigned ownership. A separately reviewed backup/recovery process must verify ownership and durable storage before considering removal.

### Other runtime state retained

- `backend/.data/conversations.json`: four local conversations also exist in MongoDB, and their local messages are present there. However, a complete comparison found differences in `messages` and `updatedAt`; the snapshot was retained rather than treating it as an exact duplicate. It is also the standalone file store and legacy migration input.
- `backend/.data/gemini-usage.json`: active quota/accounting state; deleting it could reset application budgets.
- All `.env` files, environment examples, storage directories, source modules, parsers, calculation engine, useful tests, validation scripts and backend/frontend lockfiles remain.
- No source script was proven redundant. Previously flagged tracked dependency files remain for separate review.

### Verification after this follow-up

- Existing document storage loading: PASS, 20 documents and 37 worksheets through `attachStoredSheets()` and the deterministic summary engine; no parse/scope errors.
- Existing linked histories: PASS, 20 corresponding conversations retrieved read-only from MongoDB; message arrays, roles and text types validated without printing contents. This is storage-level verification, not access to the user's existing browser session.
- Actual GridFS restore: PASS, 16 documents, 49 byte-matching files, 37 worksheets, temporary restore fully removed.
- Frontend production build: PASS using the documented HTTPS API origin provided only to the build process. Existing bundle-size warning remains.
- Backend full regression suite: PASS, 50 tests, zero failures after the storage-aware cleanup. Temporary test output was removed from the OS temporary directory.
- Runtime uploads, logs, screenshots, generated verification JSON, build output, dependencies and environment files remain covered by `.gitignore` rules. Previously staged removals of runtime data and secrets were not undone.
