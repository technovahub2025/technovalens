// Optional UI smoke test. Install Playwright separately, or set PLAYWRIGHT_MODULE
// to an existing Playwright package path; uses only isolated temporary data.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '../..');
const directory = await mkdtemp(path.join(os.tmpdir(), 'technovalens-ui-'));
const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(r => socket.close(r));
const children = []; let browser;
function start(script, cwd, env, args = []) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env }, stdio: 'ignore' }); children.push(child); return child;
}
async function ready(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Server failed to start: ${url}`);
}
try {
  start('server.js', path.join(root, 'backend'), { PORT: String(port), CONVERSATION_STORAGE: 'file', DOCUMENT_STORE_DIR: path.join(directory, 'uploads'), GEMINI_API_KEY: '' });
  await ready(`http://localhost:${port}/api/health`);
  const vite = start('node_modules/vite/bin/vite.js', path.join(root,'frontend'), { VITE_API_URL: `http://localhost:${port}` }, ['--host','localhost','--port','5173','--strictPort']);
  await ready('http://localhost:5173/technovalens/');
  assert.equal(vite.exitCode,null,'Port 5173 must be free for this isolated test.');
  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport: { width:1440, height:1000 } });
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:5173/technovalens/');
  await page.locator('.nav-item').filter({hasText:'Excel Files'}).click();
  const workbook=new ExcelJS.Workbook(); workbook.addWorksheet('Sales').addRows([['Date','Region','Revenue'],['2026-01-01','North',100],['2026-02-01','South',50],['2026-03-01','North',200]]);
  workbook.addWorksheet('Inventory').addRows([['SKU','Warehouse','Quantity'],['P1','A',10],['P2','B',20]]);
  await page.locator('input[type=file]').setInputFiles({name:'browser-workbook.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(await workbook.xlsx.writeBuffer())});
  await page.getByText('Successfully uploaded browser-workbook.xlsx',{exact:false}).waitFor({timeout:20000});
  await page.locator('.nav-item').filter({hasText:'Reports'}).click();
  await page.getByText('Analysis complete',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Worksheet').inputValue(),'Sales');
  assert.equal(await page.locator('.insight-kpi').filter({hasText:'Records'}).locator('strong').textContent(),'3');
  assert.ok(await page.locator('.recharts-surface').count()>=3);
  await page.getByLabel('Filter column',{exact:true}).selectOption('Region');
  await page.getByLabel('Exact category value').fill('North');
  await page.waitForTimeout(600); await page.getByText('Analysis complete',{exact:true}).waitFor();
  assert.equal(await page.locator('.insight-kpi').filter({hasText:'Records'}).locator('strong').textContent(),'2');
  await page.locator('.nav-item').filter({hasText:'Reports'}).click();
  await page.getByRole('heading',{name:'Notable findings'}).waitFor();
  assert.equal(await page.getByLabel('Exact category value').inputValue(),'North');
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF'}).click();const pdf=await downloaded; assert.match(pdf.suggestedFilename(),/report\.pdf$/);
  await page.getByLabel('Worksheet').selectOption('Inventory');await page.waitForTimeout(600);await page.getByText('Analysis complete',{exact:true}).waitFor();
  await page.reload();await page.locator('.nav-item').filter({hasText:'Reports'}).click();await page.getByText('Analysis complete',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Worksheet').inputValue(),'Inventory');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(directory,'analytics-mobile.png'),fullPage:true});
  const overflow = await page.locator('.insights-page').evaluate(el => [...el.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > el.getBoundingClientRect().right + 2 && !n.closest('.quality-table-wrap,.data-table-wrap')).map(n => ({tag:n.tagName,cls:n.className,width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right})).slice(0,20));
  if (overflow.length) console.log('Overflow diagnostics:', JSON.stringify(overflow));
  assert.equal(await page.locator('.insights-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Reports should fit the mobile viewport');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.nav-item').filter({hasText:'Excel Files'}).click();
  await page.locator('input[type=file]').setInputFiles({name:'new-students.csv',mimeType:'text/csv',buffer:Buffer.from('Student,Score\nA,80\nB,100\n')});
  await page.getByText('Successfully uploaded new-students.csv',{exact:false}).waitFor();
  await page.locator('.nav-item').filter({hasText:'Reports'}).click();
  await page.getByText('Analysis complete',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Workbook',{exact:true}).locator('option:checked').textContent(),'new-students.csv');
  await page.getByLabel('Workbook',{exact:true}).selectOption({label:'browser-workbook.xlsx'});
  await page.getByText('Analysis complete',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Worksheet').inputValue(),'Inventory');
  assert.deepEqual(errors,[]); console.log('UI smoke passed: upload, Recharts, filters, Reports, PDF download, worksheet persistence, mobile width, no runtime errors.');
} finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode !== null) continue; const ended=once(child,'exit');child.kill();await ended; }
  await rm(directory,{recursive:true,force:true});
}
