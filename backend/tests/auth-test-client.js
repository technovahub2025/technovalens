// Test clients obtain real sessions from an isolated MongoDB, not an auth bypass.
// Legacy workspace markers are used only to choose distinct test accounts; they
// are removed before the request reaches the server.
import crypto from 'node:crypto';
import {MongoClient} from 'mongodb';
import {createStoredAccount} from '../credentials.js';
export const rawFetch=globalThis.fetch;
const credentials=new Map(),clients=new Map();
function account(marker){if(!credentials.has(marker))credentials.set(marker,{username:`test_${crypto.createHash('sha256').update(marker).digest('hex').slice(0,20)}`,password:`Aa7!${crypto.randomBytes(24).toString('hex')}`});return credentials.get(marker);}
export async function sessionClient(base,marker){
  const key=`${base}|${marker}`;if(clients.has(key))return clients.get(key);
  const promise=(async()=>{
    let cookie='',csrf='';
    const request=async(route,init={})=>{
      const headers=new Headers(init.headers);if(cookie)headers.set('Cookie',cookie);if(csrf&&!['GET','HEAD','OPTIONS'].includes(init.method||'GET'))headers.set('X-CSRF-Token',csrf);
      const response=await rawFetch(`${base}/api${route}`,{...init,headers});const cookies=response.headers.getSetCookie();if(cookies.length)cookie=cookies.map(value=>value.split(';')[0]).join('; ');return response;
    };
    const bootstrap=await (await request('/auth/session')).json();csrf=bootstrap.csrfToken;
    const input=account(marker);
    if(process.env.NODE_ENV!=='test'||new URL(process.env.MONGODB_URI).hostname!=='127.0.0.1')throw new Error('Test provisioning requires the isolated loopback MongoDB runner.');
    const connection=new MongoClient(process.env.MONGODB_URI);await connection.connect();
    try{await createStoredAccount(connection.db(process.env.MONGODB_DB_NAME),input);}catch(error){if(error.code!=='USERNAME_UNAVAILABLE')throw error;}finally{await connection.close();}
    const response=await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const body=await response.json();if(!response.ok)throw new Error(`Test account could not authenticate (${response.status}): ${body.code}`);csrf=body.csrfToken;
    return {get cookie(){return cookie;},get csrf(){return csrf;},user:body.user,request};
  })();clients.set(key,promise);try{return await promise;}catch(error){clients.delete(key);throw error;}
}
globalThis.fetch=async(input,init)=>{
  const request=input instanceof Request?input:new Request(input,init),headers=new Headers(request.headers),marker=headers.get('X-Workspace-Token');
  const url=new URL(request.url);
  if(!/^[a-f0-9]{64}$/.test(marker||'')||!url.pathname.startsWith('/api/')||url.pathname==='/api/health'||url.pathname.startsWith('/api/auth/'))return rawFetch(input,init);
  const client=await sessionClient(url.origin,marker);headers.delete('X-Workspace-Token');headers.set('Cookie',client.cookie);if(!['GET','HEAD','OPTIONS'].includes(request.method))headers.set('X-CSRF-Token',client.csrf);
  return rawFetch(new Request(request,{headers}));
};
