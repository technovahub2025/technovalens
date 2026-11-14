import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GridFSBucket } from 'mongodb';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';

const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function hashFile(filename){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(filename))hash.update(chunk);return hash.digest('hex');}

// Mongo is the durable source; disk is a reconstructible working cache. Store
// manifests in GridFS too, so extracted PDFs do not hit BSON's document limit.
export class MongoDocumentStore {
  constructor(db, directory, bucket = new GridFSBucket(db, {bucketName:'document_data'})) {
    this.collection=db.collection('documents');this.bucket=bucket;this.directory=directory;
  }
  async initialize(){await this.collection.createIndex({ownerHash:1});}
  ids(document){return [...(document.storageVersion===2?document.sheets.map(s=>`${document.fileId}/${s.dataFile}`):[]),`${document.fileId}/manifest.json`];}
  async save(document,{signal}={}){
    if(!validId(document.fileId)||!document.ownerHash)throw new Error('A document ID and verified ownership are required.');
    const ids=this.ids(document),written=[];
    // Reserve the immutable file ID before writing blobs. Another process must
    // never overwrite or roll back an already committed workbook's GridFS data.
    try{await this.collection.insertOne({_id:document.fileId,ownerHash:document.ownerHash,blobIds:ids,state:'writing'});}
    catch(error){if(error.code===11000){const existing=await this.collection.findOne({_id:document.fileId,state:'ready'});if(existing?.ownerHash===document.ownerHash&&(await this.verify(document,{allowMissingManifest:true})).verified)return;}throw error;}
    try{
      const integrity={};
      for(const sheet of document.storageVersion===2?document.sheets:[]){
        if(!/^sheet-\d+\.ndjson$/.test(sheet.dataFile))throw new Error('Invalid normalized sheet path.');
        const id=`${document.fileId}/${sheet.dataFile}`;written.push(id);
        const hash=crypto.createHash('sha256');
        await pipeline(fs.createReadStream(path.join(this.directory,`${document.fileId}.sheets`,sheet.dataFile)),new Transform({transform(chunk,_encoding,done){hash.update(chunk);done(null,chunk);}}),this.bucket.openUploadStreamWithId(id,id,{metadata:{ownerHash:document.ownerHash,fileId:document.fileId}}),{signal});
        integrity[id]=hash.digest('hex');
      }
      const id=ids.at(-1);written.push(id);
      const manifest=JSON.stringify(document);integrity[id]=digest(manifest);
      await pipeline(Readable.from([manifest]),this.bucket.openUploadStreamWithId(id,id,{metadata:{ownerHash:document.ownerHash,fileId:document.fileId}}),{signal});
      await this.collection.updateOne({_id:document.fileId,state:'writing'},{$set:{state:'ready',integrity}});
    }catch(error){await Promise.allSettled(written.map(id=>this.bucket.delete(id)));await this.collection.deleteOne({_id:document.fileId,state:'writing'});throw error;}
  }
  async downloadManifest(fileId){const chunks=[];for await(const chunk of this.bucket.openDownloadStream(`${fileId}/manifest.json`))chunks.push(chunk);return Buffer.concat(chunks);}
  async verify(document,{allowMissingManifest=false}={}){
    const item=await this.collection.findOne({_id:document.fileId,state:'ready'});
    if(!item||item.ownerHash!==document.ownerHash)return {verified:false,reason:'backup-or-ownership-unavailable'};
    try{
      const manifest=await this.downloadManifest(document.fileId),saved=JSON.parse(manifest);
      if(saved.fileId!==document.fileId||saved.ownerHash!==document.ownerHash||JSON.stringify(this.ids(saved))!==JSON.stringify(item.blobIds))return {verified:false,reason:'manifest-mismatch'};
      const filename=path.join(this.directory,`${document.fileId}.json`);
      const local=fs.existsSync(filename)?fs.readFileSync(filename):allowMissingManifest?Buffer.from(JSON.stringify(document)):null;
      if(!local||digest(local)!==digest(manifest))return {verified:false,reason:'local-manifest-differs'};
      const hashes={[`${document.fileId}/manifest.json`]:digest(manifest)};
      for(const sheet of saved.storageVersion===2?saved.sheets:[]){
        if(!/^sheet-\d+\.ndjson$/.test(sheet.dataFile))return {verified:false,reason:'invalid-sheet-path'};
        const id=`${document.fileId}/${sheet.dataFile}`,hash=crypto.createHash('sha256');for await(const chunk of this.bucket.openDownloadStream(id))hash.update(chunk);hashes[id]=hash.digest('hex');
        if(hashes[id]!==await hashFile(path.join(this.directory,`${document.fileId}.sheets`,sheet.dataFile)))return {verified:false,reason:'worksheet-differs'};
      }
      if(item.integrity&&Object.entries(hashes).some(([id,hash])=>item.integrity[id]!==hash))return {verified:false,reason:'backup-checksum-mismatch'};
      return {verified:true,ownerHash:document.ownerHash,hashes};
    }catch{return {verified:false,reason:'backup-or-local-data-unreadable'};}
  }
  async restoreOne(fileId,ownerHash,{proof}={}){
    if(!validId(fileId))return null;
    const item=await this.collection.findOne({_id:fileId,state:'ready'});
    if(!item||ownerHash&&item.ownerHash!==ownerHash)return null;
    const manifest=await this.downloadManifest(fileId),document=JSON.parse(manifest);
    if(document.fileId!==fileId||document.ownerHash!==item.ownerHash||JSON.stringify(this.ids(document))!==JSON.stringify(item.blobIds))throw new Error('Durable document ownership or inventory mismatch.');
    if(proof&&proof.ownerHash!==document.ownerHash)throw new Error('Recovery proof ownership mismatch.');
    const integrity=proof?.hashes||item.integrity;
    if(integrity&&integrity[`${fileId}/manifest.json`]!==digest(manifest))throw new Error('Durable manifest checksum mismatch.');
    const manifestPath=path.join(this.directory,`${fileId}.json`);
    if(fs.existsSync(manifestPath)&&(fs.lstatSync(manifestPath).isSymbolicLink()||digest(fs.readFileSync(manifestPath))!==digest(manifest)))throw new Error('Surviving local manifest differs; retained.');
    fs.mkdirSync(this.directory,{recursive:true});
    const staging=fs.mkdtempSync(path.join(this.directory,`.restore-${fileId}-`));
    try{
      for(const sheet of document.storageVersion===2?document.sheets:[]){
        if(!/^sheet-\d+\.ndjson$/.test(sheet.dataFile))throw new Error('Invalid normalized sheet path.');
        const filename=path.join(staging,sheet.dataFile),id=`${fileId}/${sheet.dataFile}`;
        await pipeline(this.bucket.openDownloadStream(id),fs.createWriteStream(filename,{mode:0o600}));
        if(integrity&&integrity[id]!==await hashFile(filename))throw new Error('Durable worksheet checksum mismatch.');
      }
      // Never replace a surviving local file: it might contain unique changes.
      const directory=path.join(this.directory,`${fileId}.sheets`);
      if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw new Error('Local sheet directory is a symbolic link; retained.');
      for(const sheet of document.storageVersion===2?document.sheets:[]){
        const target=path.join(directory,sheet.dataFile);
        if(fs.existsSync(target)&&(fs.lstatSync(target).isSymbolicLink()||await hashFile(target)!==await hashFile(path.join(staging,sheet.dataFile))))throw new Error('Surviving local worksheet differs; retained.');
      }
      for(const sheet of document.storageVersion===2?document.sheets:[]){
        fs.mkdirSync(directory,{recursive:true,mode:0o700});const target=path.join(directory,sheet.dataFile);
        if(fs.existsSync(target)){if(await hashFile(target)!==await hashFile(path.join(staging,sheet.dataFile)))throw new Error('Surviving local worksheet differs; retained.');}
        else fs.copyFileSync(path.join(staging,sheet.dataFile),target,fs.constants.COPYFILE_EXCL);
      }
      const filename=path.join(this.directory,`${fileId}.json`);
      if(fs.existsSync(filename)){if(digest(fs.readFileSync(filename))!==digest(manifest))throw new Error('Surviving local manifest differs; retained.');}
      else fs.writeFileSync(filename,manifest,{mode:0o600,flag:'wx'});
      return document;
    }finally{fs.rmSync(staging,{recursive:true,force:true});}
  }
  async restore({proofs={}}={}){
    const restored=[];
    for await(const item of this.collection.find({state:'ready'})){
      if(!/^[a-f0-9-]{36}$/i.test(item._id))continue;
      try{
        const document=await this.restoreOne(item._id,item.ownerHash,{proof:proofs[item._id]});if(document)restored.push(document);
      }catch(error){console.warn('Durable document unavailable:',{fileId:item._id,errorName:error.name});}
    }
    return restored;
  }
  async has(fileId){return Boolean(await this.collection.findOne({_id:fileId,state:'ready'}));}
  async delete(fileId,ownerHash){if(!ownerHash)throw new Error('Verified document ownership is required.');const item=await this.collection.findOne({_id:fileId,ownerHash});if(!item)return;await Promise.allSettled(item.blobIds.map(id=>this.bucket.delete(id)));await this.collection.deleteOne({_id:fileId,ownerHash});}
}
