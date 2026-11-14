import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {MongoClient} from 'mongodb';
import argon2 from 'argon2';
import {createAuthentication,accountOwner,passwordError} from '../auth.js';
import {rawFetch} from './auth-test-client.js';
import {MongoDocumentStore} from '../storage/mongo-document-store.js';
import {diagnosticClient} from '../diagnostic-auth.js';

const password=()=>`Strong-7aA-${crypto.randomBytes(16).toString('hex')}`;
const username=()=>`user_${crypto.randomBytes(6).toString('hex')}`;
function browser(base){
  let cookie='',csrf='';
  const request=async(route,options={})=>{
    const headers=new Headers(options.headers);if(cookie)headers.set('Cookie',cookie);if(csrf&&!['GET','HEAD','OPTIONS'].includes(options.method||'GET'))headers.set('X-CSRF-Token',csrf);
    const response=await rawFetch(base+route,{...options,headers});const updated=response.headers.getSetCookie();if(updated.length)cookie=updated.map(value=>value.split(';')[0]).join('; ');return response;
  };
  const json=async(route,body)=>{const response=await request(route,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;return {response,data};};
  return {request,json,get cookie(){return cookie;},get csrf(){return csrf;},bootstrap:()=>json('/auth/session')};
}
async function fixture(options={}){
  const client=new MongoClient(process.env.MONGODB_URI);await client.connect();const db=client.db(`auth_case_${crypto.randomBytes(8).toString('hex')}`);
  let now=Date.now();const app=express();if(options.production)app.set('trust proxy',1);app.use(express.json());
  const auth=await createAuthentication({db,secret:process.env.SESSION_SECRET,allowedOrigins:new Set(['https://app.example']),clock:()=>now,...options});
  app.use('/api',auth.middleware);app.get('/api/private',(req,res)=>res.json({id:req.authUser._id,owner:req.ownerHash}));app.post('/api/private',(req,res)=>res.json({changed:true}));app.use((_error,_req,res,_next)=>res.status(503).json({error:'Authentication unavailable.'}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api`;
  return {auth,db,base,browser:()=>browser(base),advance:ms=>{now+=ms;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.dropDatabase();await client.close();}};
}
async function signup(actor,input={}){await actor.bootstrap();const credentials={username:username(),password:password(),...input};return {...await actor.json('/auth/signup',{...credentials,confirmPassword:credentials.password}),credentials};}

test('MongoDB signup hashes passwords with Argon2id, rejects weak/duplicate/injected names and rotates session/CSRF tokens',async()=>{
  const f=await fixture();try{
    const actor=f.browser();await actor.bootstrap();const anonymous=actor.cookie,oldCsrf=actor.csrf;
    const credentials={username:username(),password:password()};
    assert.equal((await actor.json('/auth/signup',{username:credentials.username,password:'short',confirmPassword:'short'})).response.status,400);
    const created=await actor.json('/auth/signup',{...credentials,confirmPassword:credentials.password});assert.equal(created.response.status,201);assert.equal(created.data.recoveryCodes.length,10);assert.notEqual(actor.cookie,anonymous);assert.notEqual(actor.csrf,oldCsrf);
    const record=await f.db.collection('auth_users').findOne({_id:created.data.user.id});assert.match(record.passwordHash,/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);assert.equal(await argon2.verify(record.passwordHash,credentials.password),true);assert.ok(!JSON.stringify(record).includes(credentials.password));assert.ok(!JSON.stringify(record).includes(created.data.recoveryCodes[0]));assert.equal('passwordHash' in created.data,false);
    const cookie=created.response.headers.getSetCookie().join(';');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);assert.match(cookie,/Path=\//);
    assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:anonymous}})).status,401);
    const duplicate=f.browser();await duplicate.bootstrap();assert.equal((await duplicate.json('/auth/signup',{...credentials,username:credentials.username.toUpperCase(),confirmPassword:credentials.password})).response.status,409);
    assert.equal((await duplicate.json('/auth/signup',{username:{$ne:null},password:credentials.password,confirmPassword:credentials.password})).response.status,400);
    const wrong=await duplicate.json('/auth/login',{username:credentials.username,password:password()}),unknown=await duplicate.json('/auth/login',{username:username(),password:password()});assert.equal(wrong.response.status,401);assert.deepEqual(wrong.data,unknown.data);
    assert.equal(passwordError('Password123456789'),'Choose a less predictable password that does not contain your username.');
  }finally{await f.close();}
});

test('session cookies require CSRF and trusted origins; logout and revocation survive a stale-session rewrite',async()=>{
  const f=await fixture();try{
    const actor=f.browser(),created=await signup(actor),cookie=actor.cookie;
    for(const headers of [{Cookie:cookie},{Cookie:cookie,'X-CSRF-Token':'wrong'},{Cookie:cookie,'X-CSRF-Token':'é'.repeat(64)},{Cookie:cookie,'X-CSRF-Token':actor.csrf,Origin:'https://evil.example'}])assert.equal((await rawFetch(f.base+'/private',{method:'POST',headers})).status,403);
    assert.equal((await actor.json('/private',{})).response.status,200);
    const saved=await f.db.collection('auth_sessions').findOne({'session.userId':created.data.user.id});assert.equal(saved._id.length,64);assert.ok(!cookie.includes(saved._id),'raw session IDs are not stored as Mongo IDs');
    assert.equal((await actor.json('/auth/logout',{})).response.status,200);assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:cookie}})).status,401);
    await f.db.collection('auth_sessions').replaceOne({_id:saved._id},saved,{upsert:true});assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:cookie}})).status,401,'an in-flight old save cannot resurrect a logged-out session');
  }finally{await f.close();}
});

test('recovery codes are one-time, atomically consumed and revoke all existing sessions',async()=>{
  const f=await fixture();try{
    const actor=f.browser(),created=await signup(actor),oldCookie=actor.cookie,code=created.data.recoveryCodes[0],replacement=password();
    const recover=f.browser();await recover.bootstrap();
    assert.equal((await recover.json('/auth/recover',{username:created.credentials.username,recoveryCode:'bad',password:replacement,confirmPassword:replacement})).response.status,400);
    const results=await Promise.all([recover,await(async()=>{const other=f.browser();await other.bootstrap();return other;})()].map(browser=>browser.json('/auth/recover',{username:created.credentials.username,recoveryCode:code,password:replacement,confirmPassword:replacement})));
    assert.deepEqual(results.map(item=>item.response.status).sort(),[200,400]);assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:oldCookie}})).status,401);
    const record=await f.db.collection('auth_users').findOne({_id:created.data.user.id});assert.equal(record.recoveryHashes.length,9);assert.equal(await argon2.verify(record.passwordHash,replacement),true);
    const login=f.browser();await login.bootstrap();assert.equal((await login.json('/auth/login',{username:created.credentials.username,password:created.credentials.password})).response.status,401);assert.equal((await login.json('/auth/login',{username:created.credentials.username,password:replacement})).response.status,200);
    assert.equal((await login.json('/auth/recovery-codes',{password:'incorrect'})).response.status,401);
    const rotated=await login.json('/auth/recovery-codes',{password:replacement});assert.equal(rotated.response.status,200);assert.equal(rotated.data.recoveryCodes.length,10);
    await recover.bootstrap();assert.equal((await recover.json('/auth/recover',{username:created.credentials.username,recoveryCode:created.data.recoveryCodes[1],password:password(),confirmPassword:'mismatch'})).response.status,400);
    const attempted=password();assert.equal((await recover.json('/auth/recover',{username:created.credentials.username,recoveryCode:created.data.recoveryCodes[1],password:attempted,confirmPassword:attempted})).data.code,'RECOVERY_INVALID');
  }finally{await f.close();}
});

test('per-account/IP rate limits, idle expiration and absolute expiration are enforced server-side',async()=>{
  const f=await fixture({idleMs:1000,absoluteMs:2500,limits:{account:2,ip:20}});try{
    const actor=f.browser(),created=await signup(actor);f.advance(900);assert.equal((await actor.request('/private')).status,200);f.advance(900);assert.equal((await actor.request('/private')).status,200);f.advance(800);assert.equal((await actor.request('/private')).status,401,'absolute timeout cannot be extended by activity');
    const login=f.browser();await login.bootstrap();for(const expected of [401,401,429]){const result=await login.json('/auth/login',{username:created.credentials.username,password:password()});assert.equal(result.response.status,expected);if(expected===429)assert.ok(result.response.headers.get('retry-after'));}
    f.advance(16*60*1000);assert.equal((await login.json('/auth/login',created.credentials)).response.status,200);f.advance(1001);assert.equal((await login.request('/private')).status,401,'idle deadline is checked without waiting for Mongo TTL cleanup');
  }finally{await f.close();}
});

test('production configuration refuses insecure cookies and session-store errors fail closed',async()=>{
  const f=await fixture();try{
    await assert.rejects(createAuthentication({db:f.db,secret:'short',allowedOrigins:new Set()}),/SESSION_SECRET/);
    await assert.rejects(createAuthentication({db:f.db,secret:process.env.SESSION_SECRET,production:true,secure:false,allowedOrigins:new Set()}),/Secure/);
    const actor=f.browser();await signup(actor);const get=f.auth.store.get;f.auth.store.get=(_sid,callback)=>callback(new Error('simulated outage'));
    assert.equal((await actor.request('/private')).status,503);f.auth.store.get=get;
  }finally{await f.close();}
});

test('production cookies are Secure, HttpOnly, host-only and cross-site compatible only over HTTPS',async()=>{
  const f=await fixture({production:true});try{
    assert.equal((await rawFetch(f.base+'/auth/session')).status,426);
    const bootstrap=await rawFetch(f.base+'/auth/session',{headers:{'X-Forwarded-Proto':'https'}}),preCookie=bootstrap.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),{csrfToken}=await bootstrap.json();
    const input={username:username(),password:password()};
    const created=await rawFetch(f.base+'/auth/signup',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https','X-CSRF-Token':csrfToken,Cookie:preCookie},body:JSON.stringify({...input,confirmPassword:input.password})});assert.equal(created.status,201);
    const cookie=created.headers.getSetCookie().join(';');assert.match(cookie,/__Host-technovalens.sid=/);assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/SameSite=None/);assert.doesNotMatch(cookie,/Domain=/);
  }finally{await f.close();}
});

test('MongoDB sessions survive middleware restarts and disabled accounts lose access immediately',async()=>{
  const f=await fixture();let restarted;try{
    const actor=f.browser(),created=await signup(actor),app=express();app.use(express.json());
    const auth=await createAuthentication({db:f.db,secret:process.env.SESSION_SECRET,allowedOrigins:new Set(['https://app.example'])});app.use('/api',auth.middleware);app.get('/api/private',(req,res)=>res.json({owner:req.ownerHash}));
    restarted=app.listen(0,'127.0.0.1');await once(restarted,'listening');const url=`http://127.0.0.1:${restarted.address().port}/api/private`;
    const restored=await rawFetch(url,{headers:{Cookie:actor.cookie}});assert.equal(restored.status,200);assert.equal((await restored.json()).owner,accountOwner(created.data.user.id));
    await f.db.collection('auth_users').updateOne({_id:created.data.user.id},{$set:{disabled:true}});assert.equal((await rawFetch(url,{headers:{Cookie:actor.cookie}})).status,401);
  }finally{if(restarted){restarted.closeAllConnections();await new Promise(resolve=>restarted.close(resolve));}await f.close();}
});

test('real MongoDB/GridFS endpoints enforce account ownership and never adopt existing anonymous documents',{timeout:45000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-auth-')),client=new MongoClient(process.env.MONGODB_URI);await client.connect();const dbName=`auth_http_${crypto.randomBytes(8).toString('hex')}`,db=client.db(dbName);
  const socket=(await import('node:net')).createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),MONGODB_DB_NAME:dbName,CONVERSATION_STORAGE:'mongo',DOCUMENT_STORE_DIR:directory,GEMINI_API_KEY:''},stdio:'ignore'});const base=`http://127.0.0.1:${port}/api`;
  try{
    let ready=false;for(let i=0;i<200;i++){try{if((await rawFetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,'authenticated backend started');
    for(const route of ['/files','/conversations','/usage','/reports/'+crypto.randomUUID()+'.xlsx'])assert.equal((await rawFetch(base+route,{headers:{'X-Workspace-Token':'a'.repeat(64)}})).status,401);
    const a=browser(base),b=browser(base),first=await signup(a),second=await signup(b);assert.notEqual(first.data.user.id,second.data.user.id);
    const form=new FormData();form.append('file',new Blob(['Name,Revenue\nNorth,100\nSouth,50\n']),'private.csv');const uploaded=await a.request('/files/upload',{method:'POST',body:form});assert.equal(uploaded.status,200);const file=await uploaded.json();
    const record=await db.collection('documents').findOne({_id:file.fileId});assert.equal(record.ownerHash,accountOwner(first.data.user.id));for(const blob of await db.collection('document_data.files').find({'metadata.fileId':file.fileId}).toArray())assert.equal(blob.metadata.ownerHash,record.ownerHash);
    const diagnostic=await diagnosticClient(`http://127.0.0.1:${port}`,first.credentials);assert.equal((await diagnostic.request(`/files/${file.fileId}`)).status,200);await diagnostic.logout();assert.equal((await a.request(`/files/${file.fileId}`)).status,200,'diagnostic logout does not invalidate another session');
    for(const route of [`/files/${file.fileId}`,`/analytics/${file.fileId}`,`/analytics/${file.fileId}/preview`,`/reports/${file.fileId}.pdf`,`/reports/${file.fileId}.xlsx`,`/conversations/${file.conversationId}`])assert.equal((await b.request(route)).status,404,route);
    assert.deepEqual((await b.json('/files')).data,[]);assert.deepEqual((await b.json('/conversations')).data,[]);
    assert.equal((await b.json('/ai/ask',{fileId:file.fileId,question:'count rows'})).response.status,404);
    assert.equal((await b.json(`/conversations/${file.conversationId}/messages`,{role:'user',text:'foreign'})).response.status,404);
    assert.equal((await b.request(`/files/${file.fileId}`,{method:'DELETE'})).status,404);
    const stolen=await b.request(`/files/${file.fileId}`,{headers:{'X-Workspace-Token':'a'.repeat(64)}});assert.equal(stolen.status,404);
    const legacy={fileId:crypto.randomUUID(),ownerHash:crypto.createHash('sha256').update('a'.repeat(64)).digest('hex'),name:'legacy.pdf',kind:'pdf',chunks:['Page 1\nAnonymous document that must remain private.'],pageCount:1,textLength:48};
    await fs.writeFile(path.join(directory,legacy.fileId+'.json'),JSON.stringify(legacy));const store=new MongoDocumentStore(db,directory);await store.save(legacy);
    assert.equal((await a.request(`/files/${legacy.fileId}`,{headers:{'X-Workspace-Token':'a'.repeat(64)}})).status,404);assert.equal((await db.collection('documents').findOne({_id:legacy.fileId})).ownerHash,legacy.ownerHash);assert.equal(await fs.readFile(path.join(directory,legacy.fileId+'.json'),'utf8'),JSON.stringify(legacy));
    assert.equal((await a.json('/ai/ask',{fileId:file.fileId,question:'total Revenue'})).data.calculation.value,150);
    const recovery=first.data.recoveryCodes[0],replacement=password(),reset=browser(base);await reset.bootstrap();assert.equal((await reset.json('/auth/recover',{username:first.credentials.username,recoveryCode:recovery,password:replacement,confirmPassword:replacement})).response.status,200);
    const again=browser(base);await again.bootstrap();assert.equal((await again.json('/auth/login',{username:first.credentials.username,password:replacement})).response.status,200);assert.equal((await again.request(`/files/${file.fileId}`)).status,200,'recovery preserves account ownership');
  }finally{if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}await db.dropDatabase();await client.close();await fs.rm(directory,{recursive:true,force:true});}
});
