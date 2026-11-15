import { ipcRenderer } from 'electron';
import { localizeMarkup } from '../ui/localize-markup';

window.addEventListener('DOMContentLoaded',()=>{
  localizeMarkup();
  const form=document.querySelector<HTMLFormElement>('form')!;
  const path=document.querySelector<HTMLInputElement>('#library-path')!;
  const backup=document.querySelector<HTMLInputElement>('#backup')!;
  const sync=document.querySelector<HTMLInputElement>('#sync')!;
  const error=document.querySelector<HTMLElement>('#error')!;
  const showError=(reason:unknown)=>{
    const message=reason instanceof Error?reason.message:String(reason);
    error.textContent=message.replace(/^Error invoking remote method .*?: Error: /u,'');
  };
  void ipcRenderer.invoke('onboarding:default').then(value=>{if(!path.value)path.value=value;}).catch(showError);
  document.querySelector<HTMLButtonElement>('#choose')!.onclick=async()=>{
    try{
      const chosen=await ipcRenderer.invoke('onboarding:choose');
      if(chosen)path.value=chosen;
    }catch(reason){showError(reason);}
  };
  document.querySelector<HTMLButtonElement>('#cancel')!.onclick=()=>void ipcRenderer.invoke('onboarding:cancel').catch(showError);
  form.onsubmit=async event=>{
    event.preventDefault();
    const submit=document.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.disabled=true;
    error.textContent='';
    try{await ipcRenderer.invoke('onboarding:submit',{path:path.value,backup:backup.checked,sync:sync.checked});}
    catch(reason){showError(reason);submit.disabled=false;}
  };
});
