import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

if (!isMainThread) {
  const sample = () => { const {heapUsed, rss}=process.memoryUsage();parentPort.postMessage({type:'benchmark-memory',heapUsed,rss}); };
  sample();const timer=setInterval(sample,25);timer.unref();
  if(workerData.legacy){
    const {default:ExcelJS}=await import('exceljs');
    const {prepareXlsx}=await import('./xlsx-compat.js');
    const prepared=await prepareXlsx(Buffer.from(workerData.buffer));
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(prepared.buffer);
    parentPort.postMessage({type:'technovalens:spreadsheet-result:v1',sheets:workbook.worksheets.map(sheet=>({name:sheet.name,rowCount:Math.max(0,sheet.rowCount-1),columns:Array.from({length:sheet.columnCount},(_,i)=>`Column ${i+1}`)}))});
  }else await import('./spreadsheet-parser.js');
  sample();
} else {
  const filename=process.argv[2];
  const outputDir=process.argv.includes('--disk')?mkdtempSync(path.join(os.tmpdir(),'technovalens-benchmark-')):undefined;
  const buffer=readFileSync(filename), started=performance.now();
  let peakRss=process.memoryUsage().rss,peakHeap=0, outcome;
  const worker=new Worker(new URL(import.meta.url),{workerData:{buffer,ext:'xlsx',legacy:process.argv.includes('--legacy'),outputDir},resourceLimits:{maxOldGenerationSizeMb:256}});
  const timer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},10);
  worker.on('message',message=>{
    if(message.type==='benchmark-memory'){peakHeap=Math.max(peakHeap,message.heapUsed);peakRss=Math.max(peakRss,message.rss);}
    if(message.type==='technovalens:spreadsheet-result:v1')outcome=message.error?{error:message.error}:{parserMetrics:message.metrics,worksheets:message.sheets.map(s=>({name:s.name,rows:s.rows?.length??s.rowCount,columns:s.columns.length,headerRow:s.headerRow,numericColumns:s.analytics?.types.numeric.length,formulaCount:s.formulaCount,uncachedFormulas:s.uncachedFormulas,headers:s.columns.slice(0,8)}))};
  });
  worker.on('error',error=>{outcome={error:error.message,code:error.code};});
  worker.on('exit',code=>{clearInterval(timer);if(outputDir)rmSync(outputDir,{recursive:true,force:true});console.log(JSON.stringify({mode:process.argv.includes('--legacy')?'legacy':'streaming',oldGenerationLimitMiB:256,elapsedMs:Math.round(performance.now()-started),peakRssMiB:+(peakRss/1048576).toFixed(1),sampledPeakWorkerHeapMiB:+(peakHeap/1048576).toFixed(1),exitCode:code,...outcome}));});
}
