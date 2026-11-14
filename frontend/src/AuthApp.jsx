import {useEffect,useRef,useState} from 'react';
import {LockKeyhole,ShieldCheck,Sparkles,ArrowRight,Download,LogOut} from 'lucide-react';
import App from './App.jsx';
import {api,setCsrfToken} from './api.js';
import './auth.css';

let bootstrap;
function loadSession(){
  if(!bootstrap)bootstrap=api.get('/auth/session').then(({data})=>{setCsrfToken(data.csrfToken);return data;}).finally(()=>{bootstrap=null;});
  return bootstrap;
}
const message=error=>error.response?.data?.error||'Could not connect securely. Please try again.';
export default function AuthApp(){
  const channel=useRef(null);
  const announce=()=>channel.current?.postMessage({type:'session-changed'});
  const [user,setUser]=useState(null),[ready,setReady]=useState(false),[mode,setMode]=useState('login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [form,setForm]=useState({username:'',password:'',confirmPassword:'',recoveryCode:''}),[codes,setCodes]=useState([]),[saved,setSaved]=useState(false),[manage,setManage]=useState(false),[verifyPassword,setVerifyPassword]=useState('');
  const refresh=()=>loadSession().then(data=>{setUser(data.user);setReady(true);setError('');}).catch(error=>{setError(message(error));setReady(false);});
  useEffect(()=>{let current=true;loadSession().then(data=>{if(current){setUser(data.user);setReady(true);}}).catch(error=>{if(current)setError(message(error));});return()=>{current=false;};},[]);
  useEffect(()=>{const expired=()=>{setUser(null);setMode('login');setCodes([]);setManage(false);setCsrfToken('');setNotice('Your session has ended. Sign in to continue.');refresh();};window.addEventListener('technovalens-auth-required',expired);return()=>window.removeEventListener('technovalens-auth-required',expired);},[]);
  useEffect(()=>{if(typeof BroadcastChannel==='undefined')return;const current=new BroadcastChannel('technovalens-auth');channel.current=current;current.onmessage=()=>{setReady(false);setUser(null);setMode('login');setCodes([]);setManage(false);setCsrfToken('');refresh();};return()=>{channel.current=null;current.close();};},[]);
  async function submit(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const {data}=await api.post(`/auth/${mode==='recover'?'recover':mode}`,form);
      setForm(previous=>({...previous,password:'',confirmPassword:'',recoveryCode:''}));
      if(mode==='recover'){announce();setMode('login');await refresh();setNotice('Password updated. Previous sessions are signed out. Sign in with your new password.');}
      else{setCsrfToken(data.csrfToken);setUser(data.user);setCodes(data.recoveryCodes||[]);setSaved(false);announce();}
    }catch(error){setError(message(error));}finally{setBusy(false);}
  }
  async function logout(){setBusy(true);setError('');try{try{await api.post('/auth/logout');}catch(error){if(error.response?.data?.code!=='CSRF_INVALID')throw error;await loadSession();await api.post('/auth/logout');}announce();setUser(null);setMode('login');setForm({username:'',password:'',confirmPassword:'',recoveryCode:''});setManage(false);setCodes([]);setCsrfToken('');await refresh();setNotice('You have signed out.');}catch(error){setError(message(error));}finally{setBusy(false);}}
  async function rotateCodes(event){event.preventDefault();setBusy(true);setError('');try{const {data}=await api.post('/auth/recovery-codes',{password:verifyPassword});setVerifyPassword('');setCsrfToken(data.csrfToken);setCodes(data.recoveryCodes);setSaved(false);setManage(false);announce();}catch(error){setError(message(error));}finally{setBusy(false);}}
  function download(){const blob=new Blob([`TECHNOVALENS recovery codes\nAccount: ${user.username}\nEach code works once. Keep these private and offline.\n\n${codes.join('\n')}\n`],{type:'text/plain'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='technovalens-recovery-codes.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const field=(name,label,type='text',autocomplete)=> <label className="auth-field" key={name}>{label}<input name={name} type={type} value={form[name]} autoComplete={autocomplete} autoCapitalize="none" spellCheck={false} required maxLength={name==='username'?32:name==='recoveryCode'?39:128} minLength={name==='username'?3:name==='password'&&mode!=='login'?15:undefined} onChange={event=>setForm({...form,[name]:event.target.value})}/></label>;
  if(user&&!codes.length&&!manage)return <>{error&&<div className="auth-session-notice" role="alert">{error}</div>}<App key={user.id} authUser={user} onLogout={logout} onManageRecovery={()=>{setError('');setManage(true);}}/></>;
  return <main className="auth-page">
    <aside className="auth-story"><div className="auth-brand"><Sparkles/> TECHNOVALENS</div><div><span className="auth-eyebrow">YOUR PRIVATE DATA WORKSPACE</span><h1>Clear answers.<br/>Confident decisions.</h1><p>Bring your spreadsheets and PDFs together in one workspace, with insights and conversations that stay with your account.</p><div className="auth-trust"><ShieldCheck/> Account-based access for your documents and conversations</div></div><small>Document intelligence, thoughtfully organized.</small></aside>
    <section className="auth-form-side"><div className="auth-mobile-brand"><Sparkles/> TECHNOVALENS</div><div className="auth-card">
      <div className="auth-lock"><LockKeyhole size={25}/></div>
      {!ready?<><h2>Connect to your workspace</h2><p>{error||'Checking your secure session…'}</p><button className="auth-primary" onClick={refresh}>Try again</button></>:codes.length?<>
        <span className="auth-eyebrow">ACCOUNT RECOVERY</span><h2>Save your recovery codes</h2><p>These codes are shown once. Each code can reset your password without email. Keep them private and offline.</p>
        <div className="auth-recovery-codes">{codes.map(code=><code key={code}>{code}</code>)}</div><button className="auth-secondary" onClick={download}><Download size={16}/> Download codes</button>
        <label className="auth-checkbox"><input type="checkbox" checked={saved} onChange={event=>setSaved(event.target.checked)}/> I saved these codes somewhere private.</label><button className="auth-primary" disabled={!saved} onClick={()=>setCodes([])}>Continue to workspace <ArrowRight size={17}/></button>
      </>:manage?<><h2>Replace recovery codes</h2><p>Your current password is required. Generating new codes immediately invalidates all previous recovery codes.</p><form onSubmit={rotateCodes}><label className="auth-field">Current password<input type="password" autoComplete="current-password" maxLength={128} required value={verifyPassword} onChange={event=>setVerifyPassword(event.target.value)}/></label>{error&&<div className="auth-error" role="alert">{error}</div>}<button className="auth-primary" disabled={busy}>Generate new codes</button><button type="button" className="auth-link" onClick={()=>{setManage(false);setVerifyPassword('');setError('');}}>Back to workspace</button></form></>:<>
        <span className="auth-eyebrow">WELCOME TO TECHNOVALENS</span><h2>{mode==='signup'?'Create your account':mode==='recover'?'Recover your account':'Welcome back'}</h2><p>{mode==='signup'?'A private space for your documents and insights. No email required.':mode==='recover'?'Use one of your saved recovery codes to choose a new password.':'Sign in to your documents, insights and conversations.'}</p>
        {notice&&<div className="auth-notice" role="status">{notice}</div>}{error&&<div className="auth-error" role="alert">{error}</div>}
        <form onSubmit={submit}>{field('username','Username','text','username')}{mode==='recover'&&field('recoveryCode','One-time recovery code','text','off')}{field('password',mode==='recover'?'New password':'Password','password',mode==='login'?'current-password':'new-password')}{mode!=='login'&&<><small className="auth-password-hint">15–128 characters, including uppercase and lowercase letters and a number. Avoid your username.</small>{field('confirmPassword','Confirm password','password','new-password')}</>}
          <button className="auth-primary" disabled={busy}>{busy?'Please wait…':mode==='signup'?'Create account':mode==='recover'?'Reset password':'Sign in'}<ArrowRight size={17}/></button>
        </form>
        <div className="auth-switch">{mode==='login'?<>New here? <button className="auth-link" onClick={()=>{setMode('signup');setError('');setNotice('');}}>Create an account</button><button className="auth-link auth-recover-link" onClick={()=>{setMode('recover');setError('');setNotice('');}}>Forgot your password?</button></>:<button className="auth-link" onClick={()=>{setMode('login');setError('');setNotice('');}}>Back to sign in</button>}</div>
        {mode==='recover'&&<p className="auth-help">No recovery code? Passwords cannot be reset using a username alone. Existing documents stay private; contact your deployment administrator for help.</p>}
      </>}
    </div>{user&&<button className="auth-link" disabled={busy} onClick={logout}><LogOut size={15}/> Sign out</button>}</section>
  </main>;
}
