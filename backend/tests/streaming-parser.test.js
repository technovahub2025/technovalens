import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseSpreadsheet,parseSpreadsheetInWorker,parserLimits } from '../spreadsheet-parser.js';
import { attachStoredSheets,clearSheetCache } from '../sheet-storage.js';

async function fixture(){
  const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('Production');
  sheet.getCell('A1').value='Production tracker';
  sheet.getRow(3).values=['Item','Quantity','Date'];
  sheet.addRow(['A',10,new Date('2026-10-31T00:00:00Z')]);sheet.getCell('C4').numFmt='yyyy-mm-dd';
  sheet.addRow(['B',0,null]);sheet.addRow(['C',{formula:'1+1'},null]);
  for(let i=10;i<400;i++)for(let col=1;col<=64;col++)sheet.getRow(i).getCell(col).style={numFmt:'0.00'};
  workbook.addWorksheet('Other').addRows([['Name','Value'],['é漢字 & <text>',{formula:'2+2',result:4}]]);
  return workbook.xlsx.writeBuffer();
}

test('streamed parsing excludes formatted empty cells, finds title-row headers and preserves dates, Unicode and formula caches',async()=>{
  const sheets=await parseSpreadsheet(await fixture(),'xlsx');
  assert.equal(sheets.length,2);assert.equal(sheets[0].headerRow,3);
  assert.deepEqual(sheets[0].columns,['Item','Quantity','Date']);assert.equal(sheets[0].rows.length,3);
  assert.equal(sheets[0].rows[0].Date,'2026-10-31T00:00:00.000Z');assert.equal(sheets[0].rows[1].Quantity,0);
  assert.equal(sheets[0].rows[2].Quantity,null);assert.equal(sheets[0].uncachedFormulas,1);
  assert.equal(sheets[1].rows[0].Name,'é漢字 & <text>');assert.equal(sheets[1].rows[0].Value,4);
});

test('disk manifests do not transfer or serialize all rows; normalized data reloads with cached exact analytics',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'technovalens-disk-test-')),fileId='12345678-1234-1234-1234-123456789abc';
  const directory=path.join(root,`${fileId}.sheets`);fs.mkdirSync(directory);
  try{
    const sheets=await parseSpreadsheetInWorker(await fixture(),'xlsx',{outputDir:directory});
    assert.equal(sheets[0].rows,undefined);assert.equal(sheets[0].rowCount,3);assert.equal(sheets[0].analytics.columnStats.Quantity.sum,10);
    assert.ok(fs.statSync(path.join(directory,sheets[0].dataFile)).size>0);
    assert.ok(!fs.existsSync(path.join(directory,'strings.tmp')));assert.ok(!fs.existsSync(path.join(directory,'rows.tmp')));
    const document={storageVersion:2,fileId,sheets};attachStoredSheets(document,root);
    assert.equal(document.rows.length,3);assert.equal(document.sheets[1].rows[0].Value,4);
    const persisted=JSON.parse(JSON.stringify(document));assert.equal(persisted.rows,undefined);assert.equal(persisted.sheets[0].rows,undefined);
    attachStoredSheets(persisted,root);assert.equal(persisted.rows[0].Item,'A');
  }finally{clearSheetCache();fs.rmSync(root,{recursive:true,force:true});}
});

test('bounded worker admission and cancellation release capacity before the next parse',async()=>{
  const buffer=await fixture(),controller=new AbortController();
  const cancelled=parseSpreadsheetInWorker(buffer,'xlsx',{signal:controller.signal,onProgress:()=>controller.abort()});
  if(parserLimits.concurrency===1)await assert.rejects(parseSpreadsheetInWorker(buffer,'xlsx'),{code:'PARSER_BUSY'});
  await assert.rejects(cancelled,{code:'PARSER_CANCELLED'});
  const sheets=await parseSpreadsheetInWorker(Buffer.from('A,B\n1,2\n'),'csv');assert.equal(sheets[0].rows.length,1);
});

test('worker resource settings are bounded and retain a 256 MiB default',()=>{
  const keys=['SPREADSHEET_WORKER_HEAP_MB','SPREADSHEET_WORKERS','SPREADSHEET_TIMEOUT_MS'];const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    keys.forEach(key=>delete process.env[key]);assert.equal(parserLimits.heapMiB,256);assert.equal(parserLimits.concurrency,1);assert.equal(parserLimits.timeoutMs,30000);
    process.env.SPREADSHEET_WORKER_HEAP_MB='999999';process.env.SPREADSHEET_WORKERS='1000';process.env.SPREADSHEET_TIMEOUT_MS='999999';
    assert.equal(parserLimits.heapMiB,512);assert.equal(parserLimits.concurrency,2);assert.equal(parserLimits.timeoutMs,120000);
  }finally{for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
});

test('a timed out worker is terminated and the next parse can start',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  try{
    const parsing=parseSpreadsheetInWorker(Buffer.from('A\n1\n'),'csv');
    const rejected=assert.rejects(parsing,{code:'PARSER_TIMEOUT'});
    context.mock.timers.tick(parserLimits.timeoutMs);
    await rejected;
  }finally{context.mock.timers.reset();}
  const sheets=await parseSpreadsheetInWorker(Buffer.from('A\n1\n'),'csv');assert.equal(sheets[0].rows.length,1);
});
