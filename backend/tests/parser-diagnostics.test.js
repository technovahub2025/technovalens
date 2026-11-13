import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createParserTimings } from '../parser-timings.js';
import { parseSpreadsheetInWorker, parserLimits } from '../spreadsheet-parser.js';

test('stage timing records cumulative and per-sheet spans without double counting a finished span', () => {
  let now = 0;
  const timings = createParserTimings(() => now);
  const xml = timings.span('xmlMs', 1);now = 10;
  const write = timings.span('storageWriteMs', 1);now = 15;write();write();now = 25;xml();
  const result = timings.snapshot();
  assert.equal(result.xmlMs,25);assert.equal(result.storageWriteMs,5);
  assert.deepEqual(result.worksheets,[{worksheetIndex:1,storageWriteMs:5,xmlMs:25}]);
});

test('successful worker metrics include startup, storage, analysis, heartbeat-compatible progress and bounded timeout configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'technovalens-timings-'));
  const progress = [];
  try {
    const sheets = await parseSpreadsheetInWorker(Buffer.from('Item,Quantity\nA,10\nB,20\n'), 'csv', {outputDir:directory,onProgress:event=>progress.push(event)});
    const metrics = sheets.metrics;
    for(const key of ['startupMs','shutdownMs','inputTransferMs','totalElapsedMs','elapsedMs'])assert.ok(Number.isFinite(metrics[key])&&metrics[key]>=0,key);
    assert.equal(metrics.timeoutMs,parserLimits.timeoutMs);assert.equal(metrics.heapLimitMiB,256);
    assert.ok(metrics.totalElapsedMs>=metrics.elapsedMs);
    assert.equal(metrics.timings.worksheets.length,1);
    assert.ok(metrics.timings.storageWriteMs>0);assert.ok(metrics.timings.analysisMs>0);
    assert.ok(progress.some(event=>event.stage==='worker-started'));
    assert.ok(progress.some(event=>event.stage==='worksheet-analysis'));
    assert.ok(progress.every(event=>Number.isFinite(event.elapsedMs)&&event.timeoutMs===parserLimits.timeoutMs));
    const previous = process.env.SPREADSHEET_TIMEOUT_MS;
    try{process.env.SPREADSHEET_TIMEOUT_MS='120000';assert.equal(parserLimits.timeoutMs,120000);process.env.SPREADSHEET_TIMEOUT_MS='900000';assert.equal(parserLimits.timeoutMs,120000);}
    finally{if(previous===undefined)delete process.env.SPREADSHEET_TIMEOUT_MS;else process.env.SPREADSHEET_TIMEOUT_MS=previous;}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('real HTTP timeout removes partial files and cancellation remains reliable with the 120-second diagnostic budget', {timeout:30000}, async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'technovalens-deadline-'));
  const headers={'X-Workspace-Token':crypto.randomBytes(32).toString('hex')};
  let child,base,logs='';
  const stop=async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}};
  const start=async timeout=>{
    const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));base=`http://127.0.0.1:${port}`;
    child=spawn(process.execPath,['--import',new URL('./fixtures/slow-spreadsheet-worker.mjs',import.meta.url).href,'server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),CONVERSATION_STORAGE:'file',DOCUMENT_STORE_DIR:path.join(directory,'uploads'),GEMINI_API_KEY:'',SPREADSHEET_TIMEOUT_MS:String(timeout),SPREADSHEET_WORKER_HEAP_MB:'256',SPREADSHEET_WORKERS:'1'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
    let ready=false;for(let i=0;i<150;i++){try{if((await fetch(`${base}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready);
  };
  const request=(route,options={})=>fetch(`${base}/api${route}`,{...options,headers});
  const upload=job=>{const form=new FormData();form.append('file',new Blob(['Name,Value\nA,10\n']),'timing-test.csv');return request(`/files/upload?job=${job}`,{method:'POST',body:form});};
  const waitClean=async job=>{
    let progress;for(let i=0;i<100;i++){progress=await (await request(`/files/upload-status/${job}`)).json();if(progress.cleanupComplete)break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(progress.stage,'failed');assert.equal(progress.cleanupComplete,true);
    assert.deepEqual(await readdir(path.join(directory,'uploads')),[]);
    assert.deepEqual(await (await request('/files')).json(),[]);
    assert.deepEqual(await (await request('/conversations')).json(),[]);
    return progress;
  };
  try {
    await start(1000);
    const job=crypto.randomUUID(),response=await upload(job);assert.equal(response.status,400);assert.equal((await response.json()).code,'PARSER_TIMEOUT');
    const failed=await waitClean(job);assert.equal(failed.parserMetrics.timeoutMs,1000);assert.equal(failed.parserMetrics.lastStage,'worker-starting');assert.ok(failed.parserMetrics.elapsedMs>=1000);
    assert.match(logs,/Spreadsheet worker stopped/);assert.match(logs,/PARSER_TIMEOUT/);
    await stop();await start(120000);
    const cancelJob=crypto.randomUUID(),pending=upload(cancelJob);
    let active;
    for(let i=0;i<100;i++){const result=await request(`/files/upload-status/${cancelJob}`);if(result.ok){active=await result.json();if(active.heartbeat)break;}await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(active.heartbeat,true,'progress heartbeats must continue while worker startup is delayed');assert.equal(active.timeoutMs,120000);assert.ok(active.elapsedMs>=900);
    assert.equal((await request(`/files/upload-status/${cancelJob}`,{method:'DELETE'})).status,202);
    const cancelled=await pending;assert.equal((await cancelled.json()).code,'PARSER_CANCELLED');
    await waitClean(cancelJob);
    const completed=await upload(crypto.randomUUID());assert.equal(completed.status,200,'cancellation must release worker and ingress capacity');
    const data=await completed.json();assert.equal(data.parserMetrics.timeoutMs,120000);assert.equal(data.parserMetrics.heapLimitMiB,256);assert.ok(data.parserMetrics.startupMs>=1400);assert.ok(data.parserMetrics.finalizationMs>=0);
    assert.equal((await request(`/files/${data.fileId}`,{method:'DELETE'})).status,200);
  } finally {await stop();await rm(directory,{recursive:true,force:true});}
});
