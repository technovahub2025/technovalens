import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const MAX_ROWS = 100000, MAX_COLUMNS = 256, MAX_CELLS = 2000000;
let activeWorkers = 0;
function headersFor(values, width) {
  const used = new Set();
  return Array.from({ length: width }, (_, i) => {
    const base = String(values[i] ?? '').trim() || `Column ${i + 1}`;
    let name = base, suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name); return name;
  });
}
function checkZip(buffer) {
  // Inspect the central directory before inflation, including ZIP bomb limits.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Invalid XLSX archive.');
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16), expanded = 0;
  if (entries > 10000) throw new Error('Workbook archive contains too many entries.');
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid XLSX directory.');
    expanded += buffer.readUInt32LE(offset + 24);
    if (expanded > 128 * 1024 * 1024) throw new Error('Workbook exceeds the 128 MB expanded size limit.');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
}
export async function parseSpreadsheet(buffer, ext) {
  let cells = 0, records = 0;
  const check = (rows, width) => {
    cells += rows * width; records += rows;
    if (records > MAX_ROWS || width > MAX_COLUMNS || cells > MAX_CELLS) throw new Error('Dataset limit: 100,000 rows, 256 columns and 2,000,000 cells per workbook. Split this file into smaller workbooks.');
  };
  if (ext === 'csv') {
    if (buffer.includes(0)) throw new Error('CSV must be UTF-8 text.');
    const records = parse(buffer.toString('utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 1024 * 1024 });
    const width = records.reduce((max, row) => Math.max(max, row.length), 0);
    check(Math.max(0, records.length - 1), width);
    const columns = headersFor(records.shift() || [], width);
    return [{ name: 'CSV data', columns, rows: records.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null]))), formulaCount: 0, uncachedFormulas: 0 }];
  }
  checkZip(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (workbook.worksheets.length > 32) throw new Error('Workbook exceeds the 32 worksheet limit.');
  if (!workbook.worksheets.length) throw new Error('No worksheets found.');
  return workbook.worksheets.map(ws => {
    check(Math.max(0, ws.rowCount - 1), ws.columnCount);
    let formulaCount = 0, uncachedFormulas = 0;
    const valueOf = value => {
      if (value instanceof Date) return value.toISOString();
      if (!value || typeof value !== 'object') return value ?? null;
      if ('formula' in value || 'sharedFormula' in value) {
        formulaCount++;
        if (value.result === undefined || value.result === null) uncachedFormulas++;
        return valueOf(value.result);
      }
      if ('error' in value) return null;
      if (value.richText) return value.richText.map(p => p.text || '').join('');
      return value.text ?? value.hyperlink ?? null;
    };
    const columns = headersFor(Array.from({ length: ws.columnCount }, (_, i) => valueOf(ws.getRow(1).getCell(i + 1).value)), ws.columnCount);
    const rows = [];
    ws.eachRow((row, index) => {
      if (index === 1) return;
      // Formula-only rows with no cache remain records with missing values.
      rows.push(Object.fromEntries(columns.map((c, i) => [c, valueOf(row.getCell(i + 1).value)])));
    });
    return { name: ws.name, columns, rows, formulaCount, uncachedFormulas };
  });
}
export function parseSpreadsheetInWorker(buffer, ext) {
  if (activeWorkers >= 2) return Promise.reject(new Error('Two files are already parsing. Please retry shortly.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { buffer, ext }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    activeWorkers++;
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Parsing exceeded 30 seconds. Please split this workbook.')); }, 30000);
    worker.once('message', result => { clearTimeout(timer); result.error ? reject(new Error(result.error)) : resolve(result.sheets); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { activeWorkers--; clearTimeout(timer); if (code) reject(new Error('Workbook exceeded parser resources. Please use a smaller file.')); });
  });
}
if (!isMainThread) {
  try { parentPort.postMessage({ sheets: await parseSpreadsheet(Buffer.from(workerData.buffer), workerData.ext) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}
