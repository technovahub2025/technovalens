import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { analyzeDataset, previewDataset } from '../analytics.js';
import { parseNumeric } from '../analytics.js';
import { parseSpreadsheet, parseSpreadsheetInWorker, validateSheets } from '../spreadsheet-parser.js';
import JSZip from 'jszip';
import { prepareXlsx } from '../xlsx-compat.js';
import { validateUpload, validateFileMetadata, validateAnalysis, validatePreview, fileDimensions } from '../../frontend/src/api-contracts.js';
import { createExcelReport, createPdfReport } from '../reports.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function fixture() {
  const workbook = new ExcelJS.Workbook();
  const sales = workbook.addWorksheet('Sales');
  sales.addRows([['Date', 'Region', 'Revenue'], ['2026-01-01', 'North', 100], ['2026-02-01', 'South', 50], ['2026-01-01', 'North', 100], ['2026-03-01', 'South', null]]);
  workbook.addWorksheet('Employees').addRows([['Name','Department','Salary'], ['A','Engineering',1000], ['B','HR',800], ['C','HR',null]]);
  workbook.addWorksheet('Students').addRows([['Student','Class','Score'], ['A','X',80], ['B','X',100], ['C','Y',60]]);
  workbook.addWorksheet('Inventory').addRows([['SKU','Warehouse','Quantity'], ['P1','A',20], ['P2','B',0], ['P3','A',-5]]);
  workbook.addWorksheet('Empty');
  workbook.addWorksheet('Headers').addRow(['Name','Name',null,'Name (2)']);
  const formulas = workbook.addWorksheet('Formulas');
  formulas.addRows([['Cached','Uncached','Error'], [{formula:'1+1',result:2}, {formula:'2+2'}, {error:'#DIV/0!'}]]);
  return workbook.xlsx.writeBuffer();
}

async function prefixedFixture(workbookOnly = false) {
  const zip = await JSZip.loadAsync(await fixture());
  for (const entry of Object.values(zip.files)) {
    if (!/^xl\/(workbook\.xml|styles\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(entry.name)) continue;
    if (workbookOnly && entry.name !== 'xl/workbook.xml') continue;
    let xml = await entry.async('string');
    xml = xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
      .replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g, '<$1x:$2')
      .replace(/xmlns:r=/g, 'xmlns:rel=').replace(/\br:id=/g, 'rel:id=');
    zip.file(entry.name, xml);
  }
  return zip.generateAsync({type:'nodebuffer'});
}

test('regression: prefixed OOXML reproduces undefined workbook.sheets in ExcelJS and loads all sheets through our parser', async () => {
  const buffer = await prefixedFixture(true);
  await assert.rejects(new ExcelJS.Workbook().xlsx.load(buffer), /Cannot read properties of undefined \(reading 'sheets'\)/);
  const expected = await parseSpreadsheet(await fixture(), 'xlsx');
  assert.deepEqual(await parseSpreadsheet(buffer, 'xlsx'), expected);
  assert.deepEqual(await parseSpreadsheetInWorker(buffer, 'xlsx'), expected);
  assert.deepEqual(await parseSpreadsheetInWorker(await prefixedFixture(), 'xlsx'), expected);
  const csv = await parseSpreadsheetInWorker(Buffer.from('Name,Score\nA,80\nB,100\n'), 'csv');
  assert.equal(csv[0].rows.length, 2);
  for (const invalid of [undefined, {}, [], [undefined], [{name:'Broken', rows:[]}], [{name:'Broken',columns:['A'],rows:[{}]}]]) {
    assert.throws(() => validateSheets(invalid), /worksheet/i);
  }
});

test('standard Excel XLSX remains byte-for-byte unchanged and prefixed normalization preserves relationships', async () => {
  const buffer = await fixture();
  const prepared = await prepareXlsx(buffer);
  assert.equal(prepared.buffer, buffer, 'standard OOXML must bypass rewriting');
  assert.deepEqual(prepared.normalizedParts, []);
  const prefixed = await prefixedFixture();
  const normalized = await prepareXlsx(prefixed);
  assert.ok(normalized.normalizedParts.includes('xl/workbook.xml'));
  const before = await JSZip.loadAsync(prefixed), after = await JSZip.loadAsync(normalized.buffer);
  assert.deepEqual(Object.keys(before.files), Object.keys(after.files));
  for (const entry of Object.values(before.files)) {
    if (!entry.dir && !normalized.normalizedParts.includes(entry.name)) {
      assert.deepEqual(await after.file(entry.name).async('nodebuffer'), await entry.async('nodebuffer'), entry.name);
    }
  }
  assert.deepEqual(await parseSpreadsheet(normalized.buffer, 'xlsx'), await parseSpreadsheet(buffer, 'xlsx'));
});

test('Node watch dependency messages do not masquerade as spreadsheet results for XLSX, CSV or errors', async () => {
  const original = process.env.WATCH_REPORT_DEPENDENCIES;
  process.env.WATCH_REPORT_DEPENDENCIES = '1';
  try {
    const sheets = await parseSpreadsheetInWorker(await fixture(), 'xlsx');
    assert.equal(sheets.length, 7);assert.equal(sheets[0].rows.length, 4);
    const csv = await parseSpreadsheetInWorker(Buffer.from('Name,Value\nA,1\n'), 'csv');
    assert.equal(csv.length, 1);assert.equal(csv[0].rows[0].Value, '1');
    await assert.rejects(parseSpreadsheetInWorker(Buffer.from('invalid'), 'xlsx'), /Invalid XLSX archive/);
  } finally {
    if (original === undefined) delete process.env.WATCH_REPORT_DEPENDENCIES;
    else process.env.WATCH_REPORT_DEPENDENCIES = original;
  }
});

test('invalid XML, unsupported namespaces and missing worksheet relationships fail explicitly', async () => {
  const buffer = await fixture();
  for (const [modify, message] of [
    [zip => zip.remove('xl/workbook.xml'), /workbook.xml is missing/],
    [zip => zip.file('xl/workbook.xml','<workbook>'), /Invalid XLSX XML/],
    [async zip => zip.file('xl/workbook.xml',(await zip.file('xl/workbook.xml').async('string')).replace('spreadsheetml/2006/main','spreadsheetml/2099/main')), /namespace/],
    [zip => zip.remove('xl/worksheets/sheet2.xml'), /declared worksheets/]
  ]) {
    const zip = await JSZip.loadAsync(buffer); await modify(zip);
    await assert.rejects(parseSpreadsheetInWorker(await zip.generateAsync({type:'nodebuffer'}), 'xlsx'), message);
  }
});

test('frontend contracts reject incomplete successful responses before setting Ready or rendering nested analytics', () => {
  const file = {fileId:'test',fileName:'test.xlsx',kind:'spreadsheet',sheetName:'Sales',sheetNames:['Sales','Inventory'],sheetCount:2,rowCount:4,totalRowCount:7,columnCount:3,columns:['Date','Region','Revenue'],preview:[],conversationId:'chat'};
  assert.equal(validateUpload(file),file);
  assert.match(fileDimensions(file), /7 rows · 2 worksheets/);
  const pdf = {fileId:'pdf',fileName:'test.pdf',kind:'pdf',pageCount:5};
  assert.equal(validateFileMetadata(pdf),pdf); assert.equal(fileDimensions(pdf),'5 pages');
  for (const invalid of [undefined, {}, {...file,sheetNames:undefined}, {...file,rowCount:undefined}, {...file,conversationId:undefined}]) assert.throws(() => validateUpload(invalid), /incomplete|complete upload/);
  for (const invalid of [undefined, {}, {types:{}}, {charts:{}}]) assert.throws(() => validateAnalysis(invalid), /incomplete worksheet analytics/);
  assert.throws(() => validatePreview({rows:[]}), /incomplete worksheet preview/);
});

test('multi-sheet sales, employee, student and inventory workbooks calculate actual metrics', async () => {
  const sheets = await parseSpreadsheet(await fixture(), 'xlsx');
  assert.equal(sheets.length, 7);
  const sales = analyzeDataset(sheets[0]);
  assert.equal(sales.rowCount,4); assert.equal(sales.duplicateRows,1); assert.equal(sales.missingValues,1);
  assert.equal(sales.columnStats.Revenue.sum,250); assert.equal(sales.columnStats.Revenue.average,250/3);
  assert.deepEqual(sales.types.date,['Date']);
  assert.deepEqual(sales.charts.trend.data,[{period:'2026-01',value:200},{period:'2026-02',value:50}]);
  assert.equal(analyzeDataset(sheets[1]).columnStats.Salary.sum,1800);
  assert.equal(analyzeDataset(sheets[2]).columnStats.Score.average,80);
  assert.equal(analyzeDataset(sheets[3]).columnStats.Quantity.sum,15);
  assert.equal(analyzeDataset(sheets[4]).rowCount,0);
  assert.equal(new Set(sheets[5].columns).size,4); assert.equal(sheets[5].columns[2],'Column 3');
  assert.equal(sheets[6].rows[0].Cached,2); assert.equal(sheets[6].rows[0].Uncached,null);
  assert.equal(sheets[6].formulaCount,2); assert.equal(sheets[6].uncachedFormulas,1);
  assert.match(analyzeDataset(sheets[6]).warnings[0], /not recalculated/);
});

test('filters update charts, numeric sorting, pagination, quality and stable schema', () => {
  const sheet = {name:'Mixed', columns:['Group','Value','Date'], rows:Array.from({length:20},(_,i)=>({Group:i%2?'A':'B',Value:i===19?'bad':i,Date:'2026-01-01'}))};
  const filtered = analyzeDataset(sheet,{categoryColumn:'Group',categoryValue:'A'});
  assert.equal(filtered.rowCount,10); assert.equal(filtered.columnStats.Value.invalid,1);
  assert.equal(filtered.charts.pie.reduce((n,r)=>n+r.count,0),10);
  assert.deepEqual(filtered.categories.Group,['B','A']);
  const page = previewDataset(sheet,{sort:'Value',direction:'asc',page:2,pageSize:5});
  assert.equal(page.rows[0].Value,5); assert.equal(page.totalPages,4);
  assert.equal(previewDataset(sheet,{search:'no-match',page:99}).page,1);
  assert.equal(analyzeDataset(sheet,{search:'no-match'}).columnStats.Value.type,'numeric');
  assert.equal(analyzeDataset(sheet,{search:'no-match'}).columnStats.Value.average,null);
  assert.equal(analyzeDataset(sheet).charts.pie.reduce((n,r)=>n+r.count,0),20);
});

test('CSV headers, empty files, duplicates, mixed types and chart coverage', async () => {
  assert.equal(parseNumeric('12%3'),null); assert.equal(parseNumeric('12 34'),null);
  assert.equal(parseNumeric('1,23'),null); assert.equal(parseNumeric('1e3'),1000);
  assert.equal(parseNumeric('€1,250.50'),1250.5); assert.equal(parseNumeric('(£25)'),-25);
  const [headers] = await parseSpreadsheet(Buffer.from('A,A,,A (2)\n1,2,3,4\n'), 'csv');
  assert.equal(headers.columns.length,4); assert.equal(new Set(headers.columns).size,4);
  const [empty] = await parseSpreadsheet(Buffer.from(''), 'csv'); assert.equal(analyzeDataset(empty).columnCount,0);
  const [onlyHeaders] = await parseSpreadsheet(Buffer.from('Name,Score\n'), 'csv'); assert.equal(analyzeDataset(onlyHeaders).columnCount,2);
  const rows = Array.from({length:100},(_,i)=>({Group:`G${i%20}`,Count:i}));
  const summary = analyzeDataset({name:'Groups',rows});
  assert.equal(summary.charts.pie.reduce((n,r)=>n+r.count,0),100);
  assert.equal(summary.charts.bar.omittedGroups,8);
  assert.ok(!summary.kpis.some(k=>/revenue/i.test(k.label)));
  await assert.rejects(parseSpreadsheet(Buffer.from('abc\0def'),'csv'), /UTF-8/);
  await assert.rejects(parseSpreadsheet(Buffer.from('not a zip'),'xlsx'), /Invalid/);
  await assert.rejects(parseSpreadsheet(Buffer.from(Array.from({length:257},(_,i)=>`C${i}`).join(',')),'csv'), /256 columns/);
  const invalidDates = analyzeDataset({name:'Invalid dates',rows:[{Date:'2026-02-31',Amount:1},{Date:'2026-02-31',Amount:2}]});
  assert.equal(invalidDates.types.date.length,0); assert.equal(invalidDates.charts.trend.data.length,0);
});

test('Excel and paginated PDF exports contain real summaries, charts and all column profiles', async () => {
  const sheets = await parseSpreadsheet(await fixture(),'xlsx');
  const doc = {name:'real-data.xlsx',sheets}; const stats = analyzeDataset(sheets[0]);
  const workbook = createExcelReport(doc,sheets[0],stats,'2026-11-12T08:30:00Z');
  const restored = new ExcelJS.Workbook(); await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(restored.worksheets.length,6);
  assert.equal(restored.getWorksheet('Selected Data').rowCount,5);
  assert.equal(restored.getWorksheet('Column Statistics').getRow(4).getCell(8).value,250);
  const wide = {name:'Wide',columns:Array.from({length:70},(_,i)=>`Column ${i}`),rows:[Object.fromEntries(Array.from({length:70},(_,i)=>[`Column ${i}`,i]))]};
  const pdfStats = {...analyzeDataset(wide), charts:stats.charts};
  const pdf = createPdfReport(doc,wide,pdfStats,'2026-11-12T08:30:00Z');
  const parts=[]; pdf.on('data',p=>parts.push(p)); const ended = new Promise((resolve,reject)=>{pdf.on('end',resolve);pdf.on('error',reject);}); pdf.end(); await ended;
  const buffer=Buffer.concat(parts); assert.equal(buffer.subarray(0,5).toString(),'%PDF-');
  const {PDFParse}=await import('pdf-parse'); const parser = new PDFParse({data:buffer});
  try { const result=await parser.getText(); assert.ok(result.total>=4); assert.match(result.text,/real-data.xlsx/); assert.match(result.text,/Column 69/); assert.match(result.text,/Revenue by month/); assert.match(result.text,/1 \/ /); } finally { await parser.destroy(); }
});

test('workspace isolation protects uploads, analytics, reports and conversations across restart', {timeout:30000}, async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'technovalens-reports-'));
  let child; let base;
  const tokenA='a'.repeat(64), tokenB='b'.repeat(64);
  const request=(url,token=tokenA,options={})=>fetch(`${base}${url}`,{...options,headers:{'X-Workspace-Token':token,...options.headers}});
  const start=async()=>{
    const net=await import('node:net');const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));base=`http://127.0.0.1:${port}`;
    child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),CONVERSATION_STORAGE:'file',DOCUMENT_STORE_DIR:path.join(dir,'uploads'),GEMINI_API_KEY:''},stdio:'ignore'});
    for(let i=0;i<150;i++){try{if((await fetch(`${base}/api/health`)).ok)return;}catch{} await new Promise(r=>setTimeout(r,50));}throw new Error('Test backend failed to start');
  };
  const stop=async()=>{if(!child||child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;};
  try {
    await start();
    assert.equal((await fetch(`${base}/api/files`)).status,401);
    const form=new FormData();form.append('file',new Blob([await prefixedFixture()]),'all-domains.xlsx');
    const upload=await request('/api/files/upload',tokenA,{method:'POST',body:form});assert.equal(upload.status,200);const file=await upload.json();
    validateUpload(file);assert.equal(file.sheetCount,7);assert.equal(file.totalRowCount,14);assert.equal(file.rowCount,4);assert.equal(file.pageCount,undefined);
    assert.equal(file.analysis.columnStats.Revenue.sum,250);
    const detail=await (await request(`/api/files/${file.fileId}`)).json();validateFileMetadata(detail);assert.equal(detail.totalRowCount,14);
    const listed=await (await request('/api/files')).json();assert.equal(listed[0].sheetCount,7);assert.equal(listed[0].fileId,file.fileId);
    const pathA=`/api/analytics/${file.fileId}`;
    const analysis=await (await request(pathA)).json();validateAnalysis(analysis);assert.equal(analysis.rowCount,4);assert.equal(analysis.sheetCount,7);
    for(const [sheet,column,sum] of [['Employees','Salary',1800],['Students','Score',240],['Inventory','Quantity',15]]) {
      const result=await (await request(`${pathA}?sheet=${sheet}`)).json();validateAnalysis(result);assert.equal(result.columnStats[column].sum,sum);
    }
    assert.equal((await request(`${pathA}?sheet=missing`)).status,400);
    for(const endpoint of [`/api/files/${file.fileId}`,pathA,`${pathA}/preview`,`/api/reports/${file.fileId}.pdf`,`/api/reports/${file.fileId}.xlsx`,`/api/conversations/${file.conversationId}`]) assert.equal((await request(endpoint,tokenB)).status,404,endpoint);
    assert.deepEqual(await (await request('/api/files',tokenB)).json(),[]);
    assert.deepEqual(await (await request('/api/conversations',tokenB)).json(),[]);
    assert.equal((await request(`/api/files/${file.fileId}`,tokenB,{method:'DELETE'})).status,404);
    assert.equal((await request(`/api/conversations/${file.conversationId}`,tokenB,{method:'DELETE'})).status,404);
    assert.equal((await request('/api/ai/ask',tokenB,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:file.fileId,question:'How many rows?'})})).status,404);
    const preview=await (await request(`${pathA}/preview?sheet=Inventory&sort=Quantity&direction=desc&pageSize=1&page=2`)).json();validatePreview(preview);assert.equal(preview.rows[0].Quantity,0);
    const pdf=await request(`/api/reports/${file.fileId}.pdf?sheet=Sales`); assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
    const excel=await request(`/api/reports/${file.fileId}.xlsx?sheet=Sales&categoryColumn=Region&categoryValue=North`);assert.equal(excel.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await excel.arrayBuffer()));assert.equal(wb.getWorksheet('Selected Data').rowCount,3);
    const csvForm=new FormData();csvForm.append('file',new Blob(['Name,Score\nA,80\nB,100\n'],{type:'text/csv'}),'scores.csv');
    const csvResponse=await request('/api/excel/upload',tokenA,{method:'POST',body:csvForm});assert.equal(csvResponse.status,200);const csv=await csvResponse.json();validateUpload(csv);
    assert.equal(csv.rowCount,2);assert.equal(csv.sheetCount,1);assert.equal(csv.totalRowCount,2);assert.equal(csv.pageCount,undefined);
    const csvAnalysis=await (await request(`/api/analytics/${csv.fileId}`)).json();validateAnalysis(csvAnalysis);assert.equal(csvAnalysis.columnStats.Score.average,90);
    assert.equal((await request(`/api/reports/${csv.fileId}.xlsx`)).status,200);assert.equal((await request(`/api/reports/${csv.fileId}.pdf`)).status,200);
    const pdfForm=new FormData();pdfForm.append('file',new Blob([await (await request(`/api/reports/${file.fileId}.pdf`)).arrayBuffer()],{type:'application/pdf'}),'report.pdf');
    const pdfResponse=await request('/api/files/upload',tokenA,{method:'POST',body:pdfForm});assert.equal(pdfResponse.status,200);const pdfFile=await pdfResponse.json();validateUpload(pdfFile);
    assert.ok(pdfFile.pageCount>0);assert.equal(pdfFile.rowCount,undefined);assert.equal(pdfFile.sheetCount,undefined);
    const beforeFailure=await (await request('/api/files')).json();
    const storedBeforeFailure=await readdir(path.join(dir,'uploads'));
    const invalidZip=await JSZip.loadAsync(await fixture());invalidZip.file('xl/workbook.xml','<invalid/>');
    for(const [filename,buffer] of [['bad.xlsx',await invalidZip.generateAsync({type:'nodebuffer'})],['bad.csv',Buffer.from('A\n\0')]]) {
      const failedForm=new FormData();failedForm.append('file',new Blob([buffer]),filename);
      const failed=await request('/api/files/upload',tokenA,{method:'POST',body:failedForm});assert.equal(failed.status,400);
      const error=await failed.json();assert.match(error.error,/Could not read this spreadsheet/);assert.doesNotMatch(error.error,/Cannot read properties/);
      assert.deepEqual(await (await request('/api/files')).json(),beforeFailure);
      assert.deepEqual(await readdir(path.join(dir,'uploads')),storedBeforeFailure);
    }
    const brokenId='12345678-1234-1234-1234-123456789abc';
    await writeFile(path.join(dir,'uploads',`${brokenId}.json`),JSON.stringify({fileId:brokenId,kind:'spreadsheet',name:'incomplete.xlsx'}));
    await stop();await start();assert.equal((await request(pathA)).status,200);assert.equal((await request(pathA,tokenB)).status,404);
    assert.equal((await request(`/api/files/${brokenId}`)).status,404);
    assert.equal((await request(`/api/analytics/${brokenId}`)).status,404);
    assert.deepEqual(await (await request('/api/files')).json(),beforeFailure);
  } finally {await stop();await rm(dir,{recursive:true,force:true});}
});
