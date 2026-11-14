// Render terminates TLS before forwarding to the service. Trust exactly the
// immediate platform proxy, never arbitrary forwarded headers on other hosts.
export function authenticationProxyHops(env=process.env){
  const value=env.AUTH_TRUST_PROXY_HOPS??(env.RENDER==='true'?'1':'0');
  if(!/^[0-3]$/.test(String(value)))throw new Error('AUTH_TRUST_PROXY_HOPS must be an integer from 0 to 3.');
  return Number(value);
}

export function authenticationOrigins(env=process.env){
  const origins=new Set(['https://technovahub.in','https://www.technovahub.in']);
  if(env.NODE_ENV!=='production'){
    origins.add('http://localhost:5173');
    origins.add('https://technovalens.vercel.app');
  }
  for(const origin of (env.AUTH_ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean)){
    let parsed;try{parsed=new URL(origin);}catch{throw new Error('AUTH_ALLOWED_ORIGINS must contain exact HTTP(S) origins.');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin)throw new Error('AUTH_ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or wildcards.');
    origins.add(origin);
  }
  return origins;
}
