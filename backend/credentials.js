import crypto from 'node:crypto';
import argon2 from 'argon2';

export const hashOptions={type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1,hashLength:32};
export const normalizeUsername=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value)?value.toLowerCase():null;
export function passwordError(password,username=''){
  if(typeof password!=='string'||password.length<15||password.length>128)return 'Use 15–128 characters for your password.';
  if(!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password))return 'Include uppercase and lowercase letters and a number. Symbols and spaces are welcome.';
  if(/^(?:password|letmein|qwerty|welcome|admin|technovalens)[\W\d_]*$/i.test(password)||username.length>=3&&password.toLowerCase().includes(username.toLowerCase()))return 'Choose a less predictable password that does not contain your username.';
  return '';
}
export function recoveryCodes(id){
  const codes=Array.from({length:10},()=>crypto.randomBytes(16).toString('hex').match(/.{4}/g).join('-'));
  return {codes,hashes:codes.map(code=>crypto.createHash('sha256').update(`${id}:${code.replace(/-/g,'').toLowerCase()}`).digest('hex'))};
}

// Internal provisioning only. No public HTTP route can invoke account creation.
export async function createStoredAccount(db,{username,password,initialAdmin=false}){
  const key=normalizeUsername(username),error=key?passwordError(password,key):'Use a username of 3–32 letters, numbers, dots, underscores or hyphens.';
  if(error)throw Object.assign(new Error(error),{code:'VALIDATION_ERROR',status:400});
  const users=db.collection('auth_users');await users.createIndex({usernameKey:1},{unique:true});
  const id=crypto.randomUUID(),recovery=recoveryCodes(id);
  const user={_id:id,username,usernameKey:key,passwordHash:await argon2.hash(password,hashOptions),recoveryHashes:recovery.hashes,sessionVersion:0,createdAt:new Date(),disabled:false,...(initialAdmin?{initialAdmin:true,role:'admin'}:{})};
  try{await users.insertOne(user);}catch(error){if(error.code===11000)throw Object.assign(new Error('This username is unavailable. Choose another.'),{code:'USERNAME_UNAVAILABLE',status:409});throw error;}
  return {user,recoveryCodes:recovery.codes};
}

export async function provisionInitialAdmin(db,{username='admin',password}){
  const key=normalizeUsername(username),error=key?passwordError(password,key):'Invalid administrator username.';
  if(error)throw new Error(error);
  const users=db.collection('auth_users');
  if(await users.findOne({usernameKey:key}))throw new Error('This account already exists. Sign in with its current credentials; bootstrap never overwrites accounts.');
  // A permanent singleton also fails closed after an interrupted setup. It is
  // independent of the admin username, password, session and account lifetime.
  const bootstrap=db.collection('auth_bootstrap');
  try{await bootstrap.insertOne({_id:'initial-admin',status:'locked',createdAt:new Date()});}
  catch(error){if(error.code===11000)throw new Error('Initial administrator setup is already completed or locked. Bootstrap is disabled.');throw error;}
  const result=await createStoredAccount(db,{username,password,initialAdmin:true});
  await bootstrap.updateOne({_id:'initial-admin'},{$set:{status:'complete',userId:result.user._id,completedAt:new Date()}});
  return {id:result.user._id};
}
