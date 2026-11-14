import { isBlank, parseNumeric, analyzeDataset } from './analytics.js';

const normalize=value=>String(value??'').toLocaleLowerCase().replace(/[^\p{L}\p{N}%]+/gu,' ').trim().replace(/\s+/g,' ');
const contains=(text,label)=>` ${normalize(text)} `.includes(` ${normalize(label)} `);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const format=value=>value==null?'not available':new Intl.NumberFormat('en',{maximumFractionDigits:10}).format(value);
const validDate=value=>/^\d{4}-\d\d-\d\d$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const clarify=message=>({answer:`Please specify ${message}`,clarification:true,source:'local-spreadsheet',references:[]});
const letter=index=>{let result='';for(let n=index+1;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;};

export function resolveWorksheetScope(sheets,question,selectedSheet=null) {
  if(selectedSheet!=null&&(typeof selectedSheet!=='string'||!sheets.some(sheet=>sheet.name===selectedSheet)))return clarify('an existing selected worksheet. The selection is stale or invalid.');
  const workbookWide=/\b(?:all (?:work)?sheets|(?:entire|whole|full) workbook|workbook-wide)\b|\b(?:in|across|throughout|for)\s+(?:the\s+|this\s+)?workbook\b|\b(?:summari[sz]e|summary|overview)\s+(?:of\s+)?(?:the\s+|this\s+)?workbook\b/i.test(question);
  if(workbookWide)return {sheetNames:sheets.map(sheet=>sheet.name),workbookWide:true};
  if(/\b(?:this|current|selected)\s+(?:work)?sheet\b/i.test(question))return selectedSheet?{sheetNames:[selectedSheet]}:clarify('the current worksheet using the worksheet selector. No worksheet has been assumed.');
  let named=sheets.filter(sheet=>contains(question,sheet.name));
  named=named.filter(sheet=>!named.some(other=>other!==sheet&&normalize(other.name).includes(normalize(sheet.name))));
  if(named.length>1&&!/\b(compare|comparison|versus|vs|across)\b/i.test(question)){
    if(selectedSheet&&named.some(sheet=>sheet.name===selectedSheet))return {sheetNames:[selectedSheet]};
    return clarify('one worksheet, or ask explicitly to compare the named worksheets.');
  }
  if(named.length)return {sheetNames:named.map(sheet=>sheet.name)};
  if(selectedSheet)return {sheetNames:[selectedSheet]};
  if(sheets.length===1)return {sheetNames:[sheets[0].name]};
  return clarify(`the worksheet (${sheets.map(sheet=>sheet.name).join(', ')}). No worksheet has been assumed.`);
}

export function planSpreadsheetQuestion(sheets,question,{selectedSheet=null}={}) {
  const q=String(question).trim();
  const requestedAggregations=[/\b(sum|total|combined)\b/i,/\b(average|avg|mean)\b/i,/\b(highest|maximum|max|largest)\b/i,/\b(lowest|minimum|min|smallest)\b/i].filter(pattern=>pattern.test(q));
  if(requestedAggregations.length>1)return clarify('one calculation per question (sum, average, minimum or maximum).');
  if(/\b(percent(?:age)?|ratio|median|difference|growth|weighted)\b|\bnet total\b/i.test(q))return clarify('the exact calculation and its columns. Ratios, changes and compound expressions are not inferred; ask for each supported aggregate separately.');
  let operation=/\b(how many|number of|count(?: of)?)\s+(?:work)?sheets?\b/i.test(q)?'sheets':/\b(how many|number of|list|which)\b.*\b(columns?|fields?)\b/i.test(q)?'columns':/\b(unique|distinct)\b/i.test(q)?'distinct':
    /\b(duplicate|duplicated)\b/i.test(q)?'duplicates':/\b(missing|null|blank|empty)\b/i.test(q)&&!/(where|with|only).*\b(missing|null|blank|empty)\b/i.test(q)?'missing':
    /\b(how many|number of|count(?: of)?)\b.*\b(rows?|records?)\b|\b(row|record) count\b/i.test(q)?'count':
    /\b(average|avg|mean)\b/i.test(q)?'average':/\b(highest|maximum|max|largest|most)\b/i.test(q)?'max':/\b(lowest|minimum|min|smallest|least)\b/i.test(q)?'min':
    /\b(sum|total|combined)\b/i.test(q)?'sum':/\b(trend|monthly|over time|growth)\b/i.test(q)?'trend':/\b(summary|summarize|summarise|overview|key metrics)\b/i.test(q)?'summary':null;
  if(/\b(recommend|recommendations|interpret|explain|insights|comprehensive|full analysis)\b/i.test(q)&&!operation)return null;
  if(!operation)return null;
  if(operation==='sheets')return {answer:`There are ${sheets.length} worksheets: ${sheets.map(s=>s.name).join(', ')}.`,source:'local-spreadsheet',references:[]};
  const scope=resolveWorksheetScope(sheets,q,selectedSheet);
  if(scope.answer)return scope;
  return {operation,question:q,...scope};
}

function ranges(values){
  const runs=[];for(const value of values){const previous=runs.at(-1);if(previous&&previous[1]+1===value)previous[1]=value;else runs.push([value,value]);}
  return {ranges:runs.slice(0,12),omittedRanges:Math.max(0,runs.length-12)};
}
function source(sheet,indices,columns){
  const refs=indices.map(index=>sheet.sourceRows?.[index]??index+1);
  return {worksheet:sheet.name,columns:columns.map(name=>({name,letter:letter(sheet.columns.indexOf(name))})),rowKind:sheet.sourceRows?'excel':'normalized',matchedRows:indices.length,...ranges(refs)};
}
function referenceText(reference){
  const columns=reference.columns?.map(c=>`${c.letter} (${c.name})`).join(', ')||'all columns';
  const rows=reference.ranges?.map(([a,b])=>a===b?String(a):`${a}–${b}`).join(', ')||'none';
  return `Source: worksheet "${reference.worksheet}"; ${columns}; ${reference.rowKind==='excel'?'Excel':'normalized data'} rows ${rows}${reference.omittedRanges?` (+${reference.omittedRanges} further ranges)`:''}; ${reference.matchedRows} matching records.`;
}

function filterRows(sheet,question){
  const q=question.replace(/[?!.]+$/,'');const conditions=[];
  if(/\b(last|previous|recent|top|bottom|less than|more than|greater than|before|after|excluding|without|deduplicat|unique rows)\b/i.test(q))return {error:clarify('explicit column comparisons and ISO date boundaries. Relative periods, ranking and deduplication rules are not assumed.')};
  if(/\bor\b|\bexcept\b|\bexcluding\b/i.test(q))return {error:clarify('separate questions with explicit supported AND filters. OR and exclusion expressions are not inferred.')};
  for(const column of sheet.columns){
    const expression=new RegExp(`${escape(column)}\\s*(>=|<=|!=|=|>|<|equals?|is|contains)\\s*(.+?)(?=\\s+and\\s+(?:${sheet.columns.map(escape).join('|')})\\s*(?:>=|<=|!=|=|>|<|equals?|is|contains)|$)`,'i');
    const match=q.match(expression);if(!match)continue;
    const value=match[2].trim().replace(/^['"]|['"]$/g,'');
    conditions.push({column,operator:match[1].toLowerCase(),value});
  }
  const between=q.match(new RegExp(`(${sheet.columns.map(escape).join('|')})\\s+between\\s+(\\d{4}-\\d{2}-\\d{2})\\s+and\\s+(\\d{4}-\\d{2}-\\d{2})`,'i'));
  if(between){if(!validDate(between[2])||!validDate(between[3])||between[2]>between[3])return {error:clarify('a valid ascending ISO date range (YYYY-MM-DD).')};const column=sheet.columns.find(c=>c.toLowerCase()===between[1].toLowerCase());conditions.push({column,operator:'between',value:between[2],end:between[3]});}
  if(/\b(where|with|only|between)\b/i.test(q)&&!conditions.length)return {error:clarify('the filter as Column = value, Column > number, or Date between YYYY-MM-DD and YYYY-MM-DD.')};
  const tail=q.match(/\bfor\s+["']?([^"']+)["']?$/i);
  if(!conditions.length&&tail&&!sheet.columns.some(c=>normalize(c).endsWith(normalize(tail[0])))){
    const wanted=tail[1].trim();
    const possible=sheet.columns.filter(c=>sheet.rows.some(row=>String(row[c]??'').toLowerCase()===wanted.toLowerCase()));
    if(possible.length===1)conditions.push({column:possible[0],operator:'=',value:wanted});
    else if(possible.length>1)return {error:clarify(`which column should equal "${wanted}" (${possible.join(', ')}).`)};
    else if(!/\ball\b/i.test(wanted))return {error:clarify(`a filter column and exact value for "${wanted}".`)};
  }
  for(const condition of conditions)if(['>','<','>=','<='].includes(condition.operator)&&parseNumeric(condition.value)===null&&!/^\d{4}-\d\d-\d\d$/.test(condition.value))return {error:clarify('a numeric threshold or an ISO date (YYYY-MM-DD).')};
  const indices=[];
  sheet.rows.forEach((row,index)=>{if(conditions.every(({column,operator,value,end})=>{
    const cell=row[column],raw=String(cell??'').trim(),target=value.trim();
    if(operator==='between')return raw.slice(0,10)>=target&&raw.slice(0,10)<=end;
    if(/^(?:not )?(blank|missing|null|empty)$/i.test(target)){const invert=operator==='!='!==/^not /i.test(target);return invert?!isBlank(cell):isBlank(cell);}
    if(operator==='contains')return raw.toLowerCase().includes(target.toLowerCase());
    if(['>','<','>=','<='].includes(operator)){
      if(isBlank(cell))return false;
      const date=/^\d{4}-\d\d-\d\d$/.test(target),a=date?raw.slice(0,10):parseNumeric(cell),b=date?target:parseNumeric(target);
      if(a===null)return false;return operator==='>'?a>b:operator==='<'?a<b:operator==='>='?a>=b:a<=b;
    }
    const equal=raw.toLowerCase()===target.toLowerCase();return operator==='!='?!equal:equal;
  }))indices.push(index);});
  return {indices,conditions};
}

export function answerSheetQuestion(sheet,plan){
  const {operation,question}=plan,q=question.split(/\bwhere\b|\bwith\b|\bonly\b/i)[0];
  const {indices,conditions,error}=filterRows(sheet,question);if(error)return error;
  const selected=indices.map(index=>sheet.rows[index]);
  const byClause=question.match(/\bby\s+(.+?)(?=\s+where\s+|$)/i);
  const groupedColumn=byClause?sheet.columns.find(c=>normalize(byClause[1])===normalize(c)):null;
  if(byClause&&!groupedColumn&&!/\bmonth\b/i.test(byClause[1]))return clarify('an exact grouping column using "by Column".');
  const stats=sheet.analytics||analyzeDataset(sheet);
  const numeric=stats.types.numeric;
  let metricCandidates=numeric.filter(c=>contains(q,c));
  metricCandidates=metricCandidates.filter(c=>!metricCandidates.some(other=>other!==c&&normalize(other).includes(normalize(c))));
  const quotedMetric=q.match(/\bcolumn\s+"([^"]+)"/i)?.[1];
  const metric=quotedMetric?numeric.find(column=>column===quotedMetric):metricCandidates.length===1?metricCandidates[0]:null;
  const exactMetricNeeded=['sum','average','min','max','trend'].includes(operation);
  if(exactMetricNeeded&&!metric)return clarify(`the numeric column in "${sheet.name}" (${numeric.join(', ')||'no numeric column was detected'}). No metric has been assumed.`);
  const reference=source(sheet,indices,[...new Set([...(metric?[metric]:[]),...conditions.map(c=>c.column)])]);
  let answer,calculation={operation,worksheet:sheet.name,matchedRows:indices.length,filters:conditions};
  if(operation==='columns')answer=`There are ${sheet.columns.length} columns in ${sheet.name}: ${sheet.columns.join(', ')}.`;
  else if(operation==='distinct'){
    const columns=sheet.columns.filter(c=>contains(q,c));if(columns.length!==1)return clarify('the column whose distinct values should be counted.');
    const value=new Set(selected.map(row=>row[columns[0]]).filter(v=>!isBlank(v)).map(String)).size;calculation={...calculation,column:columns[0],value};answer=`There are ${value} distinct nonblank values in ${columns[0]} in ${sheet.name}.`;
  }
  else if(operation==='count'){
    if(groupedColumn){const groups=new Map();for(const row of selected){const key=isBlank(row[groupedColumn])?'(blank)':String(row[groupedColumn]);groups.set(key,(groups.get(key)||0)+1);}const data=[...groups].map(([name,value])=>({name,value}));calculation={...calculation,groupColumn:groupedColumn,data};answer=`Record counts by ${groupedColumn} in ${sheet.name}: ${data.slice(0,30).map(g=>`${g.name}: ${g.value}`).join('; ')}.${data.length>30?` Showing 30 of ${data.length} groups; narrow the filter for others.`:''}`;}
    else answer=`There are ${indices.length} data rows in ${sheet.name}.`;
  }
  else if(operation==='duplicates'||operation==='missing'){
    const filtered=analyzeDataset({...sheet,rows:selected,analytics:undefined});const value=operation==='duplicates'?filtered.duplicateRows:filtered.missingValues;
    answer=`There are ${value} ${operation==='duplicates'?'duplicate rows beyond their first occurrence':'missing cells'} in ${sheet.name}.`;calculation.value=value;
  }else if(operation==='summary'){
    const filtered=conditions.length?analyzeDataset({...sheet,rows:selected,analytics:undefined}):stats;
    answer=`${sheet.name} has ${indices.length} rows and ${sheet.columns.length} columns. ${numeric.slice(0,5).map(c=>`${c}: total ${format(filtered.columnStats[c].sum)}, average ${format(filtered.columnStats[c].average)}`).join('; ')}.`;
  }else{
    const currencies=new Set(selected.map(row=>String(row[metric]??'').match(/[$€£₹]/)?.[0]).filter(Boolean));
    if(currencies.size>1)return clarify(`a single currency or an explicit conversion rule: "${metric}" contains mixed currency symbols.`);
    const values=selected.map(row=>parseNumeric(row[metric])).filter(v=>v!==null);
    const sum=values.reduce((n,v)=>n+v,0);
    const by=byClause;
    const group=groupedColumn;
    if(by&&!group&&operation!=='trend'&&!/\bmonth\b/i.test(by[1]))return clarify('the grouping column using "by Column".');
    if(operation==='trend'||by&&/\bmonth\b/i.test(by[1])){
      const dates=stats.types.date,mentioned=dates.filter(c=>contains(question,c));const date=mentioned.length===1?mentioned[0]:dates.length===1?dates[0]:null;
      if(!date)return clarify('one ISO date column for the monthly trend.');
      const periods=new Map();let omitted=0;
      for(const row of selected){const n=parseNumeric(row[metric]),d=String(row[date]??'').slice(0,10);if(n===null||!validDate(d)){omitted++;continue;}const month=d.slice(0,7),state=periods.get(month)||{sum:0,count:0,min:Infinity,max:-Infinity};state.sum+=n;state.count++;state.min=Math.min(state.min,n);state.max=Math.max(state.max,n);periods.set(month,state);}
      const aggregation=operation==='trend'?'sum':operation;
      const data=[...periods].sort(([a],[b])=>a.localeCompare(b)).map(([period,state])=>({period,value:aggregation==='average'?state.sum/state.count:aggregation==='min'?state.min:aggregation==='max'?state.max:state.sum}));
      reference.columns.push({name:date,letter:letter(sheet.columns.indexOf(date))});
      calculation={...calculation,column:metric,dateColumn:date,aggregation,data,excludedRows:omitted};
      answer=`Monthly ${metric} (${aggregation}) in ${sheet.name}: ${data.slice(0,48).map(item=>`${item.period}: ${format(item.value)}`).join('; ')||'no valid date/numeric pairs'}.${data.length>48?` Showing the first 48 of ${data.length} months.`:''} ${omitted} rows lacked a usable date/numeric value.`;
    }else if(group){
      const groups=new Map();for(const row of selected){const key=isBlank(row[group])?'(blank)':String(row[group]);const state=groups.get(key)||{sum:0,count:0,min:Infinity,max:-Infinity};const n=parseNumeric(row[metric]);if(n!==null){state.sum+=n;state.count++;state.min=Math.min(state.min,n);state.max=Math.max(state.max,n);}groups.set(key,state);}
      const data=[...groups].map(([name,g])=>({name,value:!g.count?null:operation==='average'?g.sum/g.count:operation==='min'?g.min:operation==='max'?g.max:g.sum,numericCount:g.count}));
      calculation={...calculation,column:metric,groupColumn:group,data};answer=`${operation} ${metric} by ${group} in ${sheet.name}: ${data.slice(0,30).map(g=>`${g.name}: ${format(g.value)} (${g.numericCount} numeric values)`).join('; ')}.${data.length>30?` Showing 30 of ${data.length} groups; narrow the filter for others.`:''}`;
    }else{
      const value=!values.length?null:operation==='sum'?sum:operation==='average'?sum/values.length:operation==='min'?values.reduce((a,b)=>Math.min(a,b),Infinity):values.reduce((a,b)=>Math.max(a,b),-Infinity);
      calculation={...calculation,column:metric,value,numericCount:values.length,excludedRows:indices.length-values.length};
      answer=`The ${operation==='average'?'average':operation==='min'?'lowest':operation==='max'?'highest':'total'} ${metric} is ${format(value)} in ${sheet.name}. ${values.length} numeric values; ${indices.length-values.length} missing or nonnumeric values excluded.`;
    }
  }
  if(operation==='count')calculation.value=indices.length;
  const warning=sheet.formulaCount?` Formula cells use cached results only; ${sheet.uncachedFormulas||0} uncached results are missing. No formulas were recalculated.`:'';
  return {answer:`${answer}${warning}\n\n${referenceText(reference)}`,source:'local-spreadsheet',references:[reference],calculation};
}
