const TOKEN_KEY = 'technovalens.workspaceToken';
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function workspaceError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Initialize lazily so storage failures reach the app's normal error UI. Never
// fall back to a temporary token: uploads must remain accessible after refresh.
export function createWorkspaceIdentity({ storage = () => globalThis.localStorage, random = bytes => globalThis.crypto.getRandomValues(bytes) } = {}) {
  let token;
  function getToken() {
    try {
      const store = storage();
      const saved = store.getItem(TOKEN_KEY);
      if (token) {
        if (saved !== token) throw workspaceError('WORKSPACE_CHANGED', 'Your private workspace changed in another tab or browser storage. Reload the application before continuing.');
        return token;
      }
      let candidate = saved;
      if (!validToken(candidate)) {
        candidate = Array.from(random(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
        if (!validToken(candidate)) throw new Error('Secure token generation failed.');
        store.setItem(TOKEN_KEY, candidate);
        if (store.getItem(TOKEN_KEY) !== candidate) throw new Error('Workspace storage did not retain the token.');
      }
      token = candidate;
      return token;
    } catch (error) {
      if (error.code === 'WORKSPACE_CHANGED') throw error;
      throw workspaceError('WORKSPACE_UNAVAILABLE', 'Cannot initialize your private workspace. Allow browser storage for this site and use HTTPS or localhost, then reload. No upload was sent.');
    }
  }
  return { getToken, getHeaders: () => ({ 'X-Workspace-Token': getToken() }) };
}

export const workspaceIdentity = createWorkspaceIdentity();

export function workspaceFailureMessage(error) {
  if (['WORKSPACE_CHANGED', 'WORKSPACE_UNAVAILABLE', 'WORKSPACE_API_CONFIG'].includes(error?.code)) return error.message;
  if ((error?.apiStatus || error?.response?.status) === 401) {
    return 'Your private workspace could not be verified. Reload the application. If this continues, check that the latest frontend is deployed and its API URL points to the matching backend.';
  }
  return '';
}
