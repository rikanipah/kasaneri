import {existsSync,mkdirSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';

export function defaultDataDirectory(appDirectory:string):string{
  if(process.platform==='linux'){
    const share=process.env.XDG_DATA_HOME||join(homedir(),'.local','share');
    for(const name of ['kasaneri','leafloop','incremental-reading']){
      const data=join(share,name);
      if(existsSync(join(data,'library','library.sqlite'))||existsSync(join(data,'library.sqlite')))return data;
    }
    return join(share,'kasaneri');
  }
  return join(appDirectory,'data');
}

export function migrateStateFiles(dataDir:string,stateDir:string):void{
  dataDir=resolve(dataDir);stateDir=resolve(stateDir);
  try{mkdirSync(stateDir,{recursive:true});}catch{return;}
  for(const name of ['window-profile','sync-device-id']){
    const source=join(dataDir,name),target=join(stateDir,name);
    if(!existsSync(target)&&existsSync(source)){
      try{renameSync(source,target);}catch{/* The existing state can still be opened on the next start. */}
    }
  }
}

export function migrateLibraryFolder(dataDir:string,libraryDir:string):void{
  dataDir=resolve(dataDir);libraryDir=resolve(libraryDir);
  if(existsSync(join(libraryDir,'library.sqlite')))return;
  mkdirSync(libraryDir,{recursive:true});
  for(const name of ['library.sqlite','library.sqlite-wal','library.sqlite-shm','assets','cache']){
    const source=join(dataDir,name);
    if(existsSync(source)){
      try{renameSync(source,join(libraryDir,name));}catch{/* Preserve the original on a failed move. */}
    }
  }
}
