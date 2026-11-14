import crypto from 'node:crypto';
import {attachStoredSheets,clearSheetCache} from '../sheet-storage.js';
import {hashWorkbook} from '../analytics.js';
import {validateSheets} from '../spreadsheet-parser.js';

const validOwner=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

export function verifyDocumentIntegrity(document,directory){
  if(!/^[a-f0-9-]{36}$/i.test(document.fileId)||!['pdf','spreadsheet'].includes(document.kind))throw new Error('Invalid document identity or kind.');
  if(document.kind==='pdf'){
    if(!Array.isArray(document.chunks)||!document.chunks.every(chunk=>typeof chunk==='string')||!Number.isInteger(document.pageCount)||document.pageCount<1)throw new Error('Invalid PDF extraction.');
    if(document.contentHash&&document.contentHash!==crypto.createHash('sha256').update(JSON.stringify(document.chunks)).digest('hex'))throw new Error('PDF content checksum differs.');
    return;
  }
  validateSheets(document.sheets);attachStoredSheets(document,directory);
  for(const sheet of document.sheets){
    const rows=sheet.rows;
    if(sheet.rowCount!==undefined&&sheet.rowCount!==rows.length)throw new Error('Worksheet row count differs.');
    if(sheet.sourceRows&&sheet.sourceRows.length!==rows.length)throw new Error('Worksheet source references differ.');
    if(sheet.contentHash&&hashWorkbook([{...sheet,contentHash:undefined,rows}])!==sheet.contentHash)throw new Error('Worksheet content checksum differs.');
    clearSheetCache(document.fileId);
  }
  if(document.contentHash&&hashWorkbook(document.sheets)!==document.contentHash)throw new Error('Workbook checksum differs.');
}

export async function backupDocument(document,{store,conversations,directory,dryRun=true}){
  verifyDocumentIntegrity(document,directory);
  if(!validOwner(document.ownerHash))return {status:'blocked',reason:'document-ownership-missing'};
  const related=await conversations.find({fileId:document.fileId}).toArray();
  if(!related.length||related.some(chat=>chat.ownerHash!==document.ownerHash))return {status:'blocked',reason:'conversation-ownership-unverified'};
  if(await store.collection.findOne({_id:document.fileId})){
    const proof=await store.verify(document);
    return {status:proof.verified?'already-backed':'blocked',reason:proof.verified?undefined:proof.reason,verified:proof.verified};
  }
  if(dryRun)return {status:'eligible',reason:'ownership-and-content-verified'};
  await store.save(document);
  const proof=await store.verify(document);if(!proof.verified)throw new Error('Backup verification failed; local data retained.');
  return {status:'backed-up',verified:true};
}

export function planConversationReconciliation(local,remote,verifiedOwner){
  if(!local||typeof local.id!=='string'||typeof local.fileId!=='string'||!Array.isArray(local.messages))return {status:'review',reason:'invalid-local-history'};
  const validMessages=messages=>messages.every(message=>typeof message.id==='string'&&message.id&&typeof message.text==='string'&&['user','assistant'].includes(message.role)&&typeof message.createdAt==='string')&&new Set(messages.map(message=>message.id)).size===messages.length;
  if(!validMessages(local.messages))return {status:'review',reason:'missing-or-duplicate-message-identity'};
  if(remote&&(remote.fileId!==local.fileId||(local.ownerHash&&remote.ownerHash!==local.ownerHash)))return {status:'review',reason:'identity-or-ownership-conflict'};
  if(remote){
    if(!Array.isArray(remote.messages)||!validMessages(remote.messages))return {status:'review',reason:'invalid-remote-history'};
    const ordered=[];for(const message of local.messages){const index=remote.messages.findIndex(saved=>saved.id===message.id);if(index>=0&&!equal(message,remote.messages[index]))return {status:'review',reason:'message-conflict'};ordered.push(index);}
    if(ordered.every((index,i)=>index>=0&&(i===0||index>ordered[i-1])))return {status:'already-preserved'};
  }
  if(!validOwner(verifiedOwner)||local.ownerHash!==verifiedOwner||remote&&remote.ownerHash!==verifiedOwner)return {status:'review',reason:'ownership-not-verified'};
  if(!remote)return {status:'insert',record:{...local}};
  if(remote.messages.length>=local.messages.length||!remote.messages.every((message,index)=>equal(message,local.messages[index])))return {status:'review',reason:'divergent-order'};
  if(typeof local.updatedAt!=='string'||local.updatedAt<remote.updatedAt)return {status:'review',reason:'timestamp-conflict'};
  const append=local.messages.slice(remote.messages.length);
  if(append.some(message=>message.createdAt<(remote.messages.at(-1)?.createdAt||'')))return {status:'review',reason:'timestamp-conflict'};
  return {status:'append',messages:append,updatedAt:local.updatedAt};
}

export async function reconcileConversation(local,{collection,verifiedOwner,dryRun=true}){
  const remote=await collection.findOne({$or:[{_id:local.id},{id:local.id}]});
  const plan=planConversationReconciliation(local,remote,verifiedOwner);
  if(dryRun||!['append','insert'].includes(plan.status))return plan;
  if(plan.status==='insert')await collection.insertOne({...plan.record,_id:local.id});
  else{
    const result=await collection.updateOne({_id:remote._id,fileId:remote.fileId,ownerHash:remote.ownerHash,updatedAt:remote.updatedAt,messages:remote.messages},{$push:{messages:{$each:plan.messages}},$set:{updatedAt:plan.updatedAt}});
    if(result.modifiedCount!==1)throw new Error('History changed during reconciliation; no replacement was attempted.');
  }
  return {...plan,applied:true};
}
