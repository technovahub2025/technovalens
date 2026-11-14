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
import {createStoredAccount,provisionInitialAdmin} from '../credentials.js';
import {authenticationProxyHops,authenticationOrigins} from '../auth-config.js';

const password=()=>`Strong-7aA-${crypto.randomBytes(16).toString('hex')}`;
const username=()=>`user_${crypto.randomBytes(6).toString('hex')}`;
const databases=new Map();
function browser(base,db=databases.get(base)){
  let cookie='',csrf='';
  const request=async(route,options={})=>{
    const headers=new Headers(options.headers);if(cookie)headers.set('Cookie',cookie);if(csrf&&!['GET','HEAD','OPTIONS'].includes(options.method||'GET'))headers.set('X-CSRF-Token',csrf);
    const response=await rawFetch(base+route,{...options,headers});const updated=response.headers.getSetCookie();if(updated.length)cookie=updated.map(value=>value.split(';')[0]).join('; ');return response;
  };
  const json=async(route,body)=>{const response=await request(route,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;return {response,data};};
  return {db,request,json,get cookie(){return cookie;},get csrf(){return csrf;},bootstrap:()=>json('/auth/session')};
}
async function fixture(options={}){
  const client=new MongoClient(process.env.MONGODB_URI);await client.connect();const db=client.db(`auth_case_${crypto.randomBytes(8).toString('hex')}`);
  let now=Date.now();const app=express();app.set('trust proxy',options.proxyHops??(options.production?1:0));app.use(express.json());
  const auth=await createAuthentication({db,secret:process.env.SESSION_SECRET,allowedOrigins:new Set(['https://app.example']),clock:()=>now,...options});
  app.use('/api',auth.middleware);app.get('/api/private',(req,res)=>res.json({id:req.authUser._id,owner:req.ownerHash}));app.post('/api/private',(req,res)=>res.json({changed:true}));app.use((_error,_req,res,_next)=>res.status(503).json({error:'Authentication unavailable.'}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api`;
  databases.set(base,db);
  return {auth,db,base,browser:()=>browser(base),advance:ms=>{now+=ms;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.dropDatabase();await client.close();}};
}
async function provisionAndLogin(actor,input={}){
  await actor.bootstrap();const credentials={username:username(),password:password(),...input};
  const record=await createStoredAccount(actor.db,credentials),loggedIn=await actor.json('/auth/login',credentials);
  assert.equal(loggedIn.response.status,200);
  return {...loggedIn,data:{...loggedIn.data,recoveryCodes:record.recoveryCodes},credentials};
}
async function signupAccount(actor,input={}){
  await actor.bootstrap();const credentials={username:username(),password:password(),...input};
  return {...await actor.json('/auth/signup',{...credentials,confirmPassword:credentials.password}),credentials};
}

test('public signup validates credentials, hashes passwords with Argon2id and rotates session/CSRF tokens',async()=>{
  const f=await fixture();try{
    const actor=f.browser();await actor.bootstrap();const anonymous=actor.cookie,oldCsrf=actor.csrf;
    const credentials={username:username(),password:password()};
    assert.equal((await actor.json('/auth/signup',{...credentials,password:'',confirmPassword:''})).response.status,400);
    assert.equal((await actor.json('/auth/signup',{...credentials,confirmPassword:'mismatch'})).response.status,400);
    assert.equal((await actor.json('/auth/signup',{...credentials,username:{$ne:null},confirmPassword:credentials.password})).response.status,400);
    assert.equal(await f.db.collection('auth_users').countDocuments(),0);
    await assert.rejects(createStoredAccount(f.db,{...credentials,password:''}),{code:'VALIDATION_ERROR'});
    const created=await actor.json('/auth/signup',{...credentials,confirmPassword:credentials.password,role:'admin',initialAdmin:true,ownerHash:'forged',_id:'forged'});assert.equal(created.response.status,201);assert.notEqual(actor.cookie,anonymous);assert.notEqual(actor.csrf,oldCsrf);
    const record=await f.db.collection('auth_users').findOne({_id:created.data.user.id});assert.match(record.passwordHash,/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);assert.equal(await argon2.verify(record.passwordHash,credentials.password),true);assert.ok(!JSON.stringify(record).includes(credentials.password));assert.equal(record.recoveryHashes.length,10);assert.equal(record.role,undefined);assert.equal(record.initialAdmin,undefined);assert.notEqual(record._id,'forged');assert.deepEqual(Object.keys(created.data).sort(),['csrfToken','user']);
    const cookie=created.response.headers.getSetCookie().join(';');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);assert.match(cookie,/Path=\//);
    assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:anonymous}})).status,401);
    const duplicate=f.browser();await duplicate.bootstrap();assert.equal((await duplicate.json('/auth/signup',{...credentials,username:credentials.username.toUpperCase(),confirmPassword:credentials.password})).response.status,409);
    assert.equal((await duplicate.json('/auth/login',{username:{$ne:null},password:credentials.password})).response.status,401);
    const wrong=await duplicate.json('/auth/login',{username:credentials.username,password:password()}),unknown=await duplicate.json('/auth/login',{username:username(),password:password()});assert.equal(wrong.response.status,401);assert.deepEqual(wrong.data,unknown.data);
    for(const value of ['x','1','password',credentials.username,' ', 'a'.repeat(128)])assert.equal(passwordError(value,credentials.username),'');
    for(const value of ['',null,123,'a'.repeat(129)])assert.ok(passwordError(value));
  }finally{await f.close();}
});

test('signup requires CSRF and trusted origins, rate limits attempts and rejects concurrent duplicate usernames',async()=>{
  const f=await fixture({limits:{signupIp:2}});try{
    const a=f.browser(),b=f.browser();await a.bootstrap();await b.bootstrap();
    const input={username:username(),password:password()};input.confirmPassword=input.password;
    assert.equal((await rawFetch(f.base+'/auth/signup',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
    assert.equal((await a.request('/auth/signup',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
    assert.equal(await f.db.collection('auth_users').countDocuments(),0);
    const results=await Promise.all([a,b].map(actor=>actor.json('/auth/signup',input)));
    assert.deepEqual(results.map(result=>result.response.status).sort(),[201,409]);assert.equal(await f.db.collection('auth_users').countDocuments(),1);
    const limited=await b.json('/auth/signup',{...input,username:username()});assert.equal(limited.response.status,429);assert.ok(limited.response.headers.get('Retry-After'));
  }finally{await f.close();}
});

test('session cookies require CSRF and trusted origins; logout and revocation survive a stale-session rewrite',async()=>{
  const f=await fixture();try{
    const actor=f.browser(),created=await provisionAndLogin(actor),cookie=actor.cookie;
    for(const headers of [{Cookie:cookie},{Cookie:cookie,'X-CSRF-Token':'wrong'},{Cookie:cookie,'X-CSRF-Token':'é'.repeat(64)},{Cookie:cookie,'X-CSRF-Token':actor.csrf,Origin:'https://evil.example'}])assert.equal((await rawFetch(f.base+'/private',{method:'POST',headers})).status,403);
    assert.equal((await actor.json('/private',{})).response.status,200);
    const saved=await f.db.collection('auth_sessions').findOne({'session.userId':created.data.user.id});assert.equal(saved._id.length,64);assert.ok(!cookie.includes(saved._id),'raw session IDs are not stored as Mongo IDs');
    assert.equal((await actor.json('/auth/logout',{})).response.status,200);assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:cookie}})).status,401);
    await f.db.collection('auth_sessions').replaceOne({_id:saved._id},saved,{upsert:true});assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:cookie}})).status,401,'an in-flight old save cannot resurrect a logged-out session');
  }finally{await f.close();}
});

test('recovery codes are one-time, atomically consumed and revoke all existing sessions',async()=>{
  const f=await fixture();try{
    const actor=f.browser(),created=await provisionAndLogin(actor),oldCookie=actor.cookie,code=created.data.recoveryCodes[0],replacement=password();
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
    const actor=f.browser(),created=await provisionAndLogin(actor);f.advance(900);assert.equal((await actor.request('/private')).status,200);f.advance(900);assert.equal((await actor.request('/private')).status,200);f.advance(800);assert.equal((await actor.request('/private')).status,401,'absolute timeout cannot be extended by activity');
    f.advance(16*60*1000);const login=f.browser();await login.bootstrap();for(const expected of [401,401,429]){const result=await login.json('/auth/login',{username:created.credentials.username,password:password()});assert.equal(result.response.status,expected);if(expected===429)assert.ok(result.response.headers.get('retry-after'));}
    f.advance(16*60*1000);assert.equal((await login.json('/auth/login',created.credentials)).response.status,200);f.advance(1001);assert.equal((await login.request('/private')).status,401,'idle deadline is checked without waiting for Mongo TTL cleanup');
  }finally{await f.close();}
});

test('production configuration refuses insecure cookies and session-store errors fail closed',async()=>{
  const f=await fixture();try{
    await assert.rejects(createAuthentication({db:f.db,secret:'short',allowedOrigins:new Set()}),/SESSION_SECRET/);
    await assert.rejects(createAuthentication({db:f.db,secret:process.env.SESSION_SECRET,production:true,secure:false,allowedOrigins:new Set()}),/Secure/);
    const actor=f.browser();await provisionAndLogin(actor);const get=f.auth.store.get;f.auth.store.get=(_sid,callback)=>callback(new Error('simulated outage'));
    assert.equal((await actor.request('/private')).status,503);f.auth.store.get=get;
  }finally{await f.close();}
});

test('production cookies are Secure, HttpOnly, host-only and cross-site compatible only over HTTPS',async()=>{
  const f=await fixture({production:true});try{
    assert.equal((await rawFetch(f.base+'/auth/session')).status,426);
    const bootstrap=await rawFetch(f.base+'/auth/session',{headers:{'X-Forwarded-Proto':'https'}}),preCookie=bootstrap.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),{csrfToken}=await bootstrap.json();
    const input={username:username(),password:password()};await createStoredAccount(f.db,input);
    const created=await rawFetch(f.base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https','X-CSRF-Token':csrfToken,Cookie:preCookie},body:JSON.stringify({...input,confirmPassword:input.password})});assert.equal(created.status,200);
    const cookie=created.headers.getSetCookie().join(';');assert.match(cookie,/__Host-technovalens.sid=/);assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/SameSite=None/);assert.doesNotMatch(cookie,/Domain=/);
  }finally{await f.close();}
});

test('Render proxy detection trusts only configured hops and never accepts spoofed HTTPS without proxy trust',async()=>{
  assert.equal(authenticationProxyHops({RENDER:'true'}),1);
  assert.equal(authenticationProxyHops({}),0);
  assert.equal(authenticationProxyHops({RENDER:'true',AUTH_TRUST_PROXY_HOPS:'0'}),0);
  for(const value of ['true','-1','4','','1.0'])assert.throws(()=>authenticationProxyHops({AUTH_TRUST_PROXY_HOPS:value}));
  const origins=authenticationOrigins({NODE_ENV:'production'});
  assert.ok(origins.has('https://technovahub.in'));assert.ok(!origins.has('http://localhost:5173'));assert.ok(!origins.has('https://technovahub.in/technovalens'));
  assert.throws(()=>authenticationOrigins({AUTH_ALLOWED_ORIGINS:'https://technovahub.in/path'}));
  const untrusted=await fixture({production:true,proxyHops:0});
  try{assert.equal((await rawFetch(untrusted.base+'/auth/session',{headers:{'X-Forwarded-Proto':'https'}})).status,426);}finally{await untrusted.close();}
  const trusted=await fixture({production:true,proxyHops:authenticationProxyHops({RENDER:'true'})});
  try{
    for(const proto of ['http','http, https','garbage'])assert.equal((await rawFetch(trusted.base+'/auth/session',{headers:{'X-Forwarded-Proto':proto}})).status,426);
    const response=await rawFetch(trusted.base+'/auth/session',{headers:{'X-Forwarded-Proto':'https'}});assert.equal(response.status,200);assert.match(response.headers.getSetCookie().join(';'),/Secure/);
  }finally{await trusted.close();}
});

test('first administrator provisioning is explicit, singleton, permanently locked and preserves existing users',async()=>{
  const f=await fixture();try{
    await assert.rejects(provisionInitialAdmin(f.db,{password:''}));assert.equal(await f.db.collection('auth_bootstrap').countDocuments(),0);
    const legacy=await createStoredAccount(f.db,{username:username(),password:password()});
    const saved=await f.db.collection('auth_users').findOne({_id:legacy.user._id});
    const results=await Promise.allSettled([provisionInitialAdmin(f.db,{username:'admin',password:password()}),provisionInitialAdmin(f.db,{username:'another_admin',password:password()})]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const admin=await f.db.collection('auth_users').findOne({initialAdmin:true});assert.equal(admin.role,'admin');assert.match(admin.passwordHash,/^\$argon2id\$/);
    assert.equal((await f.db.collection('auth_bootstrap').findOne({_id:'initial-admin'})).status,'complete');
    await f.db.collection('auth_users').updateOne({_id:admin._id},{$set:{username:'renamed',usernameKey:'renamed'}});
    await assert.rejects(provisionInitialAdmin(f.db,{username:'third_admin',password:password()}),/disabled/);
    await f.db.collection('auth_users').deleteOne({_id:admin._id});
    await assert.rejects(provisionInitialAdmin(f.db,{username:'fourth_admin',password:password()}),/disabled/);
    assert.deepEqual(await f.db.collection('auth_users').findOne({_id:saved._id}),saved);
  }finally{await f.close();}
});

test('interrupted admin setup remains locked instead of allowing a second bootstrap',async()=>{
  const f=await fixture();try{
    await f.db.collection('auth_bootstrap').insertOne({_id:'initial-admin',status:'locked'});
    await assert.rejects(provisionInitialAdmin(f.db,{password:password()}),/locked/);
    assert.equal(await f.db.collection('auth_users').countDocuments(),0);
  }finally{await f.close();}
});

test('account security verifies current password, validates changes and revokes every session while preserving ownership',async()=>{
  const f=await fixture();try{
    const actor=f.browser(),created=await provisionAndLogin(actor),other=f.browser(),anonymous=f.browser();
    await other.bootstrap();assert.equal((await other.json('/auth/login',created.credentials)).response.status,200);
    const originalCookie=actor.cookie,otherCookie=other.cookie,newUsername=username(),newPassword=password();
    await anonymous.bootstrap();assert.equal((await anonymous.json('/auth/account',{currentPassword:created.credentials.password,username:newUsername})).response.status,401);
    assert.equal((await rawFetch(f.base+'/auth/account',{method:'POST',headers:{Cookie:actor.cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await actor.json('/auth/account',{currentPassword:'wrong',username:newUsername})).response.status,401);
    const input={currentPassword:created.credentials.password,username:newUsername,newPassword,confirmPassword:newPassword};
    assert.equal((await actor.json('/auth/account',{...input,newPassword:'a'.repeat(129),confirmPassword:'a'.repeat(129)})).response.status,400);
    assert.equal((await actor.json('/auth/account',{...input,confirmPassword:'mismatch'})).response.status,400);
    assert.equal((await actor.json('/auth/account',{...input,username:{$ne:null}})).response.status,400);
    assert.equal((await actor.json('/auth/account',{...input,newPassword:created.credentials.password,confirmPassword:created.credentials.password})).response.status,400);
    const taken=await createStoredAccount(f.db,{username:username(),password:password()});
    assert.equal((await actor.json('/auth/account',{...input,username:taken.user.username.toUpperCase()})).response.status,409);
    const response=await actor.json('/auth/account',input);assert.equal(response.response.status,200);assert.equal(response.data.signInRequired,true);
    for(const cookie of [originalCookie,otherCookie])assert.equal((await rawFetch(f.base+'/private',{headers:{Cookie:cookie}})).status,401);
    const record=await f.db.collection('auth_users').findOne({_id:created.data.user.id});assert.equal(record.username,newUsername);assert.ok(await argon2.verify(record.passwordHash,newPassword));assert.equal(record.sessionVersion,1);
    const login=f.browser();await login.bootstrap();assert.equal((await login.json('/auth/login',created.credentials)).response.status,401);
    assert.equal((await login.json('/auth/login',{username:newUsername,password:created.credentials.password})).response.status,401);
    assert.equal((await login.json('/auth/login',{username:newUsername,password:newPassword})).response.status,200);
    assert.equal((await login.json('/private')).data.owner,accountOwner(created.data.user.id));
    assert.equal((await login.json('/auth/account',{username:username(),currentPassword:newPassword})).response.status,200,'username-only changes also verify password and revoke sessions');
  }finally{await f.close();}
});

test('MongoDB sessions survive middleware restarts and disabled accounts lose access immediately',async()=>{
  const f=await fixture();let restarted;try{
    const actor=f.browser(),created=await provisionAndLogin(actor),app=express();app.use(express.json());
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
    const cors=await rawFetch(base+'/health',{headers:{Origin:'https://technovahub.in'}});assert.equal(cors.headers.get('Access-Control-Allow-Origin'),'https://technovahub.in');assert.equal(cors.headers.get('Access-Control-Allow-Credentials'),'true');
    const preflight=await rawFetch(base+'/auth/login',{method:'OPTIONS',headers:{Origin:'https://technovahub.in','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type,X-CSRF-Token'}});assert.equal(preflight.status,204);assert.match(preflight.headers.get('Access-Control-Allow-Headers'),/X-CSRF-Token/i);
    const rejectedOrigin=await rawFetch(base+'/health',{headers:{Origin:'https://technovahub.in.attacker.example'}});assert.equal(rejectedOrigin.headers.get('Access-Control-Allow-Origin'),null);
    for(const route of ['/files','/conversations','/usage','/reports/'+crypto.randomUUID()+'.xlsx'])assert.equal((await rawFetch(base+route,{headers:{'X-Workspace-Token':'a'.repeat(64)}})).status,401);
    const a=browser(base,db),b=browser(base,db),first=await signupAccount(a),second=await signupAccount(b);assert.equal(first.response.status,201);assert.equal(second.response.status,201);assert.notEqual(first.data.user.id,second.data.user.id);
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
    const issued=await a.json('/auth/recovery-codes',{password:first.credentials.password});assert.equal(issued.response.status,200);
    const recovery=issued.data.recoveryCodes[0],replacement=password(),reset=browser(base);await reset.bootstrap();assert.equal((await reset.json('/auth/recover',{username:first.credentials.username,recoveryCode:recovery,password:replacement,confirmPassword:replacement})).response.status,200);
    const again=browser(base);await again.bootstrap();assert.equal((await again.json('/auth/login',{username:first.credentials.username,password:replacement})).response.status,200);assert.equal((await again.request(`/files/${file.fileId}`)).status,200,'recovery preserves account ownership');
  }finally{if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}await db.dropDatabase();await client.close();await fs.rm(directory,{recursive:true,force:true});}
});
