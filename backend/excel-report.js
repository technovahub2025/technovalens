import ExcelJS from 'exceljs';
import {attachDocumentCharts,attachStreamParts,attachStreamSheetParts,columnLetter} from './xlsx-report-parts.js';

const purple='8052D6',dark='49306E',ink='29243A',muted='716A80',pale='F6F2FC',line='E6DFF0';
const fill=color=>({type:'pattern',pattern:'solid',fgColor:{argb:`FF${color}`}});
const border={bottom:{style:'thin',color:{argb:`FF${line}`}}};
const font={name:'Calibri',size:11,color:{argb:`FF${ink}`}};
export const reportNumberFormat=column=>/\bINR\b|₹/i.test(column)?'"INR "#,##0.00;[Red]("INR "#,##0.00)':/%|\bpercent(?:age)?\b/i.test(column)?'0.00"%"':'#,##0.####;[Red](#,##0.####)';
const height=(value,width=90)=>Math.min(100,Math.max(24,Math.ceil(String(value??'').length/width)*15+9));
const headerStyle={font:{...font,bold:true,color:{argb:'FFFFFFFF'}},fill:fill(purple),alignment:{vertical:'middle',wrapText:true},border};
const dataStyle=(stripe=false,numFmt)=>({font,fill:fill(stripe?pale:'FFFFFF'),alignment:{vertical:'top',wrapText:true},border,...(numFmt?{numFmt}:{})});

export function excelTableHeaders(columns){
  const used=new Set();return columns.map((value,index)=>{const original=String(value||`Column ${index+1}`);let name=original,suffix=2;while(used.has(name.toLowerCase()))name=`${original} (${suffix++})`;used.add(name.toLowerCase());return name;});
}
function presentation(workbook,name,widths){
  const ws=workbook.addWorksheet(name,{properties:{tabColor:{argb:`FF${purple}`}}});ws.columns=widths.map(width=>({width}));ws.views=[{showGridLines:false,zoomScale:90}];ws.properties.defaultRowHeight=21;
  ws.pageSetup={paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.25,right:.25,top:.4,bottom:.4,header:.15,footer:.15}};
  ws.headerFooter={oddHeader:'&L&"Calibri,Bold"&K8052D6TECHNOVALENS',oddFooter:'&L'+name+'&RPage &P of &N'};return ws;
}
function merged(ws,row,start,end,value,style={}){
  if(start!==end)ws.mergeCells(row,start,row,end);const cell=ws.getCell(row,start);cell.value=value;cell.style={font,alignment:{vertical:'middle',wrapText:true},...style};
}
function section(ws,row,title,last){merged(ws,row,1,last,title,headerStyle);ws.getRow(row).height=28;}
function table(ws,name,headers,rows,{row=1,formats=[]}={}){
  const ref=`A${row}:${columnLetter(headers.length-1)}${row+rows.length}`;
  ws.addTable({name,ref:`A${row}`,headerRow:true,totalsRow:false,style:{theme:'TableStyleMedium5',showRowStripes:true},columns:headers.map(name=>({name,filterButton:true})),rows});
  ws.getRow(row).height=34;headers.forEach((_,index)=>ws.getCell(row,index+1).style=headerStyle);
  rows.forEach((values,index)=>{const output=ws.getRow(row+index+1);output.height=Math.max(24,...values.map((value,i)=>height(value,Math.max(12,ws.getColumn(i+1).width*1.7))));values.forEach((_,i)=>output.getCell(i+1).style=dataStyle(index%2===0,formats[i]));});
  ws.views=[{state:'frozen',ySplit:row,showGridLines:false,zoomScale:90}];ws.pageSetup.printTitlesRow=`${row}:${row}`;ws.pageSetup.printArea=ref;return {sheetId:ws.id,name,headers,ref};
}
function selectedWidths(stats){
  const widths=stats.columns.map(column=>Math.max(14,Math.min(30,column.length+3)));
  for(const row of stats.filteredRows)stats.columns.forEach((column,index)=>{widths[index]=Math.min(46,Math.max(widths[index],String(row[column]??'').length+2));});return widths;
}

export function createExcelReport(doc,sheet,stats,generatedAt,{includeData=true,decorateCharts=true}={}){
  const workbook=new ExcelJS.Workbook();workbook.creator='TECHNOVALENS';workbook.created=new Date(generatedAt);workbook.modified=new Date(generatedAt);
  const tables=[],charts=[],dashboard=presentation(workbook,'Executive Dashboard',Array(12).fill(11));
  dashboard.mergeCells('A1:L2');dashboard.getCell('A1').value='TECHNOVALENS  /  ANALYTICS REPORT';dashboard.getCell('A1').style={...headerStyle,font:{...headerStyle.font,size:22}};dashboard.getRow(1).height=24;dashboard.getRow(2).height=20;
  merged(dashboard,3,1,12,doc.name,{font:{...font,bold:true,size:15,color:{argb:`FF${dark}`}}});dashboard.getRow(3).height=30;
  merged(dashboard,4,1,12,`Selected worksheet: ${sheet.name}   |   Generated (UTC): ${generatedAt}`,{font:{...font,size:10,color:{argb:`FF${muted}`}}});dashboard.getRow(4).height=25;
  merged(dashboard,5,1,12,'Complete selected data • Local deterministic calculations • No generated estimates',{font:{...font,size:10,color:{argb:`FF${muted}`}}});
  const kpi=(start,end,row,label,value,hint,numFmt)=>{
    merged(dashboard,row,start,end,label,{font:{...font,size:11,bold:true,color:{argb:`FF${dark}`}},fill:fill(pale)});
    dashboard.mergeCells(row+1,start,row+2,end);const cell=dashboard.getCell(row+1,start);cell.value=value;cell.style={font:{...font,size:23,bold:true,color:{argb:`FF${purple}`}},fill:fill(pale),alignment:{vertical:'middle',shrinkToFit:true},numFmt:numFmt||'#,##0'};
    merged(dashboard,row+3,start,end,hint,{font:{...font,size:9,color:{argb:`FF${muted}`}},fill:fill(pale),border});dashboard.getRow(row+3).height=25;
  };
  [['Total records',stats.rowCount],['Columns',stats.columnCount],['Missing values',stats.missingValues],['Duplicate rows',stats.duplicateRows]].forEach(([label,value],index)=>kpi(index*3+1,index*3+3,7,label,value,index===0?'After selected filters':index===3?'Beyond first occurrence':index===2?'Missing cells':'Selected worksheet'));
  const numeric=stats.kpis||[];numeric.forEach((item,index)=>kpi(index*4+1,index*4+4,12,item.label,item.value,item.hint,reportNumberFormat(item.column)));
  let cursor=numeric.length?17:12;
  const groups=presentation(workbook,'Chart Data',[42,24]);section(groups,1,'VERIFIED CHART DATA',2);merged(groups,2,1,2,`Worksheet: ${sheet.name} | Source: complete selected records`,{font:{...font,color:{argb:`FF${muted}`},size:10}});groups.getRow(2).height=26;let sourceRow=4;
  const addChart=(type,title,data,valueLabel,column)=>{
    if(!data.length)return;const headers=['Category / period',valueLabel],rows=data.map(row=>[row.name,row.value]);
    tables.push(table(groups,`ChartSource${charts.length+1}`,headers,rows,{row:sourceRow,formats:[undefined,reportNumberFormat(column||'')]}));
    charts.push({type,title,data,valueLabel,numberFormat:reportNumberFormat(column||''),categoryFormula:`'Chart Data'!$A$${sourceRow+1}:$A$${sourceRow+data.length}`,valueFormula:`'Chart Data'!$B$${sourceRow+1}:$B$${sourceRow+data.length}`});sourceRow+=data.length+3;
  };
  addChart('bar',stats.charts.bar.title,stats.charts.bar.data.map(row=>({name:row.name,value:row.count})),'Records');
  addChart('doughnut','Category mix',stats.charts.pie.map(row=>({name:row.name,value:row.count})),'Records');
  addChart('line',stats.charts.trend.title,stats.charts.trend.data.map(row=>({name:row.period,value:row.value})),stats.charts.trend.valueColumn||'Value',stats.charts.trend.valueColumn);
  if(charts.length){
    section(dashboard,cursor,'VERIFIED DATA VISUALISATIONS',12);const categorical=charts.filter(chart=>chart.type!=='line');
    const chartRows=Math.max(10,Math.min(17,Math.ceil((stats.charts.bar.data.length||0)*.9+5)));
    categorical.forEach((chart,index)=>chart.anchor={col:categorical.length===2?index*6:0,row:cursor,toCol:categorical.length===2?(index+1)*6:12,toRow:cursor+chartRows});
    if(categorical.length){for(let row=cursor+1;row<=cursor+chartRows;row++)dashboard.getRow(row).height=20;cursor+=chartRows+1;}
    const trend=charts.find(chart=>chart.type==='line');if(trend){const trendRows=trend.data.length>12?14:11;trend.anchor={col:0,row:cursor,toCol:12,toRow:cursor+trendRows};for(let row=cursor+1;row<=cursor+trendRows;row++)dashboard.getRow(row).height=20;cursor+=trendRows+1;}
    merged(dashboard,cursor,1,12,`${stats.charts.bar.omittedGroups?`Top ${stats.charts.bar.data.length} categories; ${stats.charts.bar.omittedGroups} omitted. `:''}${trend?'Trend: latest 24 populated months. ':''}Editable native Excel charts; complete plotted values are on Chart Data.`,{font:{...font,size:9,color:{argb:`FF${muted}`}}});dashboard.getRow(cursor).height=30;cursor+=2;
  }else{section(dashboard,cursor,'CHART AVAILABILITY',12);merged(dashboard,++cursor,1,12,'No suitable category or date/numeric pairs are available. No chart values were invented.');dashboard.getRow(cursor).height=30;cursor+=2;}
  section(dashboard,cursor++,'KEY FINDINGS',12);
  stats.findings.slice(0,6).forEach((finding,index)=>{merged(dashboard,cursor,1,2,`Finding ${index+1}`,{font:{...font,bold:true,color:{argb:`FF${dark}`}},fill:fill(pale),border});merged(dashboard,cursor,3,12,finding,{font,fill:fill(index%2?pale:'FFFFFF'),border});dashboard.getRow(cursor++).height=height(finding,100);});
  merged(dashboard,cursor,1,12,'See Findings for all calculated observations and method notes. See Selected Data for every exported record.',{font:{...font,size:10,color:{argb:`FF${muted}`}}});dashboard.getRow(cursor).height=28;dashboard.pageSetup.printArea=`A1:L${cursor}`;
  groups.pageSetup.printArea=`A1:B${Math.max(2,sourceRow-2)}`;groups.views=[{showGridLines:false,zoomScale:95}];

  const overview=presentation(workbook,'Dataset Overview',[29,110]);section(overview,1,'DATASET OVERVIEW',2);section(overview,3,'WORKBOOK & SELECTION',2);
  const overviewRows=[['Workbook',doc.name],['Selected worksheet',sheet.name],['Generated (UTC)',new Date(generatedAt)],['Workbook sheets',doc.sheets.length],['Matching records',stats.rowCount],['Worksheet records',stats.totalRowCount],['Columns',stats.columnCount],['Missing cells',stats.missingValues],['Duplicate rows',stats.duplicateRows],['Completeness (%)',stats.completeness],['Filters',Object.keys(stats.filters||{}).length?JSON.stringify(stats.filters):'None']];
  let row=4;for(const [label,value] of overviewRows){overview.getRow(row).values=[label,value];overview.getCell(row,1).style={...dataStyle(row%2===0),font:{...font,bold:true,color:{argb:`FF${dark}`}}};overview.getCell(row,2).style=dataStyle(row%2===0,value instanceof Date?'yyyy-mm-dd hh:mm "UTC"':label==='Completeness (%)'?'0.00"%"':typeof value==='number'?'#,##0':undefined);overview.getRow(row++).height=height(value,100);}
  section(overview,++row,'METHOD & DATA QUALITY',2);row++;
  for(const note of ['Local deterministic calculations; all selected records are exported.',...stats.warnings,'Units follow explicit column labels. Percentage-point numbers use literal % formatting without multiplying by 100. ISO date strings in source records remain unchanged.']){merged(overview,row,1,2,note,{font,fill:fill(row%2?pale:'FFFFFF'),border});overview.getRow(row++).height=height(note,125);}
  const headers=excelTableHeaders(stats.columns),renamed=headers.map((name,index)=>name!==stats.columns[index]?`${name} = ${stats.columns[index]}`:null).filter(Boolean);
  if(renamed.length){merged(overview,row,1,2,`Excel requires case-insensitively unique table headings. Original column names remain in Column Statistics. Selected Data heading mappings: ${renamed.join('; ')}`,{font,border});overview.getRow(row++).height=height(renamed.join('; '),80)+30;}overview.pageSetup.printArea=`A1:B${row-1}`;

  const profile=presentation(workbook,'Column Statistics',[34,14,13,13,13,13,16,21,21,21,21]);
  const profileHeaders=['Column','Type','Present','Missing','Distinct','Invalid','Numeric count','Sum','Average','Minimum','Maximum'];
  const profileRows=Object.entries(stats.columnStats).map(([name,s])=>[name,s.type,s.count-s.missing,s.missing,s.unique,s.invalid,s.numericCount,s.sum,s.average,s.min,s.max]);tables.push(table(profile,'ColumnStatistics',profileHeaders,profileRows));
  Object.keys(stats.columnStats).forEach((column,index)=>{for(let col=8;col<=11;col++)profile.getCell(index+2,col).numFmt=reportNumberFormat(column);});
  if(profileRows.length)for(const col of ['D','F'])profile.addConditionalFormatting({ref:`${col}2:${col}${profileRows.length+1}`,rules:[{type:'cellIs',operator:'greaterThan',formulae:[0],style:{fill:fill('FFF0E6'),font:{color:{argb:'FF9C3B10'},bold:true}}},{type:'cellIs',operator:'equal',formulae:[0],style:{font:{color:{argb:'FF17806A'}}}}]});
  const findings=presentation(workbook,'Findings',[8,24,105,45]);section(findings,1,'CALCULATED FINDINGS & METHOD NOTES',4);
  const insightRows=[...stats.findings.map((finding,index)=>[index+1,'Calculated observation',finding,`Worksheet: ${sheet.name}; complete selected data`]),...stats.warnings.map((warning,index)=>[stats.findings.length+index+1,'Method / data quality',warning,'Extraction and deterministic analytics'])];
  tables.push(table(findings,'ReportFindings',['No.','Insight type','Finding / note','Evidence / scope'],insightRows,{row:3}));findings.pageSetup.printArea=`A1:D${insightRows.length+3}`;
  const data=presentation(workbook,'Selected Data',selectedWidths(stats));data.views=[{state:'frozen',ySplit:1,showGridLines:false,zoomScale:90}];data.pageSetup.printTitlesRow='1:1';data.pageSetup.printArea=`A1:${columnLetter(Math.max(0,stats.columns.length-1))}${stats.filteredRows.length+1}`;data.pageSetup.fitToWidth=stats.columns.length>12?0:1;
  if(stats.columns.length){
    if(includeData){tables.push(table(data,'SelectedRecords',headers,stats.filteredRows.map(record=>stats.columns.map(column=>record[column]??null)),{formats:stats.columns.map(reportNumberFormat)}));data.pageSetup.fitToWidth=stats.columns.length>12?0:1;}
    else{data.addRow(headers);data.getRow(1).height=40;headers.forEach((_,index)=>data.getCell(1,index+1).style=headerStyle);tables.push({sheetId:data.id,name:'SelectedRecords',headers,ref:data.pageSetup.printArea});}
  }
  [dashboard,overview,profile,findings,groups,data].forEach((ws,index)=>ws.orderNo=index);
  Object.defineProperty(workbook,'reportLayout',{value:{charts,tables,headers},enumerable:false});if(decorateCharts)attachDocumentCharts(workbook,charts);return workbook;
}

export async function writeExcelReport(stream,doc,sheet,stats,generatedAt){
  const template=createExcelReport(doc,sheet,stats,generatedAt,{includeData:false,decorateCharts:false});
  const writer=new ExcelJS.stream.xlsx.WorkbookWriter({stream,useStyles:true,useSharedStrings:false,zip:{zlib:{level:6}}});writer.creator='TECHNOVALENS';writer.created=new Date(generatedAt);writer.modified=new Date(generatedAt);
  const {charts,tables}=template.reportLayout,ordered=[...template.worksheets].sort((a,b)=>a.orderNo-b.orderNo);
  const streamTables=tables.map((table,index)=>({...table,id:index+1,sheetId:ordered.findIndex(ws=>ws.id===table.sheetId)+1}));attachStreamParts(writer,charts,streamTables);
  for(const source of ordered){
    const target=writer.addWorksheet(source.name,{properties:source.properties,views:source.views,pageSetup:source.pageSetup,headerFooter:source.headerFooter});target.columns=source.columns.map(column=>({width:column.width}));
    for(const merge of source.model.merges||[])target.mergeCells(merge);for(const rule of source.conditionalFormattings||[])target.addConditionalFormatting(rule);
    attachStreamSheetParts(target,{charts:source.name==='Executive Dashboard'?charts:[],tables:streamTables.filter(table=>table.sheetId===target.id)});
    source.eachRow({includeEmpty:true},row=>{const output=target.getRow(row.number);row.eachCell({includeEmpty:true},(cell,index)=>{if(cell.type!==ExcelJS.ValueType.Merge)output.getCell(index).value=cell.value;output.getCell(index).style=cell.style;});output.height=row.height;output.commit();});
    if(source.name==='Selected Data'){
      const styles=stats.columns.map(column=>[dataStyle(false,reportNumberFormat(column)),dataStyle(true,reportNumberFormat(column))]);
      for(const [index,record] of stats.filteredRows.entries()){
        const row=target.addRow(stats.columns.map(column=>record[column]??null));row.height=24;stats.columns.forEach((column,col)=>{row.getCell(col+1).style=styles[col][index%2];row.height=Math.max(row.height,height(record[column],Math.max(12,target.getColumn(col+1).width*1.7)));});row.commit();
      }
    }
    target.commit();
  }
  await writer.commit();
}
