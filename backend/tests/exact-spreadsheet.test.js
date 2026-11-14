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

const orders={name:'Sales',columns:['Order ID','Amount','Region'],sourceRows:[3,4,7,8,9],rows:[
  {'Order ID':'ORD-001',Amount:10,Region:'North'},
  {'Order ID':'ORD-002',Amount:20,Region:'South'},
  {'Order ID':'ORD-001',Amount:30,Region:'North'},
  {'Order ID':null,Amount:40,Region:'North'},
  {'Order ID':'ORD-0010',Amount:50,Region:'South'}
]};
const orderQuestions=['How many orders are there in Sales?','number of orders in Sales','count orders in Sales','total orders in Sales'];
const askOrders=(question,data=orders)=>{
  const plan=planSpreadsheetQuestion([data,{...sheet,name:'Inventory'}],question,{selectedSheet:'Inventory'});
  assert.deepEqual(plan.sheetNames,['Sales']);
  return answerSheetQuestion(data,plan);
};

test('order count synonyms resolve the named sheet and distinguish rows, nonempty IDs and distinct orders',()=>{
  for(const question of orderQuestions){
    const result=askOrders(question);
    assert.equal(result.calculation.value,4,question);
    assert.equal(result.calculation.totalRows,5);
    assert.equal(result.calculation.distinctOrders,3);
    assert.equal(result.calculation.missingOrderIds,1);
    assert.equal(result.calculation.duplicateOrderIds,1);
    assert.match(result.answer,/5 total data rows, 3 distinct orders/);
    assert.equal(result.references[0].columns[0].name,'Order ID');
    assert.deepEqual(result.references[0].ranges,[[3,4],[7,9]]);
  }
  for(const phrase of ['how many records','number of rows','count rows','total records'])assert.equal(askOrders(`${phrase} in Sales?`).calculation.value,5);
  for(const phrase of ['how many distinct orders','number of unique orders','count distinct orders','total unique orders'])assert.equal(askOrders(`${phrase} in Sales`).calculation.value,3);
});

test('order counts do not require numeric columns, infer no unverified order key and retain filters/groups',()=>{
  const textOnly={...orders,columns:['Order ID'],rows:[{'Order ID':'A'},{'Order ID':'B'}],sourceRows:[2,3]};
  for(const question of orderQuestions){const result=askOrders(question,textOnly);assert.equal(result.calculation.value,2);assert.match(result.answer,/2 orders/);}
  for(const data of [sheet,{...orders,columns:['Customer ID','Amount']},{...orders,columns:['Order ID','Order_ID']}])assert.equal(askOrders(orderQuestions[0],data).clarification,true);
  assert.equal(askOrders('count orders where Region = North in Sales').calculation.value,2);
  assert.deepEqual(askOrders('count orders by Region in Sales').calculation.data.map(group=>group.value),[2,2]);
  const empty=askOrders('total orders in Sales',{...textOnly,rows:[],sourceRows:[]});assert.equal(empty.calculation.value,0);
});

test('minimum and maximum share the exact metric and filters, including grouping and monthly aggregates',()=>{
  for(const phrase of ['min and max','minimum and maximum','lowest and highest']){
    const result=askOrders(`${phrase} Amount in Sales`);
    assert.equal(result.calculation.min.value,10);assert.equal(result.calculation.max.value,50);
    assert.equal(result.references[0].columns[0].name,'Amount');
  }
  const filtered=askOrders('min and max Amount where Region = North in Sales');
  assert.equal(filtered.calculation.min.value,10);assert.equal(filtered.calculation.max.value,40);
  const grouped=askOrders('min and max Amount by Region in Sales');assert.deepEqual(grouped.calculation.max.data.map(group=>group.value),[40,50]);
  const monthly=ask('min and max Revenue by month');assert.deepEqual(monthly.calculation.min.data.map(item=>item.value),[100,50]);
  for(const question of ['What is average value?','min and max Profit in Sales'])assert.equal(askOrders(question.includes('Sales')?question:`${question.replace('?','')} in Sales`).clarification,true);
});

test('exact Order ID lookup returns all matching rows and verified physical references without substring matches',()=>{
  for(const phrase of ['Show Order ID ORD-001','Find Order ID = "ORD-001"',"Look up Order ID equals 'ORD-001'",'What is Amount for Order ID ORD-001']){
    const result=askOrders(`${phrase} in Sales?`);
    assert.equal(result.calculation.matchedRows,2,phrase);
    assert.deepEqual(result.calculation.rows.map(row=>row.row),[3,7]);
    assert.deepEqual(result.references[0].ranges,[[3,3],[7,7]]);
    assert.match(result.answer,/Excel row 7/);
  }
  assert.equal(askOrders('Find Order ID ORD-00 in Sales').calculation.matchedRows,0);
  assert.equal(askOrders('Find Order ID ord-001 in Sales').calculation.matchedRows,0);
  assert.equal(askOrders('Find Order ID in Sales').clarification,true);
  const normalized=askOrders('Find Order ID ORD-001 in Sales',{...orders,sourceRows:undefined});assert.equal(normalized.references[0].rowKind,'normalized');assert.doesNotMatch(normalized.answer,/Excel row/);
});

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
