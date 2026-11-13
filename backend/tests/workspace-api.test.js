import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { createWorkspaceIdentity } from '../../frontend/src/workspace.js';
import { createWorkspaceApi } from '../../frontend/src/api.js';
import { validateUpload, validateAnalysis, validatePreview } from '../../frontend/src/api-contracts.js';

test('real frontend client uploads under Node watch dependency reporting, refreshes, analyzes and downloads reports', {timeout:45000}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'technovalens-workspace-client-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd:path.resolve(import.meta.dirname,'..'),
    env:{...process.env,PORT:String(port),CONVERSATION_STORAGE:'file',DOCUMENT_STORE_DIR:path.join(directory,'uploads'),GEMINI_API_KEY:'',WATCH_REPORT_DEPENDENCIES:'1'},
    stdio:['ignore','pipe','pipe']
  });
  let logs='';
  child.stdout.on('data',chunk=>{logs+=chunk;});
  child.stderr.on('data',()=>{});
  try {
    let ready = false;
    for (let i=0;i<150;i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) { ready=true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.ok(ready,'isolated backend must start');
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health.workspaceAuth,{version:1,header:'X-Workspace-Token'});
    const form = () => { const body=new FormData();body.append('file',new Blob(['Name,Score\nA,80\nB,100\n']),'scores.csv');return body; };
    for (const token of [undefined,'invalid','A'.repeat(64)]) {
      const rejected = await fetch(`${base}/api/files/upload`,{method:'POST',body:form(),headers:token?{'X-Workspace-Token':token}:{}});
      assert.equal(rejected.status,401);assert.equal((await rejected.json()).code,'WORKSPACE_TOKEN_REQUIRED');
      assert.equal(rejected.headers.get('cache-control'),'no-store');
    }
    assert.deepEqual(await readdir(path.join(directory,'uploads')),[],'unauthorized uploads cannot be stored');
    const values = new Map();
    const store = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
    const identity = () => createWorkspaceIdentity({storage:()=>store});
    const newClient = () => createWorkspaceApi({baseURL:`${base}/api`,pageOrigin:base,identity:identity(),adapter:'fetch'});
    const first = newClient();
    // Axios's Node fetch adapter needs a multipart hint; the browser adapter
    // clears this header itself so the browser supplies its boundary.
    const multipart = {headers:{'Content-Type':'multipart/form-data'}};
    const csv = (await first.client.post('/files/upload',form(),multipart)).data;validateUpload(csv);
    const token = values.get('technovalens.workspaceToken');assert.match(token,/^[a-f0-9]{64}$/);
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sales').addRows([['Region','Revenue'],['North',100],['South',50]]);
    workbook.addWorksheet('Inventory').addRows([['SKU','Quantity'],['A',20]]);
    const xlsx = new FormData();xlsx.append('file',new Blob([await workbook.xlsx.writeBuffer()]),'multi.xlsx');
    const file = (await first.client.post('/files/upload',xlsx,multipart)).data;validateUpload(file);
    assert.equal(file.sheetCount,2);
    assert.deepEqual(file.worksheets,[{name:'Sales',rowCount:2,columnCount:2,headerRow:1},{name:'Inventory',rowCount:1,columnCount:2,headerRow:1}]);
    assert.match(logs,/worker-watch-notification-ignored/,'the HTTP upload must tolerate actual Node worker watch messages');
    // Recreating the browser modules after a refresh must recover the same token.
    const refreshed = newClient();
    const files=(await refreshed.client.get('/files')).data;
    assert.deepEqual(new Set(files.map(f=>f.fileId)),new Set([file.fileId,csv.fileId]));
    assert.equal((await refreshed.client.get(`/files/${file.fileId}`)).data.fileName,'multi.xlsx');
    assert.equal((await refreshed.client.get(`/conversations/${file.conversationId}`)).data.fileId,file.fileId);
    const stats=(await refreshed.client.get(`/analytics/${file.fileId}`,{params:{sheet:'Inventory'}})).data;
    validateAnalysis(stats);assert.equal(stats.columnStats.Quantity.sum,20);
    validatePreview((await refreshed.client.get(`/analytics/${file.fileId}/preview`,{params:{sheet:'Sales'}})).data);
    const chat=await refreshed.client.post('/ai/ask',{fileId:file.fileId,question:'How many rows?'});assert.equal(chat.status,200);
    const progress=await refreshed.workspaceFetch('/ai/ask/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:file.fileId,question:'How many rows?'})});
    assert.equal(progress.status,200);await progress.text();
    for (const format of ['pdf','xlsx']) {
      const response=await refreshed.client.get(`/reports/${file.fileId}.${format}`,{params:{sheet:'Inventory'},responseType:'blob'});
      const buffer=Buffer.from(await response.data.arrayBuffer());
      if(format==='pdf') assert.equal(buffer.subarray(0,5).toString(),'%PDF-');
      else {const report=new ExcelJS.Workbook();await report.xlsx.load(buffer);assert.equal(report.getWorksheet('Selected Data').rowCount,2);}
      assert.ok(!response.request.url.includes(token),'download URLs must not contain the workspace token');
    }
    assert.equal(values.get('technovalens.workspaceToken'),token);
    const beforeCancel=await readdir(path.join(directory,'uploads'));
    const cancelJob=globalThis.crypto.randomUUID(),cancelForm=new FormData();
    cancelForm.append('file',new Blob(['Name,Value\n'+'A,1\n'.repeat(60000)]),'cancel-me.csv');
    const pending=fetch(`${base}/api/files/upload?job=${cancelJob}`,{method:'POST',body:cancelForm,headers:{'X-Workspace-Token':token}});
    let found=false;
    for(let attempt=0;attempt<100;attempt++){
      const progress=await fetch(`${base}/api/files/upload-status/${cancelJob}`,{headers:{'X-Workspace-Token':token}});
      if(progress.ok){found=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(found);
    const overload=await fetch(`${base}/api/files/upload`,{method:'POST',body:form(),headers:{'X-Workspace-Token':token}});
    assert.equal(overload.status,429);assert.equal((await overload.json()).code,'PARSER_BUSY');assert.equal(overload.headers.get('retry-after'),'1');
    const forbiddenCancel=await fetch(`${base}/api/files/upload-status/${cancelJob}`,{method:'DELETE',headers:{'X-Workspace-Token':'f'.repeat(64)}});assert.equal(forbiddenCancel.status,404);
    const cancelled=await first.client.delete(`/files/upload-status/${cancelJob}`);assert.equal(cancelled.status,202);
    const cancelledUpload=await pending;assert.equal(cancelledUpload.status,400);assert.equal((await cancelledUpload.json()).code,'PARSER_CANCELLED');
    assert.deepEqual(await readdir(path.join(directory,'uploads')),beforeCancel,'cancelled parsing must remove all normalized files and metadata');
    const stranger = createWorkspaceApi({baseURL:`${base}/api`,pageOrigin:base,identity:createWorkspaceIdentity({storage:()=>({getItem:()=>null,setItem(){}})}),adapter:'fetch'});
    await assert.rejects(stranger.client.get('/files'),{code:'WORKSPACE_UNAVAILABLE'});
    const otherValues=new Map();const otherStore={getItem:key=>otherValues.get(key)??null,setItem:(key,value)=>otherValues.set(key,value)};
    const other=createWorkspaceApi({baseURL:`${base}/api`,pageOrigin:base,identity:createWorkspaceIdentity({storage:()=>otherStore}),adapter:'fetch'}).client;
    assert.deepEqual((await other.get('/files')).data,[]);
    for(const endpoint of [`/files/${file.fileId}`,`/analytics/${file.fileId}`,`/reports/${file.fileId}.pdf`,`/reports/${file.fileId}.xlsx`]) {
      await assert.rejects(other.get(endpoint),error=>error.response?.status===404);
    }
    const preflight=await fetch(`${base}/api/files/upload`,{method:'OPTIONS',headers:{Origin:'https://technovahub.in','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-workspace-token'}});
    assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/X-Workspace-Token/i);
  } finally {
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await rm(directory,{recursive:true,force:true});
  }
});
