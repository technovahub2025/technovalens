import fs from 'node:fs';
import path from 'node:path';
import {clearSheetCache} from '../sheet-storage.js';
import {verifyDocumentIntegrity} from './storage-maintenance.js';

// A shared activity barrier protects uploads, workers, streams and restoration.
// Expiration is opt-in and only supported by one server per cache directory.
export class LocalDocumentCache {
  constructor({directory,store,documents,attach,enabled=false,exclusive=false,ttlMs=86400000,clock=Date.now}) {
    if(enabled&&!exclusive)throw new Error('Cache expiration requires an exclusive single-process cache directory.');
    Object.assign(this,{directory,store,documents,attach,enabled,ttlMs,clock});
    this.active=0;this.lastAccess=new Map();this.proofs={};
    this.proofPath=path.join(path.dirname(directory),'cache-recovery.json');
    try{const saved=JSON.parse(fs.readFileSync(this.proofPath,'utf8'));if(saved&&typeof saved==='object'&&!Array.isArray(saved))this.proofs=saved;}catch{}
    for(const id of documents.keys())this.lastAccess.set(id,clock());
  }
  async enter(){while(this.sweeping){try{await this.sweeping;}catch{break;}}this.active++;let released=false;return ()=>{if(!released){released=true;this.active--;}};}
  touch(id){this.lastAccess.set(id,this.clock());}
  async ensure(id,ownerHash){
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)||!ownerHash)return null;
    const existing=this.documents.get(id);
    if(existing&&existing.ownerHash!==ownerHash)return null;
    this.touch(id);
    const localComplete=existing&&fs.existsSync(path.join(this.directory,`${id}.json`))&&(existing.storageVersion!==2||existing.sheets.every(sheet=>/^sheet-\d+\.ndjson$/.test(sheet.dataFile)&&fs.existsSync(path.join(this.directory,`${id}.sheets`,sheet.dataFile))));
    if(localComplete||!this.store)return existing||null;
    // Concurrent retrievals share one restore; a different owner cannot join it.
    this.restoring??=new Map();
    const key=`${id}/${ownerHash}`;
    if(!this.restoring.has(key))this.restoring.set(key,this.store.restoreOne(id,ownerHash,{proof:this.proofs[id]}).then(document=>{if(document){this.attach(document);this.documents.set(id,document);}return document;}).catch(error=>{throw Object.assign(error,{code:'CACHE_RESTORE_FAILED'});}).finally(()=>this.restoring.delete(key)));
    const restored=await this.restoring.get(key);return restored?.ownerHash===ownerHash?restored:null;
  }
  async expire(){
    if(!this.enabled||!this.store||this.active||this.sweeping)return [];
    this.sweeping=this.expireIdle();
    try{return await this.sweeping;}finally{this.sweeping=null;}
  }
  async expireIdle(){
    const expired=[];
    for(const [id,document] of this.documents){
      if(this.clock()-(this.lastAccess.get(id)??this.clock())<this.ttlMs)continue;
      const manifest=path.join(this.directory,`${id}.json`);
      if(!fs.existsSync(manifest)||typeof document.ownerHash!=='string'||!/^[a-f0-9]{64}$/.test(document.ownerHash))continue;
      if(fs.lstatSync(manifest).isSymbolicLink()||!fs.lstatSync(manifest).isFile())continue;
      const sheetFiles=document.storageVersion===2?document.sheets.map(sheet=>sheet.dataFile):[];
      if(sheetFiles.some(name=>!/^sheet-\d+\.ndjson$/.test(name)))continue;
      const folder=path.join(this.directory,`${id}.sheets`);
      if(fs.existsSync(folder)&&(fs.lstatSync(folder).isSymbolicLink()||!fs.lstatSync(folder).isDirectory()))continue;
      const realRoot=fs.realpathSync(this.directory)+path.sep;
      if(sheetFiles.some(name=>{const target=path.join(folder,name);return !fs.existsSync(target)||fs.lstatSync(target).isSymbolicLink()||!fs.lstatSync(target).isFile()||!fs.realpathSync(target).startsWith(realRoot);}))continue;
      if(fs.existsSync(folder)&&fs.readdirSync(folder).some(name=>!sheetFiles.includes(name)))continue;
      try{verifyDocumentIntegrity(document,this.directory);}catch{continue;}
      const proof=await this.store.verify(document);if(!proof.verified)continue;
      // Persist verification fingerprints before removing any recoverable byte.
      this.proofs[id]=proof;
      const temporary=`${this.proofPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary,JSON.stringify(this.proofs),{mode:0o600});fs.renameSync(temporary,this.proofPath);
      clearSheetCache(id);
      for(const name of sheetFiles)fs.unlinkSync(path.join(folder,name));
      fs.unlinkSync(manifest);
      if(fs.existsSync(folder)&&fs.readdirSync(folder).length===0)fs.rmdirSync(folder);
      expired.push(id);
    }
    return expired;
  }
}
