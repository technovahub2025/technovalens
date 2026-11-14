// Explicit local setup only. Never print or overwrite an existing secret.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
const filename=new URL('./.env',import.meta.url);
let content='';try{content=await fs.readFile(filename,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
const env=dotenv.parse(content);
if(env.SESSION_SECRET){
  if(Buffer.byteLength(env.SESSION_SECRET)<32)throw new Error('An existing SESSION_SECRET is too short. Replace it deliberately with a securely generated value.');
  console.log('An existing SESSION_SECRET is configured; it was not changed.');
}else{
  // Append only: preserve existing local configuration and comments. A new
  // value deliberately supersedes an optional earlier empty declaration.
  await fs.appendFile(filename,`${content.endsWith('\n')?'':'\n'}SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}\n`,{mode:0o600});
  console.log('A random SESSION_SECRET was saved to the ignored backend/.env. Its value was not printed.');
}
