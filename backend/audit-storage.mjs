// Read-only unless an explicit, separately approved --apply is supplied.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {MongoClient} from 'mongodb';
import {MongoDocumentStore} from './storage/mongo-document-store.js';
import {backupDocument,reconcileConversation} from './storage/storage-maintenance.js';

dotenv.config({path:fileURLToPath(new URL('./.env',import.meta.url))});
const directory=process.env.DOCUMENT_STORE_DIR?path.resolve(process.env.DOCUMENT_STORE_DIR):fileURLToPath(new URL('./.data/uploads',import.meta.url));
const apply=process.argv.includes('--apply');
if(apply&&process.env.ALLOW_STORAGE_MIGRATION!=='true')throw new Error('Apply requires separately approved ALLOW_STORAGE_MIGRATION=true. Default is read-only.');
const client=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000,socketTimeoutMS:15000});
try{
  await client.connect();const db=client.db(process.env.MONGODB_DB_NAME||'technovalens'),store=new MongoDocumentStore(db,directory),conversations=db.collection('conversations'),owners=new Map();
  for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.json'))){
    try{const document=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));const result=await backupDocument(document,{store,conversations,directory,dryRun:!apply});if(result.verified||result.status==='eligible')owners.set(document.fileId,document.ownerHash);console.log(JSON.stringify({file:name,status:result.status,reason:result.reason||null}));}
    catch(error){console.log(JSON.stringify({file:name,status:'review',reason:'integrity-or-storage-check-failed',errorName:error.name}));}
  }
  const snapshot=path.join(path.dirname(directory),'conversations.json');
  if(fs.existsSync(snapshot))for(const local of JSON.parse(fs.readFileSync(snapshot,'utf8'))){const result=await reconcileConversation(local,{collection:conversations,verifiedOwner:owners.get(local.fileId),dryRun:!apply});console.log(JSON.stringify({conversationId:local.id,status:result.status,reason:result.reason||null,applied:result.applied===true}));}
}finally{await client.close();}
