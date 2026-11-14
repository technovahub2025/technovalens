// Read-only source workbooks; all generated files stay in this isolated folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {parseSpreadsheet,querySpreadsheetInWorker} from './spreadsheet-parser.js';
import {readStoredRows} from './xlsx-stream.js';
import {analyzeDataset} from './analytics.js';
const root=path.resolve(import.meta.dirname,'.data/xlsx-report-validation');await fs.mkdir(root,{recursive:true});
const results=[];
for(const filename of process.argv.slice(2)){
  const slug=path.basename(filename,'.xlsx').replace(/[^a-z0-9]+/gi,'-'),directory=path.join(root,slug);await fs.mkdir(directory,{recursive:true});
  const sheets=await parseSpreadsheet(await fs.readFile(filename),'xlsx',{outputDir:directory});
  await fs.writeFile(path.join(directory,'sheets.json'),JSON.stringify(sheets));
  for(const [index,sheet] of sheets.entries()){
    const output=path.join(directory,`report-${String(index+1).padStart(2,'0')}.xlsx`),started=performance.now();
    await querySpreadsheetInWorker({mode:'xlsx',sheet,filename:path.join(directory,sheet.dataFile),options:{},document:{name:path.basename(filename),sheets},exportPath:output});
    const buffer=await fs.readFile(output),book=new ExcelJS.Workbook();await book.xlsx.load(buffer);
    assert.equal(book.worksheets[0].name,'Executive Dashboard');assert.equal(book.worksheets.length,6);
    const raw=book.getWorksheet('Selected Data');assert.equal(raw.rowCount,sheet.rowCount+1);assert.equal(raw.views[0].ySplit,1);assert.ok(raw.getTable('SelectedRecords'));
    const rows=[];for await(const row of readStoredRows(path.join(directory,sheet.dataFile),sheet.columns))rows.push(row);
    for(const [n,row] of rows.entries())for(const [c,column] of sheet.columns.entries())assert.deepEqual(raw.getCell(n+2,c+1).value,row[column]??null,`${sheet.name} source row ${n+2}, ${column}`);
    const stats=analyzeDataset({...sheet,rows}),profile=book.getWorksheet('Column Statistics');
    for(const [n,column] of sheet.columns.entries()){
      const s=stats.columnStats[column];assert.deepEqual(Array.from({length:11},(_,index)=>profile.getCell(n+2,index+1).value),[column,s.type,s.count-s.missing,s.missing,s.unique,s.invalid,s.numericCount,s.sum,s.average,s.min,s.max]);
    }
    assert.equal(book.worksheets[0].getCell('A8').value,stats.rowCount);assert.equal(book.worksheets[0].getCell('G8').value,stats.missingValues);
    const zip=await JSZip.loadAsync(buffer),chartNames=Object.keys(zip.files).filter(name=>/^xl\/charts\/analyticsChart\d+\.xml$/.test(name));
    const expected=[stats.charts.bar.data.length,stats.charts.pie.length,stats.charts.trend.data.length].filter(Boolean).length;assert.equal(chartNames.length,expected);
    const result={workbook:path.basename(filename),worksheet:sheet.name,output,records:sheet.rowCount,columns:sheet.columns.length,charts:chartNames.length,bytes:buffer.length,elapsedMs:Math.round(performance.now()-started),allValuesVerified:true};results.push(result);console.log(JSON.stringify(result));
  }
}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));
