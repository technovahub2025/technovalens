export function localGreeting(date=new Date()){
  const hour=date.getHours();
  return hour>=5&&hour<12?'Good morning!':hour>=12&&hour<17?'Good afternoon!':'Good evening!';
}
export function browserTimeZone(){return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}
export function validateDashboard(data){
  if(!data||!['uploadedFiles','totalRecords','dataColumns','aiQuestions'].every(key=>Number.isSafeInteger(data[key])&&data[key]>=0)||!Array.isArray(data.recentFiles)||!Array.isArray(data.activity)||typeof data.hasActivity!=='boolean'||!data.activity.every(bin=>typeof bin.date==='string'&&typeof bin.name==='string'&&Number.isSafeInteger(bin.value)&&bin.value>=0))throw new Error('Dashboard response is incomplete. Please retry.');
  return data;
}
