import crypto from 'node:crypto';

const dayKey=(formatter,date)=>{
  const parts=Object.fromEntries(formatter.formatToParts(date).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export function activityRange(days=7,timeZone='UTC',now=new Date()){
  if(![7,30,90].includes(Number(days)))throw Object.assign(new Error('Choose 7, 30 or 90 days.'),{status:400});
  let formatter;try{formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw Object.assign(new Error('Choose a valid IANA timezone.'),{status:400});}
  const today=dayKey(formatter,now),end=new Date(today+'T00:00:00Z');
  const bins=Array.from({length:Number(days)},(_,index)=>{
    const date=new Date(end);date.setUTCDate(date.getUTCDate()-Number(days)+1+index);
    return {date:date.toISOString().slice(0,10),name:new Intl.DateTimeFormat('en',{timeZone:'UTC',...(Number(days)===7?{weekday:'short'}:{month:'short',day:'numeric'})}).format(date),uploads:0,questions:0,value:0};
  });
  return {bins,key:date=>dayKey(formatter,new Date(date))};
}
export function dashboardSummary(files,events,{days=7,timeZone='UTC',now=new Date()}={}){
  const {bins,key}=activityRange(days,timeZone,now),byDate=new Map(bins.map(bin=>[bin.date,bin]));
  let totalRecords=0,dataColumns=0;
  const uniqueFiles=[...new Map(files.map(file=>[file.fileId,file])).values()];
  for(const file of uniqueFiles){
    if(file.kind!=='spreadsheet')continue;
    if(!Array.isArray(file.worksheets))throw new Error('Worksheet counts are unavailable.');
    for(const sheet of file.worksheets){
      if(!Number.isSafeInteger(sheet.rowCount)||sheet.rowCount<0||!Number.isSafeInteger(sheet.columnCount)||sheet.columnCount<0)throw new Error('Worksheet counts are invalid.');
      totalRecords+=sheet.rowCount;dataColumns+=sheet.columnCount;
    }
  }
  const uniqueEvents=new Map();
  for(const file of uniqueFiles)uniqueEvents.set(`upload:${file.fileId}`,{key:`upload:${file.fileId}`,kind:'upload',createdAt:file.uploadedAt});
  for(const event of events)if(!uniqueEvents.has(event.key))uniqueEvents.set(event.key,event);
  let aiQuestions=0;
  for(const event of uniqueEvents.values()){
    if(event.kind==='question')aiQuestions++;
    const timestamp=new Date(event.createdAt);if(!Number.isFinite(+timestamp)||timestamp>now)continue;
    const bin=byDate.get(key(timestamp));if(!bin)continue;
    if(event.kind==='upload')bin.uploads++;else if(event.kind==='question')bin.questions++;else continue;
    bin.value++;
  }
  return {uploadedFiles:uniqueFiles.length,totalRecords,dataColumns,aiQuestions,columnDefinition:'Sum of columns across all worksheets in current spreadsheet files',recentFiles:uniqueFiles.sort((a,b)=>String(b.uploadedAt).localeCompare(String(a.uploadedAt))).slice(0,5),activity:bins,hasActivity:bins.some(bin=>bin.value>0),days:Number(days),timeZone,generatedAt:now.toISOString()};
}
export class WorkspaceActivityStore{
  constructor(db){this.collection=db.collection('workspace_activity');}
  async initialize(){await this.collection.createIndex({ownerHash:1,createdAt:1});}
  id(ownerHash,key){return crypto.createHash('sha256').update(`${ownerHash}:${key}`).digest('hex');}
  async record(ownerHash,key,kind,createdAt=new Date().toISOString()){
    if(!ownerHash)throw new Error('Verified ownership is required.');
    try{await this.collection.updateOne({_id:this.id(ownerHash,key),ownerHash},{$setOnInsert:{key,kind,ownerHash,createdAt}},{upsert:true});}
    catch(error){if(error.code!==11000||!await this.collection.findOne({_id:this.id(ownerHash,key),ownerHash,key,kind}))throw error;}
  }
  async remove(ownerHash,key){await this.collection.deleteOne({_id:this.id(ownerHash,key),ownerHash});}
  async list(ownerHash){if(!ownerHash)throw new Error('Verified ownership is required.');return this.collection.find({ownerHash},{projection:{_id:0,key:1,kind:1,createdAt:1}}).toArray();}
}
