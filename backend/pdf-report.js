import PDFDocument from 'pdfkit';

const colors=['#8052d6','#4385f5','#19b8a6','#ff9a55','#ed6aaf'];
const number=value=>value==null?'N/A':new Intl.NumberFormat('en-IN',{maximumFractionDigits:4}).format(value);
// Units come from explicit column labels; never infer currency from a business name.
export function formatReportValue(value,column=''){
  if(value==null)return 'N/A';
  if(/\bINR\b|₹/i.test(column))return `INR ${number(value)}`;
  if(/%|\bpercent(?:age)?\b/i.test(column))return `${number(value)}%`;
  return number(value);
}

export function createPdfReport(doc,sheet,stats,generatedAt){
  const pdf=new PDFDocument({size:'A4',margin:40,bufferPages:true,info:{Title:`${doc.name} - dataset report`,Author:'TECHNOVALENS'}});
  const left=40,width=pdf.page.width-80,right=left+width,top=70,bottom=pdf.page.height-62;
  let y=top;
  const style=(size=10,bold=false,color='#625c70')=>pdf.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(color);
  const text=(value,x,at,w=width,options={})=>pdf.text(String(value),x,at,{width:w,...options});
  const newPage=()=>{pdf.addPage();y=top;};
  const room=height=>{if(y+height>bottom)newPage();};
  const measure=(value,w=width)=>pdf.heightOfString(String(value),{width:w,lineGap:2});
  const heading=(title,following=30)=>{
    style(14,true,'#49306e');const height=Math.min(measure(title),(pdf.currentLineHeight(true)+2)*3);
    room(height+12+following);style(14,true,'#49306e');text(title,left,y,width,{lineGap:2,height,ellipsis:true});y+=height+12;
  };
  // Split even unusually long warnings across pages instead of allowing implicit
  // PDFKit overflow to lose track of our layout cursor.
  const wrap=(value,w)=>{
    const lines=[];
    for(const paragraph of String(value).split('\n')){
      let line='';
      for(const word of paragraph.split(/\s+/)){
        if(pdf.widthOfString(line?`${line} ${word}`:word)<=w){line=line?`${line} ${word}`:word;continue;}
        if(line){lines.push(line);line='';}
        let part='';for(const char of word){if(part&&pdf.widthOfString(part+char)>w){lines.push(part);part='';}part+=char;}line=part;
      }
      lines.push(line);
    }
    return lines;
  };
  const paragraph=(value,{size=10,color='#625c70'}={})=>{
    style(size,false,color);const lines=wrap(value,width),lineHeight=pdf.currentLineHeight(true)+2;
    // Keep ordinary paragraphs intact; only split a paragraph taller than a page.
    if(lines.length*lineHeight<=bottom-top)room(lines.length*lineHeight+8);
    for(const line of lines){room(lineHeight);style(size,false,color);text(line,left,y,width,{lineBreak:false});y+=lineHeight;}
    y+=8;
  };
  const cards=items=>{
    const gap=10,cardWidth=(width-gap*2)/3;
    for(let start=0;start<items.length;start+=3){
      const batch=items.slice(start,start+3);
      const layouts=batch.map(([label,value])=>{
        style(9);const labelHeight=measure(label,cardWidth-20);
        let size=18;style(size,true);while(size>10&&pdf.widthOfString(String(value))>cardWidth-20){size--;style(size,true);}
        return {label,value,labelHeight,size,valueHeight:measure(value,cardWidth-20)};
      });
      const height=Math.max(...layouts.map(item=>item.labelHeight+item.valueHeight+25));room(height+10);
      layouts.forEach((item,index)=>{const x=left+index*(cardWidth+gap);pdf.roundedRect(x,y,cardWidth,height,7).fill('#f6f2fc');style(9);text(item.label,x+10,y+9,cardWidth-20,{lineGap:2});style(item.size,true,colors[0]);text(item.value,x+10,y+14+item.labelHeight,cardWidth-20,{lineGap:2});});
      y+=height+10;
    }
  };

  style(25,true,'#29243a');text('Dataset report',left,y);y+=38;
  paragraph(`Workbook: ${doc.name}\nWorksheet: ${sheet.name}\nGenerated (UTC): ${generatedAt}`,{size:9});
  heading('Executive summary',60);
  paragraph(`${number(stats.rowCount)} matching records across ${number(stats.columnCount)} columns in this worksheet (${number(stats.totalRowCount)} records before filters). Calculations use the complete selected data; no generated estimates.`);
  const metrics=[['Records',number(stats.rowCount)],['Columns',number(stats.columnCount)],['Complete cells',stats.completeness==null?'N/A':`${number(stats.completeness)}%`],['Missing cells',number(stats.missingValues)],['Duplicate rows',number(stats.duplicateRows)],['Workbook sheets',number(doc.sheets.length)]];
  cards(metrics);
  if(stats.kpis?.length)cards(stats.kpis.map(kpi=>[kpi.label,formatReportValue(kpi.value,kpi.column)]));

  if(stats.charts.bar.data.length){
    const data=stats.charts.bar.data,max=Math.max(...data.map(row=>row.count),1);
    style(9);const layouts=data.map(row=>({...row,height:Math.min(48,Math.max(24,measure(row.name,132)+6))}));
    // A whole chart moves only when it fits on a fresh page. Oversized charts
    // split by complete bars with a repeated title.
    const height=layouts.reduce((sum,row)=>sum+row.height,0)+35;
    if(height<=bottom-top)room(height);
    heading(stats.charts.bar.title,layouts[0].height);
    for(const [index,row] of layouts.entries()){
      if(y+row.height>bottom){newPage();heading(`${stats.charts.bar.title} (continued)`,row.height);}
      style(9);text(row.name,left,y+3,132,{lineGap:2,height:row.height-4,ellipsis:true});
      const barLeft=left+142,barWidth=width-205;
      pdf.roundedRect(barLeft,y+2,Math.max(1,row.count/max*barWidth),15,2).fill(colors[index%colors.length]);
      style(9,false,'#29243a');text(number(row.count),right-55,y+3,55,{align:'right'});y+=row.height;
    }
    y+=8;if(stats.charts.bar.omittedGroups)paragraph(`Top ${data.length} groups shown; ${number(stats.charts.bar.omittedGroups)} further groups omitted.`,{size:9});
  }
  if(stats.charts.pie.length){
    style(9);const legend=stats.charts.pie.map(row=>({...row,label:`${row.name}: ${number(row.count)} (${(row.count/Math.max(1,stats.rowCount)*100).toFixed(1)}%)`}));
    const heights=legend.map(row=>Math.min(42,Math.max(22,measure(row.label,width-205)+5))),chartHeight=Math.max(160,heights.reduce((a,b)=>a+b,0));
    room(chartHeight+43);heading('Category mix',chartHeight);
    const start=y,cx=left+82,cy=start+79,radius=70;let angle=-Math.PI/2,legendY=start;
    legend.forEach((row,index)=>{
      const sweep=row.count/Math.max(1,stats.rowCount)*Math.PI*2;
      pdf.moveTo(cx,cy).lineTo(cx+radius*Math.cos(angle),cy+radius*Math.sin(angle));
      for(let step=1;step<=80;step++){const a=angle+sweep*step/80;pdf.lineTo(cx+radius*Math.cos(a),cy+radius*Math.sin(a));}
      pdf.closePath().fill(colors[index%colors.length]);angle+=sweep;
      pdf.circle(left+185,legendY+5,3).fill(colors[index%colors.length]);style(9);text(row.label,left+196,legendY,width-196,{lineGap:2,height:heights[index]-4,ellipsis:true});legendY+=heights[index];
    });
    pdf.circle(cx,cy,40).fill('#ffffff');y=start+chartHeight+10;
  }
  if(stats.charts.trend.data.length){
    const data=stats.charts.trend.data;room(228);heading(stats.charts.trend.title,193);
    const chartLeft=left+90,chartRight=right-5,chartTop=y+8,chartBottom=y+140;
    const min=Math.min(0,...data.map(row=>row.value)),max=Math.max(1,...data.map(row=>row.value));
    const pointY=value=>chartBottom-(value-min)/(max-min)*132;
    pdf.moveTo(chartLeft,chartTop).lineTo(chartLeft,chartBottom).lineTo(chartRight,chartBottom).strokeColor('#ddd6eb').lineWidth(1).stroke();
    style(8);text(formatReportValue(max,stats.charts.trend.valueColumn),left,chartTop,82);text(formatReportValue(min,stats.charts.trend.valueColumn),left,chartBottom-8,82);
    data.forEach((row,index)=>{const x=chartLeft+index/Math.max(1,data.length-1)*(chartRight-chartLeft);if(index===0)pdf.moveTo(x,pointY(row.value));else pdf.lineTo(x,pointY(row.value));});pdf.strokeColor(colors[0]).lineWidth(2).stroke();
    data.forEach((row,index)=>pdf.circle(chartLeft+index/Math.max(1,data.length-1)*(chartRight-chartLeft),pointY(row.value),2).fill(colors[0]));
    style(8);text(data[0].period,chartLeft,chartBottom+8,100);if(data.length>1)text(data.at(-1).period,chartRight-100,chartBottom+8,100,{align:'right'});
    y=chartBottom+30;paragraph('Monthly sums of numeric values; latest 24 populated months.',{size:9});
  }
  if(!stats.charts.bar.data.length&&!stats.charts.trend.data.length){heading('Charts');paragraph('No suitable category or date/numeric columns are available for charts.');}
  heading('Business insights',40);stats.findings.forEach(finding=>paragraph(`- ${finding}`));
  heading('Method and data quality',40);stats.warnings.forEach(warning=>paragraph(warning,{size:9}));
  if(Object.keys(stats.filters||{}).length)paragraph(`Filters: ${JSON.stringify(stats.filters)}`,{size:9});
  if(stats.columns.some(column=>/\bINR\b|₹|%|\bpercent(?:age)?\b/i.test(column)))paragraph('Units follow explicit column labels. INR denotes Indian rupees; percentages retain the stored percentage-point values without rescaling.',{size:9});

  // Table rows are measured with the same font/line height used to draw them.
  // Exceptionally long cells split into aligned fragments; each page repeats
  // the section title and table header, including continuation labels.
  const cellWidths=[156,132,width-288],cellXs=[left,left+156,left+288];
  style(9);const lineHeight=pdf.currentLineHeight(true)+2;
  const profiles=Object.entries(stats.columnStats).map(([name,s])=>{
    const quality=`Present: ${number(s.count-s.missing)}\nMissing: ${number(s.missing)}\nDistinct: ${number(s.unique)}\nInvalid: ${number(s.invalid)}`;
    const numeric=s.numericCount?`Sum: ${formatReportValue(s.sum,name)}\nAverage: ${formatReportValue(s.average,name)}\nMinimum: ${formatReportValue(s.min,name)}\nMaximum: ${formatReportValue(s.max,name)}`:'No numeric summary';
    const cells=[`${name}\n${s.type}`,quality,numeric].map((value,index)=>wrap(value,cellWidths[index]-16));
    return {cells,lines:Math.max(...cells.map(lines=>lines.length))};
  });
  const tableHeader=continued=>{
    heading(`Data Quality & Key Statistics${continued?' (continued)':''}`,profiles.length?lineHeight*2+34:24);
    pdf.rect(left,y,width,25).fill(colors[0]);style(9,true,'#ffffff');
    ['Column / type','Data quality','Key statistics'].forEach((label,index)=>text(label,cellXs[index]+8,y+7,cellWidths[index]-16,{lineBreak:false}));y+=30;
  };
  // Keep the heading, header and first row together without forcing a new page.
  const firstHeight=profiles.length?Math.min(profiles[0].lines*lineHeight+14,bottom-top-75):24;
  room(65+firstHeight);tableHeader(false);
  if(!profiles.length)paragraph('No columns are available for this worksheet.');
  for(const [index,profile] of profiles.entries()){
    // Move a short final group together rather than leaving one or two rows on
    // an otherwise empty last page. The preceding page still retains its rows.
    const tailHeight=profiles.slice(index).reduce((sum,row)=>sum+row.lines*lineHeight+14,0);
    if(tailHeight<(bottom-top)*.45&&tailHeight>bottom-y&&y>top+200){newPage();tableHeader(true);}
    let offset=0;
    while(offset<profile.lines){
      const remaining=profile.lines-offset,fullHeight=remaining*lineHeight+14;
      if(y+fullHeight>bottom&&fullHeight<=bottom-top-75){newPage();tableHeader(true);}
      let capacity=Math.floor((bottom-y-14)/lineHeight);
      if(capacity<1){newPage();tableHeader(true);capacity=Math.floor((bottom-y-14)/lineHeight);}
      let count=Math.min(remaining,capacity);
      if(remaining>capacity&&remaining-capacity<Math.ceil(capacity*.35))count=Math.ceil(remaining/2);
      const height=count*lineHeight+14;
      if(index%2===0)pdf.rect(left,y,width,height).fill('#faf8fe');
      profile.cells.forEach((lines,column)=>{
        style(9,false,column===0?'#49306e':'#625c70');
        for(let line=0;line<count;line++){const value=lines[offset+line];if(value!==undefined)text(value,cellXs[column]+8,y+6+line*lineHeight,cellWidths[column]-16,{lineBreak:false});}
      });
      y+=height;pdf.moveTo(left,y).lineTo(right,y).strokeColor('#eeeaf4').lineWidth(.5).stroke();offset+=count;
      if(offset<profile.lines){newPage();tableHeader(true);style(8);text('Column continued from previous page',left+8,y+2,width-16);y+=17;}
    }
  }

  const range=pdf.bufferedPageRange();
  for(let index=0;index<range.count;index++){
    pdf.switchToPage(range.start+index);
    // Disable the bottom text boundary only while drawing fixed running matter.
    // Otherwise PDFKit creates a new page for a footer below the normal margin.
    const margin=pdf.page.margins.bottom;pdf.page.margins.bottom=0;
    style(9,true,colors[0]);text('TECHNOVALENS / WORKBOOK INTELLIGENCE',left,28,width,{lineBreak:false,height:14});
    pdf.moveTo(left,49).lineTo(right,49).strokeColor('#eeeaf4').lineWidth(.5).stroke();
    pdf.moveTo(left,pdf.page.height-47).lineTo(right,pdf.page.height-47).stroke();
    style(8);text(`TECHNOVALENS | ${sheet.name}`,left,pdf.page.height-33,width-75,{lineBreak:false,height:12,ellipsis:true});
    text(`${index+1} / ${range.count}`,right-65,pdf.page.height-33,65,{align:'right',lineBreak:false,height:12});
    pdf.page.margins.bottom=margin;
  }
  return pdf;
}
