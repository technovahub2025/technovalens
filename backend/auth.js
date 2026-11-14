import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import argon2 from 'argon2';
import crypto from 'node:crypto';

const random=()=>crypto.randomBytes(32).toString('hex');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const accountOwner=id=>sha(`technovalens:account:v1:${id}`);
const publicUser=user=>({id:user._id,username:user.username});
const asyncRoute=handler=>(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next);
const call=(object,method)=>new Promise((resolve,reject)=>object[method](error=>error?reject(error):resolve()));
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const normalizeUsername=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value)?value.toLowerCase():null;
const hashOptions={type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1,hashLength:32};
let hashing=0;
async function boundedHash(work){
  if(hashing>=4)throw Object.assign(new Error('Authentication is busy. Try again shortly.'),{status:429,code:'AUTH_BUSY'});
  hashing++;try{return await work();}finally{hashing--;}
}
export function passwordError(password,username=''){
  if(typeof password!=='string'||password.length<15||password.length>128)return 'Use 15–128 characters for your password.';
  if(!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password))return 'Include uppercase and lowercase letters and a number. Symbols and spaces are welcome.';
  if(/^(?:password|letmein|qwerty|welcome|admin|technovalens)[\W\d_]*$/i.test(password)||username.length>=3&&password.toLowerCase().includes(username.toLowerCase()))return 'Choose a less predictable password that does not contain your username.';
  return '';
}

export async function createAuthentication({db,secret,allowedOrigins,production=false,secure=production,sameSite=production?'none':'lax',idleMs=30*60*1000,absoluteMs=8*60*60*1000,clock=Date.now,limits={}}){
  if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw new Error('SESSION_SECRET must be configured with at least 32 random bytes.');
  if(!['lax','strict','none'].includes(sameSite)||sameSite==='none'&&!secure||production&&!secure)throw new Error('Invalid authentication cookie configuration. Production and SameSite=None require Secure cookies.');
  const users=db.collection('auth_users'),attempts=db.collection('auth_attempts'),sessions=db.collection('auth_sessions'),revocations=db.collection('auth_revocations');
  await users.createIndex({usernameKey:1},{unique:true});await attempts.createIndex({expiresAt:1},{expireAfterSeconds:0});
  await revocations.createIndex({expiresAt:1},{expireAfterSeconds:0});
  const store=MongoStore.create({client:db.client,dbName:db.databaseName,collectionName:'auth_sessions',stringify:false,autoRemove:'native',ttl:Math.ceil(idleMs/1000),transformId:sha});
  // Equal-cost verification for unknown usernames reduces account enumeration.
  const dummy=await argon2.hash(random(),hashOptions);
  const name=secure?'__Host-technovalens.sid':'technovalens.sid';
  const cookie={httpOnly:true,secure,sameSite,path:'/',maxAge:idleMs};
  const router=express.Router();
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');if(production&&!req.secure)return res.status(426).json({code:'HTTPS_REQUIRED',error:'HTTPS is required for authentication.'});next();});
  router.use(session({name,secret,store,resave:false,saveUninitialized:false,rolling:true,cookie,unset:'destroy'}));
  router.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    const origin=req.get('Origin');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&((origin&&!allowedOrigins.has(origin))||!origin&&req.get('Sec-Fetch-Site')==='cross-site'))return res.status(403).json({code:'CSRF_INVALID',error:'This request origin is not allowed.'});
    next();
  });
  const csrfToken=req=>req.session.csrfToken||(req.session.csrfToken=random());
  const csrf=(req,res,next)=>{
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    if(!equal(req.get('X-CSRF-Token'),req.session.csrfToken))return res.status(403).json({code:'CSRF_INVALID',error:'Your security token expired. Refresh the page and try again.'});
    next();
  };
  async function readUser(req){
    if(!req.session.userId)return null;
    const now=clock();
    const user=typeof req.session.userId==='string'?await users.findOne({_id:req.session.userId}):null;
    if(!user||user.disabled||await revocations.findOne({_id:sha(req.sessionID)})||user.sessionVersion!==req.session.sessionVersion||!Number.isFinite(req.session.authenticatedAt)||now-req.session.authenticatedAt>=absoluteMs||!Number.isFinite(req.session.lastSeen)||now-req.session.lastSeen>=idleMs){await call(req.session,'destroy');return null;}
    req.session.lastSeen=now;req.session.cookie.maxAge=Math.min(idleMs,absoluteMs-(now-req.session.authenticatedAt));return user;
  }
  const requireUser=asyncRoute(async(req,res,next)=>{
    const user=await readUser(req);if(!user){res.clearCookie(name,{httpOnly:true,secure,sameSite,path:'/'});return res.status(401).json({code:'AUTH_REQUIRED',error:'Please sign in to continue.'});}
    req.authUser=user;req.ownerHash=accountOwner(user._id);next();
  });
  async function rate(req,action,username=''){
    const windowMs=15*60*1000,now=clock(),window=Math.floor(now/windowMs);
    const keys=[['ip',req.ip,action==='signup'?(limits.signupIp??20):(limits.ip??60)]];
    if(username)keys.push(['account',username,limits.account??10]);
    for(const [kind,key,limit] of keys){
      const id=crypto.createHmac('sha256',secret).update(`${action}:${kind}:${key}:${window}`).digest('hex');
      const record=await attempts.findOneAndUpdate({_id:id},{$inc:{count:1},$setOnInsert:{expiresAt:new Date((window+1)*windowMs)}},{upsert:true,returnDocument:'after'});
      if(record.count>limit)throw Object.assign(new Error('Too many authentication attempts. Try again later.'),{status:429,code:'AUTH_RATE_LIMIT',retryAfter:Math.ceil(((window+1)*windowMs-now)/1000)});
    }
  }
  const codesFor=id=>{const codes=Array.from({length:10},()=>crypto.randomBytes(16).toString('hex').match(/.{4}/g).join('-'));return {codes,hashes:codes.map(code=>sha(`${id}:${code.replace(/-/g,'').toLowerCase()}`))};};
  const recoveryHash=(id,code)=>typeof code==='string'&&/^[a-f0-9-]{32,39}$/i.test(code)?sha(`${id}:${code.replace(/-/g,'').toLowerCase()}`):null;
  const revoke=async req=>revocations.updateOne({_id:sha(req.sessionID)},{$set:{expiresAt:new Date(clock()+absoluteMs+idleMs)}},{upsert:true});
  async function establish(req,user){await revoke(req);await call(req.session,'regenerate');Object.assign(req.session,{userId:user._id,sessionVersion:user.sessionVersion,authenticatedAt:clock(),lastSeen:clock(),csrfToken:random()});req.session.cookie.maxAge=Math.min(idleMs,absoluteMs);await call(req.session,'save');}
  function credentials(body){const key=normalizeUsername(body.username);if(!key)return {error:'Use a username of 3–32 letters, numbers, dots, underscores or hyphens.'};const error=passwordError(body.password,key);return {key,error};}
  router.get('/auth/session',asyncRoute(async(req,res)=>{
    await rate(req,'bootstrap');
    const user=await readUser(req);
    if(!req.session)req.sessionStore.generate(req);
    res.json({user:user?publicUser(user):null,csrfToken:csrfToken(req)});
  }));
  router.post('/auth/signup',csrf,asyncRoute(async(req,res)=>{
    await rate(req,'signup');const {key,error}=credentials(req.body||{});
    if(error)return res.status(400).json({error,code:'VALIDATION_ERROR'});
    if(req.body.password!==req.body.confirmPassword)return res.status(400).json({error:'Passwords do not match.',code:'VALIDATION_ERROR'});
    const id=crypto.randomUUID(),recovery=codesFor(id),passwordHash=await boundedHash(()=>argon2.hash(req.body.password,hashOptions));
    const user={_id:id,username:req.body.username,usernameKey:key,passwordHash,recoveryHashes:recovery.hashes,sessionVersion:0,createdAt:new Date(clock()),disabled:false};
    try{await users.insertOne(user);}catch(error){if(error.code===11000)return res.status(409).json({code:'USERNAME_UNAVAILABLE',error:'This username is unavailable. Choose another.'});throw error;}
    await establish(req,user);res.status(201).json({user:publicUser(user),csrfToken:csrfToken(req),recoveryCodes:recovery.codes});
  }));
  router.post('/auth/login',csrf,asyncRoute(async(req,res)=>{
    const key=normalizeUsername(req.body?.username);await rate(req,'login',key||'invalid');
    const user=key?await users.findOne({usernameKey:key}):null,password=req.body?.password;
    const valid=typeof password==='string'&&password.length<=128&&await boundedHash(()=>argon2.verify(user?.passwordHash||dummy,password));
    if(!valid||!user||user.disabled)return res.status(401).json({code:'INVALID_CREDENTIALS',error:'Invalid username or password.'});
    await establish(req,user);res.json({user:publicUser(user),csrfToken:csrfToken(req)});
  }));
  router.post('/auth/recover',csrf,asyncRoute(async(req,res)=>{
    const key=normalizeUsername(req.body?.username);await rate(req,'recovery',key||'invalid');
    const error=passwordError(req.body?.password,key||'');if(error||req.body.password!==req.body.confirmPassword)return res.status(400).json({code:'VALIDATION_ERROR',error:error||'Passwords do not match.'});
    const user=key?await users.findOne({usernameKey:key}):null,hash=user?recoveryHash(user._id,req.body.recoveryCode):null;
    // Hash even an invalid recovery attempt; never expose whether the account exists.
    const passwordHash=await boundedHash(()=>argon2.hash(req.body.password,hashOptions));
    const changed=user&&hash&&!user.disabled?await users.findOneAndUpdate({_id:user._id,sessionVersion:user.sessionVersion,recoveryHashes:hash},{$set:{passwordHash,passwordChangedAt:new Date(clock())},$inc:{sessionVersion:1},$pull:{recoveryHashes:hash}},{returnDocument:'after'}):null;
    if(!changed)return res.status(400).json({code:'RECOVERY_INVALID',error:'The username or recovery code is invalid or has already been used.'});
    await sessions.deleteMany({'session.userId':user._id});await call(req.session,'destroy');res.clearCookie(name,{httpOnly:true,secure,sameSite,path:'/'});res.json({recovered:true});
  }));
  router.post('/auth/logout',csrf,asyncRoute(async(req,res)=>{await revoke(req);await call(req.session,'destroy');res.clearCookie(name,{httpOnly:true,secure,sameSite,path:'/'});res.json({loggedOut:true});}));
  router.post('/auth/recovery-codes',requireUser,csrf,asyncRoute(async(req,res)=>{
    await rate(req,'recovery-codes',req.authUser.usernameKey);
    if(typeof req.body?.password!=='string'||req.body.password.length>128||!await boundedHash(()=>argon2.verify(req.authUser.passwordHash,req.body.password)))return res.status(401).json({code:'INVALID_CREDENTIALS',error:'Invalid username or password.'});
    const recovery=codesFor(req.authUser._id);
    const result=await users.updateOne({_id:req.authUser._id,sessionVersion:req.authUser.sessionVersion},{$set:{recoveryHashes:recovery.hashes}});
    if(!result.matchedCount)return res.status(401).json({code:'AUTH_REQUIRED',error:'Please sign in again.'});
    await establish(req,req.authUser);res.json({csrfToken:csrfToken(req),recoveryCodes:recovery.codes});
  }));
  router.use(requireUser,csrf);
  router.use((error,req,res,next)=>{
    if(!error.status)return next(error);
    if(error.retryAfter)res.set('Retry-After',String(error.retryAfter));res.status(error.status).json({code:error.code,error:error.message});
  });
  return {middleware:router,store,cookieName:name,users};
}
