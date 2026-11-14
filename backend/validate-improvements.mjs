// Local-only acceptance run. Uses a fresh file store and a fresh browser profile.
// PLAYWRIGHT_MODULE may point to an existing playwright-core/index.mjs installation.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'technovalens-acceptance-'));
const children=[];let browser;
const freePort=async()=>{const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));return port;};
const port=await freePort(),webPort=5173;
const backend=`http://127.0.0.1:${port}`,frontend=`http://localhost:${webPort}`;
const run=(args,cwd,env={})=>{const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(child);let output='';child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});return {child,output:()=>output};};
const ready=async url=>{for(let i=0;i<240;i++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error(`Local test server did not start: ${url}`);};
try{
  if(process.env.VERIFY_MONGODB_DB_NAME&&!/^technovalens_verify_[a-f0-9]{12}$/.test(process.env.VERIFY_MONGODB_DB_NAME))throw new Error('Invalid isolated verification database');
  run(['server.js'],import.meta.dirname,{PORT:String(port),CONVERSATION_STORAGE:process.env.VERIFY_MONGODB_DB_NAME?'mongo':'file',MONGODB_DB_NAME:process.env.VERIFY_MONGODB_DB_NAME||'',DOCUMENT_STORE_DIR:path.join(directory,'uploads'),GEMINI_API_KEY:''});await ready(`${backend}/api/health`);
  for(const filename of process.argv.slice(2)){
    const task=run(['validate-large-workbook.mjs',filename,backend],import.meta.dirname);
    await once(task.child,'exit');fs.writeFileSync(path.join(import.meta.dirname,`validation-${path.basename(filename).startsWith('EVEREADY')?'eveready':'sample'}.log`),task.output());
    assert.equal(task.child.exitCode,0,task.output().slice(-4000));
    console.log(`Workbook HTTP validation passed: ${path.basename(filename)}`);
  }
  if(!process.env.PLAYWRIGHT_MODULE){console.log('Browser validation skipped: set PLAYWRIGHT_MODULE');process.exitCode=0;}
  else{
    const vite=run(['node_modules/vite/bin/vite.js','--host','localhost','--port',String(webPort),'--strictPort'],path.resolve(import.meta.dirname,'../frontend'),{VITE_API_URL:backend});await ready(`${frontend}/technovalens/`);
    assert.equal(vite.child.exitCode,null,'The permitted local development origin on port 5173 must be free.');
    const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);browser=await chromium.launch({headless:true,channel:'msedge'});
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});const page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.goto(`${frontend}/technovalens/`);await page.waitForSelector('.sidebar');
    if(process.env.CHAT_WORKBOOK_PATH){
      await page.setViewportSize({width:1440,height:1000});
      await page.waitForFunction(()=>!document.querySelector('.processing-status'));
      await page.waitForLoadState('networkidle');
      await page.waitForFunction(()=>!document.querySelector('.upload-button')?.disabled);
      await page.locator('input[type=file]').setInputFiles(process.env.CHAT_WORKBOOK_PATH);
      try{await page.getByText(`Successfully uploaded ${path.basename(process.env.CHAT_WORKBOOK_PATH)}`,{exact:false}).waitFor({timeout:30000});}
      catch(error){console.log('Worksheet upload diagnostics:',await page.locator('.notice,.processing-status,.upload-button').allTextContents());throw error;}
      await page.waitForFunction(()=>!document.querySelector('.upload-button')?.disabled);
      await page.getByRole('button',{name:'AI Excel Chat',exact:true}).click();
      assert.equal(await page.getByLabel('Chat worksheet',{exact:true}).inputValue(),'Sales');
      for(const name of ['Sales','Employees','Inventory','Expenses']){
        await page.getByLabel('Chat worksheet',{exact:true}).selectOption(name);
        await page.getByRole('button',{name:'Summarise this sheet',exact:true}).click();
        const sent=page.waitForRequest(request=>request.url().endsWith('/ai/ask/progress')&&request.postDataJSON()?.selectedSheet===name);
        await page.locator('.chat-input button').click();await sent;
        await page.waitForFunction(name=>Array.from(document.querySelectorAll('.bubble')).at(-1)?.textContent.includes(`${name} has`),name);
        await page.waitForFunction(()=>!document.querySelector('.upload-button')?.disabled);
      }
      await page.reload();await page.waitForFunction(()=>!document.querySelector('.processing-status'));
      assert.equal(await page.getByLabel('Chat worksheet',{exact:true}).inputValue(),'Expenses');
      await page.getByLabel('Chat worksheet',{exact:true}).selectOption('');
      await page.getByPlaceholder('Ask anything about your file...').fill('Summarise this sheet');await page.locator('.chat-input button').click();
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('.bubble')).at(-1)?.textContent.includes('No worksheet has been assumed'));
      console.log('Sample workbook browser worksheet switching, request payloads, summaries, refresh and missing selection passed');
    }
    const upload=async(name,contents)=>{
      await page.waitForFunction(()=>!document.querySelector('.upload-button')?.disabled);
      await page.locator('input[type=file]').setInputFiles({name,mimeType:'text/csv',buffer:Buffer.from(contents)});
      await page.locator('.sidebar-conversations button').filter({hasText:name}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('.upload-button')?.disabled);
    };
    await upload('first-history.csv','Region,Revenue\nNorth,100\nSouth,50\n');
    await page.getByRole('button',{name:'AI Excel Chat',exact:true}).click();
    await page.getByPlaceholder('Ask anything about your file...').fill('total Revenue');await page.locator('.chat-input button').click();
    await page.waitForFunction(()=>document.querySelector('.messages')?.textContent.includes('150')||document.querySelector('.chat-messages')?.textContent.includes('150')||Array.from(document.querySelectorAll('.bubble')).some(b=>b.textContent.includes('150')));
    await upload('second-history.csv','Region,Revenue\nWest,900\n');
    await page.locator('.sidebar-conversations button').filter({hasText:'first-history.csv'}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.bubble')).some(b=>b.textContent.includes('150')));
    assert.ok(!(await page.locator('.bubble').allTextContents()).join(' ').includes('900'));
    await page.reload();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.bubble')).some(b=>b.textContent.includes('150')));
    await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByLabel('Workbook',{exact:true}).selectOption({label:'first-history.csv'});await page.waitForSelector('.data-table td');
    assert.ok(await page.locator('.recharts-surface').count()>=2,'Reports must render real charts');
    for(const button of ['Excel','Download PDF']){const download=page.waitForEvent('download');await page.getByRole('button',{name:button,exact:true}).click();await download;}
    assert.equal(await page.getByRole('button',{name:'Analytics',exact:true}).count(),0);
    for(const nav of ['Dashboard','Excel Files','AI Excel Chat','Reports']){await page.getByRole('button',{name:nav,exact:true}).click();assert.equal(await page.locator('.crumb').innerText().then(t=>t.includes(nav)),true);}
    await page.goto(`${frontend}/technovalens/#analytics`);await page.waitForSelector('.data-table td');assert.equal(new URL(page.url()).hash,'#reports');
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:1000});await page.waitForTimeout(300);
      const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,bodyFont:getComputedStyle(document.body).fontSize}));assert.ok(metrics.scroll<=metrics.width+1,JSON.stringify(metrics));assert.equal(metrics.bodyFont,'16px');
      await page.screenshot({path:path.join(import.meta.dirname,`validation-reports-${width}.png`),fullPage:true});console.log('Browser layout:',metrics);
      for(const destination of ['dashboard','files','chat','reports']){
        await page.goto(`${frontend}/technovalens/#${destination}`);
        await page.waitForFunction(()=>!document.querySelector('.processing-status'));
        const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,font:getComputedStyle(document.body).fontFamily}));
        assert.ok(layout.scroll<=layout.width+1,`${destination}: ${JSON.stringify(layout)}`);
        assert.match(layout.font,/Inter/);
      }
    }
    await page.getByLabel('Saved conversation').selectOption({label:'second-history.csv'});await page.waitForFunction(()=>document.querySelector('.page h1')?.textContent==='AI Excel Chat');
    assert.deepEqual(errors,[]);console.log('Browser conversation switching, refresh, navigation, Reports exports and responsive layouts passed');
  }
}finally{
  await browser?.close();for(const child of children)if(child.exitCode===null){child.kill();await once(child,'exit');}
  if(path.resolve(directory).startsWith(path.join(os.tmpdir(),'technovalens-acceptance-')))fs.rmSync(directory,{recursive:true,force:true});
}
