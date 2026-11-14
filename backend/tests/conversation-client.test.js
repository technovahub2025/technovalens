import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConversation,initialPage} from '../../frontend/src/conversation-client.js';
test('conversation restoration fetches the authoritative associated file and preserved messages',async()=>{
  const calls=[];const messages=[{role:'user',text:'original question'}];
  const api={get:async url=>{calls.push(url);return {data:url.startsWith('/conversations')?{id:'selected',fileId:'original',messages,documentAvailable:false,recoveryMessage:'Original file unavailable'}:null};}};
  const result=await loadConversation(api,'selected');assert.equal(result.chat.messages,messages);assert.equal(result.document,null);assert.deepEqual(calls,['/conversations/selected']);
});
test('missing or inconsistent conversations never substitute a different history',async()=>{
  const missing=Object.assign(new Error('Unavailable'),{response:{status:404}});
  await assert.rejects(loadConversation({get:async()=>{throw missing;}},'missing'),missing);
  await assert.rejects(loadConversation({get:async()=>({data:{id:'other',fileId:'a',messages:[]}})},'selected'),/inconsistent/);
});
test('old Analytics links resolve to Reports',()=>{
  for(const location of [{hash:'#analytics'},{hash:'#/analytics'},{pathname:'/technovalens/analytics'},{hash:'#reports'}])assert.equal(initialPage(location),'Reports');
});

test('failed cache restoration still returns saved conversation messages with a recovery notice',async()=>{
  const messages=[{role:'user',text:'saved question'}];
  const api={get:async url=>{if(url.startsWith('/conversations'))return {data:{id:'selected',fileId:'file',messages}};throw Object.assign(new Error('Cannot restore'),{response:{status:503,data:{code:'CACHE_RESTORE_FAILED'}}});}};
  const result=await loadConversation(api,'selected');assert.equal(result.chat.messages,messages);assert.equal(result.document,null);assert.match(result.recoveryMessage,/could not be safely restored/);
});
