import {useEffect,useState} from 'react';
import {api} from './api.js';
import {browserTimeZone,localGreeting,validateDashboard} from './dashboard.js';

export function useLocalGreeting(){
  const [greeting,setGreeting]=useState(()=>localGreeting());
  useEffect(()=>{
    let timer;
    const tick=()=>{setGreeting(localGreeting());clearTimeout(timer);timer=setTimeout(tick,60000-Date.now()%60000+10);};
    tick();window.addEventListener('focus',tick);document.addEventListener('visibilitychange',tick);
    return()=>{clearTimeout(timer);window.removeEventListener('focus',tick);document.removeEventListener('visibilitychange',tick);};
  },[]);
  return greeting;
}
export function useDashboard(days,revision,enabled){
  const [state,setState]=useState({status:'loading',data:null,error:''});
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    if(!enabled)return;
    let current=true;const controller=new AbortController();
    setState({status:'loading',data:null,error:''});
    api.get('/dashboard',{params:{days,timeZone:browserTimeZone()},signal:controller.signal}).then(({data})=>{
      if(current)setState({status:'success',data:validateDashboard(data),error:''});
    }).catch(error=>{if(current&&!controller.signal.aborted)setState({status:'error',data:null,error:error.response?.data?.error||error.message||'Dashboard data could not be loaded.'});});
    return()=>{current=false;controller.abort();};
  },[days,revision,enabled,reload]);
  useEffect(()=>{
    let day=new Date().toDateString(),zone=browserTimeZone();
    const refresh=()=>setReload(value=>value+1);
    const timer=setInterval(()=>{const next=new Date().toDateString(),nextZone=browserTimeZone();if(day!==next||zone!==nextZone){day=next;zone=nextZone;refresh();}},30000);
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);
    return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);};
  },[]);
  return {...state,retry:()=>setReload(value=>value+1)};
}
