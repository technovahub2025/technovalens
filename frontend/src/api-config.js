// VITE_API_URL is a build-time setting. Development always uses Vite's proxy.
export function resolveApiBase(env = {}) {
  const configured = env.DEV ? '' : String(env.VITE_API_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return '/api';
  let url;
  try { url = new URL(configured); } catch { throw new Error('VITE_API_URL must be an absolute backend URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/', '/api'].includes(url.pathname)) {
    throw new Error('VITE_API_URL must be the backend origin, optionally ending in /api.');
  }
  return `${url.origin}/api`;
}
