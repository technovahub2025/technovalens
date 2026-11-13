import fs from 'node:fs';
import path from 'node:path';

// At most one selected worksheet is retained, never all uploaded workbooks.
let cache;
const CACHE_BYTES=32*1024*1024;
export function clearSheetCache(fileId) { if(!fileId||cache?.fileId===fileId)cache=undefined; }
export function attachStoredSheets(document,root) {
  if(document.storageVersion!==2)return document;
  if(!/^[a-f0-9-]{36}$/i.test(document.fileId))throw new Error('Invalid stored workbook identifier.');
  for(const sheet of document.sheets) {
    if(!/^sheet-\d+\.ndjson$/.test(sheet.dataFile)||!Number.isInteger(sheet.rowCount))throw new Error('Incomplete stored worksheet metadata.');
    const filename=path.join(root,`${document.fileId}.sheets`,sheet.dataFile);
    if(!fs.statSync(filename).isFile())throw new Error('Normalized worksheet data is missing. Upload the workbook again.');
    Object.defineProperty(sheet,'rows',{configurable:true,enumerable:false,get(){
      const key=filename;
      if(cache?.key===key&&cache.expires>Date.now())return cache.rows;
      clearSheetCache();
      const text=fs.readFileSync(filename,'utf8');
      const rows=[];
      // Scan lines without creating another array containing every line.
      let start=0;
      for(let end=text.indexOf('\n');end>=0;end=text.indexOf('\n',start)){
        const values=JSON.parse(text.slice(start,end));rows.push(Object.fromEntries(sheet.columns.map((column,i)=>[column,values[i]??null])));start=end+1;
      }
      if(rows.length!==sheet.rowCount)throw new Error('Normalized worksheet data is incomplete. Upload the workbook again.');
      if(Buffer.byteLength(text)*6<=CACHE_BYTES)cache={key,fileId:document.fileId,rows,expires:Date.now()+60000};
      return rows;
    }});
  }
  Object.defineProperty(document,'rows',{configurable:true,enumerable:false,get(){return document.sheets[0].rows;}});
  return document;
}
