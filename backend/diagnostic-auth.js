// Existing HTTP diagnostic tools use real login sessions, never an anonymous
// workspace-token bypass. Supply a dedicated diagnostic account via private env.
export async function diagnosticClient(base,{username=process.env.TECHNOVALENS_DIAGNOSTIC_USERNAME,password=process.env.TECHNOVALENS_DIAGNOSTIC_PASSWORD}={}){
  const target=new URL(base),local=['localhost','127.0.0.1','[::1]'].includes(target.hostname);
  if(target.protocol!=='https:'&&!(target.protocol==='http:'&&local))throw new Error('Diagnostic login requires HTTPS, or HTTP on localhost.');
  if(!username||!password)throw new Error('Set TECHNOVALENS_DIAGNOSTIC_USERNAME and TECHNOVALENS_DIAGNOSTIC_PASSWORD for a dedicated existing account. Credentials are never printed.');
  let cookie='',csrf='';
  const request=async(route,options={})=>{
    const headers=new Headers(options.headers);if(cookie)headers.set('Cookie',cookie);if(csrf&&!['GET','HEAD','OPTIONS'].includes(options.method||'GET'))headers.set('X-CSRF-Token',csrf);
    const response=await fetch(`${base}/api${route}`,{...options,headers});const values=response.headers.getSetCookie();if(values.length)cookie=values.map(value=>value.split(';')[0]).join('; ');return response;
  };
  const bootstrap=await request('/auth/session');if(!bootstrap.ok)throw new Error(`Diagnostic session failed (${bootstrap.status}).`);csrf=(await bootstrap.json()).csrfToken;
  const login=await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});if(!login.ok)throw new Error(`Diagnostic login failed (${login.status}).`);csrf=(await login.json()).csrfToken;
  return {request,logout:()=>request('/auth/logout',{method:'POST'})};
}
