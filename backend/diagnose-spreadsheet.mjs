import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { prepareXlsx } from './xlsx-compat.js';
import { parseSpreadsheet, parseSpreadsheetInWorker } from './spreadsheet-parser.js';
import { validateUpload, validateAnalysis } from '../frontend/src/api-contracts.js';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node diagnose-spreadsheet.mjs <workbook.xlsx> [http://localhost:5173]');
const buffer = await readFile(filename);
const zip = await JSZip.loadAsync(buffer);
console.log('Archive', { bytes:buffer.length, entries:Object.keys(zip.files).length,
  worksheetEntries:Object.keys(zip.files).filter(name=>/^xl\/worksheets\/[^/]+\.xml$/.test(name)).length });
for (const part of ['xl/workbook.xml','xl/_rels/workbook.xml.rels']) {
  const xml=await zip.file(part)?.async('string');
  console.log('XML structure', {part, root:xml?.match(/<(?!\?|!)[^>]+>/)?.[0],
    sheetDeclarations:(xml?.match(/<(?:\w+:)?sheet\s/g)||[]).length,
    worksheetRelationships:(xml?.match(/Type=["'][^"']*\/worksheet["']/g)||[]).length});
}
for (const entry of Object.values(zip.files).filter(entry => /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name))) {
  const xml = await entry.async('string');
  console.log('Worksheet XML', { part:entry.name, root:xml.match(/<(?!\?|!)([\w:]+)/)?.[1],
    dimension:xml.match(/<(?:\w+:)?dimension\b[^>]*\bref="([^"]+)"/)?.[1], rowElements:(xml.match(/<(?:\w+:)?row\b/g)||[]).length });
}
const summary = sheets => sheets.map(sheet=>({name:sheet.name,rows:sheet.rows.length,columns:sheet.columns.length}));
let expected;
for (const mode of ['raw-exceljs','prepared-exceljs','direct-parser','worker-parser']) {
  try {
    if (mode.endsWith('exceljs')) {
      const prepared=mode==='prepared-exceljs'?await prepareXlsx(buffer):{buffer};
      const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(prepared.buffer);
      console.log(mode,{changed:!buffer.equals(prepared.buffer),worksheets:workbook.worksheets.map(sheet=>({name:sheet.name,rows:sheet.rowCount,columns:sheet.columnCount}))});
    } else {
      const sheets = await (mode==='direct-parser'?parseSpreadsheet:parseSpreadsheetInWorker)(buffer,'xlsx');
      expected = summary(sheets);
      console.log(mode, expected);
    }
  } catch(error) {console.log(mode,{error:error.message,stack:error.stack?.split('\n').slice(0,4)});}
}
if (process.argv[3]) {
  const base=process.argv[3].replace(/\/$/,'');
  const {diagnosticClient}=await import('./diagnostic-auth.js'),client=await diagnosticClient(base);
  const form=new FormData();form.append('file',new Blob([buffer]),path.basename(filename));
  const response=await client.request('/files/upload',{method:'POST',body:form});
  const result=await response.json();
  console.log('HTTP upload',{base,status:response.status,error:result.error,sheetNames:result.sheetNames,sheetCount:result.sheetCount,rowCount:result.rowCount,columnCount:result.columnCount,totalRowCount:result.totalRowCount,worksheets:result.worksheets});
  if(response.ok) {
    try {
      validateUpload(result);
      assert.ok(expected, 'a parser comparison must succeed');
      assert.deepEqual(result.sheetNames, expected.map(sheet => sheet.name));
      assert.deepEqual(result.worksheets.map(({name,rowCount,columnCount})=>({name,rowCount,columnCount})), expected.map(sheet => ({name:sheet.name,rowCount:sheet.rows,columnCount:sheet.columns})));
      assert.equal(result.totalRowCount, expected.reduce((total, sheet) => total + sheet.rows, 0));
      for(const sheet of result.sheetNames) {
        const response=await client.request(`/analytics/${result.fileId}?sheet=${encodeURIComponent(sheet)}`);
        const stats=await response.json();console.log('HTTP analytics',{sheet,status:response.status,rows:stats.rowCount,columns:stats.columnCount,error:stats.error});
        assert.equal(response.status, 200);validateAnalysis(stats);
        assert.equal(stats.rowCount, expected.find(item => item.name === sheet).rows);
        assert.equal(stats.columnCount, expected.find(item => item.name === sheet).columns);
      }
      for(const format of ['pdf','xlsx']) {
        const report=await client.request(`/reports/${result.fileId}.${format}`);
        const bytes = Buffer.from(await report.arrayBuffer());
        console.log('HTTP report',{format,status:report.status,bytes:bytes.length});
        assert.equal(report.status,200);
        if(format === 'pdf') assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
        else { const exported = new ExcelJS.Workbook();await exported.xlsx.load(bytes);assert.equal(exported.getWorksheet('Selected Data').rowCount,expected[0].rows+1); }
      }
    } finally {
      const removed=await client.request(`/files/${result.fileId}`,{method:'DELETE'});
      console.log('Diagnostic upload cleanup',{status:removed.status});
      await client.logout();
    }
  } else {await client.logout();process.exitCode=1;}
}
