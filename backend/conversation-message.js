export const isRequestId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function existingMessage(conversation,input){
  if(input.role!=='user'||!isRequestId(input.clientRequestId))return null;
  const message=conversation.messages.find(message=>message.id===input.clientRequestId);
  if(message&&(message.role!==input.role||message.text!==input.text))throw Object.assign(new Error('This request ID was already used for another message.'),{status:409});
  return message||null;
}
