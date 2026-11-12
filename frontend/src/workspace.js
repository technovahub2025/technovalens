import axios from 'axios';

// A private browser workspace until account authentication is introduced.
let token;
try {
  token = localStorage.getItem('technovalens.workspaceToken');
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('technovalens.workspaceToken', token);
  }
} catch {
  token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}
export const workspaceHeaders = { 'X-Workspace-Token': token };
axios.interceptors.request.use(config => {
  if (config.url?.startsWith('/api/') || config.url?.startsWith(`${(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')}/api/`)) {
    config.headers['X-Workspace-Token'] = token;
  }
  return config;
});
