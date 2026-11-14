import ExcelJS from 'exceljs';
export { createPdfReport } from './pdf-report.js';

const palette = ['#8052d6', '#4385f5', '#19b8a6', '#ff9a55', '#ed6aaf'];
const format = value => value === null || value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString('en', { maximumFractionDigits: 4 }) : String(value);

export function createExcelReport(doc, sheet, stats, generatedAt) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TECHNOVALENS'; workbook.created = new Date(generatedAt);
  const overview = workbook.addWorksheet('Dataset Overview');
  overview.addRows([
    ['TECHNOVALENS DATA REPORT'], ['Workbook', doc.name], ['Worksheet', sheet.name], ['Generated (UTC)', generatedAt],
    ['Workbook sheets', doc.sheets.length], ['Matching records', stats.rowCount], ['Worksheet records', stats.totalRowCount], ['Columns', stats.columnCount],
    ['Missing cells', stats.missingValues], ['Duplicate rows', stats.duplicateRows], ['Completeness (%)', stats.completeness],
    [], ['Method', 'Local deterministic calculations; no generated estimates.'],
    ['Filters', JSON.stringify(stats.filters || {})], ...stats.warnings.map(w => ['Note', w])
  ]);
  overview.columns = [{ width: 28 }, { width: 105 }];
  const profile = workbook.addWorksheet('Column Statistics');
  profile.addRow(['Column', 'Type', 'Present', 'Missing', 'Distinct', 'Invalid', 'Numeric count', 'Sum', 'Average', 'Minimum', 'Maximum']);
  Object.entries(stats.columnStats).forEach(([name, s]) => profile.addRow([name, s.type, s.count-s.missing, s.missing, s.unique, s.invalid, s.numericCount, s.sum, s.average, s.min, s.max]));
  profile.columns.forEach(c => { c.width = 22; });
  const findings = workbook.addWorksheet('Findings'); findings.addRow(['Calculated findings']); stats.findings.forEach(f => findings.addRow([f])); findings.getColumn(1).width = 110;
  const groups = workbook.addWorksheet('Chart Data');
  groups.addRow([stats.charts.bar.title, 'Records']); stats.charts.bar.data.forEach(r => groups.addRow([r.name, r.count]));
  groups.addRow([]); groups.addRow(['Category mix (all records)', 'Records']); stats.charts.pie.forEach(r => groups.addRow([r.name, r.count]));
  groups.addRow([]); groups.addRow(['Month', stats.charts.trend.valueColumn || 'Value']); stats.charts.trend.data.forEach(r => groups.addRow([r.period, r.value]));
  groups.columns = [{ width: 45 }, { width: 25 }];
  const data = workbook.addWorksheet('Selected Data');
  data.addRow(stats.columns); stats.filteredRows.forEach(r => data.addRow(stats.columns.map(c => r[c] ?? null)));
  data.columns.forEach(c => { c.width = 23; });
  for (const ws of workbook.worksheets) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.getRow(1).eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8052D6' } }; cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 }; });
    ws.getRow(1).height = 28;
    ws.eachRow((row, index) => { if (index > 1) row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; if (typeof cell.value === 'number') cell.numFmt = '#,##0.####'; }); });
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
  return workbook;
}

export async function writeExcelReport(stream,doc,sheet,stats,generatedAt) {
  const template=createExcelReport(doc,sheet,{...stats,filteredRows:[]},generatedAt);
  const writer=new ExcelJS.stream.xlsx.WorkbookWriter({stream,useStyles:true,useSharedStrings:false});
  writer.creator='TECHNOVALENS';writer.created=new Date(generatedAt);
  for(const source of template.worksheets){
    const target=writer.addWorksheet(source.name,{views:source.views,pageSetup:source.pageSetup});
    target.columns=source.columns.map(column=>({width:column.width}));
    source.eachRow(row=>{const output=target.addRow(row.values.slice(1));output.height=row.height;row.eachCell((cell,index)=>{output.getCell(index).style=cell.style;});output.commit();});
    if(source.name==='Selected Data')for(const row of stats.filteredRows)target.addRow(stats.columns.map(column=>row[column]??null)).commit();
    target.commit();
  }
  await writer.commit();
}
