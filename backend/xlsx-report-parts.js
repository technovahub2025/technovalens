// ExcelJS 4.x has no chart writer and its streaming writer has no table API.
// Keep these small OOXML parts separate from streamed worksheet data. No ZIP
// reload or second in-memory copy of Selected Data is needed by the download.
import ContentTypesXform from 'exceljs/lib/xlsx/xform/core/content-types-xform.js';

export const xml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
export const columnLetter=index=>{let label='';for(let n=index+1;n;n=Math.floor((n-1)/26))label=String.fromCharCode(65+(n-1)%26)+label;return label;};
const declaration='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relBase='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const chartColors=['8052D6','4385F5','19B8A6','FF9A55','ED6AAF','B99AE9','A6A0B0'];
const pointCache=(values,numeric)=>`<c:${numeric?'numCache':'strCache'}>${numeric?'<c:formatCode>General</c:formatCode>':''}<c:ptCount val="${values.length}"/>${values.map((value,index)=>`<c:pt idx="${index}"><c:v>${xml(value)}</c:v></c:pt>`).join('')}</c:${numeric?'numCache':'strCache'}>`;
const textProperties=size=>`<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const titleXml=title=>`<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"><a:solidFill><a:srgbClr val="49306E"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${xml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

export function chartXml(chart){
  const categories=chart.data.map(row=>row.name),values=chart.data.map(row=>row.value);
  const points=chart.type==='line'?'':chart.data.map((_,index)=>`<c:dPt><c:idx val="${index}"/><c:spPr><a:solidFill><a:srgbClr val="${chartColors[index%chartColors.length]}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`).join('');
  const series=`<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${xml(chart.valueLabel)}</c:v></c:tx><c:spPr>${chart.type==='line'?'<a:ln w="28575"><a:solidFill><a:srgbClr val="8052D6"/></a:solidFill></a:ln>':'<a:solidFill><a:srgbClr val="8052D6"/></a:solidFill>'}</c:spPr>${chart.type==='line'?'<c:marker><c:symbol val="circle"/><c:size val="4"/></c:marker>':''}${points}<c:cat><c:strRef><c:f>${xml(chart.categoryFormula)}</c:f>${pointCache(categories,false)}</c:strRef></c:cat><c:val><c:numRef><c:f>${xml(chart.valueFormula)}</c:f>${pointCache(values,true)}</c:numRef></c:val></c:ser>`;
  const dataLabels='<c:dLbls>'+textProperties(900)+'<c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/></c:dLbls>';
  let plot;
  if(chart.type==='doughnut')plot=`<c:doughnutChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="270"/><c:holeSize val="62"/></c:doughnutChart>`;
  else {
    const kind=chart.type==='line'?'lineChart':'barChart';
    const categoryAxis=`<c:catAx><c:axId val="100"/><c:scaling><c:orientation val="${chart.type==='bar'?'maxMin':'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type==='bar'?'l':'b'}"/><c:tickLblPos val="nextTo"/>${textProperties(900)}<c:crossAx val="200"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`;
    const valueAxis=`<c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type==='bar'?'b':'l'}"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="EEEAF4"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${xml(chart.numberFormat||'#,##0.##')}" sourceLinked="0"/><c:tickLblPos val="nextTo"/>${textProperties(900)}<c:crossAx val="100"/><c:crosses val="${chart.type==='bar'?'max':'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
    plot=`<c:${kind}>${chart.type==='bar'?'<c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="1"/>':'<c:grouping val="standard"/><c:varyColors val="0"/>'}${series}${chart.type==='bar'?dataLabels+'<c:gapWidth val="65"/>':'<c:smooth val="0"/>'}<c:axId val="100"/><c:axId val="200"/></c:${kind}>${categoryAxis}${valueAxis}`;
  }
  return `${declaration}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${relBase.slice(0,-1)}"><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>${titleXml(chart.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>${chart.type==='doughnut'?'<c:legend><c:legendPos val="b"/><c:overlay val="0"/>'+textProperties(900)+'</c:legend>':''}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="E6DFF0"/></a:solidFill></a:ln></c:spPr>${textProperties(1000)}</c:chartSpace>`;
}

const chartParts=charts=>{
  if(!charts.length)return [];
  const position=(tag,col,row)=>`<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  const anchors=charts.map((chart,index)=>`<xdr:twoCellAnchor editAs="oneCell">${position('from',chart.anchor.col,chart.anchor.row)}${position('to',chart.anchor.toCol,chart.anchor.toRow)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index+1}" name="Chart ${index+1}" descr="${xml(chart.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${relBase.slice(0,-1)}" r:id="rId${index+1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('');
  return [
    {name:'xl/drawings/analyticsDrawing.xml',data:`${declaration}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`},
    {name:'xl/drawings/_rels/analyticsDrawing.xml.rels',data:`${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${charts.map((_,index)=>`<Relationship Id="rId${index+1}" Type="${relBase}chart" Target="../charts/analyticsChart${index+1}.xml"/>`).join('')}</Relationships>`},
    ...charts.map((chart,index)=>({name:`xl/charts/analyticsChart${index+1}.xml`,data:chartXml(chart)}))
  ];
};
const chartOverrides=charts=>(charts.length?'<Override PartName="/xl/drawings/analyticsDrawing.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>':'')+charts.map((_,index)=>`<Override PartName="/xl/charts/analyticsChart${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');

export function attachDocumentCharts(workbook,charts){
  if(!charts.length)return;
  const xlsx=workbook.xlsx,prepare=xlsx.prepareModel.bind(xlsx),types=xlsx.addContentTypes.bind(xlsx),drawings=xlsx.addDrawings.bind(xlsx);
  xlsx.prepareModel=(model,options)=>{prepare(model,options);const dashboard=model.worksheets[0],rId=`rId${dashboard.rels.length+1}`;dashboard.rels.push({Id:rId,Type:`${relBase}drawing`,Target:'../drawings/analyticsDrawing.xml'});dashboard.drawing={rId};};
  xlsx.addContentTypes=(zip,model)=>types({append:(data,options)=>zip.append(String(data).replace('</Types>',`${chartOverrides(charts)}</Types>`),options)},model);
  xlsx.addDrawings=async(zip,model)=>{await drawings(zip,{...model,worksheets:model.worksheets.slice(1)});for(const part of chartParts(charts))zip.append(part.data,{name:part.name});};
}

export function tableXml(table){
  return `${declaration}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${table.id}" name="${xml(table.name)}" displayName="${xml(table.name)}" ref="${table.ref}" totalsRowShown="0"><autoFilter ref="${table.ref}"/><tableColumns count="${table.headers.length}">${table.headers.map((name,index)=>`<tableColumn id="${index+1}" name="${xml(name)}"/>`).join('')}</tableColumns><tableStyleInfo name="TableStyleMedium5" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;
}

export function attachStreamParts(writer,charts,tables){
  if(typeof writer.addContentTypes!=='function')throw new Error('Unsupported ExcelJS streaming writer version.');
  writer.addContentTypes=async()=>{
    const contentTypes=new ContentTypesXform().toXml({worksheets:writer._worksheets.filter(Boolean),sharedStrings:writer.sharedStrings,commentRefs:writer.commentRefs,media:writer.media,tables:tables.map(table=>({target:`table${table.id}.xml`}))});
    writer.zip.append(contentTypes.replace('</Types>',`${chartOverrides(charts)}</Types>`),{name:'[Content_Types].xml'});
  };
  for(const part of chartParts(charts))writer.zip.append(part.data,{name:part.name});
  for(const table of tables)writer.zip.append(tableXml(table),{name:`xl/tables/table${table.id}.xml`});
}

export function attachStreamSheetParts(target,{charts=[],tables=[]}={}){
  const relationships=target._sheetRelsWriter;
  if(typeof target._writeCloseWorksheet!=='function'||typeof relationships?.addRelationship!=='function')throw new Error('Unsupported ExcelJS worksheet writer version.');
  let suffix='';
  if(charts.length){const rId=relationships.addRelationship({Type:`${relBase}drawing`,Target:'../drawings/analyticsDrawing.xml'});suffix+=`<drawing r:id="${rId}"/>`;}
  if(tables.length){suffix+=`<tableParts count="${tables.length}">${tables.map(table=>{const rId=relationships.addRelationship({Type:`${relBase}table`,Target:`../tables/table${table.id}.xml`});return `<tablePart r:id="${rId}"/>`;}).join('')}</tableParts>`;}
  const close=target._writeCloseWorksheet.bind(target);target._writeCloseWorksheet=()=>{target.stream.write(suffix);close();};
}
