import { validateFileMetadata } from './api-contracts.js';

export async function loadConversation(api, id, {signal} = {}) {
  const {data:chat}=await api.get(`/conversations/${encodeURIComponent(id)}`,{signal});
  if(!chat||chat.id!==id||typeof chat.fileId!=='string'||!Array.isArray(chat.messages))throw new Error('The saved conversation returned an inconsistent document mapping. No other chat has been substituted.');
  let document=null,recoveryMessage=chat.recoveryMessage||'';
  if(chat.documentAvailable!==false){
    try{
      const response=await api.get(`/files/${encodeURIComponent(chat.fileId)}`,{signal});
      document=validateFileMetadata(response.data);
      if(document.fileId!==chat.fileId)throw new Error('The selected conversation and file do not match.');
    }catch(error){if(error.response?.status!==404&&error.response?.data?.code!=='CACHE_RESTORE_FAILED')throw error;recoveryMessage='Saved messages are preserved, but their original file is unavailable or could not be safely restored. Restore the original storage backup to continue. Re-uploading starts a new conversation.';}
  }
  return {chat,document,recoveryMessage};
}

export function initialPage(location) {
  const route=(location.hash||location.pathname||'').toLowerCase().replace(/^#\/?/,'').replace(/\/$/,'');
  if(/(?:^|\/)(analytics|reports)$/.test(route))return 'Reports';
  if(/(?:^|\/)(files|excel-files)$/.test(route))return 'My Documents';
  if(/(?:^|\/)(chat|ai-excel-chat)$/.test(route))return 'AI Assistant';
  return 'Dashboard';
}
