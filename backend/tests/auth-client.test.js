import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceApi} from '../../frontend/src/api.js';

test('authenticated browser clients include cookies and CSRF headers without depending on anonymous workspace tokens',async()=>{
  const requests=[],token='a'.repeat(64),factory=createWorkspaceApi({baseURL:'https://api.example/api',pageOrigin:'https://app.example',getCsrfToken:()=>token,adapter:async config=>{requests.push(config);return {data:{},status:200,statusText:'OK',headers:{},config};},fetchImpl:async(url,init)=>{requests.push({url,...init});return new Response('{}',{status:200});}});
  await factory.client.get('/files');await factory.client.post('/auth/login',{username:'sample',password:'not-a-real-credential'});await factory.workspaceFetch('/ai/ask/progress',{method:'POST',body:'{}'});
  assert.equal(requests[0].withCredentials,true);assert.equal(requests[0].headers.has('X-Workspace-Token'),false);assert.equal(requests[0].headers.has('X-CSRF-Token'),false);
  assert.equal(requests[1].headers.get('X-CSRF-Token'),token);assert.equal(requests[2].credentials,'include');assert.equal(requests[2].headers.get('X-CSRF-Token'),token);
});
test('mutations fail before transport if a CSRF token is unavailable and secrets cannot be sent to another origin',async()=>{
  let sent=0;const factory=createWorkspaceApi({baseURL:'https://api.example/api',pageOrigin:'https://app.example',getCsrfToken:()=>'',adapter:async()=>{sent++;}});
  await assert.rejects(factory.client.post('/files/upload',{}),{code:'AUTH_CSRF_MISSING'});await assert.rejects(factory.workspaceFetch('/ai/ask/progress',{method:'POST'}),{code:'AUTH_CSRF_MISSING'});await assert.rejects(factory.client.post('https://evil.example/api/upload',{}),{code:'WORKSPACE_API_CONFIG'});assert.equal(sent,0);
});
