import axios from 'axios';
import { workspaceIdentity } from './workspace.js';
import { resolveApiBase } from './api-config.js';
export { resolveApiBase } from './api-config.js';

export function createWorkspaceApi({ baseURL, identity = workspaceIdentity, pageOrigin = globalThis.location?.origin || 'http://localhost', fetchImpl = (...args) => globalThis.fetch(...args), adapter, configurationError } = {}) {
  const client = axios.create({ baseURL, ...(adapter ? { adapter } : {}) });
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
    config.headers.set('X-Workspace-Token', identity.getToken(), true);
    return config;
  });
  async function workspaceFetch(path, init = {}) {
    const url = client.getUri({ url: path });
    checkTarget(url);
    const headers = new Headers(init.headers);
    headers.set('X-Workspace-Token', identity.getToken());
    return fetchImpl(url, { ...init, headers });
  }
  return { client, workspaceFetch };
}

let baseURL, configurationError;
try { baseURL = resolveApiBase(import.meta.env); }
catch (error) { configurationError = error; baseURL = '/api'; }
const workspaceApi = createWorkspaceApi({ baseURL, configurationError });
export const api = workspaceApi.client;
export const apiFetch = workspaceApi.workspaceFetch;
