import {useEffect,useRef,useState} from 'react';
import {Sparkles,LogOut} from 'lucide-react';
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
const emptyForm={username:'',password:'',confirmPassword:''};
const emptyAccount={username:'',currentPassword:'',newPassword:'',confirmPassword:''};
export default function AuthApp(){
  const channel=useRef(null);
  const announce=()=>channel.current?.postMessage({type:'session-changed'});
  const [user,setUser]=useState(null),[ready,setReady]=useState(false),[mode,setMode]=useState('login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [form,setForm]=useState(emptyForm),[account,setAccount]=useState(emptyAccount),[manage,setManage]=useState(false);
  const refresh=()=>loadSession().then(data=>{setUser(data.user);setReady(true);setError('');}).catch(error=>{setError(message(error));setReady(false);});
  const clearPrivateForms=()=>{setAccount(emptyAccount);setManage(false);setForm(emptyForm);};
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
      const {data}=await api.post(`/auth/${mode==='signup'?'signup':'login'}`,form);
      setForm(emptyForm);setCsrfToken(data.csrfToken);setUser(data.user);announce();
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
  const field=(name,label,type='text',autoComplete)=> <label className="auth-field" key={name}>{label}<input name={name} type={type} value={form[name]} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false} required maxLength={name==='username'?32:128} minLength={name==='username'?3:undefined} onChange={event=>setForm({...form,[name]:event.target.value})}/></label>;
  const accountField=(name,label,type='password',autoComplete='new-password',required=false)=> <label className="auth-field" key={name}>{label}<input name={name} type={type} value={account[name]} autoComplete={autoComplete} required={required} maxLength={name==='username'?32:128} minLength={name==='username'?3:undefined} onChange={event=>setAccount({...account,[name]:event.target.value})}/></label>;
  if(user&&!manage)return <>{error&&<div className="auth-session-notice" role="alert">{error}</div>}<App key={user.id} authUser={user} onLogout={logout} onManageRecovery={()=>{setError('');setAccount({...emptyAccount,username:user.username});setManage(true);}}/></>;
  return <main className="auth-page">
    <section className="auth-form-side" aria-label={manage?'Account Security':mode==='signup'?'Sign Up':'Login'}><div className="auth-card">
      <div className="auth-brand"><Sparkles aria-hidden="true"/> TECHNOVALENS</div>
      {manage?<>
        <span className="auth-eyebrow">SETTINGS</span><h2>Account Security</h2><p>Change your username or password. Your current password is required. Saving changes logs out all sessions and keeps your documents with your account.</p>
        {error&&<div className="auth-error" role="alert">{error}</div>}
        <form onSubmit={updateAccount}>
          {accountField('username','Username','text','username',true)}{accountField('currentPassword','Current password','password','current-password',true)}
          {accountField('newPassword','New password (optional)')}{accountField('confirmPassword','Confirm new password','password','new-password',Boolean(account.newPassword))}
          <button className="auth-primary" disabled={busy}>Save changes</button>
          <button type="button" className="auth-link" onClick={()=>{setManage(false);setAccount(emptyAccount);setError('');}}>Back to workspace</button>
        </form>
      </>:<>
        <h2>{mode==='signup'?'Create Account':'Welcome Back'}</h2>{mode==='login'&&<p className="auth-subtitle">Sign in to your account</p>}
        {notice&&<div className="auth-notice" role="status">{notice}</div>}{error&&<div className="auth-error" role="alert">{error}</div>}
        <form onSubmit={submit}>{field('username','Username','text','username')}{field('password','Password','password',mode==='login'?'current-password':'new-password')}{mode==='signup'&&field('confirmPassword','Confirm Password','password','new-password')}
          <button className="auth-primary" disabled={busy||!ready}>{busy?'Please wait…':mode==='signup'?'Create Account':'Login'}</button>
        </form>
        {!ready&&<div className="auth-connection" role="status">{error?<button className="auth-link" onClick={refresh}>Retry secure connection</button>:'Connecting securely…'}</div>}
        <div className="auth-switch">{mode==='login'?"Don't have an account? ":'Already have an account? '}<button className="auth-link" disabled={busy} onClick={()=>{setMode(mode==='login'?'signup':'login');setForm(emptyForm);setError('');setNotice('');}}>{mode==='login'?'Sign Up':'Login'}</button></div>
      </>}
    </div>{user&&<button className="auth-link" disabled={busy} onClick={logout}><LogOut size={15}/> Log out</button>}</section>
  </main>;
}
