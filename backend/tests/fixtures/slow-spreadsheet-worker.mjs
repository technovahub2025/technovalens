// Test-only preload: emulate a throttled worker after a partial filesystem write.
// The server process itself is not delayed. Production never imports this file.
import { isMainThread, workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
if (!isMainThread && workerData?.outputDir) {
  writeFileSync(path.join(workerData.outputDir, 'partial-test.tmp'), 'partial', { mode: 0o600 });
  await new Promise(resolve => setTimeout(resolve, 1500));
}
