import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { streamSpreadsheet, readStoredRows } from './xlsx-stream.js';
import { analyzeDataset, hashWorkbook, previewDataset } from './analytics.js';

const RESULT_TYPE = 'technovalens:spreadsheet-result:v1';
const PROGRESS_TYPE = 'technovalens:spreadsheet-progress:v1';
const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.parseInt(value,10)||fallback));
export const parserLimits = {
  get heapMiB(){return bounded(process.env.SPREADSHEET_WORKER_HEAP_MB,256,128,512);},
  get concurrency(){return bounded(process.env.SPREADSHEET_WORKERS,1,1,2);},
  get timeoutMs(){return bounded(process.env.SPREADSHEET_TIMEOUT_MS,30000,1000,120000);}
};
let activeWorkers=0;
const queryQueue=[];
function drainQueries(){while(queryQueue.length&&activeWorkers<parserLimits.concurrency)queryQueue.shift()();}
export function querySpreadsheetInWorker(task,{signal}={}) {
  if(queryQueue.length>=8)return Promise.reject(Object.assign(new Error('Worksheet processing is busy. Please retry shortly.'),{code:'PARSER_BUSY'}));
  return new Promise((resolve,reject)=>{
    let queued=true;
    const cancel=()=>{if(!queued)return;queued=false;const index=queryQueue.indexOf(start);if(index>=0)queryQueue.splice(index,1);clearTimeout(timer);reject(Object.assign(new Error('Worksheet request cancelled.'),{code:'PARSER_CANCELLED'}));};
    const start=()=>{if(!queued)return;queued=false;clearTimeout(timer);signal?.removeEventListener('abort',cancel);parseSpreadsheetInWorker(Buffer.alloc(0),'query',{task,signal}).then(resolve,reject);};
    const timer=setTimeout(cancel,parserLimits.timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();else if(activeWorkers<parserLimits.concurrency)start();else queryQueue.push(start);
  });
}
export function validateSheets(sheets) {
  if(!Array.isArray(sheets)||!sheets.length)throw new Error('Spreadsheet parsing returned no worksheets. Please upload a valid XLSX or CSV file.');
  const names=new Set();
  for(const sheet of sheets){
    if(!sheet||typeof sheet.name!=='string'||!sheet.name||names.has(sheet.name)||!Array.isArray(sheet.columns)||!sheet.columns.every(c=>typeof c==='string'))throw new Error('Spreadsheet contains incomplete worksheet data. Please upload the original file again.');
    if(sheet.dataFile){
      if(!/^sheet-\d+\.ndjson$/.test(sheet.dataFile)||!Number.isInteger(sheet.rowCount)||sheet.rowCount<0)throw new Error('Spreadsheet contains incomplete worksheet data.');
    }else if(!Array.isArray(sheet.rows)||!sheet.rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&sheet.columns.every(c=>Object.hasOwn(row,c))))throw new Error('Spreadsheet contains incomplete worksheet data. Please upload the original file again.');
    names.add(sheet.name);
  }
  return sheets;
}
export async function parseSpreadsheet(buffer,ext,{outputDir,onProgress=()=>{}}={}) {
  const ownDirectory=!outputDir;
  const directory=outputDir||fs.mkdtempSync(path.join(os.tmpdir(),'technovalens-parser-'));
  fs.mkdirSync(directory,{recursive:true});
  try {
    const manifests=await streamSpreadsheet(buffer,ext,directory,{onProgress});
    if(outputDir){
      for(let i=0;i<manifests.length;i++){
        const sheet=manifests[i], rows=[];
        for await(const row of readStoredRows(path.join(directory,sheet.dataFile),sheet.columns))rows.push(row);
        const loaded={...sheet,rows};delete loaded.dataFile;
        const {filteredRows,...summary}=analyzeDataset(loaded);
        sheet.analytics=summary;sheet.contentHash=hashWorkbook([loaded]);
        sheet.preview=rows.slice(0,10);
        onProgress({stage:'worksheet-analyzed',worksheetIndex:i+1,worksheetCount:manifests.length,rowCount:sheet.rowCount,columnCount:sheet.columns.length});
      }
      return validateSheets(manifests);
    }
    const sheets=[];
    for(const sheet of manifests){const rows=[];for await(const row of readStoredRows(path.join(directory,sheet.dataFile),sheet.columns))rows.push(row);const {dataFile,rowCount,...metadata}=sheet;sheets.push({...metadata,rows});}
    return validateSheets(sheets);
  } finally {if(ownDirectory)fs.rmSync(directory,{recursive:true,force:true});}
}
export function parseSpreadsheetInWorker(buffer,ext,{outputDir,signal,onProgress=()=>{},task}={}) {
  if(signal?.aborted)return Promise.reject(Object.assign(new Error('Spreadsheet upload cancelled.'),{code:'PARSER_CANCELLED'}));
  if(activeWorkers>=parserLimits.concurrency)return Promise.reject(Object.assign(new Error('Spreadsheet processing is busy. Please retry shortly.'),{code:'PARSER_BUSY'}));
  const bytes=Uint8Array.from(buffer);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{buffer:bytes,ext,outputDir,task},transferList:[bytes.buffer],resourceLimits:{maxOldGenerationSizeMb:parserLimits.heapMiB}});
    activeWorkers++;let settled=false,watchLogged=false;
    async function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);await worker.terminate();if(error)reject(error);else resolve(value);}
    const cancel=()=>finish(Object.assign(new Error('Spreadsheet upload cancelled.'),{code:'PARSER_CANCELLED'}));
    const timer=setTimeout(()=>finish(Object.assign(new Error('Spreadsheet processing exceeded its time limit. Split the workbook into smaller files.'),{code:'PARSER_TIMEOUT'})),parserLimits.timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    worker.on('message',result=>{
      if(settled)return;
      if(result?.type===PROGRESS_TYPE){try{onProgress(result.progress);}catch{}return;}
      if(result?.type!==RESULT_TYPE){if(!watchLogged&&(result?.['watch:import']||result?.['watch:require'])){watchLogged=true;console.info('Spreadsheet parser:',{stage:'worker-watch-notification-ignored'});}return;}
      if(result.error)return finish(Object.assign(new Error(result.error),{code:result.code||'SPREADSHEET_PARSE_FAILED'}));
      if(task)return finish(null,result.taskResult);
      try{const sheets=validateSheets(result.sheets);Object.defineProperty(sheets,'metrics',{value:result.metrics});finish(null,sheets);}catch(error){finish(error);}
    });
    worker.once('error',error=>finish(error.code==='ERR_WORKER_OUT_OF_MEMORY'?Object.assign(new Error('This workbook exceeds the bounded parser memory budget. Split it into smaller workbooks.'),{code:error.code}):error));
    worker.once('exit',code=>{activeWorkers--;if(!settled)finish(new Error('Spreadsheet parser stopped before returning complete worksheets. Please retry.'));drainQueries();});
  });
}
if(!isMainThread){
  const started=performance.now();let peakHeap=0,peakRss=0;
  const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);};
  const timer=setInterval(sample,25);timer.unref();
  const onProgress=progress=>{sample();parentPort.postMessage({type:PROGRESS_TYPE,progress});console.info('Spreadsheet parser:',progress);};
  try{
    sample();const view=workerData.buffer;
    if(workerData.task){
      const {mode,sheet,filename,options,document,exportPath}=workerData.task;
      const rows=[];for await(const row of readStoredRows(filename,sheet.columns))rows.push(row);
      const loaded={...sheet,rows};
      let taskResult;
      if(mode==='preview')taskResult=previewDataset(loaded,options);
      else {
        const stats=analyzeDataset(loaded,options);
        if(mode==='analysis'){const {filteredRows,...summary}=stats;taskResult=summary;}
        else {
          stats.filters=Object.fromEntries(['search','categoryColumn','categoryValue'].filter(key=>options[key]).map(key=>[key,options[key]]));
          const {writeExcelReport,createPdfReport}=await import('./reports.js');
          const stream=fs.createWriteStream(exportPath,{mode:0o600});
          if(mode==='xlsx')await writeExcelReport(stream,document,loaded,stats,new Date().toISOString());
          else {const {pipeline}=await import('node:stream/promises');const pdf=createPdfReport(document,loaded,stats,new Date().toISOString());const written=pipeline(pdf,stream);pdf.end();await written;}
          taskResult={bytes:fs.statSync(exportPath).size};
        }
      }
      parentPort.postMessage({type:RESULT_TYPE,taskResult});
    }else{
    const sheets=await parseSpreadsheet(Buffer.from(view.buffer,view.byteOffset,view.byteLength),workerData.ext,{outputDir:workerData.outputDir,onProgress});sample();
    const metrics={elapsedMs:Math.round(performance.now()-started),peakHeapMiB:+(peakHeap/1048576).toFixed(1),peakRssMiB:+(peakRss/1048576).toFixed(1),heapLimitMiB:parserLimits.heapMiB};
    console.info('Spreadsheet parser completed:',metrics);parentPort.postMessage({type:RESULT_TYPE,sheets,metrics});
    }
  }catch(error){console.error('Spreadsheet parser failed:',{errorName:error.name,errorCode:error.code||'SPREADSHEET_PARSE_FAILED'});parentPort.postMessage({type:RESULT_TYPE,error:error.message,code:error.code});}
  finally{clearInterval(timer);}
}
