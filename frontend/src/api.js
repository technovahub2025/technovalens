import axios from 'axios';
import { resolveApiBase } from './api-config.js';
export { resolveApiBase } from './api-config.js';

let csrfToken='';
export const setCsrfToken=value=>{csrfToken=typeof value==='string'?value:'';};
export function createWorkspaceApi({ baseURL, identity, getCsrfToken=()=>csrfToken, pageOrigin = globalThis.location?.origin || 'http://localhost', fetchImpl = (...args) => globalThis.fetch(...args), adapter, configurationError } = {}) {
  const client = axios.create({ baseURL, withCredentials:true, ...(adapter ? { adapter } : {}) });
  const root = new URL(baseURL, pageOrigin);
  function checkTarget(url) {
    if (configurationError) throw Object.assign(new Error(configurationError.message), { code: 'WORKSPACE_API_CONFIG' });
    if (['localhost', '127.0.0.1', '[::1]'].includes(root.hostname) && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(pageOrigin).hostname)) {
      throw Object.assign(new Error('The deployed frontend cannot use a localhost backend. Set VITE_API_URL to the public HTTPS backend URL and rebuild the frontend.'), { code: 'WORKSPACE_API_CONFIG' });
    }
    if (new URL(pageOrigin).protocol === 'https:' && root.protocol !== 'https:') {
      throw Object.assign(new Error('The HTTPS frontend requires an HTTPS backend. Update VITE_API_URL and rebuild the frontend.'), { code: 'WORKSPACE_API_CONFIG' });
    }
    const target = new URL(url, pageOrigin);
    if (target.origin !== root.origin || !target.pathname.startsWith(`${root.pathname.replace(/\/$/, '')}/`) || target.username || target.password) {
      throw Object.assign(new Error('The private workspace client can only contact the configured backend API. Check VITE_API_URL.'), { code: 'WORKSPACE_API_CONFIG' });
    }
  }
  client.interceptors.request.use(config => {
    checkTarget(client.getUri(config));
    if(identity)config.headers.set('X-Workspace-Token', identity.getToken(), true);
    if(!['get','head','options'].includes((config.method||'get').toLowerCase())){
      const token=getCsrfToken();if(token)config.headers.set('X-CSRF-Token',token,true);
      else if(!identity)throw Object.assign(new Error('Your sign-in session is not ready. Refresh the page.'),{code:'AUTH_CSRF_MISSING'});
    }
    return config;
  });
  async function workspaceFetch(path, init = {}) {
    const url = client.getUri({ url: path });
    checkTarget(url);
    const headers = new Headers(init.headers);
    if(identity)headers.set('X-Workspace-Token',identity.getToken());
    if(!['GET','HEAD','OPTIONS'].includes((init.method||'GET').toUpperCase())){const token=getCsrfToken();if(token)headers.set('X-CSRF-Token',token);else if(!identity)throw Object.assign(new Error('Your sign-in session is not ready. Refresh the page.'),{code:'AUTH_CSRF_MISSING'});}
    const response=await fetchImpl(url, { ...init, headers, credentials:'include' });
    if(response.status===401&&!identity)globalThis.dispatchEvent?.(new Event('technovalens-auth-required'));
    return response;
  }
  return { client, workspaceFetch };
}

let baseURL, configurationError;
try { baseURL = resolveApiBase(import.meta.env); }
catch (error) { configurationError = error; baseURL = '/api'; }
const workspaceApi = createWorkspaceApi({ baseURL, configurationError });
export const api = workspaceApi.client;
export const apiFetch = workspaceApi.workspaceFetch;
api.interceptors.response.use(response=>response,error=>{
  if(error.response?.status===401&&error.response?.data?.code==='AUTH_REQUIRED')globalThis.dispatchEvent?.(new Event('technovalens-auth-required'));
  return Promise.reject(error);
});
