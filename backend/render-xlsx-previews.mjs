// Inspect exported cells/styles and cached native chart data. This local canvas
// preview is not an Excel rendering engine; the XLSX charts remain editable.
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {createCanvas,loadImage} from '@napi-rs/canvas';
const root=path.resolve(import.meta.dirname,'.data/xlsx-report-validation'),results=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8'));
const decode=value=>String(value).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
const palette=['#8052d6','#4385f5','#19b8a6','#ff9a55','#ed6aaf','#b99ae9','#a6a0b0'];
function drawPie(ctx,labels,numbers,{x,y,w,h}){
  const sum=numbers.reduce((a,b)=>a+b,0),legendRows=Math.ceil(labels.length/2),plotBottom=y+h-legendRows*18-24;
  const cx=x+w/2,cy=(y+45+plotBottom)/2,radius=Math.max(20,Math.min(w*.2,(plotBottom-y-55)/2));let angle=-Math.PI/2;
  numbers.forEach((value,i)=>{ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,radius,angle,angle+value/sum*Math.PI*2);ctx.closePath();ctx.fillStyle=palette[i%palette.length];ctx.fill();angle+=value/sum*Math.PI*2;});
  ctx.beginPath();ctx.arc(cx,cy,radius*.62,0,Math.PI*2);ctx.fillStyle='white';ctx.fill();
  labels.forEach((label,i)=>{ctx.font='12px Arial';ctx.fillStyle=palette[i%palette.length];ctx.fillText(`${label}: ${numbers[i]}`,x+16+(i%2)*(w-24)/2,plotBottom+20+Math.floor(i/2)*18,(w-36)/2);});
}
function wrapped(ctx,value,x,y,width,lineHeight,maxHeight){
  let line='',offset=0;for(const word of String(value).split(/\s+/)){if(ctx.measureText(line?`${line} ${word}`:word).width>width&&line){if(offset+lineHeight>maxHeight)return;ctx.fillText(line,x,y+offset);offset+=lineHeight;line=word;}else line=line?`${line} ${word}`:word;}if(offset+lineHeight<=maxHeight)ctx.fillText(line,x,y+offset);
}
const thumbnails=[];
for(const [index,result] of results.entries()){
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(result.output);const zip=await JSZip.loadAsync(await fs.readFile(result.output));
  const sheets=index===0||result.worksheet==='SETTING'?book.worksheets:[book.worksheets[0]];
  for(const sheet of sheets){
    const maxCol=sheet.name==='Executive Dashboard'?12:Math.min(sheet.columnCount,12),maxRow=sheet.name==='Executive Dashboard'?sheet.rowCount:Math.min(sheet.rowCount,sheet.name==='Chart Data'?50:18);
    const xs=[20],ys=[20];for(let c=1;c<=maxCol;c++)xs.push(xs.at(-1)+(sheet.getColumn(c).width||12)*7+5);for(let r=1;r<=maxRow;r++)ys.push(ys.at(-1)+(sheet.getRow(r).height||21)*4/3);
    const canvas=createCanvas(Math.ceil(xs.at(-1)+20),Math.ceil(ys.at(-1)+20)),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
    const merged=new Map();for(const range of sheet.model.merges||[]){const match=range.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/);const col=value=>[...value].reduce((n,char)=>n*26+char.charCodeAt(0)-64,0);merged.set(`${+match[2]}:${col(match[1])}`,{lastRow:+match[4],lastCol:col(match[3])});}
    for(let r=1;r<=maxRow;r++)for(let c=1;c<=maxCol;c++){
      const cell=sheet.getCell(r,c);if(cell.type===ExcelJS.ValueType.Merge)continue;
      const merge=merged.get(`${r}:${c}`),endCol=Math.min(maxCol,merge?.lastCol||c),endRow=Math.min(maxRow,merge?.lastRow||r),x=xs[c-1],y=ys[r-1],w=xs[endCol]-x,h=ys[endRow]-y;
      ctx.fillStyle=cell.fill?.fgColor?.argb?`#${cell.fill.fgColor.argb.slice(-6)}`:'white';ctx.fillRect(x,y,w,h);
      if(cell.border?.bottom){ctx.strokeStyle='#e6dff0';ctx.beginPath();ctx.moveTo(x,y+h);ctx.lineTo(x+w,y+h);ctx.stroke();}
      let value=cell.value;if(value==null)continue;if(value instanceof Date)value=value.toISOString().slice(0,16).replace('T',' ');else if(typeof value==='number')value=`${/INR/.test(cell.numFmt)?'INR ':''}${new Intl.NumberFormat('en-IN',{maximumFractionDigits:/INR/.test(cell.numFmt)?2:4}).format(value)}${/%/.test(cell.numFmt)?'%':''}`;
      const size=(cell.font?.size||11)*4/3;ctx.font=`${cell.font?.bold?'bold ':''}${size}px Arial`;ctx.fillStyle=`#${cell.font?.color?.argb?.slice(-6)||'29243a'}`;
      ctx.save();ctx.beginPath();ctx.rect(x+2,y+2,w-4,h-4);ctx.clip();wrapped(ctx,value,x+6,y+Math.max(size+3,(h-size)/2),w-12,size*1.2,h-4);ctx.restore();
    }
    if(sheet.name==='Executive Dashboard'){
      const drawing=await zip.file('xl/drawings/analyticsDrawing.xml')?.async('string');
      for(const anchor of drawing?.matchAll(/<xdr:twoCellAnchor[\s\S]*?<\/xdr:twoCellAnchor>/g)||[]){
        const values=[...anchor[0].matchAll(/<xdr:(?:col|row)>(\d+)<\/xdr:(?:col|row)>/g)].map(match=>+match[1]);const id=+anchor[0].match(/r:id="rId(\d+)"/)[1],xml=await zip.file(`xl/charts/analyticsChart${id}.xml`).async('string');
        const [col,row,toCol,toRow]=values,x=xs[col]+7,y=ys[row]+7,w=xs[toCol]-xs[col]-14,h=ys[toRow]-ys[row]-14;
        ctx.fillStyle='white';ctx.fillRect(x,y,w,h);ctx.strokeStyle='#e6dff0';ctx.strokeRect(x,y,w,h);ctx.fillStyle='#49306e';ctx.font='bold 17px Arial';ctx.fillText(decode(xml.match(/<a:t>(.*?)<\/a:t>/)[1]),x+16,y+28);
        const labels=[...xml.match(/<c:strCache>([\s\S]*?)<\/c:strCache>/)[1].matchAll(/<c:v>(.*?)<\/c:v>/g)].map(match=>decode(match[1])),numbers=[...xml.match(/<c:numCache>([\s\S]*?)<\/c:numCache>/)[1].matchAll(/<c:v>(.*?)<\/c:v>/g)].map(match=>+match[1]);
        if(xml.includes('<c:barChart>')){const max=Math.max(...numbers,1),step=(h-60)/labels.length;labels.forEach((label,i)=>{ctx.font='12px Arial';ctx.fillStyle='#716a80';ctx.fillText(label,x+14,y+56+i*step,130);ctx.fillStyle=palette[i%palette.length];ctx.fillRect(x+150,y+45+i*step,numbers[i]/max*(w-205),Math.min(20,step-6));ctx.fillStyle='#49306e';ctx.fillText(String(numbers[i]),x+w-42,y+58+i*step);});}
        else if(xml.includes('<c:doughnutChart>'))drawPie(ctx,labels,numbers,{x,y,w,h});
        else{const max=Math.max(...numbers,1),min=Math.min(...numbers,0);ctx.strokeStyle='#8052d6';ctx.lineWidth=3;ctx.beginPath();numbers.forEach((value,i)=>{const px=x+80+i/Math.max(1,numbers.length-1)*(w-110),py=y+h-40-(value-min)/(max-min)*(h-100);if(i)ctx.lineTo(px,py);else ctx.moveTo(px,py);});ctx.stroke();ctx.font='12px Arial';ctx.fillStyle='#716a80';ctx.fillText(labels[0],x+70,y+h-15);ctx.fillText(labels.at(-1),x+w-80,y+h-15);}
      }
    }
    const output=path.join(path.dirname(result.output),`${path.basename(result.output,'.xlsx')}-${sheet.name.replace(/ /g,'-')}.png`);await fs.writeFile(output,canvas.toBuffer('image/png'));if(sheet.name==='Executive Dashboard')thumbnails.push({path:output,label:`${result.workbook.startsWith('TECH')?'Sample':'Eveready'} / ${result.worksheet}`});console.log(output);
  }
}
for(let start=0;start<thumbnails.length;start+=6){const batch=thumbnails.slice(start,start+6),canvas=createCanvas(1600,Math.ceil(batch.length/3)*1000),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);for(const [index,item] of batch.entries()){const bitmap=await loadImage(await fs.readFile(item.path)),x=index%3*533,y=Math.floor(index/3)*1000;ctx.drawImage(bitmap,x,y+30,510,Math.min(950,bitmap.height*510/bitmap.width));ctx.fillStyle='#49306e';ctx.font='16px Arial';ctx.fillText(item.label,x+10,y+20);}await fs.writeFile(path.join(root,`dashboards-${start/6+1}.png`),canvas.toBuffer('image/png'));}
