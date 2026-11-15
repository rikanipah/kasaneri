import { t } from '../core/i18n';
import type {BrowserWindow,IpcMain} from 'electron';
import type {IPty} from '@homebridge/node-pty-prebuilt-multiarch';
import {randomUUID} from 'node:crypto';
import {existsSync,statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

const shells=new Set(['cmd','powershell','pwsh','bash']);

function terminalModule():typeof import('@homebridge/node-pty-prebuilt-multiarch'){
  try{return createRequire(__filename)('@homebridge/node-pty-prebuilt-multiarch');}
  catch{throw Error(t('未找到终端组件（node-pty），请重新安装程序。'));}
}

function terminalCommand(choice:unknown):string{
  const wanted=typeof choice==='string'?choice.toLowerCase():'';
  const shell=shells.has(wanted)?wanted:'';
  if(process.platform!=='win32'){
    return shell==='bash'||shell==='pwsh'?shell:process.env.SHELL||'bash';
  }
  const systemRoot=process.env.SystemRoot||'C:\\Windows';
  if(shell==='powershell')return join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  if(shell==='pwsh'||shell==='bash')return 'pwsh.exe';
  // ConPTY needs an absolute cmd.exe path when the application starts with a different working directory.
  return process.env.ComSpec||join(systemRoot,'System32','cmd.exe');
}

function dimensions(cols:unknown,rows:unknown){
  return {cols:Math.max(20,Math.min(500,Math.floor(Number(cols)||80))),rows:Math.max(5,Math.min(200,Math.floor(Number(rows)||24)))};
}

export function registerTerminalHost(ipc:IpcMain,mainWindow:()=>BrowserWindow|undefined,dataDirectory:()=>string){
  const terminals=new Map<string,IPty>();
  const stop=(term:IPty)=>{try{term.kill();}catch{}};
  ipc.handle('reading:terminal:new',(event,payload:unknown)=>{
    const owner=mainWindow();
    if(!owner||owner.isDestroyed()||event.sender!==owner.webContents)throw Error(t('无效请求。'));
    const input=(payload||{}) as {cwd?:unknown;cols?:unknown;rows?:unknown;shell?:unknown};
    const size=dimensions(input.cols,input.rows);
    const cwd=typeof input.cwd==='string'&&input.cwd.trim()?input.cwd.trim():dataDirectory();
    if(!existsSync(cwd)||!statSync(cwd).isDirectory())throw Error(t('工作目录不存在：{0}',cwd));
    const args=process.platform==='win32'?[]:['-l'];
    const term=terminalModule().spawn(terminalCommand(input.shell),args,{...size,name:'xterm-256color',cwd,env:{...process.env,TERM:'xterm-256color'}});
    const id=randomUUID();
    terminals.set(id,term);
    term.onData(data=>{if(!owner.isDestroyed())owner.webContents.send('reading:terminal:data',{id,data});});
    term.onExit(()=>{
      terminals.delete(id);
      if(!owner.isDestroyed())owner.webContents.send('reading:terminal:exit',{id});
    });
    return {id,pid:term.pid};
  });
  for(const channel of ['reading:terminal:input','reading:terminal:resize','reading:terminal:kill'] as const){
    ipc.on(channel,(event,payload:unknown)=>{
      const owner=mainWindow();
      if(!owner||owner.isDestroyed()||event.sender!==owner.webContents)return;
      const message=(payload||{}) as {id?:string;data?:unknown;cols?:unknown;rows?:unknown};
      const term=message.id?terminals.get(message.id):undefined;
      if(!term)return;
      if(channel==='reading:terminal:input'){
        if(typeof message.data==='string'&&message.data.length<=8192)term.write(message.data);
      }else if(channel==='reading:terminal:resize'){
        const size=dimensions(message.cols,message.rows);
        try{term.resize(size.cols,size.rows);}catch{}
      }else{terminals.delete(message.id!);stop(term);}
    });
  }
  return ()=>{for(const term of terminals.values())stop(term);terminals.clear();};
}
