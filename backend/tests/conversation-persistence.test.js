import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable,Writable} from 'node:stream';
import {MongoDocumentStore} from '../storage/mongo-document-store.js';

test('HTTP conversations retain exact messages and file mapping across switching, refresh and restart; missing files preserve history', {timeout:30000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-history-'));
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}/api`,token='a'.repeat(64);let child;
  const request=(route,options={},identity=token)=>fetch(base+route,{...options,headers:{'X-Workspace-Token':identity,...options.headers}});
  const start=async()=>{
    child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),CONVERSATION_STORAGE:'file',DOCUMENT_STORE_DIR:path.join(directory,'uploads'),GEMINI_API_KEY:''},stdio:'ignore'});
    for(let i=0;i<150;i++){try{if((await request('/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('Test server did not start');
  };
  const stop=async()=>{if(child?.exitCode===null){child.kill();await once(child,'exit');}};
  const post=(route,body)=>request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    await start();const files=[];
    for(const [name,value] of [['first',10],['second',90]]){
      const form=new FormData();form.append('file',new Blob([`Name,Value\nA,${value}\n`]),`${name}.csv`);
      const response=await request('/files/upload',{method:'POST',body:form});assert.equal(response.status,200);const file=await response.json();files.push(file);
      assert.equal((await post(`/conversations/${file.conversationId}/messages`,{role:'user',text:`message-${name}`,fileId:file.fileId})).status,201);
    }
    for(let i=0;i<6;i++){const file=files[i%2],chat=await (await request(`/conversations/${file.conversationId}`)).json();assert.equal(chat.fileId,file.fileId);assert.equal(chat.messages[0].text,`message-${i%2?'second':'first'}`);}
    assert.equal((await post('/ai/ask',{fileId:files[1].fileId,conversationId:files[0].conversationId,question:'total Value'})).status,409);
    assert.equal((await post(`/conversations/${files[0].conversationId}/messages`,{fileId:files[1].fileId,role:'user',text:'wrong file'})).status,409);
    assert.equal((await request(`/conversations/${files[0].conversationId}`,{},'b'.repeat(64))).status,404);
    assert.equal((await request('/conversations/missing')).status,404);
    await stop();await start();
    assert.equal((await (await request(`/conversations/${files[0].conversationId}`)).json()).messages[0].text,'message-first');
    await stop();await fs.rm(path.join(directory,'uploads',`${files[0].fileId}.json`));await start();
    const orphan=await (await request(`/conversations/${files[0].conversationId}`)).json();assert.equal(orphan.documentAvailable,false);assert.equal(orphan.messages[0].text,'message-first');assert.match(orphan.recoveryMessage,/restore/i);
    assert.equal((await post(`/conversations/${files[0].conversationId}/messages`,{role:'user',text:'cannot continue'})).status,409);
    const list=await (await request('/conversations')).json();assert.equal(list.length,2,'startup must not recreate history');
    assert.deepEqual(await (await request('/conversations',{},'b'.repeat(64))).json(),[]);
  }finally{await stop();await fs.rm(directory,{recursive:true,force:true});}
});

function durableFake(){
  const records=new Map(),blobs=new Map();let fail=false;
  const matches=(item,query)=>item&&Object.entries(query).every(([k,v])=>item[k]===v);
  const collection={createIndex:async()=>{},insertOne:async item=>{if(records.has(item._id))throw Object.assign(new Error('duplicate'),{code:11000});records.set(item._id,{...item});},findOne:async q=>[...records.values()].find(i=>matches(i,q)),updateOne:async(q,u)=>Object.assign(records.get(q._id),u.$set),deleteOne:async q=>{if(matches(records.get(q._id),q))records.delete(q._id);},find:q=>(async function*(){yield* [...records.values()].filter(i=>matches(i,q));})()};
  const bucket={openUploadStreamWithId:id=>{const chunks=[];return new Writable({write(c,e,done){if(fail)return done(new Error('storage interrupted'));chunks.push(c);done();},final(done){blobs.set(id,Buffer.concat(chunks));done();}});},openDownloadStream:id=>Readable.from([blobs.get(id)]),delete:async id=>blobs.delete(id)};
  return {db:{collection:()=>collection},bucket,records,blobs,setFailure:value=>{fail=value;}};
}
test('durable normalized files and manifests restore into an empty deployment cache; failed writes roll back',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-durable-')),fake=durableFake();
  const fileId='12345678-1234-1234-1234-123456789abc',document={fileId,ownerHash:'owner',storageVersion:2,sheets:[{name:'Sales',dataFile:'sheet-1.ndjson',columns:['Value'],rowCount:1}]};
  try{
    const store=new MongoDocumentStore(fake.db,dir,fake.bucket);await store.initialize();
    await fs.mkdir(path.join(dir,`${fileId}.sheets`));await fs.writeFile(path.join(dir,`${fileId}.sheets/sheet-1.ndjson`),'[125]\n');
    await store.save(document);await store.save(document);assert.equal(fake.blobs.size,2);
    await fs.rm(path.join(dir,`${fileId}.sheets`),{recursive:true});
    const replacement=new MongoDocumentStore(fake.db,dir,fake.bucket);assert.deepEqual(await replacement.restore(),[document]);
    assert.equal(await fs.readFile(path.join(dir,`${fileId}.sheets/sheet-1.ndjson`),'utf8'),'[125]\n');
    await replacement.delete(fileId,document.ownerHash);assert.equal(fake.blobs.size,0);assert.equal(fake.records.size,0);
    fake.setFailure(true);await assert.rejects(store.save(document),/storage interrupted/);assert.equal(fake.records.size,0);assert.equal(fake.blobs.size,0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
