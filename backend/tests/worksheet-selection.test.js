import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import ExcelJS from 'exceljs';

test('worksheet selection crosses JSON and streaming APIs, switches reliably, and preserves workbook/ownership scope',{timeout:30000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-worksheets-'));
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),CONVERSATION_STORAGE:'file',DOCUMENT_STORE_DIR:path.join(directory,'uploads'),GEMINI_API_KEY:''},stdio:'ignore'});
  const request=(route,options={},token='a'.repeat(64))=>fetch(`http://127.0.0.1:${port}/api${route}`,{...options,headers:{'X-Workspace-Token':token,...options.headers}});
  try{
    for(let n=0;n<200;n++){try{if((await request('/health')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
    const book=new ExcelJS.Workbook(),names=['Sales','Employees','Inventory','Expenses'];
    names.forEach((name,index)=>book.addWorksheet(name).addRows([['Item','Value'],['A',index+1],['B',10]]));
    const form=new FormData();form.append('file',new Blob([await book.xlsx.writeBuffer()]),'worksheet-regression.xlsx');
    const upload=await request('/files/upload',{method:'POST',body:form});assert.equal(upload.status,200);const file=await upload.json();
    const ask=(question,selectedSheet,endpoint='/ai/ask',token)=>request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:file.fileId,conversationId:file.conversationId,question,selectedSheet})},token);
    for(const selectedSheet of [...names,...names].reverse()){
      const summary=await (await ask('Summarise this sheet',selectedSheet)).json();assert.equal(summary.calculation.worksheet,selectedSheet);assert.equal(summary.calculation.matchedRows,2);
      const sum=await (await ask('total Value',selectedSheet)).json();assert.equal(sum.calculation.value,names.indexOf(selectedSheet)+11);
      const response=await ask('Summary of selected worksheet',selectedSheet,'/ai/ask/progress');assert.equal(response.status,200);const stream=await response.text();const complete=stream.split('\n\n').find(event=>event.startsWith('event: complete'));assert.ok(complete,stream);const data=JSON.parse(complete.split('\ndata: ')[1]);assert.equal(data.calculation.worksheet,selectedSheet);
    }
    assert.equal((await (await ask('Summarise this sheet',null)).json()).clarification,true);
    assert.equal((await (await ask('summarize Sales and Employees',null)).json()).clarification,true);
    for(const selection of ['missing',42,{},''])assert.equal((await ask('Summarise this sheet',selection)).status,400);
    const all=await (await ask('Summarise the entire workbook','Sales')).json();assert.deepEqual(all.calculations.map(item=>item.worksheet),names);
    const named=await (await ask('total Value in Expenses','Sales')).json();assert.equal(named.calculation.worksheet,'Expenses');
    assert.equal((await ask('Summarise this sheet','Sales','/ai/ask','b'.repeat(64))).status,404);

    // Exercise the stored-sheet worker beyond both upload and table previews.
    const ordersBook=new ExcelJS.Workbook(),orders=ordersBook.addWorksheet('Sales');
    orders.addRow(['Order ID','Amount']);
    for(let n=1;n<=135;n++)orders.addRow([`ORD-${n}`,n]);
    orders.addRow(['ORD-135',200]);orders.addRow([null,300]);
    ordersBook.addWorksheet('Inventory').addRows([['Item'],['A']]);
    const ordersForm=new FormData();ordersForm.append('file',new Blob([await ordersBook.xlsx.writeBuffer()]),'orders.xlsx');
    const ordersUpload=await request('/files/upload',{method:'POST',body:ordersForm});assert.equal(ordersUpload.status,200);
    const ordersFile=await ordersUpload.json();
    const query=(question,endpoint='/ai/ask',token)=>request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:ordersFile.fileId,conversationId:ordersFile.conversationId,question,selectedSheet:'Inventory'})},token);
    for(const phrase of ['How many orders are there','number of orders','count orders','total orders']){
      const response=await query(`${phrase} in Sales?`);assert.equal(response.status,200);
      const result=await response.json();assert.equal(result.source,'local-spreadsheet');assert.equal(result.calculation.value,136);assert.equal(result.calculation.distinctOrders,135);assert.equal(result.calculation.totalRows,137);
    }
    for(const phrase of ['how many records','number of rows'])assert.equal((await (await query(`${phrase} in Sales`)).json()).calculation.value,137);
    const extrema=await (await query('min and max Amount in Sales')).json();assert.equal(extrema.calculation.min.value,1);assert.equal(extrema.calculation.max.value,300);
    const lookup=await (await query('Find Order ID ORD-135 in Sales')).json();assert.deepEqual(lookup.references[0].ranges,[[136,137]]);assert.equal(lookup.calculation.matchedRows,2);
    const events=await (await query('How many orders are there in Sales?','/ai/ask/progress')).text();
    const complete=events.split('\n\n').find(event=>event.startsWith('event: complete'));assert.ok(complete,events);
    assert.equal(JSON.parse(complete.split('\ndata: ')[1]).calculation.value,136);
    assert.equal((await (await query('What is average value in Sales?')).json()).clarification,true);
    assert.equal((await query('Find Order ID ORD-135 in Sales','/ai/ask','b'.repeat(64))).status,404);
    const before=await (await request(`/conversations/${ordersFile.conversationId}`)).json();
    const stored=await request(`/conversations/${ordersFile.conversationId}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'assistant',text:lookup.answer,fileId:ordersFile.fileId})});assert.equal(stored.status,201);
    const after=await (await request(`/conversations/${ordersFile.conversationId}`)).json();assert.equal(after.messages.length,before.messages.length+1);assert.equal(after.messages.at(-1).text,lookup.answer);
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await fs.rm(directory,{recursive:true,force:true});
  }
});
