import { BrowserWindow, dialog } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readSnapshotSchemaVersion } from './snapshot-schema';
import { getLocale, t } from '../core/i18n';

type InitialOptions={backup:boolean;sync:boolean};
export type StartupConfiguration={dataDir:string;initialOptions?:InitialOptions};

export function existingLibrary(directory:string):string|undefined{
  return [join(directory,'library','library.sqlite'),join(directory,'library.sqlite')].find(existsSync);
}

export function readStartupConfiguration(path:string):StartupConfiguration|null{
  if(!existsSync(path))return null;
  const value=JSON.parse(readFileSync(path,'utf8')) as StartupConfiguration;
  if(typeof value?.dataDir!=='string'||!isAbsolute(value.dataDir))throw Error(t('启动配置中的资料库位置无效。'));
  return value;
}

export function saveStartupConfiguration(path:string,configuration:StartupConfiguration):void{
  mkdirSync(dirname(path),{recursive:true});
  const temporary=path+'.tmp';
  writeFileSync(temporary,JSON.stringify(configuration,null,2),'utf8');
  renameSync(temporary,path);
}

function validateDirectory(path:unknown):{dataDir:string;existing:boolean}{
  if(typeof path!=='string'||!isAbsolute(path.trim()))throw Error(t('请输入完整的资料库文件夹路径。'));
  const dataDir=resolve(path.trim());
  if(existsSync(dataDir)){
    if(!statSync(dataDir).isDirectory())throw Error(t('所选位置是文件，请选择文件夹。'));
    const database=existingLibrary(dataDir);
    if(database){
      readSnapshotSchemaVersion(database);
      return {dataDir,existing:true};
    }
    if(readdirSync(dataDir).length)throw Error(t('请选择空文件夹，或选择已有的 Kasaneri 资料库。'));
  }
  mkdirSync(dataDir,{recursive:true});
  return {dataDir,existing:false};
}

export async function showOnboarding(defaultDataDir:string):Promise<StartupConfiguration|null>{
  const window=new BrowserWindow({
    title:t('设置资料库'),width:630,height:465,minWidth:540,minHeight:410,show:false,backgroundColor:'#1e1e1e',
    webPreferences:{preload:join(__dirname,'onboarding-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true},
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.ipc.handle('onboarding:default',()=>defaultDataDir);
  window.webContents.ipc.handle('onboarding:choose',async()=>{
    const selected=await dialog.showOpenDialog(window,{title:t('选择资料库文件夹'),properties:['openDirectory','createDirectory']});
    return selected.filePaths[0]||'';
  });
  return new Promise((done,fail)=>{
    let selected:StartupConfiguration|null=null;
    window.webContents.ipc.handle('onboarding:submit',(_event,input:unknown)=>{
      const values=input as {path?:unknown;backup?:unknown;sync?:unknown}|null;
      const {dataDir,existing}=validateDirectory(values?.path);
      selected=existing?{dataDir}:{dataDir,initialOptions:{backup:values?.backup===true,sync:values?.sync===true}};
      window.close();
    });
    window.webContents.ipc.handle('onboarding:cancel',()=>window.close());
    window.once('closed',()=>done(selected));
    window.once('ready-to-show',()=>window.show());
    void window.loadFile(join(__dirname,'onboarding.html'),{query:{locale:getLocale()}}).catch(error=>{
      fail(error);
      if(!window.isDestroyed())window.destroy();
    });
  });
}
