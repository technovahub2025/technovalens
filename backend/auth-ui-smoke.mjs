// Run with: node tests/run-tests.js --auth-ui
// Uses only the runner's isolated MongoDB and a disposable Edge profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
const freePort=async()=>{const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const backendPort=await freePort(),frontendPort=await freePort(),debugPort=await freePort(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-auth-ui-'));
const backendDir=import.meta.dirname,frontendDir=path.resolve(backendDir,'../frontend'),origin=`http://127.0.0.1:${frontendPort}`,base=`http://127.0.0.1:${backendPort}`;
const output=path.join(backendDir,'.data/auth-validation');await fs.mkdir(output,{recursive:true});
const children=[],client=new MongoClient(process.env.MONGODB_URI);let ws;
const start=(command,args,options={})=>{const child=spawn(command,args,{windowsHide:true,stdio:'ignore',...options});children.push(child);return child;};
try{
  const username=`ui_${crypto.randomBytes(6).toString('hex')}`,password=String.fromCharCode(97+crypto.randomInt(26));
  start(process.execPath,['server.js'],{cwd:backendDir,env:{...process.env,PORT:String(backendPort),DOCUMENT_STORE_DIR:path.join(directory,'uploads'),CONVERSATION_STORAGE:'mongo',GEMINI_API_KEY:'',AUTH_ALLOWED_ORIGINS:origin}});
  start(process.execPath,[path.join(frontendDir,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(frontendPort),'--strictPort'],{cwd:frontendDir,env:{...process.env,VITE_API_URL:base}});
  for(const url of [base+'/api/health',origin+'/technovalens/']){let ready=false;for(let i=0;i<200;i++){try{if((await fetch(url)).ok){ready=true;break;}}catch{}await pause(100);}assert.ok(ready,'isolated UI services started');}
  const edge=process.env.AUTH_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  start(edge,['--headless=new','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(directory,'browser-profile')}`,'about:blank']);
  let target;for(let i=0;i<150;i++){try{target=(await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item=>item.type==='page');if(target)break;}catch{}await pause(100);}assert.ok(target,'headless Edge started');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let id=0;const pending=new Map();ws.addEventListener('message',event=>{const result=JSON.parse(event.data);if(!result.id)return;const handler=pending.get(result.id);if(handler){pending.delete(result.id);result.error?handler.reject(new Error(result.error.message)):handler.resolve(result.result);}});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const request=++id;pending.set(request,{resolve,reject});ws.send(JSON.stringify({id:request,method,params}));});
  const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error('Browser evaluation failed.');return result.result.value;};
  const waitFor=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await pause(100);}throw new Error('Browser UI did not reach expected state.');};
  const click=label=>evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})?.click()`);
  const fill=(name,value)=>evaluate(`(()=>{const field=document.querySelector('input[name="${name}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const screenshot=async name=>{const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await fs.writeFile(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));};
  const checkPassword=async(name)=>{
    const selector=`input[name="${name}"]`,before=await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).type`),'password');
    await evaluate(`document.querySelector('button[aria-controls="'+document.querySelector(${JSON.stringify(selector)}).id+'"]').focus()`);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await command('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).type`),'text','keyboard reveals password');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),before);
    await evaluate(`document.querySelector('button[aria-controls="'+document.querySelector(${JSON.stringify(selector)}).id+'"]').click()`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).type`),'password');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),before);
  };
  const stats=()=>evaluate(`Array.from(document.querySelectorAll('.stat-card strong')).map(node=>node.textContent)`);
  await command('Page.enable');await command('Runtime.enable');await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await command('Page.navigate',{url:origin+'/technovalens/'});
  await waitFor(`document.querySelector('h2')?.textContent==='Welcome Back'&&!document.querySelector('.auth-primary').disabled`);
  assert.equal(await evaluate(`document.querySelectorAll('input').length`),2);assert.equal(await evaluate(`Boolean(document.querySelector('.auth-story'))||/Admin Login|Recover access|Recovery/.test(document.body.textContent)`),false);
  assert.equal(await evaluate(`(()=>{const card=document.querySelector('.auth-card').getBoundingClientRect();return Math.abs(card.x+card.width/2-innerWidth/2)<2&&Math.abs(card.y+card.height/2-innerHeight/2)<2})()`),true,'login card is centered in both directions');await screenshot('centered-login-desktop');
  await fill('password',password);await checkPassword('password');
  assert.equal((await fetch(base+'/api/files')).status,401,'anonymous dashboard API is protected');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});await screenshot('centered-login-mobile');assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,'mobile form has no horizontal overflow');
  await click('Sign Up');await waitFor(`document.querySelector('h2')?.textContent==='Create Account'`);assert.equal(await evaluate(`document.querySelectorAll('input').length`),3);await screenshot('centered-signup-mobile');
  await command('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,'signup fits small phones');
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await screenshot('centered-signup-desktop');
  await fill('username',username);await fill('password',password);await fill('confirmPassword',password);await checkPassword('password');await checkPassword('confirmPassword');await fill('confirmPassword','mismatch');await click('Create Account');await waitFor(`document.body.textContent.includes('Passwords do not match')`);
  await fill('confirmPassword',password);await click('Create Account');
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await waitFor(`Boolean(document.querySelector('[aria-label="Sign out"]'))`);await waitFor(`!document.body.textContent.includes('Loading saved documents')`);
  await click('Dashboard');await waitFor(`document.body.textContent.includes('No activity yet')`);assert.deepEqual(await stats(),['0','0','0','0']);assert.equal(await evaluate(`document.querySelectorAll('.chart-area svg').length`),0);await screenshot('dashboard-empty');
  // These Date overrides exist only in the disposable test page. Advance the
  // local clock through a real timer boundary without changing the server clock.
  const setHour=async(hour,minute=0,second=0,millisecond=0)=>evaluate(`(()=>{const Real=window.__realDate||(window.__realDate=Date),target=new Real();target.setHours(${hour},${minute},${second},${millisecond});const offset=+target-Real.now();window.Date=class extends Real{constructor(...args){super(...(args.length?args:[Real.now()+offset]));}static now(){return Real.now()+offset;}};window.dispatchEvent(new Event('focus'));})()`);
  for(const [hour,expected] of [[9,'morning'],[14,'afternoon'],[20,'evening'],[0,'evening']]){await setHour(hour);await waitFor(`document.querySelector('h1')?.textContent==='Good ${expected}!'`);}
  await setHour(11,59,59,850);await waitFor(`document.querySelector('h1')?.textContent==='Good morning!'`);await waitFor(`document.querySelector('h1')?.textContent==='Good afternoon!'`);
  await evaluate(`window.Date=window.__realDate;delete window.__realDate;window.dispatchEvent(new Event('focus'))`);
  let pausedRequest;
  const paused=new Promise(resolve=>{pausedRequest=resolve;});
  const intercept=event=>{const response=JSON.parse(event.data);if(response.method==='Fetch.requestPaused')pausedRequest(response.params.requestId);};ws.addEventListener('message',intercept);
  await command('Fetch.enable',{patterns:[{urlPattern:'*/api/dashboard*',requestStage:'Request'}]});await evaluate(`window.dispatchEvent(new Event('focus'))`);
  const requestId=await Promise.race([paused,pause(10000).then(()=>{throw new Error('Dashboard request was not intercepted.');})]);
  await waitFor(`document.body.textContent.includes('Loading dashboard')`);assert.deepEqual(await stats(),['—','—','—','—']);
  await command('Fetch.fulfillRequest',{requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin},{name:'Access-Control-Allow-Credentials',value:'true'}],body:Buffer.from(JSON.stringify({error:'Dashboard test outage.'})).toString('base64')});
  await waitFor(`document.body.textContent.includes('Dashboard test outage')`);assert.deepEqual(await stats(),['—','—','—','—']);assert.equal(await evaluate(`document.body.textContent.includes('No activity yet')`),false);
  await command('Fetch.disable');ws.removeEventListener('message',intercept);await click('Retry dashboard');await waitFor(`document.body.textContent.includes('No activity yet')`);
  // Upload through the actual browser UI; no passwords or recovery codes appear in screenshots.
  await click('My Documents');const csv=path.join(directory,'auth-ui.csv');await fs.writeFile(csv,'Region,Revenue\nNorth,100\nSouth,50\n');
  const root=await command('DOM.getDocument');const input=await command('DOM.querySelector',{nodeId:root.root.nodeId,selector:'input[type="file"]'});await command('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[csv]});await waitFor(`document.body.textContent.includes('Successfully uploaded auth-ui.csv')`);
  await click('Dashboard');await waitFor(`document.querySelector('.stat-card strong')?.textContent==='1'`);assert.deepEqual(await stats(),['1','2','2','0']);await waitFor(`Boolean(document.querySelector('.chart-area svg'))`);await screenshot('dashboard-upload');
  await evaluate(`(()=>{const field=document.querySelector('[aria-label="Activity date range"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,'30');field.dispatchEvent(new Event('change',{bubbles:true}));})()`);await waitFor(`document.querySelector('.stat-card strong')?.textContent==='1'`);
  await click('AI Assistant');await waitFor(`document.querySelector('.chat-input input')&&!document.querySelector('.chat-input input').disabled`);
  await evaluate(`(()=>{const field=document.querySelector('.chat-input input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'How many rows are there?');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);await evaluate(`document.querySelector('.chat-input').requestSubmit()`);await waitFor(`!document.querySelector('.chat-input input').disabled`);
  await click('Dashboard');await waitFor(`Array.from(document.querySelectorAll('.stat-card strong'))[3]?.textContent==='1'`);assert.deepEqual(await stats(),['1','2','2','1']);await screenshot('dashboard-question');
  await command('Page.reload',{ignoreCache:true});await waitFor(`Boolean(document.querySelector('[aria-label="Sign out"]'))`);await click('My Documents');await waitFor(`document.body.textContent.includes('auth-ui.csv')`);
  await evaluate(`document.querySelector('[aria-label="Sign out"]').click()`);await waitFor(`document.querySelector('h2')?.textContent==='Welcome Back'`);
  await click('Sign Up');await fill('username',username);await fill('password',password);await fill('confirmPassword',password);await click('Create Account');await waitFor(`document.body.textContent.includes('username is unavailable')`);
  await click('Login');await fill('username',username);await fill('password','incorrect-password');await click('Login');await waitFor(`document.body.textContent.includes('Invalid username or password')`);
  await fill('password',password);await click('Login');await waitFor(`Boolean(document.querySelector('[aria-label="Sign out"]'))`);await click('My Documents');await waitFor(`document.body.textContent.includes('auth-ui.csv')`);
  await click('Settings');await waitFor(`document.querySelector('h2')?.textContent==='Account Security'`);await screenshot('account-security-desktop');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:1100,deviceScaleFactor:1,mobile:true});await screenshot('account-security-mobile');assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);
  const updatedUsername=`owner_${crypto.randomBytes(5).toString('hex')}`,updatedPassword=String.fromCharCode(65+crypto.randomInt(26));
  await fill('username',updatedUsername);await fill('currentPassword',password);await fill('newPassword',updatedPassword);assert.equal(await evaluate(`document.querySelector('.auth-primary').disabled`),false);
  await fill('confirmPassword',updatedPassword);for(const name of ['currentPassword','newPassword','confirmPassword'])await checkPassword(name);
  assert.equal(await evaluate(`/recovery/i.test(document.body.textContent)`),false,'settings has no recovery UI');
  await fill('newPassword',updatedPassword);await fill('confirmPassword',updatedPassword);await click('Save changes');await waitFor(`document.querySelector('h2')?.textContent==='Welcome Back'&&document.body.textContent.includes('Account security updated')`);
  await fill('password',password);await click('Login');await waitFor(`document.body.textContent.includes('Invalid username or password')`);
  await fill('password',updatedPassword);await click('Login');await waitFor(`Boolean(document.querySelector('[aria-label="Sign out"]'))`);await waitFor(`document.body.textContent.includes('auth-ui.csv')`);
  await click('Dashboard');await waitFor(`Array.from(document.querySelectorAll('.stat-card strong'))[3]?.textContent==='1'`);assert.deepEqual(await stats(),['1','2','2','1']);
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await screenshot('dashboard-mobile');
  assert.equal(await evaluate(`document.cookie.includes('technovalens.sid')`),false,'session cookie is inaccessible to JavaScript');
  assert.equal(await evaluate(`Object.keys(localStorage).some(key=>/password|csrf|sessiontoken/i.test(key))`),false,'credentials are not persisted in browser storage');
  await evaluate(`document.querySelector('[aria-label="Sign out"]').click()`);await waitFor(`document.querySelector('h2')?.textContent==='Welcome Back'`);assert.equal(await evaluate(`Boolean(document.querySelector('.nav-item'))`),false,'protected dashboard is unmounted after logout');
  await click('Sign Up');await fill('username',`second_${crypto.randomBytes(5).toString('hex')}`);await fill('password',password);await fill('confirmPassword',password);await click('Create Account');await waitFor(`document.body.textContent.includes('No activity yet')`);assert.deepEqual(await stats(),['0','0','0','0']);assert.equal(await evaluate(`document.body.textContent.includes('auth-ui.csv')`),false);await screenshot('dashboard-second-account');
  await evaluate(`document.querySelector('[aria-label="Sign out"]').click()`);await waitFor(`document.querySelector('h2')?.textContent==='Welcome Back'`);
  console.log(JSON.stringify({centeredLogin:true,desktopAndMobile:true,signup:true,signupConfirmation:true,uniqueUsername:true,sessionPersistence:true,incorrectPasswordRejected:true,accountSecurity:true,usernameAndPasswordChange:true,oldPasswordRejected:true,upload:true,loginRestoresDocuments:true,logout:true,protectedDashboard:true,recoveryUiAbsent:true,httpOnlyCookie:true,noStoredCredentials:true,passwordToggles:6,keyboardToggles:true,emptyDashboard:true,secondAccountIsolation:true,loadingAndErrorStates:true,realMetrics:true,activityRange:true,questionActivity:true,localGreetings:true,greetingBoundary:true,screenshots:output}));
}finally{
  if(ws?.readyState===WebSocket.OPEN)ws.close();
  for(const child of children.reverse())if(child.exitCode===null){const ended=once(child,'exit');child.kill();await Promise.race([ended,pause(5000)]);}
  await client.connect();await client.db(process.env.MONGODB_DB_NAME).dropDatabase();await client.close();
  // Edge may briefly retain profile files after its parent exits. All paths are
  // within the exact disposable directory created above; leave locked files alone.
  try{await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}
}
