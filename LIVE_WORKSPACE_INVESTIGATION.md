# Live workspace investigation

Observed 13 November 2026, approximately 17:40 IST (12:10 UTC). All production requests and MongoDB operations were read-only. Browser observations used fresh isolated profiles, with POST/PUT/PATCH/DELETE requests blocked. No existing user browser storage was accessed; no token, identity hash, credential, message text or customer filename was printed. No deployment, Render setting change, migration or login implementation was performed.

## Main finding

The empty live Dashboard is a view of files available to one browser workspace, not a count of all MongoDB records. The live frontend is older than the local build and sends a valid workspace identity. Its backend behavior also predates the local missing-history recovery change. The configured MongoDB database contains historical conversations, many without ownership or a durable document manifest. A separate confirmed issue is that www and non-www create independent workspaces.

The most likely explanation is the combination of older file-dependent conversation visibility, unavailable file records on the deployed backend, and/or a different browser workspace. The affected user's exact combination cannot be proved without an in-place comparison of their original browser identity and the deployed service's storage/configuration. Missing Dashboard rows do not establish MongoDB data loss.

## Confirmed observations

### Versions

| Component | Live | Local |
| --- | --- | --- |
| Frontend bundle | `/technovalens/assets/index--bZYZiIr.js`, 708,114 bytes | `index-C3TW2DBS.js`, different SHA-256 |
| Chat worksheet selector | Absent from live bundle | Present |
| New conversation/file-mapping recovery | Absent from live bundle | Present |
| Missing conversation API | 404 with older `Conversation not found.` response | 404 with `CONVERSATION_UNAVAILABLE` recovery code |
| Durable document implementation | Exact deployed source/commit not exposed | Local `MongoDocumentStore` uses `documents` plus `document_data` GridFS bucket |

No deployment SHA is exposed by the observed health response, so an exact backend commit comparison is unavailable. The live missing-conversation response matches the older implementation in local Git HEAD (`2d8f854`), but that does not establish that exact commit is deployed.

The inspected pre-improvement Git HEAD stores uploaded manifests under `backend/.data/uploads` or `DOCUMENT_STORE_DIR`, restores an in-memory document map from disk, and does not use the new MongoDB document/GridFS store. Its conversation-list route loads MongoDB conversations but filters them with `getDocument(item.fileId)`. That helper also enforces the current workspace's file ownership. Its conversation detail route returns 404 if the associated file cannot be loaded. This is a concrete code path that hides surviving MongoDB messages when file records are unavailable or belong to another workspace.

### Actual live requests and identity

The observed browser at `https://technovahub.in` sent both lists to `https://technovalens.onrender.com`:

| Request | Observed result |
| --- | --- |
| `GET /api/health` | 200, workspace authentication version 1 |
| `GET /api/files` without workspace header | 401, `WORKSPACE_TOKEN_REQUIRED` |
| `GET /api/files` in a fresh workspace | 200, empty array |
| `GET /api/conversations` in that workspace | 200, empty array |
| List requests after refresh | Header still valid and identical to the saved browser identity |

Both browser list requests contained a valid `X-Workspace-Token`, matching `localStorage['technovalens.workspaceToken']`. The token persisted across refresh. CORS allowed the production origin, responses used `Cache-Control: no-store`, and the isolated browser reported no JavaScript runtime errors. These observations do not support a general missing-header, CORS or stale-list-cache explanation for the tested profile. They do not prove the affected user's existing profile is healthy.

The live bundle's Uploaded files KPI uses the length of the returned file array, so an empty array directly produces 0. It does not query a global MongoDB total. An empty fresh workspace is expected, even when other workspaces contain data.

### Workspace storage and origin split

The current identity code generates 32 random bytes as 64 hexadecimal characters when a valid saved token is absent, and saves it under `technovalens.workspaceToken`. Requests attach that identity; the backend compares its SHA-256 against `ownerHash`. The raw token is not stored as the ownership field. A stored owner hash cannot recover a lost raw token.

Both `https://technovahub.in/technovalens` and `https://www.technovahub.in/technovalens` returned 200 without redirecting to one origin. In the same fresh browser profile, visiting these two origins created two valid but different workspace identities. Localhost and any previous hosting domain are separate origins as well. The trailing slash alone does not change origin.

This follows the browser's origin-scoped storage behavior; storage can persist across sessions, but private browsing, clearing site data, different origins and different browser profiles affect continuity. See [MDN localStorage documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).

### MongoDB metadata snapshot

Read-only queries used the locally configured connection and database `technovalens`. Whether Render uses that exact connection/database was not independently verified because its environment was not accessed.

| Collection | Documents |
| --- | ---: |
| `conversations` | 122 |
| `documents` | 16 |
| `document_data.files` | 49 |
| `document_data.chunks` | 61 |

Ownership and associations:

- 106 conversations lack `ownerHash` and have no matching record in `documents` by original `fileId`.
- 16 conversations have valid owner hashes, distributed across seven distinct workspace hashes. Seven hashes do not imply seven people or accounts.
- All 16 owned conversations have matching durable document manifests, all in state `ready`.
- All 49 manifest-referenced GridFS file records exist. This is a reference-completeness check, not a new full blob-download/restore test.
- At the later snapshot, the unowned group contained 195 messages in 24 nonempty conversations; the owned group contained 35 messages in nine nonempty conversations. Message totals changed from 224 to 230 across the read-only observations, consistent with concurrent application activity; counts are snapshots, not a frozen export.
- No conversation message text or title was inspected or emitted for this report.
- The 16 owned conversations' hashes match ownership found among local stored documents. That does not identify the affected live browser or prove those records originated in production.
- Four unowned conversations have original file IDs present among local stored manifests. This is a possible recovery source requiring content integrity and ownership verification. The other 102 have no original-ID match among the inspected local manifests; other backups or original files may still exist.

The new local store filters conversations by `ownerHash` and can preserve owned history when its file is missing. Ownership-less conversations remain unresolved until a defensible migration establishes ownership. Simply deploying the local code cannot assign the 106 unowned records to a user or manufacture missing document data.

## Hypotheses and verification limits

1. **Older file visibility filtering is hiding surviving messages.** Strongly supported by the pre-improvement source and live backend fingerprint. Exact deployed route implementation still needs deployment-source confirmation.
2. **Some original file records were lost from Render's filesystem.** The older source stores document data on disk, and many historical conversations lack durable manifests. Render's default filesystem is ephemeral; without a persistent disk covering the actual path, changes are lost on redeploy/restart. The service's disk attachment, mount path, deployment history and current filesystem were not inspected, so actual file loss or a particular restart cannot be asserted. See [Render persistent disk documentation](https://render.com/docs/disks).
3. **The affected browser uses a different workspace.** Plausible and directly reproducible between www/non-www. The user's real token was not obtained, and no token should be pasted into chat or logs. Therefore it is not confirmed which, if any, of the seven owned workspaces belongs to that browser. Most older records have no ownership field at all, so they cannot be described as proven members of a different workspace.
4. **Render uses a different MongoDB database or connection.** Not ruled out. Collection presence through local credentials alone does not prove the deployed environment points at the same database.

The GridFS documents already present in the database do not prove the old deployed backend can read or restore them. In the inspected older source, it cannot.

## Recommended migration plan — not executed

1. **Preserve evidence and available originals before changing services.** Back up conversation/documents collections and GridFS using appropriate database backup tooling. Secure any remaining Render upload data, mounted-disk backups and local original-ID manifests/worksheet directories. Preserve existing browser storage on both hostnames; do not clear it to troubleshoot.
2. **Confirm the affected identity and deployed configuration privately.** In the actual affected browser, report only whether the identity exists, is valid, is stable and is attached to both list requests. Use an authorized comparison that keeps the raw token private to establish an ownership match, and compare response statuses/counts. Verify the backend deploy commit, database selection, `DOCUMENT_STORE_DIR` and actual disk mount coverage without changing settings.
3. **Build a dry-run recovery inventory.** Separate verified-owned records, unowned records with surviving original-ID files, orphaned histories and missing/corrupt blobs. Validate the four potential local matches and any backups. Retain original conversation IDs, file IDs, messages and timestamps. Do not merge workspaces or assign all legacy data to the current visitor. Filename similarity or email alone is insufficient proof of ownership.
4. **Review a bounded, idempotent migration.** For verified records only, back up normalized datasets/manifests into durable storage and assign ownership from trustworthy existing ownership data or an approved administrative recovery process. Produce a reviewable mapping and unresolved-record report before any write. The current legacy workspace migration helper assigns ownership to all unowned local uploads in its directory; it is too broad to run blindly against this mixed-history situation.
5. **Prepare a coordinated release after explicit approval.** Publish matching frontend/backend versions with durable restore support and missing-file recovery messaging, preserve workspace identities and original IDs, and expose a non-secret build identifier for later diagnostics. Keep unresolved messages intact; never recreate historical chats. Validate cold-cache restoration, restart persistence, missing files, worksheet calculations and workspace isolation in staging before production approval. No release is requested or authorized by this report.
6. **Plan account-based access separately.** Authenticated accounts linked to stable workspace membership would improve cross-device access and recovery from lost browser storage. They would not recover absent source files or establish ownership of unowned legacy records. Link an anonymous workspace only with proof of its existing token/control; require separately verified administrative recovery for unowned records. Preserve isolation and existing IDs during that transition. No login functionality has been created.
7. **Canonicalize the domain with an identity-transition plan.** Choose www or non-www after providing a secure, explicit method for users to retain/control existing workspaces. A redirect alone does not transfer localStorage and can strand access on the old origin. Never place raw workspace tokens in URLs, analytics or ordinary logs.

This investigation changed only this local report. Production reads did not create indexes, migrate records, upload workbooks, call Gemini, or alter data/settings.
