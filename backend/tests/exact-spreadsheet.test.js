import test from 'node:test';
import assert from 'node:assert/strict';
import {planSpreadsheetQuestion,answerSheetQuestion,resolveWorksheetScope} from '../exact-spreadsheet.js';
import {answerPdfLocally} from '../local-document.js';

const sheet={name:'Sales',columns:['Region','Revenue','Date'],sourceRows:[3,4,7,8],rows:[
  {Region:'North',Revenue:100,Date:'2026-01-01'},
  {Region:'South',Revenue:50,Date:'2026-02-01'},
  {Region:'North',Revenue:200,Date:'2026-01-02'},
  {Region:'North',Revenue:null,Date:null}
]};
const ask=q=>answerSheetQuestion(sheet,planSpreadsheetQuestion([sheet],q));

test('current worksheet references use explicit selection for all sample and Eveready worksheet names',()=>{
  for(const names of [['Sales','Employees','Inventory','Expenses'],['PURLIN','CNC','PTW & HAND SETTING','DRILLING & PUNCHING','STIFFENER ','SETTING','WELDING','LATHE','CLEANING','PAINTING','DISPACHED']]){
    const sheets=names.map(name=>({...sheet,name}));
    for(const selectedSheet of names)for(const phrase of ['Summarise this sheet','Summarize current sheet','Summary of selected worksheet']){
      const plan=planSpreadsheetQuestion(sheets,phrase,{selectedSheet});
      assert.deepEqual(plan.sheetNames,[selectedSheet]);
      assert.equal(answerSheetQuestion(sheets.find(s=>s.name===selectedSheet),plan).calculation.worksheet,selectedSheet);
    }
    assert.equal(planSpreadsheetQuestion(sheets,'Summarise this sheet').clarification,true);
    assert.equal(planSpreadsheetQuestion(sheets,'Summarise this sheet',{selectedSheet:'missing'}).clarification,true);
    assert.deepEqual(planSpreadsheetQuestion(sheets,'Summarise the entire workbook',{selectedSheet:names[0]}).sheetNames,names);
    assert.deepEqual(planSpreadsheetQuestion(sheets,'count rows across all worksheets',{selectedSheet:names[0]}).sheetNames,names);
    assert.deepEqual(planSpreadsheetQuestion(sheets,'count rows in this workbook',{selectedSheet:names[0]}).sheetNames,names);
    assert.equal(planSpreadsheetQuestion(sheets,`summarize ${names[0]} and ${names[1]}`).clarification,true);
    assert.deepEqual(resolveWorksheetScope(sheets,'Explain this sheet',names[1]).sheetNames,[names[1]]);
  }
});
test('exact answers use all rows, explicit columns, filters and actual Excel references',()=>{
  assert.equal(ask('total Revenue').calculation.value,350);
  assert.equal(ask('average Revenue where Region = North').calculation.value,150);
  assert.equal(ask('maximum Revenue').calculation.value,200);
  assert.equal(ask('minimum Revenue').calculation.value,50);
  assert.equal(ask('count rows where Revenue >= 100').calculation.value,2);
  assert.deepEqual(ask('total Revenue by Region').calculation.data.map(g=>g.value),[300,50]);
  assert.deepEqual(ask('count rows by Region').calculation.data.map(g=>g.value),[3,1]);
  assert.deepEqual(ask('monthly Revenue trend').calculation.data,[{period:'2026-01',value:300},{period:'2026-02',value:50}]);
  const answer=ask('total Revenue where Region = North');
  assert.deepEqual(answer.references[0].ranges,[[3,3],[7,8]]);
  assert.equal(answer.references[0].columns[0].letter,'B');
});
test('ambiguous sheets, columns, currencies, dates and unsupported filters never guess',()=>{
  assert.equal(planSpreadsheetQuestion([sheet,{...sheet,name:'Costs'}],'total Revenue').clarification,true);
  for(const q of ['total Profit','total Revenue where Region near North','total Revenue where Date between 2026-02-30 and 2026-03-01','total Revenue where Region = North or Region = South'])assert.equal(ask(q).clarification,true,q);
  const mixed={...sheet,rows:[{Region:'North',Revenue:'$10',Date:null},{Region:'South',Revenue:'€20',Date:null}]};
  assert.equal(answerSheetQuestion(mixed,{operation:'sum',question:'total Revenue'}).clarification,true);
});
test('uncached formulas remain missing and references never manufacture physical row numbers',()=>{
  const data={...sheet,sourceRows:undefined,formulaCount:2,uncachedFormulas:1};
  const result=answerSheetQuestion(data,{operation:'sum',question:'total Revenue'});
  assert.match(result.answer,/cached results only/);assert.match(result.answer,/normalized data rows/);
});

test('monthly aggregates respect the requested operation and include the date source',()=>{
  const average=ask('average Revenue by month');
  assert.deepEqual(average.calculation.data,[{period:'2026-01',value:150},{period:'2026-02',value:50}]);
  assert.equal(average.calculation.aggregation,'average');
  assert.ok(average.references[0].columns.some(column=>column.name==='Date'));
  assert.deepEqual(ask('maximum Revenue by month').calculation.data.map(item=>item.value),[200,50]);
  assert.deepEqual(ask('minimum Revenue by month').calculation.data.map(item=>item.value),[100,50]);
});

test('multiple and compound calculations require clarification instead of silently choosing one',()=>{
  for(const question of ['sum and average Revenue','total Revenue difference','total Revenue growth','weighted average Revenue','net total Revenue']){
    assert.equal(planSpreadsheetQuestion([sheet],question).clarification,true,question);
  }
});

test('case-distinct workbook columns require an explicit exact column name',()=>{
  const data={name:'LATHE',columns:['Qty','QTY'],rows:[{Qty:10,QTY:200}]};
  const ambiguous=answerSheetQuestion(data,{operation:'sum',question:'total Qty'});
  assert.equal(ambiguous.clarification,true);
  assert.equal(answerSheetQuestion(data,{operation:'sum',question:'total column "Qty"'}).calculation.value,10);
  assert.equal(answerSheetQuestion(data,{operation:'sum',question:'total column "QTY"'}).calculation.value,200);
});
test('PDF text without verified page markers cannot produce a page citation',()=>{
  const text='Production revenue was 125 units. Production costs were 80 units. Production workers improved output during the year. '.repeat(10);
  const result=answerPdfLocally({chunks:[text],pageCount:2,textLength:text.length},'Summarize the document');
  assert.ok(result);assert.doesNotMatch(result,/\[Page \d+\]/);
});
