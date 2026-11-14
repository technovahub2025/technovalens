import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceIdentity, workspaceFailureMessage } from '../../frontend/src/workspace.js';
import { createWorkspaceApi, resolveApiBase } from '../../frontend/src/api.js';

function storage(initial) {
  const values = new Map(initial ? [['technovalens.workspaceToken', initial]] : []);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function identity(store) { return createWorkspaceIdentity({ storage: () => store }); }
function recordingApi(store, baseURL = '/api') {
  const requests = [];
  const workspace = identity(store);
  const api = createWorkspaceApi({
    baseURL, identity: workspace, pageOrigin: 'https://technovahub.in',
    adapter: async config => { requests.push(config); return {data:{}, status:200, statusText:'OK', headers:{}, config}; },
    fetchImpl: async (url, init) => { requests.push({url, ...init}); return new Response('{}'); }
  });
  return {...api, workspace, requests};
}

test('workspace initializes once before concurrent requests and survives refresh/navigation', async () => {
  const store = storage();
  const first = recordingApi(store);
  assert.equal(store.getItem('technovalens.workspaceToken'), null);
  await Promise.all([first.client.get('/files'), first.client.get('/conversations')]);
  const token = store.getItem('technovalens.workspaceToken');
  assert.match(token, /^[a-f0-9]{64}$/);
  const body = new FormData(); body.append('file', new Blob(['A\n1\n']), 'test.csv');
  await first.client.post('/files/upload', body);
  await first.client.get('/files', {headers:{'X-Workspace-Token':false}});
  const refreshed = recordingApi(store);
  await refreshed.client.get('/analytics/workbook');
  await refreshed.client.get('/analytics/workbook/preview');
  for (const format of ['pdf', 'xlsx']) await refreshed.client.get(`/reports/workbook.${format}`, {responseType:'blob'});
  await refreshed.client.post('/ai/ask', {question:'Count rows', fileId:'workbook'});
  await refreshed.workspaceFetch('/ai/ask/progress', {method:'POST', headers:{Accept:'text/event-stream'}, body:'{}'});
  for (const request of [...first.requests, ...refreshed.requests]) {
    assert.equal(request.headers.get('X-Workspace-Token'),token);
    assert.ok(!request.url.includes(token));
  }
  assert.equal(refreshed.workspace.getToken(),token);
  assert.equal(first.requests[2].data, body, 'upload FormData is preserved');
  assert.notEqual(identity(storage()).getToken(),token, 'another browser gets a separate workspace');
});

test('development, production origins, trailing slashes and /api suffix use the same authenticated client', async () => {
  assert.equal(resolveApiBase({DEV:true,VITE_API_URL:'https://backend.example'}),'/api');
  assert.equal(resolveApiBase({}),'/api');
  for (const value of ['https://backend.example',' https://backend.example/ ','https://backend.example/api/']) {
    const base = resolveApiBase({VITE_API_URL:value}); assert.equal(base,'https://backend.example/api');
    const app = recordingApi(storage(),base);
    await app.client.post('/files/upload',new FormData());
    await app.client.get(`${base}/files`);
    await app.workspaceFetch('/ai/ask/progress');
    assert.equal(app.requests.length,3);
    app.requests.forEach(request => assert.match(request.headers.get('X-Workspace-Token'),/^[a-f0-9]{64}$/));
  }
  for(const value of ['localhost:5000','https://backend.example/api/api','https://backend.example?token=abc','https://user:pass@backend.example','file:///api']) {
    assert.throws(() => resolveApiBase({VITE_API_URL:value}),/VITE_API_URL/);
  }
});

test('invalid initial tokens are replaced before sending and valid existing workspace tokens are retained', async () => {
  for (const initial of ['', 'invalid', 'A'.repeat(64), 'a'.repeat(63)]) {
    const store=storage(initial), app=recordingApi(store);
    await app.client.post('/files/upload',new FormData());
    const saved=store.getItem('technovalens.workspaceToken');assert.match(saved,/^[a-f0-9]{64}$/);
    assert.equal(app.requests[0].headers.get('X-Workspace-Token'),saved);
  }
  const saved=identity(storage()).getToken();
  const existing=createWorkspaceIdentity({storage:()=>storage(saved),random:()=>{throw new Error('must not regenerate');}});
  assert.equal(existing.getToken(),saved);
});

test('blocked storage and workspace changes fail before an upload or stream can be sent', async () => {
  const blockedStores = [
    {getItem(){throw new Error('blocked');}},
    {getItem(){return null;},setItem(){throw new Error('quota');}},
    {getItem(){return null;},setItem(){}}
  ];
  for (const store of blockedStores) {
    const app=recordingApi(store);
    await assert.rejects(app.client.post('/files/upload',new FormData()),{code:'WORKSPACE_UNAVAILABLE'});
    await assert.rejects(app.workspaceFetch('/ai/ask/progress'),{code:'WORKSPACE_UNAVAILABLE'});
    assert.equal(app.requests.length,0);
  }
  const store=storage(), app=recordingApi(store);
  await app.client.get('/files');const first=app.workspace.getToken();
  store.setItem('technovalens.workspaceToken',identity(storage()).getToken());
  await assert.rejects(app.client.post('/files/upload',new FormData()),{code:'WORKSPACE_CHANGED'});
  assert.equal(app.requests.length,1);assert.notEqual(store.getItem('technovalens.workspaceToken'),first);
});

test('workspace tokens cannot be sent to another origin or outside the configured API', async () => {
  const app=recordingApi(storage(),'https://backend.example/api');
  for (const target of ['https://other.example/api/files','https://backend.example/other/files','https://backend.example/api/../other/files']) {
    await assert.rejects(app.client.get(target),{code:'WORKSPACE_API_CONFIG'});
    await assert.rejects(app.workspaceFetch(target),{code:'WORKSPACE_API_CONFIG'});
  }
  assert.equal(app.requests.length,0);
  const deployed=recordingApi(storage(),'http://localhost:5000/api');
  await assert.rejects(deployed.client.get('/files'),{code:'WORKSPACE_API_CONFIG'});
  assert.equal(deployed.requests.length,0);
  assert.match(workspaceFailureMessage({response:{status:401}}),/sign-in session/);
});
