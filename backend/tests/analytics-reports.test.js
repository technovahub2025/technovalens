import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { analyzeDataset, previewDataset } from '../analytics.js';
import { parseNumeric } from '../analytics.js';
import { parseSpreadsheet } from '../spreadsheet-parser.js';
import { createExcelReport, createPdfReport } from '../reports.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
  assert.equal(restored.worksheets.length,5);
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
    const form=new FormData();form.append('file',new Blob([await fixture()]),'all-domains.xlsx');
    const upload=await request('/api/files/upload',tokenA,{method:'POST',body:form});assert.equal(upload.status,200);const file=await upload.json();
    const pathA=`/api/analytics/${file.fileId}`;
    assert.equal((await request(pathA)).status,200);
    assert.equal((await request(`${pathA}?sheet=missing`)).status,400);
    for(const endpoint of [`/api/files/${file.fileId}`,pathA,`${pathA}/preview`,`/api/reports/${file.fileId}.pdf`,`/api/reports/${file.fileId}.xlsx`,`/api/conversations/${file.conversationId}`]) assert.equal((await request(endpoint,tokenB)).status,404,endpoint);
    assert.deepEqual(await (await request('/api/files',tokenB)).json(),[]);
    assert.deepEqual(await (await request('/api/conversations',tokenB)).json(),[]);
    assert.equal((await request(`/api/files/${file.fileId}`,tokenB,{method:'DELETE'})).status,404);
    assert.equal((await request(`/api/conversations/${file.conversationId}`,tokenB,{method:'DELETE'})).status,404);
    assert.equal((await request('/api/ai/ask',tokenB,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:file.fileId,question:'How many rows?'})})).status,404);
    const preview=await (await request(`${pathA}/preview?sheet=Inventory&sort=Quantity&direction=desc&pageSize=1&page=2`)).json();assert.equal(preview.rows[0].Quantity,0);
    const pdf=await request(`/api/reports/${file.fileId}.pdf?sheet=Sales`); assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
    const excel=await request(`/api/reports/${file.fileId}.xlsx?sheet=Sales&categoryColumn=Region&categoryValue=North`);assert.equal(excel.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await excel.arrayBuffer()));assert.equal(wb.getWorksheet('Selected Data').rowCount,3);
    await stop();await start();assert.equal((await request(pathA)).status,200);assert.equal((await request(pathA,tokenB)).status,404);
  } finally {await stop();await rm(dir,{recursive:true,force:true});}
});
