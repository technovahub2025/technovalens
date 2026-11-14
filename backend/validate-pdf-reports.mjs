// Local-only report diagnostics. Inputs are read; artifacts go into an isolated directory.
// node validate-pdf-reports.mjs before|after workbook.xlsx [another.xlsx]
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import {PDFParse} from 'pdf-parse';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {parseSpreadsheet,querySpreadsheetInWorker} from './spreadsheet-parser.js';
import {readStoredRows} from './xlsx-stream.js';
import {analyzeDataset} from './analytics.js';
import assert from 'node:assert/strict';

const [phase,...files]=process.argv.slice(2);
if(!['before','after'].includes(phase)||!files.length)throw new Error('Usage: node validate-pdf-reports.mjs before|after workbook.xlsx [...]');
const root=path.resolve(import.meta.dirname,'.data/pdf-report-validation');await fs.mkdir(root,{recursive:true});
const baseline=path.join(root,'reports-before.mjs');
if(phase==='before'){
  await fs.copyFile(new URL('./reports.js',import.meta.url),baseline);
  // Newer report entry points delegate to a sibling module; snapshot both.
  try{await fs.copyFile(new URL('./pdf-report.js',import.meta.url),path.join(root,'pdf-report.js'));}catch(error){if(error.code!=='ENOENT')throw error;}
}
const {createPdfReport}=await import(phase==='before'?pathToFileURL(baseline).href:'./reports.js');
const results=[];
for(const filename of files){
  const slug=path.basename(filename,'.xlsx').replace(/[^a-z0-9]+/gi,'-');
  const directory=path.join(root,slug);await fs.mkdir(directory,{recursive:true});
  const manifest=path.join(directory,'sheets.json');
  let sheets;
  if(phase==='before'){
    sheets=await parseSpreadsheet(await fs.readFile(filename),'xlsx',{outputDir:directory});
    await fs.writeFile(manifest,JSON.stringify(sheets));
  }else sheets=JSON.parse(await fs.readFile(manifest,'utf8'));
  for(const [index,metadata] of sheets.entries()){
    const rows=[];for await(const row of readStoredRows(path.join(directory,metadata.dataFile),metadata.columns))rows.push(row);
    const sheet={...metadata,rows},stats=analyzeDataset(sheet),prefix=`${phase}-${String(index+1).padStart(2,'0')}`;
    const output=path.join(directory,`${prefix}.pdf`);
    if(phase==='after'){
      await querySpreadsheetInWorker({mode:'pdf',sheet:metadata,filename:path.join(directory,metadata.dataFile),options:{},document:{name:path.basename(filename),sheets},exportPath:output});
    }else{
      const pdf=createPdfReport({name:path.basename(filename),sheets},sheet,stats,'2026-11-14T12:00:00Z');
      const written=pipeline(pdf,createWriteStream(output));pdf.end();await written;
    }
    const parser=new PDFParse({data:await fs.readFile(output)}),pages=[];
    try{
      const text=await parser.getText({pageJoiner:''});
      const thumbnails=[];
      for(let n=1;n<=text.total;n++){
        const page=await parser.doc.getPage(n),content=await page.getTextContent(),viewport=page.getViewport({scale:1});
        const items=content.items.filter(item=>item.str?.trim());
        const body=items.filter(item=>{const y=viewport.height-item.transform[5];return y>75&&y<775;});
        const clipped=items.filter(item=>item.transform[4]<35||item.transform[4]+item.width>viewport.width-35||item.transform[5]<25||item.transform[5]+item.height>viewport.height-25).map(item=>item.str);
        const screenshot=(await parser.getScreenshot({partial:[n],scale:1,imageDataUrl:false})).pages[0];
        const png=path.join(directory,`${prefix}-page-${n}.png`);await fs.writeFile(png,screenshot.data);
        const bitmap=await loadImage(screenshot.data),canvas=createCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
        const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let ink=0,minY=canvas.height,maxY=0;
        for(let y=76;y<Math.min(775,canvas.height);y++)for(let x=36;x<canvas.width-36;x++){const at=(y*canvas.width+x)*4;if(Math.min(pixels[at],pixels[at+1],pixels[at+2])<230){ink++;minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
        const characters=body.reduce((sum,item)=>sum+item.str.length,0);
        const span=ink?maxY-minY:0;
        pages.push({page:n,characters,inkPixels:ink,bodySpan:span,clipped,blank:characters<10&&ink<100,nearlyEmpty:characters<100||span<180});
        if(phase==='after'){
          assert.ok(items.some(item=>item.str===`${n} / ${text.total}`),`Correct page number ${n}`);
          assert.ok(items.some(item=>item.str.includes('TECHNOVALENS / WORKBOOK INTELLIGENCE')),`Running header ${n}`);
        }
        thumbnails.push(bitmap);
      }
      // Eight pages per contact sheet, each large enough to inspect its structure.
      for(let start=0;start<thumbnails.length;start+=8){
        const batch=thumbnails.slice(start,start+8),canvas=createCanvas(1200,Math.ceil(batch.length/3)*590),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
        batch.forEach((bitmap,index)=>{const x=index%3*400,y=Math.floor(index/3)*590;ctx.drawImage(bitmap,x,y,390,552);ctx.fillStyle='#49306e';ctx.font='14px sans-serif';ctx.fillText(`Page ${start+index+1}`,x+12,y+573);});
        await fs.writeFile(path.join(directory,`${prefix}-contact-${start/8+1}.png`),canvas.toBuffer('image/png'));
      }
      const result={workbook:path.basename(filename),worksheet:sheet.name,phase,pages:pages.length,rows:stats.rowCount,columns:stats.columnCount,blankPages:pages.filter(page=>page.blank).map(page=>page.page),nearlyEmptyPages:pages.filter(page=>page.nearlyEmpty).map(page=>page.page),clippedPages:pages.filter(page=>page.clipped.length).map(page=>({page:page.page,text:page.clipped})),pageChecks:pages};
      results.push(result);console.log(JSON.stringify({...result,pageChecks:undefined}));
    }finally{await parser.destroy();}
  }
}
await fs.writeFile(path.join(root,`${phase}.json`),JSON.stringify(results,null,2));
if(phase==='after'&&results.some(result=>result.blankPages.length||result.nearlyEmptyPages.length||result.clippedPages.length))process.exitCode=1;
