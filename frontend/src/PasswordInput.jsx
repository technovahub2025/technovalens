import {useState} from 'react';
import {Eye,EyeOff} from 'lucide-react';

export default function PasswordInput({label,...props}){
  const [visible,setVisible]=useState(false);
  return <div className="auth-password-input">
    <input {...props} type={visible?'text':'password'}/>
    <button type="button" className="auth-password-toggle" aria-label={`${visible?'Hide':'Show'} ${label.toLowerCase()}`} aria-pressed={visible} aria-controls={props.id} onClick={()=>setVisible(value=>!value)}>
      {visible?<EyeOff size={18} aria-hidden="true"/>:<Eye size={18} aria-hidden="true"/>}
    </button>
  </div>;
}
