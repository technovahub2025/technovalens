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
const message=error=>error.response?.data?.code==='HTTPS_REQUIRED'
  ?'Secure sign-in is temporarily unavailable. Ask your administrator to check the HTTPS proxy configuration.'
  :error.response?.data?.error||'Could not connect securely. Please try again.';
const emptyForm={username:'',password:'',confirmPassword:'',recoveryCode:''};
const emptyAccount={username:'',currentPassword:'',newPassword:'',confirmPassword:''};
export default function AuthApp(){
  const channel=useRef(null);
  const announce=()=>channel.current?.postMessage({type:'session-changed'});
  const [user,setUser]=useState(null),[ready,setReady]=useState(false),[mode,setMode]=useState('login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [form,setForm]=useState(emptyForm),[account,setAccount]=useState(emptyAccount),[codes,setCodes]=useState([]),[saved,setSaved]=useState(false),[manage,setManage]=useState(false);
  const refresh=()=>loadSession().then(data=>{setUser(data.user);setReady(true);setError('');}).catch(error=>{setError(message(error));setReady(false);});
  const clearPrivateForms=()=>{setAccount(emptyAccount);setCodes([]);setManage(false);setForm(emptyForm);};
  useEffect(()=>{let current=true;loadSession().then(data=>{if(current){setUser(data.user);setReady(true);}}).catch(error=>{if(current)setError(message(error));});return()=>{current=false;};},[]);
  useEffect(()=>{
    const expired=()=>{setUser(null);setMode('login');clearPrivateForms();setCsrfToken('');setNotice('Your session has ended. Log in to continue.');refresh();};
    window.addEventListener('technovalens-auth-required',expired);return()=>window.removeEventListener('technovalens-auth-required',expired);
  },[]);
  useEffect(()=>{
    if(typeof BroadcastChannel==='undefined')return;
    const current=new BroadcastChannel('technovalens-auth');channel.current=current;
    current.onmessage=()=>{setReady(false);setUser(null);setMode('login');clearPrivateForms();setCsrfToken('');refresh();};
    return()=>{channel.current=null;current.close();};
  },[]);
  async function submit(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      await loadSession();
      const {data}=await api.post(`/auth/${mode==='recover'?'recover':'login'}`,form);
      setForm(previous=>({...previous,password:'',confirmPassword:'',recoveryCode:''}));
      if(mode==='recover'){announce();setMode('login');await refresh();setNotice('Password updated. Log in with your new password.');}
      else{setCsrfToken(data.csrfToken);setUser(data.user);announce();}
    }catch(error){setError(message(error));}finally{setBusy(false);}
  }
  async function logout(){
    setBusy(true);setError('');
    try{
      try{await api.post('/auth/logout');}catch(error){if(error.response?.data?.code!=='CSRF_INVALID')throw error;await loadSession();await api.post('/auth/logout');}
      announce();setUser(null);setMode('login');clearPrivateForms();setCsrfToken('');await refresh();setNotice('You have logged out.');
    }catch(error){setError(message(error));}finally{setBusy(false);}
  }
  async function updateAccount(event){
    event.preventDefault();setBusy(true);setError('');
    try{
      await api.post('/auth/account',account);announce();setUser(null);setManage(false);setAccount(emptyAccount);setCsrfToken('');
      setForm({...emptyForm,username:account.username});setMode('login');await refresh();setNotice('Account security updated. All previous sessions have ended. Log in again.');
    }catch(error){setError(message(error));}finally{setBusy(false);}
  }
  async function rotateCodes(){
    setBusy(true);setError('');
    try{const {data}=await api.post('/auth/recovery-codes',{password:account.currentPassword});setAccount(emptyAccount);setCsrfToken(data.csrfToken);setCodes(data.recoveryCodes);setSaved(false);setManage(false);announce();}
    catch(error){setError(message(error));}finally{setBusy(false);}
  }
  function download(){
    const blob=new Blob([`TECHNOVALENS recovery codes\nAccount: ${user.username}\nEach code works once. Keep these private and offline.\n\n${codes.join('\n')}\n`],{type:'text/plain'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=url;anchor.download='technovalens-recovery-codes.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const field=(name,label,type='text',autoComplete)=> <label className="auth-field" key={name}>{label}<input name={name} type={type} value={form[name]} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false} required maxLength={name==='username'?32:name==='recoveryCode'?39:128} minLength={name==='username'?3:name==='password'&&mode==='recover'?15:undefined} onChange={event=>setForm({...form,[name]:event.target.value})}/></label>;
  const accountField=(name,label,type='password',autoComplete='new-password',required=false)=> <label className="auth-field" key={name}>{label}<input name={name} type={type} value={account[name]} autoComplete={autoComplete} required={required} maxLength={name==='username'?32:128} minLength={name==='username'?3:name==='newPassword'?15:undefined} onChange={event=>setAccount({...account,[name]:event.target.value})}/></label>;
  const meetsRules=account.newPassword.length>=15&&/[a-z]/.test(account.newPassword)&&/[A-Z]/.test(account.newPassword)&&/[0-9]/.test(account.newPassword)&&!account.newPassword.toLowerCase().includes(account.username.toLowerCase())&&!/^(?:password|letmein|qwerty|welcome|admin|technovalens)[\W\d_]*$/i.test(account.newPassword);
  if(user&&!codes.length&&!manage)return <>{error&&<div className="auth-session-notice" role="alert">{error}</div>}<App key={user.id} authUser={user} onLogout={logout} onManageRecovery={()=>{setError('');setAccount({...emptyAccount,username:user.username});setManage(true);}}/></>;
  return <main className="auth-page">
    <aside className="auth-story"><div className="auth-brand"><Sparkles/> TECHNOVALENS</div><div><span className="auth-eyebrow">YOUR PRIVATE DATA WORKSPACE</span><h1>Clear answers.<br/>Confident decisions.</h1><p>Bring your spreadsheets and PDFs together in one workspace, with insights and conversations that stay with your account.</p><div className="auth-trust"><ShieldCheck/> Secure access to your documents and conversations</div></div><small>Document intelligence, thoughtfully organized.</small></aside>
    <section className="auth-form-side"><div className="auth-mobile-brand"><Sparkles/> TECHNOVALENS</div><div className="auth-card">
      <div className="auth-lock"><LockKeyhole size={25}/></div>
      {codes.length?<>
        <span className="auth-eyebrow">ACCOUNT RECOVERY</span><h2>Save your recovery codes</h2><p>These codes are shown once. Each code can reset your password without email. Keep them private and offline.</p>
        <div className="auth-recovery-codes">{codes.map(code=><code key={code}>{code}</code>)}</div><button className="auth-secondary" onClick={download}><Download size={16}/> Download codes</button>
        <label className="auth-checkbox"><input type="checkbox" checked={saved} onChange={event=>setSaved(event.target.checked)}/> I saved these codes somewhere private.</label><button className="auth-primary" disabled={!saved} onClick={()=>setCodes([])}>Continue to workspace <ArrowRight size={17}/></button>
      </>:manage?<>
        <span className="auth-eyebrow">SETTINGS</span><h2>Account Security</h2><p>Change your username or password. Your current password is required. Saving changes logs out all sessions and keeps your documents with your account.</p>
        {error&&<div className="auth-error" role="alert">{error}</div>}
        <form onSubmit={updateAccount}>
          {accountField('username','Username','text','username',true)}{accountField('currentPassword','Current password','password','current-password',true)}
          {accountField('newPassword','New password (optional)')}{accountField('confirmPassword','Confirm new password','password','new-password',Boolean(account.newPassword))}
          <small className="auth-password-hint">15–128 characters, including uppercase and lowercase letters and a number. Avoid your username.</small>
          {account.newPassword&&<p className="auth-strength" role="status">{meetsRules?'Password requirements met.':'Choose a stronger password that meets all requirements.'}</p>}
          <button className="auth-primary" disabled={busy||Boolean(account.newPassword&&!meetsRules)}>Save changes</button>
          <button type="button" className="auth-secondary auth-code-button" disabled={busy||!account.currentPassword} onClick={rotateCodes}>Replace recovery codes</button>
          <small className="auth-password-hint">Replacing recovery codes requires your current password and invalidates previous codes.</small>
          <button type="button" className="auth-link" onClick={()=>{setManage(false);setAccount(emptyAccount);setError('');}}>Back to workspace</button>
        </form>
      </>:<>
        <span className="auth-eyebrow">TECHNOVALENS</span><h2>{mode==='recover'?'Recover admin access':'Admin Login'}</h2><p>{mode==='recover'?'Use a saved recovery code to choose a new password.':'Log in to your documents, insights and conversations.'}</p>
        {notice&&<div className="auth-notice" role="status">{notice}</div>}{error&&<div className="auth-error" role="alert">{error}</div>}
        <form onSubmit={submit}>{field('username','Username','text','username')}{mode==='recover'&&field('recoveryCode','One-time recovery code','text','off')}{field('password',mode==='recover'?'New password':'Password','password',mode==='login'?'current-password':'new-password')}{mode==='recover'&&<><small className="auth-password-hint">15–128 characters, including uppercase and lowercase letters and a number. Avoid your username.</small>{field('confirmPassword','Confirm password','password','new-password')}</>}
          <button className="auth-primary" disabled={busy||!ready}>{busy?'Please wait…':mode==='recover'?'Reset password':'Login'}<ArrowRight size={17}/></button>
        </form>
        {!ready&&<div className="auth-connection" role="status">{error?<button className="auth-link" onClick={refresh}>Retry secure connection</button>:'Connecting securely…'}</div>}
        <div className="auth-switch"><button className="auth-link" onClick={()=>{setMode(mode==='login'?'recover':'login');setForm(emptyForm);setError('');setNotice('');}}>{mode==='login'?'Recover access with a code':'Back to Admin Login'}</button></div>
        {mode==='recover'&&<p className="auth-help">A username alone cannot reset a password. Contact your deployment administrator if you have no recovery code.</p>}
      </>}
    </div>{user&&<button className="auth-link" disabled={busy} onClick={logout}><LogOut size={15}/> Log out</button>}</section>
  </main>;
}
