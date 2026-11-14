// Own the test database outside the test process so cleanup is reliable even
// when an assertion fails. No configured development/production database is used.
import {MongoMemoryServer} from 'mongodb-memory-server-core';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const mongo=await MongoMemoryServer.create({binary:{version:'8.0.18',downloadDir:path.resolve(import.meta.dirname,'../.data/test-mongodb-binaries')},instance:{ip:'127.0.0.1'}});
try{
  const filename=process.argv.includes('--auth-ui')?'../auth-ui-smoke.mjs':process.argv.includes('--dashboard-only')?'dashboard.test.js':process.argv.includes('--auth-only')?'auth.test.js':'test-suite.js';
  const child=spawn(process.execPath,['--import',new URL('./auth-test-client.js',import.meta.url).href,fileURLToPath(new URL(filename,import.meta.url))],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,MONGODB_URI:mongo.getUri(),MONGODB_DB_NAME:`technovalens_test_${crypto.randomBytes(8).toString('hex')}`,SESSION_SECRET:crypto.randomBytes(48).toString('hex'),NODE_ENV:'test',AUTH_COOKIE_SECURE:'false',AUTH_COOKIE_SAMESITE:'lax',AUTH_TRUST_PROXY_HOPS:'0'},stdio:'inherit'});
  const [code]=await once(child,'exit');process.exitCode=code??1;
}finally{await mongo.stop();}
