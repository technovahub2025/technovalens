import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {SaxesParser} from 'saxes';
import {analyzeDataset} from '../analytics.js';
import {createExcelReport,writeExcelReport} from '../reports.js';
import {excelTableHeaders} from '../excel-report.js';

const sheet={name:'Sales',columns:['Date','Region','Revenue INR','Discount Percent'],rows:[{Date:'2026-01-01',Region:'North','Revenue INR':1250.5,'Discount Percent':10},{Date:'2026-02-01',Region:'South','Revenue INR':2499.5,'Discount Percent':null},{Date:'2026-02-01',Region:'North','Revenue INR':0,'Discount Percent':0}]};
const doc={name:'sample.xlsx',sheets:[sheet]},at='2026-11-14T12:00:00Z';
async function bufferFor(data,streaming){const stats=analyzeDataset(data);if(!streaming)return createExcelReport(doc,data,stats,at).xlsx.writeBuffer();const parts=[],sink=new Writable({write(chunk,_encoding,done){parts.push(chunk);done();}});await writeExcelReport(sink,doc,data,stats,at);return Buffer.concat(parts);}
for(const streaming of [false,true])test(`${streaming?'streaming':'document'} XLSX has dashboard, editable charts, styled tables and exact source data`,async()=>{
  const buffer=await bufferFor(sheet,streaming),zip=await JSZip.loadAsync(buffer),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map(ws=>ws.name),['Executive Dashboard','Dataset Overview','Column Statistics','Findings','Chart Data','Selected Data']);
  assert.equal(workbook.worksheets[0].getCell('A8').value,3);assert.equal(workbook.worksheets[0].getCell('G8').value,1);
  assert.ok(workbook.worksheets[0].model.merges.includes('A1:L2'));assert.equal(workbook.worksheets[0].views[0].showGridLines,false);
  const raw=workbook.getWorksheet('Selected Data');assert.equal(raw.rowCount,4);assert.equal(raw.getTable('SelectedRecords').table.tableRef,'A1:D4');assert.equal(raw.views[0].ySplit,1);
  assert.equal(raw.getCell('D2').numFmt,'0.00"%"');assert.match(raw.getCell('C2').numFmt,/INR/);assert.notDeepEqual(raw.getCell('A2').fill,raw.getCell('A3').fill);
  sheet.rows.forEach((record,index)=>sheet.columns.forEach((column,col)=>assert.equal(raw.getCell(index+2,col+1).value,record[column])));
  assert.equal(workbook.getWorksheet('Column Statistics').getCell('H4').value,3750);assert.ok(workbook.getWorksheet('Column Statistics').conditionalFormattings.length);
  const charts=Object.keys(zip.files).filter(name=>/^xl\/charts\/analyticsChart\d+\.xml$/.test(name));assert.equal(charts.length,3);
  for(const name of Object.keys(zip.files).filter(name=>/\.xml$|\.rels$/.test(name))){const parser=new SaxesParser({xmlns:true});parser.write(await zip.file(name).async('string')).close();}
  assert.match(await zip.file(charts[0]).async('string'),/barChart/);assert.match(await zip.file(charts[1]).async('string'),/doughnutChart/);assert.match(await zip.file(charts[2]).async('string'),/lineChart/);
  for(const name of charts)assert.match(await zip.file(name).async('string'),/Chart Data.*\$[AB]\$/);
});
test('filtered, text-only, empty and case-distinct worksheets preserve data without inventing charts or table headings',async()=>{
  const text={name:'Text',columns:['Qty','QTY','Qty (2)'],rows:[{Qty:'=literal',QTY:'001', 'Qty (2)':'text'}]};
  assert.deepEqual(excelTableHeaders(text.columns),['Qty','QTY (2)','Qty (2) (2)']);
  for(const data of [text,{name:'Empty',columns:['Value'],rows:[]},{name:'No columns',columns:[],rows:[]}]){
    const buffer=await bufferFor(data,true),book=new ExcelJS.Workbook();await book.xlsx.load(buffer);assert.equal(book.getWorksheet('Selected Data').rowCount,data.columns.length?data.rows.length+1:0);
    const zip=await JSZip.loadAsync(buffer);if(!data.rows.length)assert.equal(Object.keys(zip.files).filter(name=>/^xl\/charts\//.test(name)).length,0);
  }
});
