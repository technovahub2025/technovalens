import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run by the server administrator only. Never let an HTTP request claim legacy files.
const token = process.env.WORKSPACE_TOKEN || '';
if (!/^[a-f0-9]{64}$/.test(token)) {
  console.error('Set WORKSPACE_TOKEN to the private browser workspace token before running this migration.');
  process.exit(1);
}
const directory = process.env.DOCUMENT_STORE_DIR ? path.resolve(process.env.DOCUMENT_STORE_DIR) : fileURLToPath(new URL('./.data/uploads/', import.meta.url));
const ownerHash = crypto.createHash('sha256').update(token).digest('hex');
let migrated = 0;
for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  const file = path.join(directory, entry.name);
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (document.ownerHash || typeof document.fileId !== 'string') continue;
  document.ownerHash = ownerHash;
  const temporary = `${file}.migration.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(document), { mode: 0o600 }); fs.renameSync(temporary, file);
  migrated++;
}
console.log(`Assigned ${migrated} previously unowned uploads to the specified private workspace. Restart the backend.`);
