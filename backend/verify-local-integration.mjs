// Only synthetic data is written remotely, to a unique disposable database.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import {MongoClient} from 'mongodb';
import {GoogleGenAI} from '@google/genai';
import ExcelJS from 'exceljs';

dotenv.config({path:path.join(import.meta.dirname,'.env')});
const results=[];
const record=(check,status,evidence)=>{results.push({check,status,evidence});console.log(JSON.stringify(results.at(-1)));};
const safeError=error=>({name:error.name,status:error.status||error.code||null});
const database=`technovalens_verify_${crypto.randomBytes(6).toString('hex')}`;
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-final-'));
const uploads=path.join(directory,'uploads');
let client,child,connected=false;
const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null&&!child.killed){const done=once(child,'exit');child.kill();await done;}};
try{
  if(!process.env.MONGODB_URI)record(1,'NOT TESTED','MONGODB_URI is absent');
  else{
    try{
      client=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000,socketTimeoutMS:20000});await client.connect();
      await client.db('technovalens').command({ping:1});connected=true;record(1,'PASS','Configured MongoDB connection and production-database ping; no production writes');
    }catch(error){record(1,'FAIL',safeError(error));}
  }
  if(connected){
    try{
      const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
      const token=crypto.randomBytes(32).toString('hex'),other=crypto.randomBytes(32).toString('hex');
      const request=(route,options={},identity=token)=>fetch(`http://127.0.0.1:${port}/api${route}`,{...options,headers:{'X-Workspace-Token':identity,...options.headers}});
      const json=async(route,options)=>{const response=await request(route,options);assert.ok(response.ok,`HTTP ${response.status}`);return response.json();};
      const post=(route,body)=>json(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const start=async()=>{
        child=spawn(process.execPath,['server.js'],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port),MONGODB_DB_NAME:database,CONVERSATION_STORAGE:'mongo',DOCUMENT_STORE_DIR:uploads,GEMINI_API_KEY:''},stdio:'ignore'});
        for(let n=0;n<400;n++){try{if((await request('/health')).ok)return;}catch{}if(child.exitCode!==null)throw new Error('Isolated server exited');await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Isolated server startup timed out');
      };
      await start();const files=[];
      for(const [name,value] of [['verify-first',10],['verify-second',90]]){
        const book=new ExcelJS.Workbook();book.addWorksheet('Synthetic Sales').addRows([['Region','Revenue'],['North',value],['South',5]]);
        const form=new FormData();form.append('file',new Blob([await book.xlsx.writeBuffer()]),`${name}.xlsx`);
        const file=await json('/files/upload',{method:'POST',body:form});files.push(file);
        await post(`/conversations/${file.conversationId}/messages`,{role:'user',text:`saved-${name}`,fileId:file.fileId});
        const answer=await post('/ai/ask',{fileId:file.fileId,conversationId:file.conversationId,question:'total Revenue'});
        assert.equal(answer.calculation.value,value+5);assert.equal(answer.source,'local-spreadsheet');
        await post(`/conversations/${file.conversationId}/messages`,{role:'assistant',text:answer.answer,fileId:file.fileId,source:answer.source});
      }
      for(let i=0;i<6;i++){const file=files[i%2],chat=await json(`/conversations/${file.conversationId}`);assert.equal(chat.fileId,file.fileId);assert.equal(chat.messages.length,2);assert.equal(chat.messages[0].text,`saved-verify-${i%2?'second':'first'}`);}
      assert.equal((await request(`/conversations/${files[0].conversationId}`,{},other)).status,404);
      assert.deepEqual(await (await request('/conversations',{},other)).json(),[]);
      assert.equal((await request('/conversations/missing')).status,404);
      const db=client.db(database);assert.equal(await db.collection('conversations').countDocuments(),2);
      assert.equal(await db.collection('document_data.files').countDocuments(),4);
      await stop();
      assert.ok(path.resolve(uploads).startsWith(path.resolve(directory)+path.sep));await fs.rm(uploads,{recursive:true,force:true});
      await start();
      for(const file of files){const chat=await json(`/conversations/${file.conversationId}`);assert.equal(chat.messages.length,2);assert.equal(chat.documentAvailable,true);const metadata=await json(`/files/${file.fileId}`);assert.equal(metadata.fileId,file.fileId);}
      const restored=await post('/ai/ask',{fileId:files[0].fileId,conversationId:files[0].conversationId,question:'total Revenue'});assert.equal(restored.calculation.value,15);
      record(2,'PASS','Real MongoDB API creation, six switches, persisted user/assistant messages, fresh retrieval, restart and workspace isolation');
      record(3,'PASS','Two synthetic XLSX uploads: four GridFS blobs; empty disk cache restored at restart and exact sum remained 15');
      record(5,'PASS','Gemini disabled: real XLSX API sums 15 and 95, including after GridFS restoration');
      await stop();
      if(process.env.PLAYWRIGHT_MODULE){
        const browserTask=spawn(process.execPath,['validate-improvements.mjs'],{cwd:import.meta.dirname,env:{...process.env,VERIFY_MONGODB_DB_NAME:database},stdio:['ignore','pipe','pipe']});let output='';browserTask.stdout.on('data',data=>{output+=data;});browserTask.stderr.on('data',data=>{output+=data;});await once(browserTask,'exit');
        await fs.writeFile(path.join(import.meta.dirname,'validation-mongo-browser.log'),output);
        assert.equal(browserTask.exitCode,0,'MongoDB browser acceptance failed');record('2-browser','PASS','Real MongoDB browser switching, refresh and mobile restoration passed');record(7,'PASS','Reports charts, navigation, PDF/XLSX exports and responsive browser acceptance passed');
      }else record(7,'NOT TESTED','PLAYWRIGHT_MODULE absent');
    }catch(error){record('mongo-integration','FAIL',safeError(error));}
  }else{for(const n of [2,3])record(n,'NOT TESTED','MongoDB connection unavailable');}
  if(process.env.VERIFY_SKIP_GEMINI==='1')record(4,'NOT TESTED','Explicitly skipped; the single earlier request returned 401');
  else if(!process.env.GEMINI_API_KEY)record(4,'NOT TESTED','No Gemini key configured');
  else{
    try{
      const model=process.env.PRIMARY_GEMINI_MODEL||process.env.GEMINI_MODEL||'gemini-flash-latest';
      const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY,...(process.env.GEMINI_API_BASE_URL?{httpOptions:{baseUrl:process.env.GEMINI_API_BASE_URL}}:{})});
      const response=await ai.models.generateContent({model,contents:'Reply with OK only.',config:{maxOutputTokens:16,httpOptions:{timeout:20000,retryOptions:{attempts:1}}}});
      assert.ok(response.text?.trim());record(4,'PASS',{requests:1,responseReceived:true,usage:response.usageMetadata});
    }catch(error){record(4,'FAIL',{requests:1,...safeError(error)});}
  }
}finally{
  await stop();
  await fs.writeFile(path.join(import.meta.dirname,'validation-live-integration.json'),JSON.stringify(results,null,2));
  if(connected&&/^technovalens_verify_[a-f0-9]{12}$/.test(database)){
    const cleanupClient=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:10000,socketTimeoutMS:15000});
    try{await cleanupClient.connect();await cleanupClient.db(database).dropDatabase();record('cleanup','PASS','Only the uniquely generated verification database was removed');}catch(error){record('cleanup','FAIL',safeError(error));}finally{await cleanupClient.close();}
  }
  await client?.close();assert.ok(path.resolve(directory).startsWith(path.join(os.tmpdir(),'technovalens-final-')));await fs.rm(directory,{recursive:true,force:true});
  await fs.writeFile(path.join(import.meta.dirname,'validation-live-integration.json'),JSON.stringify(results,null,2));
}
