import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFParse} from 'pdf-parse';
import {analyzeDataset} from '../analytics.js';
import {createPdfReport,formatReportValue} from '../pdf-report.js';

async function inspect(sheet,check){
  const stats=analyzeDataset(sheet),pdf=createPdfReport({name:'layout-fixture.xlsx',sheets:[sheet]},sheet,stats,'2026-11-14T12:00:00Z');
  const parts=[];pdf.on('data',part=>parts.push(part));
  const finished=new Promise((resolve,reject)=>{pdf.on('end',resolve);pdf.on('error',reject);});pdf.end();await finished;
  const parser=new PDFParse({data:Buffer.concat(parts)});
  try{
    const result=await parser.getText({pageJoiner:''});
    for(let index=1;index<=result.total;index++){
      const page=await parser.doc.getPage(index),{items}=await page.getTextContent(),viewport=page.getViewport({scale:1});
      const texts=items.filter(item=>item.str?.trim());
      assert.ok(texts.some(item=>item.str.includes('TECHNOVALENS / WORKBOOK INTELLIGENCE')),`header on page ${index}`);
      assert.ok(texts.some(item=>item.str===`${index} / ${result.total}`),`correct footer on page ${index}`);
      const body=texts.filter(item=>item.transform[5]>65&&item.transform[5]<viewport.height-65);
      assert.ok(body.reduce((n,item)=>n+item.str.length,0)>60,`meaningful content on page ${index}`);
      for(const item of texts){
        assert.ok(item.transform[4]>=39&&item.transform[4]+item.width<=viewport.width-39,`horizontal bounds: ${item.str}`);
        assert.ok(item.transform[5]>=25&&item.transform[5]+item.height<viewport.height-20,`vertical bounds: ${item.str}`);
      }
      const bodyText=body.map(item=>item.str).join(' ');
      if(bodyText.includes('Data Quality & Key Statistics'))for(const header of ['Column / type','Data quality','Key statistics'])assert.ok(bodyText.includes(header),`repeated ${header}`);
    }
    await check(result,stats);
  }finally{await parser.destroy();}
}

test('PDF footers do not generate empty pages, and executive content precedes statistics',async()=>{
  const sheet={name:'Sales',columns:['Region','Revenue INR','Discount Percent','Date'],rows:[{Region:'North','Revenue INR':1250.5,'Discount Percent':10,Date:'2026-01-01'},{Region:'South','Revenue INR':2499.5,'Discount Percent':20,Date:'2026-02-01'}]};
  await inspect(sheet,async result=>{
    assert.ok(result.total<=3);
    assert.match(result.text,/Data Quality & Key Statistics/);assert.doesNotMatch(result.text,/Column profile and numeric summaries/);
    assert.ok(result.text.indexOf('Executive summary')<result.text.indexOf('Records by Region'));
    assert.ok(result.text.indexOf('Business insights')<result.text.indexOf('Data Quality & Key Statistics'));
    for(const value of ['Sum: INR 3,750','Average: INR 1,875','Minimum: INR 1,250.5','Maximum: INR 2,499.5','Sum: 30%','Average: 15%','Present: 2','Missing: 0','Distinct: 2'])assert.ok(result.text.includes(value),value);
  });
});

test('wide PDF tables repeat headings, retain every column and keep all text inside page bounds',async()=>{
  const columns=Array.from({length:73},(_,index)=>`Metric ${index} with a descriptive heading`);
  const rows=Array.from({length:3},(_,index)=>Object.fromEntries(columns.map((column,i)=>[column,i+index])));
  await inspect({name:'Wide worksheet',columns,rows},async result=>{
    assert.ok(result.total>=6);assert.match(result.text,/Data Quality & Key Statistics \(continued\)/);
    for(let index=0;index<73;index++)assert.ok(result.text.includes(`Metric ${index} with a`),`column ${index}`);
    assert.ok(!result.pages.at(-1).text.includes('Executive summary'));
  });
});

test('an exceptionally tall table cell splits cleanly without dropping its final text',async()=>{
  const column=`Long heading ${'wrapped column description '.repeat(260)}END-OF-HEADING`;
  await inspect({name:'Long cells',columns:[column],rows:[{[column]:'one'}]},async result=>{
    assert.ok(result.total>2);assert.match(result.text,/Column continued from previous page/);assert.match(result.text,/END-OF-HEADING/);
  });
});

test('empty worksheets export meaningful reports and units require an explicit label',async()=>{
  assert.equal(formatReportValue(0,'Revenue INR'),'INR 0');assert.equal(formatReportValue(0.25,'Discount Percent'),'0.25%');
  assert.equal(formatReportValue(0.25,'Value'),'0.25');assert.equal(formatReportValue(null,'INR'),'N/A');
  await inspect({name:'Empty',columns:[],rows:[]},async result=>{assert.match(result.text,/No columns are available/);assert.ok(result.total<=2);});
});
