import unzipper from 'unzipper';
import { SaxesParser } from 'saxes';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { parse as csvParse } from 'csv-parse';
import { createParserTimings } from './parser-timings.js';

const MAIN = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main']);
const MAX_ROWS=100000, MAX_COLUMNS=256, MAX_CELLS=2000000, MAX_EXPANDED=128*1024*1024;
const limit = () => new Error('Dataset limit: 100,000 rows, 256 columns and 2,000,000 cells per workbook (populated data). Split this file into smaller workbooks.');
const blank = value => value == null || typeof value === 'string' && !value.trim();
const dateFormat = fmt => /[ymdhMsb]/.test(String(fmt).replace(/\[[^\]]*\]|"[^"]*"|\\./g,''));
const builtInDate = id => id>=14&&id<=22 || id>=27&&id<=36 || id>=45&&id<=47 || id>=50&&id<=58;

export function checkZip(buffer) {
  let end=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--) if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0) throw new Error('Invalid XLSX archive.');
  const entries=buffer.readUInt16LE(end+10);let offset=buffer.readUInt32LE(end+16), expanded=0;
  if(entries>10000) throw new Error('Workbook archive contains too many entries.');
  for(let i=0;i<entries;i++) {
    if(offset+46>buffer.length || buffer.readUInt32LE(offset)!==0x02014b50) throw new Error('Invalid XLSX directory.');
    expanded+=buffer.readUInt32LE(offset+24);
    if(expanded>MAX_EXPANDED) throw new Error('Workbook exceeds the 128 MB expanded size limit.');
    offset+=46+buffer.readUInt16LE(offset+28)+buffer.readUInt16LE(offset+30)+buffer.readUInt16LE(offset+32);
  }
}

function sink(filename,timings,worksheetIndex) {
  const fd=timings.sync('storageWriteMs',()=>fs.openSync(filename,'w',0o600),worksheetIndex);let pending='';
  return {write(value){pending+=JSON.stringify(value)+'\n';if(pending.length>65536){timings.sync('storageWriteMs',()=>fs.writeSync(fd,pending),worksheetIndex);pending='';}},close(){timings.sync('storageWriteMs',()=>{try{if(pending)fs.writeSync(fd,pending);}finally{fs.closeSync(fd);}},worksheetIndex);}};
}
export async function* readStoredRows(filename, columns) {
  const stream=fs.createReadStream(filename,{encoding:'utf8'});
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  try {for await(const line of lines) if(line) {const values=JSON.parse(line);yield Object.fromEntries(columns.map((c,i)=>[c,values[i]??null]));}}
  finally {lines.close();stream.destroy();}
}

// Shared strings are indexed on disk with a small bounded read cache. A unique
// string in every cell must not turn into a second workbook-sized JS heap.
class Strings {
  constructor(directory,timings){this.timings=timings;this.filename=path.join(directory,'strings.tmp');this.fd=fs.openSync(this.filename,'w+',0o600);this.offsets=[];this.lengths=[];this.position=0;this.cache=new Map();this.cacheBytes=0;}
  add(text){const bytes=Buffer.from(text);if(this.offsets.length>=MAX_CELLS || bytes.length>1024*1024)throw limit();this.offsets.push(this.position);this.lengths.push(bytes.length);this.timings.sync('storageWriteMs',()=>fs.writeSync(this.fd,bytes,0,bytes.length,this.position));this.position+=bytes.length;}
  get(index){if(!Number.isInteger(index)||index<0||index>=this.offsets.length)throw new Error('Invalid XLSX shared string reference.');if(this.cache.has(index))return this.cache.get(index);const bytes=Buffer.allocUnsafe(this.lengths[index]);this.timings.sync('storageReadMs',()=>fs.readSync(this.fd,bytes,0,bytes.length,this.offsets[index]),this.worksheetIndex);const value=bytes.toString('utf8');if(this.cache.size>=512||this.cacheBytes+bytes.length>2*1024*1024){this.cache.clear();this.cacheBytes=0;}this.cache.set(index,value);this.cacheBytes+=bytes.length;return value;}
  close(){fs.closeSync(this.fd);fs.rmSync(this.filename,{force:true});}
}

function headersFor(values,width){const used=new Set();return Array.from({length:width},(_,i)=>{const base=String(values[i]??'').trim()||`Column ${i+1}`;let name=base,n=2;while(used.has(name))name=`${base} (${n++})`;used.add(name);return name;});}
function headerScore(row){const values=Object.values(row.values).filter(v=>!blank(v));const text=values.filter(v=>typeof v==='string'&&!/^[-+\d.]+$/.test(v)&&!/^\d{4}-\d\d-\d\d/.test(v));const unique=new Set(text).size;return unique*3+Math.min(text.length,unique*1.5)+values.length*.05;}

export async function streamSpreadsheet(buffer,ext,directory,{onProgress=()=>{},timings=createParserTimings()}={}) {
  let totalRows=0,totalCells=0,xmlCells=0,expandedBytes=0;
  const manifests=[];
  async function xml(entry,handlers,expectedRoot,worksheetIndex) {
    if(!entry)throw new Error('Some declared worksheets could not be read. A required XLSX part is missing.');
    const parser=new SaxesParser({xmlns:true});let root=false;
    parser.on('doctype',()=>{throw new Error('DOCTYPE is not supported in XLSX XML.');});
    parser.on('error',()=>{throw new Error('Invalid XLSX XML.');});
    parser.on('opentag',node=>{if(!root){root=true;if(expectedRoot&&(node.local!==expectedRoot||!MAIN.has(node.uri)))throw new Error('Invalid XLSX XML: unsupported namespace or root.');}handlers.open?.(node);});
    parser.on('text',text=>handlers.text?.(text));parser.on('cdata',text=>handlers.text?.(text));parser.on('closetag',node=>handlers.close?.(node));
    const stream=entry.stream(), decoder=new StringDecoder('utf8'),finishXml=timings.span('xmlMs',worksheetIndex);
    try {for await(const chunk of stream){expandedBytes+=chunk.length;if(expandedBytes>MAX_EXPANDED)throw new Error('Workbook exceeds the 128 MB expanded size limit.');parser.write(decoder.write(chunk));}parser.write(decoder.end()).close();}
    finally {stream.destroy();finishXml();}
  }
  async function normalize(meta,rawFile,width,candidates,csv=false) {
    const worksheetIndex=manifests.length+1,finishNormalization=timings.span('normalizationMs',worksheetIndex);
    onProgress({stage:'worksheet-storage',worksheetIndex});
    if(width>MAX_COLUMNS)throw limit();
    const header=csv?candidates[0]:candidates.reduce((best,row)=>!best||headerScore(row)>headerScore(best)+.01?row:best,null);
    const values=header?Array.from({length:width},(_,i)=>header.values[i]):[];
    const next=candidates.find(row=>row.number===header?.number+1);
    let dateHeading='';
    for(let i=0;i<width;i++){
      if(!blank(values[i]))dateHeading=/^\d{4}-\d\d-\d\d/.test(String(values[i]))?String(values[i]).slice(0,10):'';
      const sub=next?.values[i];
      if(dateHeading&&typeof sub==='string'&&!blank(sub)&&!/^[-+\d.]+$/.test(sub)&&sub.length<100)values[i]=`${dateHeading} ${sub.trim()}`;
    }
    const columns=headersFor(values,width);
    const filename=`sheet-${manifests.length}.ndjson`, writer=sink(path.join(directory,filename),timings,worksheetIndex);let rowCount=0;
    const lines=createInterface({input:fs.createReadStream(rawFile,{encoding:'utf8'}),crlfDelay:Infinity});
    try {for await(const line of lines){const row=JSON.parse(line);if(!header||row.number<=header.number)continue;const values=columns.map((_,i)=>row.values[i]??null);if(!row.formulas&&values.every(blank))continue;totalRows++;totalCells+=width;if(totalRows>MAX_ROWS||totalCells>MAX_CELLS)throw limit();writer.write(values);rowCount++;}}
    finally {writer.close();lines.close();fs.rmSync(rawFile,{force:true});finishNormalization();}
    const manifest={...meta,columns,rowCount,dataFile:filename,headerRow:header?.number||1};manifests.push(manifest);
    onProgress({stage:'worksheet-parsed',worksheetIndex:manifests.length,worksheetCount:ext==='csv'?1:undefined,rowCount,columnCount:width});
  }
  if(ext==='csv') {
    if(buffer.includes(0))throw new Error('CSV must be UTF-8 text.');
    const filename=path.join(directory,'rows.tmp'), writer=sink(filename,timings,1),candidates=[];let number=0,width=0;
    const parser=Readable.from([buffer]).pipe(csvParse({bom:true,skip_empty_lines:true,relax_column_count:true,max_record_size:1024*1024}));
    try {for await(const values of parser){number++;width=Math.max(width,values.length);if(width>MAX_COLUMNS||number>MAX_ROWS+1)throw limit();const row={number,values,formulas:0};if(!candidates.length)candidates.push(row);writer.write(row);}}
    finally{writer.close();parser.destroy();}
    await normalize({name:'CSV data',formulaCount:0,uncachedFormulas:0},filename,width,candidates,true);return manifests;
  }
  checkZip(buffer);
  const archive=await unzipper.Open.buffer(buffer), entries=new Map();
  for(const entry of archive.files){if(entries.has(entry.path))throw new Error('Duplicate XLSX archive entries.');entries.set(entry.path,entry);}
  if(!entries.has('xl/workbook.xml'))throw new Error('Invalid XLSX: xl/workbook.xml is missing.');
  const sheets=[], relationships=new Map(), formats=new Map(),dateStyles=[];let date1904=false;
  await xml(entries.get('xl/workbook.xml'),{open(node){if(!MAIN.has(node.uri))return;if(node.local==='workbookPr')date1904=['1','true'].includes(node.attributes.date1904?.value);if(node.local==='sheet')sheets.push({name:node.attributes.name?.value,rel:Object.values(node.attributes).find(a=>a.local==='id')?.value});}},'workbook');
  if(!sheets.length||sheets.some(s=>!s.name))throw new Error('No valid worksheets declared in this workbook.');
  if(sheets.length>32)throw new Error('Workbook exceeds the 32 worksheet limit.');
  await xml(entries.get('xl/_rels/workbook.xml.rels'),{open(node){if(node.local==='Relationship'){const attrs=node.attributes;relationships.set(attrs.Id?.value,{target:attrs.Target?.value,type:attrs.Type?.value,external:attrs.TargetMode?.value==='External'});}}});
  onProgress({stage:'worksheets-discovered',worksheetCount:sheets.length});
  if(entries.has('xl/styles.xml')) {let inCellXfs=false;await xml(entries.get('xl/styles.xml'),{open(node){if(!MAIN.has(node.uri))return;if(node.local==='numFmt')formats.set(+node.attributes.numFmtId?.value,node.attributes.formatCode?.value);if(node.local==='cellXfs')inCellXfs=true;if(node.local==='xf'&&inCellXfs){const id=+node.attributes.numFmtId?.value;dateStyles.push(builtInDate(id)||dateFormat(formats.get(id)||''));}},close(node){if(node.local==='cellXfs')inCellXfs=false;}},'styleSheet');}
  const strings=new Strings(directory,timings);
  try {
    if(entries.has('xl/sharedStrings.xml')) {let value='',inText=false,phonetic=0;await xml(entries.get('xl/sharedStrings.xml'),{open(node){if(!MAIN.has(node.uri))return;if(node.local==='si')value='';if(node.local==='rPh')phonetic++;if(node.local==='t'&&!phonetic)inText=true;},text(text){if(inText)value+=text;if(value.length>1024*1024)throw limit();},close(node){if(node.local==='t')inText=false;if(node.local==='rPh')phonetic--;if(node.local==='si')strings.add(value);}},'sst');}
    for(let sheetIndex=0;sheetIndex<sheets.length;sheetIndex++) {
      strings.worksheetIndex=sheetIndex+1;
      const sheet=sheets[sheetIndex], rel=relationships.get(sheet.rel);
      if(!rel||rel.external||!rel.type?.endsWith('/worksheet'))throw new Error('Some declared worksheets could not be read. Invalid worksheet relationships.');
      const target=decodeURIComponent(rel.target||''), part=path.posix.normalize(target.startsWith('/')?target.slice(1):path.posix.join('xl',target));
      if(!part.startsWith('xl/worksheets/')||!part.endsWith('.xml'))throw new Error('Invalid XLSX worksheet relationship target.');
      onProgress({stage:'worksheet-processing',worksheetIndex:sheetIndex+1,worksheetCount:sheets.length});
      const rawFile=path.join(directory,'rows.tmp'), writer=sink(rawFile,timings,sheetIndex+1), candidates=[];
      let row,cell,textTarget='',width=0,formulaCount=0,uncachedFormulas=0,rowNumber=0;
      try {await xml(entries.get(part),{
        open(node){if(!MAIN.has(node.uri))return;
          if(node.local==='row'){rowNumber=+(node.attributes.r?.value||rowNumber+1);row={number:rowNumber,values:{},formulas:0};}
          if(node.local==='c'&&row){if(++xmlCells>MAX_CELLS)throw limit();const address=node.attributes.r?.value||'';let column=0;for(const letter of address.match(/^[A-Z]+/i)?.[0]||'')column=column*26+letter.toUpperCase().charCodeAt(0)-64;cell={column:column?column-1:(row.lastColumn??-1)+1,type:node.attributes.t?.value,style:+node.attributes.s?.value,value:'',inline:'',formula:false,hasValue:false};row.lastColumn=cell.column;}
          if(cell&&node.local==='f'){cell.formula=true;row.formulas++;formulaCount++;}
          if(cell&&node.local==='v'){textTarget='value';cell.hasValue=true;}
          if(cell&&node.local==='t')textTarget='inline';
        },
        text(text){if(cell&&textTarget){cell[textTarget]+=text;if(cell[textTarget].length>1024*1024)throw limit();}},
        close(node){if(!MAIN.has(node.uri))return;
          if(['v','t'].includes(node.local))textTarget='';
          if(node.local==='c'&&cell){let value=null;
            if(cell.formula&&(!cell.hasValue||!cell.value.trim()))uncachedFormulas++;
            if(cell.type==='inlineStr')value=cell.inline;
            else if(cell.hasValue){if(cell.type==='s')value=strings.get(+cell.value);else if(cell.type==='b')value=cell.value==='1';else if(cell.type==='e')value=null;else if(['str','d'].includes(cell.type))value=cell.value;else if(cell.value.trim()){value=Number(cell.value);if(!Number.isFinite(value))throw new Error('Invalid numeric XLSX cell.');if(dateStyles[cell.style]){const date=new Date(Math.round((value-25569+(date1904?1462:0))*86400000));value=Number.isFinite(date.valueOf())?date.toISOString():null;}}}
            if(!blank(value)||cell.formula){if(cell.column>=MAX_COLUMNS)throw limit();row.values[cell.column]=value;width=Math.max(width,cell.column+1);}cell=null;
          }
          if(node.local==='row'&&row){if(Object.keys(row.values).length||row.formulas){writer.write(row);if(candidates.length<25)candidates.push(row);}row=null;}
        }
      },'worksheet',sheetIndex+1);}finally{writer.close();}
      await normalize({name:sheet.name,formulaCount,uncachedFormulas},rawFile,width,candidates);
    }
  } finally {strings.close();}
  return manifests;
}
