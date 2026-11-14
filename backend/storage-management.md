# Local upload storage management

The implementation is prepared locally. No existing upload/conversation file was deleted, and no production MongoDB write, deployment or push was performed. Cache expiration is disabled until deletion is explicitly approved. Do not turn it on as part of ordinary validation.

## Current audit

The configured database has verified GridFS copies for 16 local documents (49 files). Four additional PDF manifests have no durable backup. Full byte verification is separate from the stricter application-level content checks added here.

The four unbacked documents are:

```text
3c8e88b7-6666-4eaf-9f6d-d217d11e8f1d.json
50797dbb-b003-4296-9a04-961a5850e857.json
5c9fd026-5c39-4548-8e44-1012a738df7a.json
909966c6-538f-4e28-811c-b50d90649d12.json
```

Each has a basic readable PDF extraction (two pages, one extracted chunk), but neither its manifest nor its linked MongoDB conversation has an owner hash. The previous startup backup loop only considered documents with ownership. That is why these files were skipped. Inferring ownership from a filename or simply assigning them to the current workspace would compromise isolation. They remain unmodified; verified ownership must come from a separately approved recovery process before backup/migration.

One additional file, `57e1dd76-332e-41cc-a620-dede5fad9412.json`, has a byte-matching GridFS backup but its legacy `contentHash` differs from the current workbook hash recomputation. This does not establish corruption: older hash semantics or historical data changes are possible. Its local and durable copies are retained; it is excluded from expiration pending review. No checksum was rewritten to hide the discrepancy.

The other 15 documents, comprising 48 local files, passed ownership, local content and complete GridFS comparisons. They are candidates for idle expiration **after approval**, not files removed by this work:

```text
1c811ee9-1c1e-4e7c-b587-f008fad96b0c
205c2c62-ffd5-4b5e-bf7a-bd293ba7e6fd
34cfbac9-ff3c-4479-84cb-49f85e4770a8
46f04217-b5ce-4e1c-bf83-ea29757b56c4
532d20b3-e940-450a-9459-0599e033c732
6c7294e0-77dd-47f3-bf7c-da6bef65787f
878ef8ab-50e0-47d4-995c-1cdac5440656
8e29d497-a6f2-4581-bf86-4da86ade65f1
a6da1c0c-cb28-4599-b044-81b929a5d84d
af621bbd-2c9b-4178-b846-92b35d21c948
b4f1c164-b614-4794-b384-d498b6211fbe
c0d731f8-bc0c-4a2b-b1d1-d85525a3f34a
c59b57dd-492d-410e-9afc-09eb0459aa3d
df624477-c4af-45fa-99c5-7a148dc3e42d
ee81bb8d-5d81-4b4e-9f2e-d9ce0ba6d56d
```

Each entry represents its `.json` manifest and referenced normalized sheet files. They remain associated with their original conversations and IDs; identical sheet contents under different IDs are not deduplicated.

## Maintenance and reconciliation

`npm run audit:storage` is read-only by default. It does not initialize indexes, upload files, change ownership, rewrite snapshots or delete local data. It reports only IDs/status/reasons, not document text, workspace identities or credentials.

The backing functions enforce:

- Verified document ID, extracted content/schema, row counts and available content hashes.
- A valid existing document owner and agreeing owners on every linked conversation before a new historical backup is eligible.
- Insert-only file-ID reservation. Existing records are verified rather than overwritten; ownership or content conflicts are blocked.
- SHA-256 fingerprints on all newly written GridFS blobs. Failed backups do not remove local data.
- Snapshot reconciliation compares original message IDs, complete message content and order. It never creates historical text, message IDs or timestamps. A MongoDB superset is already reconciled. Only an exact owned extension can append its existing suffix, using a compare-and-set guard; conflicting records require review.

All four local snapshot conversations are already represented in MongoDB with their local messages preserved in order; MongoDB has newer messages/timestamps. The correct reconciliation is **no write**. The snapshot remains on disk, and no messages were deleted or invented.

The tool supports an explicit `--apply` only behind `ALLOW_STORAGE_MIGRATION=true`. This is an additional accidental-write guard, not authorization to change production. It was not enabled or used here. There are currently no eligible unbacked documents: the four candidates lack ownership. Historical startup backup/import/owner assignment has been removed; these actions now require this reviewed maintenance workflow. Newly uploaded files still use the normal durable upload pipeline.

## Recoverable cache expiration

`LocalDocumentCache` keeps metadata/list visibility while local payloads expire. File retrieval, chat, preview and Reports requests hydrate missing local data from the matching workspace's GridFS record before reading it. Concurrent restores share work, while other workspace identities cannot retrieve or hydrate the file. Recovery errors preserve history and produce a clear notice in the frontend.

Expiration takes an exclusive activity barrier. It waits for uploads, asynchronous handlers, spreadsheet workers and response streams to finish; a disconnected client does not release a still-running operation. New requests wait for a sweep to settle. This intentionally uses a conservative server-wide barrier instead of risking deletion during another operation.

For each idle document, expiration rechecks semantic integrity, ownership and every local/GridFS byte. It skips missing backups, checksum differences, unexpected files, symbolic links and unverified ownership. It persists fingerprints to ignored runtime `cache-recovery.json` before removing any payload. Restoration checks those fingerprints, stages downloads before publication, never overwrites differing surviving local files, and preserves conversation IDs/history. Interrupted or failed checks retain data and allow later recovery.

Configuration examples are documented in `.env.example`; actual `.env` files were not edited:

```dotenv
LOCAL_CACHE_EXPIRATION_ENABLED=false
LOCAL_CACHE_SINGLE_PROCESS=false
LOCAL_CACHE_TTL_MS=86400000
```

Only after explicit deletion approval, an administrator may configure both enable/single-process flags to true for a directory exclusively used by one backend. The default idle TTL is 24 hours and the minimum is one minute. The current activity barrier is process-local: sharing that cache directory with another server, worker utility or old deployment is unsupported. Full-source backups are still required independently of a working GridFS cache.

Startup restores durable data without replacing surviving differing local files. Consequently a restart can repopulate an expired cache; it is safe restoration, not a promise that disk use remains minimal immediately after restart. New read-through access also allows cache eviction without waiting for a restart.

## Read-only local serving mode

`STORAGE_READ_ONLY=true` skips collection initialization/migrations, disables expiration and rejects mutating storage APIs. Read endpoints and calculation endpoints remain available, but the normal frontend cannot save chats/uploads in this mode. Health reports the mode explicitly. This prevents a development watcher or verification restart from writing to the production-connected database.

For this task, the existing local Node watcher was paused before edits because it would otherwise restart against production credentials. The local backend was then restarted without watch in read-only mode, with expiration off. Its environment override is process-local; `.env` and Render settings are unchanged. Return to normal writable development only when writes to the configured database are authorized, or configure a separate development database.

## Validation and limits

- Storage tests exercise expiration-disabled behavior, activity protection, request/sweep ordering, concurrent restore sharing, unbacked/corrupt/modified data, immutable backups, ownership isolation, reconciliation conflicts and optimistic writes using disposable fixtures.
- A 30,000-row worksheet is expired/restored in a fixture; its exact total is compared to an independent arithmetic result.
- A real backend restart into an empty temporary cache, in read-only mode, restored all 16 existing durable documents and all 49 files byte-for-byte. Workspace isolation and rejection of storage writes passed. Only the newly created temporary test cache was removed.
- Actual sample and Eveready upload/question/Reports acceptance passed against isolated file-mode servers, with Gemini disabled. Production records and existing local uploads were not used as writable test fixtures.
- Backend full suite and frontend build results are reported with the final task result. The existing Vite chunk-size warning remains.
- `.gitignore` covers `.data` (including recovery fingerprints), uploads, logs, generated output and environment files. Existing staged secret/runtime removals were not undone.

Files changed: `server.js`, `storage/mongo-document-store.js`, `storage/json-conversation-store.js`, new `storage/local-document-cache.js`, new `storage/storage-maintenance.js`, new `audit-storage.mjs`, `.env.example`, package scripts, regression tests, and `frontend/src/conversation-client.js`. No existing user file was deleted by these changes.
