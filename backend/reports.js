import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

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

export function createPdfReport(doc, sheet, stats, generatedAt) {
  const pdf = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: `${doc.name} — dataset report`, Author: 'TECHNOVALENS' } });
  const width = 511; let y = 42;
  const text = (value, x, at, options = {}) => pdf.text(String(value), x, at, { width: width - (x - 42), ...options });
  const newPage = () => { pdf.addPage(); y = 45; };
  const room = height => { if (y + height > 770) newPage(); };
  const heading = title => { room(48); pdf.font('Helvetica-Bold').fontSize(15).fillColor('#49306e'); text(title, 42, y); y += 30; };
  const paragraph = value => {
    pdf.font('Helvetica').fontSize(10).fillColor('#625c70');
    const height = pdf.heightOfString(String(value), { width }); room(height + 12); text(value, 42, y); y += height + 12;
  };
  pdf.font('Helvetica-Bold').fontSize(12).fillColor(palette[0]); text('TECHNOVALENS / WORKBOOK INTELLIGENCE', 42, y); y += 34;
  pdf.fontSize(27).fillColor('#29243a'); text('Dataset report', 42, y); y += 45;
  paragraph(`Workbook: ${doc.name}\nWorksheet: ${sheet.name}\nGenerated (UTC): ${generatedAt}`);
  heading('Dataset overview');
  const metrics = [['Records', stats.rowCount], ['Columns', stats.columnCount], ['Sheets', doc.sheets.length], ['Missing cells', stats.missingValues], ['Duplicate rows', stats.duplicateRows], ['Complete cells', stats.completeness === null ? 'N/A' : `${format(stats.completeness)}%`]];
  metrics.forEach(([label, value], index) => {
    if (index % 3 === 0) room(79);
    const x = 42 + (index % 3) * 173;
    pdf.roundedRect(x, y, 165, 67, 9).fill('#f6f2fc');
    pdf.font('Helvetica').fontSize(10).fillColor('#777185'); text(label, x + 11, y + 10, { width: 143 });
    pdf.font('Helvetica-Bold').fontSize(20).fillColor(palette[index % palette.length]); text(format(value), x + 11, y + 30, { width: 143 });
    if (index % 3 === 2) y += 79;
  });
  heading('Notable findings'); stats.findings.forEach(f => paragraph(`• ${f}`));
  heading('Method and data quality'); stats.warnings.forEach(paragraph);
  if (Object.keys(stats.filters || {}).length) paragraph(`Filters: ${JSON.stringify(stats.filters)}`);
  if (stats.charts.bar.data.length) {
    newPage(); heading(stats.charts.bar.title);
    const max = Math.max(...stats.charts.bar.data.map(r => r.count), 1);
    stats.charts.bar.data.forEach((row, i) => {
      room(34); pdf.font('Helvetica').fontSize(9).fillColor('#625c70'); text(row.name, 42, y + 3, { width: 130, height: 24, ellipsis: true });
      pdf.roundedRect(180, y, Math.max(1, row.count / max * 310), 18, 3).fill(palette[i % palette.length]);
      pdf.fillColor('#29243a'); text(format(row.count), 498, y + 3, { width: 55 }); y += 33;
    });
    if (stats.charts.bar.omittedGroups) paragraph(`Top 12 groups shown; ${stats.charts.bar.omittedGroups} further groups omitted from this bar chart.`);
  }
  if (stats.charts.pie.length) {
    room(240); heading('Category mix');
    const startY = y, cx = 137, cy = y + 80, radius = 72;
    let angle = -Math.PI / 2;
    stats.charts.pie.forEach((row, i) => {
      const sweep = row.count / Math.max(1, stats.rowCount) * Math.PI * 2;
      pdf.moveTo(cx, cy).lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
      for (let step = 1; step <= 80; step++) { const a = angle + sweep * step / 80; pdf.lineTo(cx + radius * Math.cos(a), cy + radius * Math.sin(a)); }
      pdf.closePath().fill(palette[i % palette.length]); angle += sweep;
      pdf.font('Helvetica').fontSize(9).fillColor(palette[i % palette.length]);
      text(`${row.name}: ${row.count} (${(row.count / Math.max(1, stats.rowCount) * 100).toFixed(1)}%)`, 250, startY + i * 23, { width: 303, height: 21, ellipsis: true });
    });
    pdf.circle(cx, cy, 41).fill('#ffffff'); y = startY + 180;
  }
  if (stats.charts.trend.data.length) {
    room(260); heading(stats.charts.trend.title);
    const data = stats.charts.trend.data, top = y + 10, bottom = y + 160;
    const min = Math.min(0, ...data.map(r => r.value)), max = Math.max(1, ...data.map(r => r.value));
    const pointY = v => bottom - (v-min) / (max-min) * 150;
    pdf.moveTo(92, top).lineTo(92, bottom).lineTo(548, bottom).strokeColor('#ddd6eb').lineWidth(1).stroke();
    pdf.font('Helvetica').fontSize(8).fillColor('#625c70'); text(format(max), 42, top, { width: 45 }); text(format(min), 42, bottom-8, { width: 45 });
    data.forEach((r,i) => { const x = 92 + i / Math.max(1, data.length-1) * 456; if (i === 0) pdf.moveTo(x, pointY(r.value)); else pdf.lineTo(x, pointY(r.value)); });
    pdf.strokeColor(palette[0]).lineWidth(2).stroke();
    data.forEach((r,i) => { const x = 92 + i / Math.max(1, data.length-1) * 456; pdf.circle(x, pointY(r.value), 2).fill(palette[0]); });
    text(data[0].period, 92, bottom+8, { width: 100 }); text(data.at(-1).period, 450, bottom+8, { width: 100, align: 'right' });
    y = bottom + 38; paragraph('Monthly sums of numeric values; latest 24 populated months.');
  }
  if (!stats.charts.bar.data.length && !stats.charts.trend.data.length) { heading('Charts'); paragraph('No suitable category or date/numeric columns are available for charts.'); }
  newPage(); heading('Column profile and numeric summaries');
  // One profile row per column: wrapped names, repeated headings, no horizontal clipping.
  const header = () => {
    pdf.rect(42,y,width,24).fill('#8052d6'); pdf.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    text('Column / type', 49,y+7,{width:154}); text('Quality',210,y+7,{width:125}); text('Numeric summary',344,y+7,{width:200}); y += 30;
  };
  header();
  for (const [name,s] of Object.entries(stats.columnStats)) {
    pdf.font('Helvetica').fontSize(9);
    const quality = `${s.count-s.missing} present\n${s.missing} missing; ${s.invalid} invalid\n${s.unique} distinct`;
    const numeric = s.numericCount ? `Sum: ${format(s.sum)}\nAverage: ${format(s.average)}\nMin: ${format(s.min)}; Max: ${format(s.max)}` : 'No numeric summary';
    const height = Math.max(pdf.heightOfString(`${name}\n${s.type}`,{width:150}), pdf.heightOfString(quality,{width:125}), pdf.heightOfString(numeric,{width:200})) + 18;
    if (y + height > 765) { newPage(); heading('Column profile — continued'); header(); pdf.font('Helvetica').fontSize(9); }
    pdf.fillColor('#49306e'); text(`${name}\n${s.type}`,49,y+4,{width:150}); pdf.fillColor('#625c70'); text(quality,210,y+4,{width:125}); text(numeric,344,y+4,{width:200});
    y += height; pdf.moveTo(42,y-3).lineTo(553,y-3).strokeColor('#eeeaf4').lineWidth(.5).stroke();
  }
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(i); pdf.font('Helvetica').fontSize(8).fillColor('#898397');
    text(`TECHNOVALENS • ${sheet.name}`,42,795,{width:400,lineBreak:false}); text(`${i+1} / ${range.count}`,480,795,{width:73,align:'right',lineBreak:false});
  }
  return pdf;
}
