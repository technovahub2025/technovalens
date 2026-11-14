import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Readable,Writable} from 'node:stream';
import {MongoDocumentStore} from '../storage/mongo-document-store.js';
import {LocalDocumentCache} from '../storage/local-document-cache.js';
import {backupDocument,planConversationReconciliation,reconcileConversation} from '../storage/storage-maintenance.js';
import {attachStoredSheets,clearSheetCache} from '../sheet-storage.js';
import {answerSheetQuestion} from '../exact-spreadsheet.js';

function fakeStorage(){
  const records=new Map(),blobs=new Map();let writes=0;
  const matches=(record,query)=>record&&Object.entries(query).every(([key,value])=>record[key]===value);
  const collection={createIndex:async()=>{},findOne:async query=>[...records.values()].find(record=>matches(record,query)),find:query=>(async function*(){yield* [...records.values()].filter(record=>matches(record,query));})(),insertOne:async record=>{if(records.has(record._id))throw Object.assign(new Error('duplicate'),{code:11000});records.set(record._id,structuredClone(record));writes++;},updateOne:async(query,update)=>{const record=[...records.values()].find(record=>matches(record,query));if(record){Object.assign(record,update.$set);writes++;}return {modifiedCount:record?1:0};},deleteOne:async query=>{if(matches(records.get(query._id),query)){records.delete(query._id);writes++;}}};
  const bucket={openUploadStreamWithId:id=>{const chunks=[];return new Writable({write(chunk,_encoding,done){chunks.push(chunk);done();},final(done){blobs.set(id,Buffer.concat(chunks));done();}});},openDownloadStream:id=>{if(!blobs.has(id))throw new Error('missing blob');return Readable.from([blobs.get(id)]);},delete:async id=>blobs.delete(id)};
  return {records,blobs,bucket,collection,db:{collection:()=>collection},writeCount:()=>writes};
}
function fixture(rows=4){
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'technovalens-cache-unit-')),directory=path.join(temporaryRoot,'uploads'),fileId=crypto.randomUUID(),ownerHash='a'.repeat(64);fs.mkdirSync(directory);
  const document={fileId,ownerHash,kind:'spreadsheet',storageVersion:2,sheetName:'Sales',columns:['Value'],rowCount:rows,sheets:[{name:'Sales',columns:['Value'],rowCount:rows,dataFile:'sheet-0.ndjson',sourceRows:Array.from({length:rows},(_,index)=>index+2)}]};
  fs.mkdirSync(path.join(directory,`${fileId}.sheets`));fs.writeFileSync(path.join(directory,`${fileId}.sheets/sheet-0.ndjson`),Array.from({length:rows},(_,index)=>JSON.stringify([index+1])).join('\n')+'\n');fs.writeFileSync(path.join(directory,`${fileId}.json`),JSON.stringify(document));
  const fake=fakeStorage(),store=new MongoDocumentStore(fake.db,directory,fake.bucket),documents=new Map([[fileId,document]]);
  const attach=doc=>attachStoredSheets(doc,directory);attach(document);
  return {directory,fileId,ownerHash,document,fake,store,documents,attach,cleanup(){clearSheetCache();fs.rmSync(temporaryRoot,{recursive:true,force:true});}};
}

test('cache expiration is disabled by default, protects activity, then restores exact large-sheet calculations',async()=>{
  const f=fixture(30000);let now=0;
  // Proofs belong inside each isolated fixture parent, rather than shared tmp.
  const proofPath=path.join(f.directory,'proof.json');
  try{
    await f.store.save(f.document);const writes=f.fake.writeCount();
    const cache=new LocalDocumentCache({...f,directory:f.directory,clock:()=>now,ttlMs:10});cache.proofPath=proofPath;
    now=20;assert.deepEqual(await cache.expire(),[]);assert.ok(fs.existsSync(path.join(f.directory,`${f.fileId}.json`)));
    cache.enabled=true;const release=await cache.enter();assert.deepEqual(await cache.expire(),[],'active workers/uploads/streams prevent expiration');release();
    assert.deepEqual(await cache.expire(),[f.fileId]);assert.equal(fs.existsSync(path.join(f.directory,`${f.fileId}.json`)),false);
    assert.equal(await cache.ensure(f.fileId,'b'.repeat(64)),null);assert.equal(fs.existsSync(path.join(f.directory,`${f.fileId}.json`)),false,'other workspace cannot hydrate the file');
    const restored=await cache.ensure(f.fileId,f.ownerHash);const result=answerSheetQuestion(restored.sheets[0],{operation:'sum',question:'total Value'});assert.equal(result.calculation.value,30000*30001/2);
    assert.equal(f.fake.writeCount(),writes,'verification, eviction and hydration never mutate MongoDB');
    now=40;assert.deepEqual(await cache.expire(),[f.fileId]);
    const restarted=new MongoDocumentStore(f.fake.db,f.directory,f.fake.bucket);assert.equal((await restarted.restore({proofs:cache.proofs})).length,1);
    assert.equal(fs.readFileSync(path.join(f.directory,`${f.fileId}.sheets/sheet-0.ndjson`),'utf8').split('\n').length-1,30000);
  }finally{f.cleanup();}
});

test('unbacked files, unknown ownership, modified local data, extra files and corrupt backups never expire',async()=>{
  const f=fixture();let now=0;
  try{
    const cache=new LocalDocumentCache({...f,directory:f.directory,enabled:true,exclusive:true,clock:()=>now,ttlMs:1});cache.proofPath=path.join(f.directory,'proof.json');now=2;
    assert.deepEqual(await cache.expire(),[]);await f.store.save(f.document);
    const sheet=path.join(f.directory,`${f.fileId}.sheets/sheet-0.ndjson`),original=fs.readFileSync(sheet);
    fs.appendFileSync(sheet,'[999]\n');assert.deepEqual(await cache.expire(),[]);fs.writeFileSync(sheet,original);
    const extra=path.join(f.directory,`${f.fileId}.sheets/unique-original.xlsx`);fs.writeFileSync(extra,'preserve');assert.deepEqual(await cache.expire(),[]);fs.unlinkSync(extra);
    const blob=`${f.fileId}/sheet-0.ndjson`;f.fake.blobs.set(blob,Buffer.from('[999]\n'));assert.deepEqual(await cache.expire(),[]);assert.equal((await f.store.verify(f.document)).verified,false);
    assert.ok(fs.existsSync(sheet));
    assert.throws(()=>new LocalDocumentCache({...f,enabled:true}),/exclusive/);
  }finally{f.cleanup();}
});

test('recovery fingerprints reject changed GridFS data and restoration never overwrites a surviving local file',async()=>{
  const f=fixture();
  try{
    await f.store.save(f.document);const proof=await f.store.verify(f.document);assert.equal(proof.verified,true);
    const target=path.join(f.directory,`${f.fileId}.sheets/sheet-0.ndjson`);fs.writeFileSync(target,'[1234]\n');
    await assert.rejects(f.store.restoreOne(f.fileId,f.ownerHash,{proof}),/Surviving local/);assert.equal(fs.readFileSync(target,'utf8'),'[1234]\n');
    f.fake.blobs.set(`${f.fileId}/manifest.json`,Buffer.from(JSON.stringify({...f.document,name:'changed'})));
    await assert.rejects(f.store.restoreOne(f.fileId,f.ownerHash,{proof}),/checksum/);
    assert.equal(await f.store.restoreOne(f.fileId,'b'.repeat(64)),null);
  }finally{f.cleanup();}
});

test('requests wait for verification/expiration and concurrent restores share work without crossing ownership',async()=>{
  const f=fixture();let now=0,continueVerify,started;
  try{
    await f.store.save(f.document);const actualVerify=f.store.verify.bind(f.store);
    const verifying=new Promise(resolve=>{started=resolve;});const wait=new Promise(resolve=>{continueVerify=resolve;});
    f.store.verify=async document=>{started();await wait;return actualVerify(document);};
    const cache=new LocalDocumentCache({...f,enabled:true,exclusive:true,clock:()=>now,ttlMs:1});now=2;
    const expiration=cache.expire();await verifying;let entered=false;const reader=cache.enter().then(release=>{entered=true;return release;});
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(entered,false);continueVerify();await expiration;
    const release=await reader;let calls=0;const restore=f.store.restoreOne.bind(f.store);f.store.restoreOne=async(...args)=>{calls++;return restore(...args);};
    const [a,b]=await Promise.all([cache.ensure(f.fileId,f.ownerHash),cache.ensure(f.fileId,f.ownerHash)]);assert.equal(a.fileId,b.fileId);assert.equal(calls,1);release();
  }finally{continueVerify?.();f.cleanup();}
});

test('maintenance defaults to dry-run, verifies ownership, backs up eligible documents without overwriting',async()=>{
  const f=fixture();const conversations={find:()=>({toArray:async()=>[{fileId:f.fileId,ownerHash:f.ownerHash}]})};
  try{
    assert.equal((await backupDocument(f.document,{...f,conversations})).status,'eligible');assert.equal(f.fake.records.size,0);
    assert.equal((await backupDocument({...f.document,ownerHash:undefined},{...f,conversations})).reason,'document-ownership-missing');
    assert.equal((await backupDocument(f.document,{...f,conversations,dryRun:false})).status,'backed-up');const writes=f.fake.writeCount();
    assert.equal((await backupDocument(f.document,{...f,conversations,dryRun:false})).status,'already-backed');assert.equal(f.fake.writeCount(),writes);
    await assert.rejects(f.store.save({...f.document,ownerHash:'b'.repeat(64)}),/duplicate/);assert.equal(f.fake.records.get(f.fileId).ownerHash,f.ownerHash);
  }finally{f.cleanup();}
});

const message=(id,text)=>({id,text,role:'user',createdAt:`2026-11-13T00:00:0${id}Z`});
test('snapshot reconciliation preserves newer Mongo history and flags conflicts without inventing messages',()=>{
  const owner='a'.repeat(64),local={id:'chat',fileId:'file',ownerHash:owner,updatedAt:'2026-11-13T00:00:02Z',messages:[message('1','one'),message('2','two')]};
  const remote={...local,messages:[...local.messages,message('3','three')]};
  assert.equal(planConversationReconciliation(local,remote,owner).status,'already-preserved');
  const append=planConversationReconciliation(local,{...local,messages:[local.messages[0]],updatedAt:'2026-11-13T00:00:01Z'},owner);assert.equal(append.status,'append');assert.deepEqual(append.messages,[local.messages[1]]);
  assert.equal(planConversationReconciliation(local,{...remote,messages:[message('1','different')]},owner).reason,'message-conflict');
  assert.equal(planConversationReconciliation(local,{...remote,fileId:'other'},owner).status,'review');
  assert.equal(planConversationReconciliation({...local,ownerHash:undefined},null,owner).status,'review');
  assert.equal(planConversationReconciliation({...local,messages:[local.messages[1],local.messages[0]]},remote,owner).status,'review');
});

test('reconciliation writes only original suffix messages with an optimistic concurrency guard',async()=>{
  const owner='a'.repeat(64),remote={_id:'chat',id:'chat',fileId:'file',ownerHash:owner,updatedAt:'2026-11-13T00:00:01Z',messages:[message('1','one')]},local={...remote,updatedAt:'2026-11-13T00:00:02Z',messages:[...remote.messages,message('2','two')]};let writes=0;
  const collection={findOne:async()=>remote,updateOne:async(filter,update)=>{writes++;assert.deepEqual(filter.messages,remote.messages);assert.equal(filter.ownerHash,owner);assert.deepEqual(update.$push.messages.$each,[local.messages[1]]);return {modifiedCount:1};}};
  assert.equal((await reconcileConversation(local,{collection,verifiedOwner:owner})).status,'append');assert.equal(writes,0);
  assert.equal((await reconcileConversation(local,{collection,verifiedOwner:owner,dryRun:false})).applied,true);assert.equal(writes,1);
  collection.updateOne=async()=>({modifiedCount:0});await assert.rejects(reconcileConversation(local,{collection,verifiedOwner:owner,dryRun:false}),/changed/);
});
