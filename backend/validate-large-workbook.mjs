import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import ExcelJS from 'exceljs';
import { validateUpload,validateAnalysis,validatePreview } from '../frontend/src/api-contracts.js';
import {diagnosticClient} from './diagnostic-auth.js';

const filename=process.argv[2],base=(process.argv[3]||'http://localhost:5173').replace(/\/$/,'');
if(!filename)throw new Error('Usage: node validate-large-workbook.mjs <workbook.xlsx> [http://localhost:5173]');
const bytes=fs.readFileSync(filename),created=[],client=await diagnosticClient(base);
const request=client.request;
const json=async(route)=>{const response=await request(route);const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
const initialDocuments=(await json('/files')).length;

// Independent XML oracle: no ExcelJS cell graph and no production parser code.
const archive=await JSZip.loadAsync(bytes),strings=[];
let value='',inText=false;
if(archive.file('xl/sharedStrings.xml')){const parser=new SaxesParser({xmlns:true});parser.on('opentag',node=>{if(node.local==='si')value='';if(node.local==='t')inText=true;});parser.on('text',text=>{if(inText)value+=text;});parser.on('closetag',node=>{if(node.local==='t')inText=false;if(node.local==='si')strings.push(value);});parser.write(await archive.file('xl/sharedStrings.xml').async('string')).close();}
const workbookSheets=[],rels=new Map();
const bookParser=new SaxesParser({xmlns:true});bookParser.on('opentag',node=>{if(node.local==='sheet')workbookSheets.push({name:node.attributes.name.value,id:Object.values(node.attributes).find(a=>a.local==='id').value});});bookParser.write(await archive.file('xl/workbook.xml').async('string')).close();
const relParser=new SaxesParser({xmlns:true});relParser.on('opentag',node=>{if(node.local==='Relationship')rels.set(node.attributes.Id.value,node.attributes.Target.value);});relParser.write(await archive.file('xl/_rels/workbook.xml.rels').async('string')).close();
async function oracle(meta,columns){
  const target=rels.get(workbookSheets.find(s=>s.name===meta.name).id),part=target.startsWith('/')?target.slice(1):path.posix.normalize(path.posix.join('xl',target));
  const metric=columns.findIndex(c=>/^(Qty|No\.|Length\(mm\))$/.test(c));
  let row=0,cell,reading=false,meaningful=false,rowCount=0,sum=0,numericCount=0,xmlCells=0;
  const parser=new SaxesParser({xmlns:true});parser.on('opentag',node=>{if(node.local==='row'){row=+node.attributes.r.value;meaningful=false;}if(node.local==='c'){xmlCells++;cell={ref:node.attributes.r?.value,type:node.attributes.t?.value,text:'',formula:false};}if(node.local==='f'&&cell)cell.formula=true;if(node.local==='v'||node.local==='t')reading=true;});
  parser.on('text',text=>{if(cell&&reading)cell.text+=text;});
  parser.on('closetag',node=>{if(node.local==='v'||node.local==='t')reading=false;if(node.local==='c'&&cell){let v=cell.type==='s'?strings[+cell.text]:cell.text;if(cell.type==='e')v='';if(cell.formula||String(v??'').trim())meaningful=true;let col=0;for(const letter of cell.ref?.match(/^[A-Z]+/)?.[0]||'')col=col*26+letter.charCodeAt(0)-64;
    if(row>meta.headerRow&&col-1===metric&&String(v??'').trim()&&cell.type!=='e'&&Number.isFinite(Number(v))){sum+=Number(v);numericCount++;}cell=null;}
    if(node.local==='row'&&row>meta.headerRow&&meaningful)rowCount++;});parser.write(await archive.file(part).async('string')).close();
  return {rowCount,metric:columns[metric],sum,numericCount,xmlCells};
}

const runs=[],stages=new Set();
try {
  for(let run=0;run<3;run++){
    const job=crypto.randomUUID(),form=new FormData();form.append('file',new Blob([bytes]),path.basename(filename));
    const started=performance.now();
    const poll=setInterval(async()=>{try{const response=await request(`/files/upload-status/${job}`);if(response.ok)stages.add((await response.json()).stage);}catch{}},100);
    let response,file;
    try{response=await request(`/files/upload?job=${job}`,{method:'POST',body:form});file=await response.json();}
    finally{clearInterval(poll);}
    assert.equal(response.status,200,JSON.stringify(file));validateUpload(file);created.push(file.fileId);
    assert.deepEqual(file.sheetNames,workbookSheets.map(sheet=>sheet.name));
    const progress=await json(`/files/upload-status/${job}`);assert.equal(progress.stage,'completed');
    assert.equal((await fetch(`${base}/api/files/upload-status/${job}`,{headers:{'X-Workspace-Token':crypto.randomBytes(32).toString('hex')}})).status,401);
    const metrics={run:run+1,uploadMs:Math.round(performance.now()-started),...file.parserMetrics,parentAfterUpload:progress.memory};runs.push(metrics);console.log('Real upload:',metrics);
    if(run>0)continue;
    for(const meta of file.worksheets){
      const params=new URLSearchParams({sheet:meta.name});
      const stats=await json(`/analytics/${file.fileId}?${params}`);validateAnalysis(stats);
      assert.equal(stats.rowCount,meta.rowCount);assert.equal(stats.columnCount,meta.columnCount);
      const expected=await oracle(meta,stats.columns);assert.equal(stats.rowCount,expected.rowCount);
      for(const question of ['Summarise this sheet','Summarize current sheet','Summary of selected worksheet']){
        const response=await request('/ai/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:file.fileId,conversationId:file.conversationId,selectedSheet:meta.name,question})});
        const answer=await response.json();assert.equal(response.status,200);assert.equal(answer.clarification,undefined,JSON.stringify(answer));assert.equal(answer.calculation.worksheet,meta.name);assert.equal(answer.calculation.matchedRows,expected.rowCount);assert.equal(answer.references[0].worksheet,meta.name);
      }
      if(expected.metric){const actual=stats.columnStats[expected.metric];assert.equal(actual.numericCount,expected.numericCount);assert.ok(Math.abs(actual.sum-expected.sum)<=Math.max(1e-7,Math.abs(expected.sum)*1e-10));}
      if(expected.metric){
        for(const [operation,value] of [['total',expected.sum],['average',expected.numericCount?expected.sum/expected.numericCount:null]]){
          const response=await request('/ai/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:file.fileId,conversationId:file.conversationId,question:`${operation} column "${expected.metric}" in worksheet ${meta.name}`})});
          const answer=await response.json();assert.equal(response.status,200);assert.equal(answer.source,'local-spreadsheet');assert.ok(answer.calculation,JSON.stringify(answer));
          if(value===null)assert.equal(answer.calculation.value,null);else assert.ok(Math.abs(answer.calculation.value-value)<=Math.max(1e-7,Math.abs(value)*1e-10),JSON.stringify(answer));
          assert.equal(answer.references[0].worksheet,meta.name);assert.equal(answer.references[0].rowKind,'excel');
        }
      }
      const page=await json(`/analytics/${file.fileId}/preview?${params}&page=2&pageSize=7`);validatePreview(page);assert.ok(page.rows.length<=7);assert.equal(page.total,meta.rowCount);
      if(page.rows.length){const term=String(page.rows[0][stats.columns[0]]??'');if(term){const filtered=await json(`/analytics/${file.fileId}?${params}&search=${encodeURIComponent(term)}`);validateAnalysis(filtered);assert.ok(filtered.rowCount>0&&filtered.rowCount<=stats.rowCount);}}
      if(stats.types.category[0]){const column=stats.types.category[0],category=stats.categories[column][0];const filtered=await json(`/analytics/${file.fileId}?${params}&categoryColumn=${encodeURIComponent(column)}&categoryValue=${encodeURIComponent(category)}`);assert.ok(filtered.rowCount>0&&filtered.rowCount<=stats.rowCount);}
      assert.equal(stats.charts.pie.reduce((n,r)=>n+r.count,0),stats.charts.pie.length?stats.rowCount:0);
      console.log('Verified worksheet:',{name:meta.name,headerRow:meta.headerRow,rows:meta.rowCount,columns:meta.columnCount,metric:expected.metric,sum:expected.sum,numericColumns:stats.types.numeric.length,formulaWarning:stats.warnings.find(w=>w.includes('formula cells'))||null,xmlCells:expected.xmlCells});
    }
    const largest=file.worksheets.reduce((a,b)=>a.rowCount>b.rowCount?a:b);
    for(const format of ['pdf','xlsx']){
      const response=await request(`/reports/${file.fileId}.${format}?sheet=${encodeURIComponent(largest.name)}`);const data=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);
      if(format==='pdf')assert.equal(data.subarray(0,5).toString(),'%PDF-');
      else{const report=new ExcelJS.Workbook();await report.xlsx.load(data);assert.equal(report.getWorksheet('Selected Data').rowCount,largest.rowCount+1);}
      console.log('Verified report:',{sheet:largest.name,format,bytes:data.length});
    }
    assert.equal((await json(`/files/${file.fileId}`)).sheetCount,workbookSheets.length);
  }
  if(bytes.length>1024*1024){
  const cancelledJob=crypto.randomUUID(),abort=new AbortController(),cancelForm=new FormData();cancelForm.append('file',new Blob([bytes]),path.basename(filename));
  const cancelled=request(`/files/upload?job=${cancelledJob}`,{method:'POST',body:cancelForm,signal:abort.signal});
  const cancellation=assert.rejects(cancelled,error=>error.name==='AbortError');
  let processing=false;
  for(let attempt=0;attempt<100;attempt++){const response=await request(`/files/upload-status/${cancelledJob}`);if(response.ok&&(await response.json()).stage!=='processing'){processing=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(processing,'cancellation should occur during spreadsheet processing');
  const cancelResponse=await request(`/files/upload-status/${cancelledJob}`,{method:'DELETE'});assert.equal(cancelResponse.status,202);
  abort.abort();await cancellation;
  let failed=false;
  for(let attempt=0;attempt<100;attempt++){const response=await request(`/files/upload-status/${cancelledJob}`);if(response.ok&&(await response.json()).stage==='failed'){failed=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(failed);assert.equal((await json('/files')).length,created.length+initialDocuments);console.log('Verified cancellation: no incomplete upload listed');
  }
  console.log('VALIDATION PASSED',JSON.stringify({worksheets:workbookSheets.length,runs,observedProgressStages:[...stages]}));
}finally{try{for(const fileId of created){const response=await request(`/files/${fileId}`,{method:'DELETE'});assert.equal(response.status,200);}}finally{await client.logout();}}
