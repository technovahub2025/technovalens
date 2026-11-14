import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {MongoClient} from 'mongodb';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {activityRange,dashboardSummary,WorkspaceActivityStore} from '../dashboard.js';
import {localGreeting,validateDashboard} from '../../frontend/src/dashboard.js';
import {rawFetch} from './auth-test-client.js';
import {FileConversationStore} from '../storage/file-conversation-store.js';

test('dashboard uses all worksheet counts once, excludes PDF rows and deduplicates persisted events',()=>{
  const now=new Date('2026-11-14T12:00:00Z');
  const file={fileId:'one',kind:'spreadsheet',uploadedAt:now.toISOString(),worksheets:[{rowCount:3,columnCount:2},{rowCount:2,columnCount:3}],totalRowCount:5,rowCount:3};
  const summary=dashboardSummary([file,file,{fileId:'pdf',kind:'pdf',pageCount:10,uploadedAt:now.toISOString()}],[{key:'upload:one',kind:'upload',createdAt:now},{key:'question:a',kind:'question',createdAt:now},{key:'question:a',kind:'question',createdAt:now}],{now});
  assert.deepEqual([summary.uploadedFiles,summary.totalRecords,summary.dataColumns,summary.aiQuestions],[2,5,5,1]);
  assert.equal(summary.activity.at(-1).value,3);assert.equal(summary.hasActivity,true);
  const empty=dashboardSummary([],[],{now});assert.deepEqual([empty.uploadedFiles,empty.totalRecords,empty.dataColumns,empty.aiQuestions],[0,0,0,0]);assert.equal(empty.hasActivity,false);
  assert.throws(()=>dashboardSummary([{...file,worksheets:undefined}],[],{now}));
  assert.throws(()=>validateDashboard({uploadedFiles:0}));
});

test('activity ranges use calendar dates in the supplied timezone across midnight and DST',()=>{
  const now=new Date('2026-11-02T06:00:00Z'),events=[
    {key:'q1',kind:'question',createdAt:'2026-11-01T05:30:00Z'}, // first 01:30 in New York
    {key:'q2',kind:'question',createdAt:'2026-11-01T06:30:00Z'}, // repeated 01:30
    {key:'q3',kind:'question',createdAt:'2026-11-02T04:59:59Z'},
    {key:'q4',kind:'question',createdAt:'2026-11-02T05:00:00Z'}
  ];
  const ny=dashboardSummary([],events,{now,timeZone:'America/New_York'});
  assert.equal(ny.activity.find(bin=>bin.date==='2026-11-01').questions,3);assert.equal(ny.activity.at(-1).questions,1);
  const la=activityRange(7,'America/Los_Angeles',new Date('2026-11-14T02:00:00Z'));
  const tokyo=activityRange(7,'Asia/Tokyo',new Date('2026-11-14T02:00:00Z'));
  assert.equal(la.bins.at(-1).date,'2026-11-13');assert.equal(tokyo.bins.at(-1).date,'2026-11-14');
  for(const days of [7,30,90])assert.equal(activityRange(days,'UTC',now).bins.length,days);
  const edge=dashboardSummary([],[{key:'first',kind:'upload',createdAt:'2026-11-08T00:00:00Z'},{key:'outside',kind:'upload',createdAt:'2026-11-07T23:59:59Z'}],{now:new Date('2026-11-14T12:00:00Z')});assert.equal(edge.activity.reduce((sum,bin)=>sum+bin.value,0),1);
  assert.throws(()=>activityRange(8));assert.throws(()=>activityRange(7,'invented/timezone'));
});

test('local greetings follow browser-local hours including exact boundaries',()=>{
  for(const [hour,minute,expected] of [[9,0,'morning'],[14,0,'afternoon'],[20,0,'evening'],[0,0,'evening'],[4,59,'evening'],[5,0,'morning'],[11,59,'morning'],[12,0,'afternoon'],[16,59,'afternoon'],[17,0,'evening']])assert.equal(localGreeting(new Date(2026,0,1,hour,minute)),`Good ${expected}!`);
});

test('local conversation submission IDs preserve one message and ownership on retries',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-question-id-'));
  try{const store=new FileConversationStore(directory);await store.initialize();const chat=await store.create('file','Test','owner'),input={role:'user',text:'count rows',clientRequestId:crypto.randomUUID()};
    const [a,b]=await Promise.all([store.append(chat.id,input,'owner'),store.append(chat.id,input,'owner')]);assert.equal(a.id,b.id);assert.equal((await store.get(chat.id,'owner')).messages.length,1);assert.equal((await store.activity('other')).length,0);
    await assert.rejects(store.append(chat.id,{...input,text:'different'},'owner'),{status:409});
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('authenticated dashboards track XLSX, PDF and questions, persist across restarts and isolate accounts',{timeout:45000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-dashboard-')),client=new MongoClient(process.env.MONGODB_URI);await client.connect();const dbName=`dashboard_${crypto.randomBytes(8).toString('hex')}`,db=client.db(dbName);
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));const base=`http://127.0.0.1:${port}/api`;let child;
  const start=async()=>{child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),MONGODB_DB_NAME:dbName,CONVERSATION_STORAGE:'mongo',DOCUMENT_STORE_DIR:directory,GEMINI_API_KEY:''},stdio:'ignore',windowsHide:true});for(let index=0;index<200;index++){try{if((await rawFetch(base+'/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Dashboard test server did not start.');};
  const stop=async()=>{if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}};
  function actor(){let cookie='',csrf='';return {async request(route,body,method=body===undefined?'GET':'POST'){
    const response=await rawFetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});
    const cookies=response.headers.getSetCookie();if(cookies.length)cookie=cookies.map(value=>value.split(';')[0]).join('; ');const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;return {status:response.status,data};
  }};}
  const upload=async(actor,buffer,name)=>{const form=new FormData();form.append('file',new Blob([buffer]),name);const response=await actor.request('/files/upload',form);assert.equal(response.status,200);return response.data;};
  try{
    await start();assert.equal((await rawFetch(base+'/dashboard')).status,401);
    const a=actor(),b=actor(),credentials={username:`dash_${crypto.randomBytes(6).toString('hex')}`,password:crypto.randomBytes(6).toString('hex')};await a.request('/auth/session');assert.equal((await a.request('/auth/signup',{...credentials,confirmPassword:credentials.password})).status,201);
    const empty=(await a.request('/dashboard?days=7&timeZone=America%2FNew_York')).data;assert.deepEqual([empty.uploadedFiles,empty.totalRecords,empty.dataColumns,empty.aiQuestions],[0,0,0,0]);assert.equal(empty.hasActivity,false);assert.deepEqual(empty.recentFiles,[]);
    const workbook=new ExcelJS.Workbook();workbook.addWorksheet('Sales').addRows([['Region','Revenue'],['North',100],['South',50],['West',25]]);workbook.addWorksheet('Inventory').addRows([['SKU','Quantity','Cost'],['A',2,10],['B',4,5]]);
    const xlsx=await upload(a,await workbook.xlsx.writeBuffer(),'dashboard.xlsx');let summary=(await a.request('/dashboard')).data;assert.deepEqual([summary.uploadedFiles,summary.totalRecords,summary.dataColumns],[1,5,5]);assert.equal(summary.activity.reduce((sum,bin)=>sum+bin.uploads,0),1);
    const pdf=new PDFDocument(),chunks=[];pdf.on('data',chunk=>chunks.push(chunk));const completed=once(pdf,'end');pdf.text('A business report for testing private document uploads.');pdf.end();await completed;await upload(a,Buffer.concat(chunks),'dashboard.pdf');
    summary=(await a.request('/dashboard')).data;assert.deepEqual([summary.uploadedFiles,summary.totalRecords,summary.dataColumns],[2,5,5]);assert.equal(summary.recentFiles.length,2);assert.equal(summary.activity.reduce((sum,bin)=>sum+bin.uploads,0),2);
    const input={role:'user',text:'How many rows in Sales?',clientRequestId:crypto.randomUUID()},pathToMessage=`/conversations/${xlsx.conversationId}/messages`;
    const [first,repeat]=await Promise.all([a.request(pathToMessage,input),a.request(pathToMessage,input)]);assert.equal(first.status,201);assert.equal(repeat.status,201);assert.equal(first.data.id,repeat.data.id);
    const question={fileId:xlsx.fileId,conversationId:xlsx.conversationId,questionId:first.data.id,question:input.text};for(let index=0;index<2;index++)assert.equal((await a.request('/ai/ask',question)).status,200);
    summary=(await a.request('/dashboard')).data;assert.equal(summary.aiQuestions,1);assert.equal(summary.activity.reduce((sum,bin)=>sum+bin.questions,0),1);
    const store=new WorkspaceActivityStore(db);await Promise.all([store.record('other','upload:foreign','upload'),store.record('other','question:foreign','question')]);assert.equal((await a.request('/dashboard')).data.aiQuestions,1);
    await b.request('/auth/session');const another={username:`dash_${crypto.randomBytes(6).toString('hex')}`,password:'x'};await b.request('/auth/signup',{...another,confirmPassword:another.password});const privateSummary=(await b.request('/dashboard')).data;assert.deepEqual([privateSummary.uploadedFiles,privateSummary.totalRecords,privateSummary.dataColumns,privateSummary.aiQuestions],[0,0,0,0]);assert.equal(privateSummary.hasActivity,false);assert.equal((await b.request(`/files/${xlsx.fileId}`)).status,404);assert.equal((await b.request(`/conversations/${xlsx.conversationId}`)).status,404);
    for(const days of [7,30,90])assert.equal((await a.request(`/dashboard?days=${days}&timeZone=Asia%2FTokyo`)).data.activity.length,days);assert.equal((await a.request('/dashboard?days=10')).status,400);assert.equal((await a.request('/dashboard?timeZone=invalid')).status,400);
    await a.request('/auth/logout',{});assert.equal((await a.request('/dashboard')).status,401);await a.request('/auth/session');await a.request('/auth/login',credentials);assert.equal((await a.request('/dashboard')).data.aiQuestions,1);
    await stop();await start();summary=(await a.request('/dashboard')).data;assert.deepEqual([summary.uploadedFiles,summary.totalRecords,summary.dataColumns,summary.aiQuestions],[2,5,5,1]);
  }finally{await stop();await db.dropDatabase();await client.close();await fs.rm(directory,{recursive:true,force:true});}
});
