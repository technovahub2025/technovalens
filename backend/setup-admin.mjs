import dotenv from 'dotenv';
import {MongoClient} from 'mongodb';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {provisionInitialAdmin} from './credentials.js';

// Never accept passwords in command arguments, print them or put them in .env.
// An operator must explicitly run this command against their intended database.
dotenv.config({path:fileURLToPath(new URL('./.env',import.meta.url))});
let client,reader;
try{
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Run admin setup in a private interactive terminal. Piped credentials are not accepted.');
  if(!process.env.MONGODB_URI)throw new Error('Configure MONGODB_URI before running administrator setup.');
  const muted=new Writable({write(_chunk,_encoding,done){done();}});
  reader=createInterface({input:process.stdin,output:muted,terminal:true});
  reader.on('SIGINT',()=>reader.close());
  const ask=async prompt=>{process.stdout.write(prompt);const answer=await reader.question('');process.stdout.write('\n');return answer;};
  const username=(await ask('Admin username [admin] (input hidden): ')).trim()||'admin';
  const password=await ask('Initial password (input hidden): ');
  const confirm=await ask('Confirm initial password (input hidden): ');
  if(password!==confirm)throw new Error('Passwords do not match. No account was created.');
  reader.close();reader=null;
  client=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000});await client.connect();
  await provisionInitialAdmin(client.db(process.env.MONGODB_DB_NAME?.trim()||'technovalens'),{username,password});
  console.log('Initial administrator created. Bootstrap is permanently disabled. Sign in and manage credentials under Settings > Account Security.');
}catch(error){console.error(error.code==='VALIDATION_ERROR'?error.message:error.message?.startsWith('Use ')||error.message?.startsWith('Include ')||error.message?.startsWith('Choose ')?error.message:({MongoServerSelectionError:'Cannot connect to MongoDB.'}[error.name]||(/^(Run admin|Configure |Passwords do not|Initial administrator setup|This account already)/.test(error.message||'')?error.message:'Administrator setup failed. No credentials were printed. Inspect the database setup state before retrying.')));process.exitCode=1;}
finally{reader?.close();await client?.close();}
