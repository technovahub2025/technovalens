# Production worker deadline diagnostics

This patch is prepared locally for review. It does not deploy code or change Render settings.

## Configuration to review in Render

The existing worker timer is already configurable. Its default remains 30 seconds on localhost and anywhere the variable is unset. It is clamped to a maximum of 120 seconds; zero, invalid values and omitted values do not disable it.

For a bounded diagnostic run on the confirmed Render Free service, set these backend environment variables **after the patch is reviewed**:

```dotenv
SPREADSHEET_TIMEOUT_MS=120000
SPREADSHEET_WORKER_HEAP_MB=256
SPREADSHEET_WORKERS=1
```

Do not change `frontend/.env`, the Vite API URL, `NODE_OPTIONS`, the streaming parser or any upload/dataset limit for this diagnostic. Do not increase the heap or worker count. The shared worker timeout also applies to worksheet queries; this is a temporary diagnostic budget, not a claim that all workloads should routinely take two minutes. The configured deadline includes worker startup but excludes multipart upload and final document/conversation storage. It does not extend any external proxy/hosting HTTP deadline.

Render environment changes can trigger a deployment. No provider settings have been changed by this work. Keep the existing local `.env` unchanged; `.env.example` retains `30000` and documents the production diagnostic override as a comment.

## Measurements

`parserMetrics` is included in successful upload responses and private job status. Parser progress and failure logs retain the current stage, worksheet index, completed spans and elapsed time even when the worker times out. Timings contain indices and counts, without worksheet contents, names, filenames or tokens.

| Field | Meaning |
| --- | --- |
| `startupMs` | Worker construction to module initialization, including module imports and scheduler/preload delay |
| `inputTransferMs` | Parent-side input buffer preparation |
| `elapsedMs` | Parsing/analysis time after the worker module initializes |
| `workerCpuMs` | Cumulative worker-thread CPU time, including its imports; `null` if the Node runtime cannot measure thread CPU |
| `timings.xmlMs` | Streaming ZIP XML reading/decompression, SAX parsing and callbacks |
| `timings.storageWriteMs` | Native synchronous open/write/close calls for shared strings and temporary/normalized worksheet data |
| `timings.storageReadMs` | Native shared-string reads on cache misses |
| `timings.normalizationMs` | Sparse-row normalization, including row decoding and normalized writes |
| `timings.worksheetLoadMs` | Reading/decoding one normalized sheet for analysis |
| `timings.analysisMs` | Worksheet statistics and charts |
| `timings.hashingMs` | Per-worksheet content hashing |
| `timings.validationMs` | Final worker result validation |
| `timings.worksheets` | Corresponding cumulative spans for each worksheet index |
| `shutdownMs`, `totalElapsedMs` | Worker termination/release and full parent-side worker elapsed time |
| `metadataStorageMs`, `conversationMs`, `finalizationMs` | Final metadata save and conversation creation, measured outside the worker deadline |
| `processingMs` | Backend processing after multipart receipt, through readiness to send the response |

Spans overlap: XML callbacks perform shared-string and row writes, and normalization includes normalized writes. **Do not add all timing fields together.** The parent-side total is the elapsed worker measurement. Finalization fields are emitted in the upload response/status/log after saving, rather than rewriting metadata solely to persist diagnostic timings.

Parent-side heartbeats run every second while a worker is alive, including startup. They preserve `stage`, `worksheetIndex`, `elapsedMs`, `stageElapsedMs`, `timeoutMs` and the last worker timing snapshot. Heartbeats show that the parent is responsive; they do not by themselves prove that a worker has progressed. The frontend continues its existing authenticated polling for the entire request, with no client processing timeout, and uses the existing upload-status area. No Dashboard layout or styles change.

On timeout/cancellation, the parent first awaits worker termination and then removes partial sheet directories, metadata, metadata temporary files and conversations. Cleanup actions are all attempted independently; private job status reports `cleanupComplete`, `cleanupMs`, or an explicit cleanup error. The machine-readable timeout code remains `PARSER_TIMEOUT`.

## Local evidence and how to interpret the production run

An instrumented Eveready upload through the localhost Vite proxy completed all 11 sheets with its normal 30-second budget. One representative run measured:

- Upload round trip: 5,706 ms; parent-side worker elapsed: 5,573 ms.
- Worker startup: 430.51 ms; worker CPU time: 5,202 ms.
- XML: 3,048.01 ms; native writes: 57.76 ms; shared-string reads: 77.66 ms.
- Normalization: 148.73 ms; normalized sheet loading: 227.70 ms.
- Analysis: 376.26 ms; content hashing: 1,279.70 ms.
- Final metadata storage: 5.74 ms; conversation creation: 37.58 ms; finalization: 43.76 ms.
- Heap cap: 256 MiB, unchanged; sampled worker heap peak: 48.7 MiB.

These are local measurements, not production measurements. They show CPU-heavy XML processing and hashing dominate this local run. With only 0.1 CPU, roughly five seconds of CPU work can require much longer wall time; a simple quota-only estimate is around 52 seconds, before additional scheduling/I/O. This supports testing a bounded 120-second window on Render Free, but does not establish the production phase distribution or fix its performance bottleneck.

After an approved deploy/configuration change, upload Eveready once in the original browser workspace and inspect the new logs:

1. Compare the active commit and effective `timeoutMs` with the reviewed patch and `120000`.
2. Compare startup and worker CPU with elapsed time. A large wall/CPU gap supports scheduling/throttling or waiting; it does not isolate storage without the per-stage measurements.
3. Compare XML, per-sheet writes/loads, analysis and hashing with the local measurements above.
4. Confirm all 11 sheets and 13,610 data rows, then exercise Analytics and Reports.
5. If it still times out, inspect `lastStage`, `stageElapsedMs` and the last worksheet timing snapshot. Do not remove the deadline or increase it beyond 120 seconds.
6. Verify a deliberate cancellation leaves `cleanupComplete: true` and no incomplete upload in the file list.

## Regression tests

`tests/parser-diagnostics.test.js` checks timing aggregation, per-sheet metrics, startup measurements and bounded configuration. Its isolated real HTTP test uses a test-only Node preload to delay workers and write a partial file. It verifies that a 1-second deadline terminates the worker and removes partial data, a 120-second budget continues heartbeat progress, explicit cancellation cleans up, and a subsequent upload succeeds at the unchanged 256 MiB cap. The preload is never imported by production.

Local validation completed: all **36 backend tests passed**, the frontend production build passed, and three instrumented Eveready uploads through `http://localhost:5173/api` passed all eleven worksheet/13,610-row accuracy checks, Analytics filters/pagination, PDF/XLSX exports and cancellation cleanup. The build retains its existing bundle-size warning; no stylesheets were modified. Production performance has not been re-measured because nothing has been pushed or deployed.
