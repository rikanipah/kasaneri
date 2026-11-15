import { t } from '../core/i18n';
import type {IpcMain,WebContents} from 'electron';
import {existsSync} from 'node:fs';
import {mkdir,readdir,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {snapshotsToPrune} from '../core/snapshot-retention';

interface BackupConfig{enabled:boolean;folder:string;intervalHours:number;lastAt:number;keepLast:number}
type BackupResult={ok:true;path:string;pruned:number}|{ok:false;error:string};

export const defaultBackupConfig:BackupConfig={enabled:true,folder:'',intervalHours:24,lastAt:0,keepLast:14};

interface BackupOptions {
  dataDir:string;
  isOurWindow(sender:WebContents):boolean;
  call<T=unknown>(action:string,payload?:unknown):Promise<T>;
  chooseFolder():Promise<string|undefined>;
  exportSnapshot(folder:string):Promise<string>;
}

async function pruneBackups(folder:string,keepLast:number):Promise<number>{
  if(!(keepLast>0))return 0;
  const root=resolve(folder);
  let pruned=0;
  try{
    const names=(await readdir(root,{withFileTypes:true}))
      .filter(entry=>entry.isDirectory()&&existsSync(join(root,entry.name,'manifest.json')))
      .map(entry=>entry.name);
    for(const name of snapshotsToPrune(names,keepLast)){
      const target=resolve(root,name);
      if(dirname(target)!==root)continue;
      await rm(target,{recursive:true,force:true});
      pruned++;
    }
  }catch{/* A retention error leaves the finished snapshot available. */}
  return pruned;
}

export function createBackupService(options:BackupOptions){
  const defaultFolder=join(options.dataDir,'backups');
  let config:BackupConfig={...defaultBackupConfig,folder:defaultFolder};
  let status:{at:number;error:string;path:string;pruned?:number}={at:0,error:'',path:''};
  let running:Promise<BackupResult>|null=null;
  let initialTimer:ReturnType<typeof setTimeout>|undefined;
  let intervalTimer:ReturnType<typeof setInterval>|undefined;

  async function loadSettings(){
    try{
      const saved=await options.call<Partial<BackupConfig>|null>('settingGet',{key:'backupSettings'});
      if(saved)config={...config,...saved,folder:saved.folder||defaultFolder};
      await mkdir(config.folder,{recursive:true}).catch(()=>{});
    }catch{/* Keep defaults if settings cannot be read. */}
  }

  async function saveSettings(){
    try{await options.call('settingSet',{key:'backupSettings',value:config});}catch{}
  }

  async function backup():Promise<BackupResult>{
    const {folder,keepLast}=config;
    if(!folder)return {ok:false,error:t('请先选择备份文件夹。')};
    try{
      const path=await options.exportSnapshot(folder);
      const pruned=await pruneBackups(folder,keepLast);
      const at=Date.now();
      status={at,error:'',path,pruned};
      if(config.folder===folder){
        config={...config,lastAt:at};
        await saveSettings();
      }
      return {ok:true,path,pruned};
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      status={...status,error:message};
      return {ok:false,error:message};
    }
  }

  function runBackup(){
    return running??=(backup().finally(()=>{running=null;}));
  }

  function tick(){
    if(!config.enabled||!config.folder)return;
    const interval=Math.max(1,Number(config.intervalHours)||24)*3600*1000;
    if(Date.now()-Number(config.lastAt||0)>=interval)void runBackup();
  }

  function registerIpc(ipc:IpcMain){
    const state=()=>({config,status});
    const authorized=(sender:WebContents)=>{
      if(!options.isOurWindow(sender))throw Error(t('无效请求。'));
    };
    ipc.handle('backup:status',event=>{authorized(event.sender);return state();});
    ipc.handle('backup:configure',async(event,payload:unknown)=>{
      authorized(event.sender);
      const input=(payload||{}) as Partial<BackupConfig>;
      config={enabled:!!input.enabled,folder:String(input.folder||config.folder||''),
        intervalHours:Math.max(1,Math.min(720,Math.floor(Number(input.intervalHours)||24))),
        keepLast:Math.max(0,Math.min(3650,Math.floor(Number(input.keepLast)||0))),lastAt:Number(config.lastAt||0)};
      await saveSettings();
      return state();
    });
    ipc.handle('backup:choose',async event=>{
      authorized(event.sender);
      const folder=await options.chooseFolder();
      if(folder){config={...config,folder};await saveSettings();}
      return state();
    });
    ipc.handle('backup:now',async event=>{
      authorized(event.sender);
      const result=await runBackup();
      return {...state(),result};
    });
  }

  return {loadSettings,registerIpc,
    start(){
      initialTimer=setTimeout(tick,config.lastAt?45000:5000);
      intervalTimer=setInterval(tick,15*60*1000);
    },
    stop(){
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      return running;
    },
  };
}
