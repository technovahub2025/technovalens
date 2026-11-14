// Read the source workbook; write only isolated temporary parser files.
// Usage: node verify-spreadsheet-questions.mjs path/to/sample.xlsx
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {parseSpreadsheet,querySpreadsheetInWorker} from './spreadsheet-parser.js';
import {planSpreadsheetQuestion} from './exact-spreadsheet.js';

const filename=process.argv[2];
if(!filename)throw new Error('Supply the sample workbook path.');
const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(filename);
const sales=workbook.getWorksheet('Sales');assert.ok(sales,'Sample must contain Sales');
const headers=sales.getRow(1).values;
const idIndex=headers.findIndex(value=>value==='Order ID');assert.ok(idIndex>0,'Verified Order ID header required');
const expected=[];
sales.eachRow((row,number)=>{if(number>1)expected.push({number,id:String(row.getCell(idIndex).value??'').trim(),values:row.values});});
const ids=expected.map(row=>row.id).filter(Boolean),distinct=new Set(ids).size;
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'technovalens-question-verification-'));
try{
  const sheets=await parseSpreadsheet(await fs.readFile(filename),'xlsx',{outputDir:directory});
  const sheet=sheets.find(sheet=>sheet.name==='Sales');assert.ok(sheet);assert.equal(sheet.rows,undefined);
  assert.ok(expected.length>sheet.preview.length,'Verification must exceed preview size');
  const ask=question=>querySpreadsheetInWorker({mode:'chat',sheet,filename:path.join(directory,sheet.dataFile),options:{plan:planSpreadsheetQuestion(sheets,question)}});
  for(const phrase of ['How many orders are there','number of orders','count orders','total orders']){
    const result=await ask(`${phrase} in Sales?`);
    assert.equal(result.calculation.value,ids.length);
    assert.equal(result.calculation.totalRows,expected.length);
    assert.equal(result.calculation.distinctOrders,distinct);
  }
  for(const phrase of ['how many records','number of rows'])assert.equal((await ask(`${phrase} in Sales`)).calculation.value,expected.length);
  const numericIndex=headers.findIndex((header,index)=>index!==idIndex&&expected.every(row=>typeof row.values[index]==='number'));
  assert.ok(numericIndex>0,'Sample needs a complete numeric metric');
  const metric=headers[numericIndex],numbers=expected.map(row=>row.values[numericIndex]);
  const extrema=await ask(`min and max ${metric} in Sales`);
  assert.equal(extrema.calculation.min.value,Math.min(...numbers));assert.equal(extrema.calculation.max.value,Math.max(...numbers));
  const target=expected.at(-1).id,lookup=await ask(`Find Order ID = "${target}" in Sales`);
  assert.deepEqual(lookup.calculation.rows.map(row=>row.row),expected.filter(row=>row.id===target).map(row=>row.number));
  assert.equal((await ask('What is average value in Sales?')).clarification,true);
  console.log(JSON.stringify({workbook:path.basename(filename),worksheet:'Sales',totalRows:expected.length,nonemptyOrderIds:ids.length,distinctOrders:distinct,metric,min:Math.min(...numbers),max:Math.max(...numbers),lookup:{id:target,rows:lookup.calculation.rows.map(row=>row.row)},verified:true},null,2));
}finally{await fs.rm(directory,{recursive:true,force:true});}
