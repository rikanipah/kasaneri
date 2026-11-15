import { t } from '../core/i18n';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {copyFile,cp,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {SNAPSHOT_PREFIX} from '../core/snapshot-retention';
import {readSnapshotSchemaVersion} from './snapshot-schema';

const attachmentDirectories=['assets','cache'];
const snapshotEntries=['library.sqlite','library.sqlite-wal','library.sqlite-shm',...attachmentDirectories];
const stagingPrefix='.ir-snapshot-';

async function databaseHash(file:string):Promise<string>{
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}

async function copyDatabase(source:string,target:string):Promise<void>{
  const live=new DatabaseSync(source,{readOnly:true,timeout:5000});
  try{
    // Establish a read snapshot so concurrent edits on the worker connection cannot move its boundary.
    live.exec('BEGIN');
    live.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
    await backup(live,target);
  }finally{live.close();}
  const copy=new DatabaseSync(target);
  try{copy.exec('PRAGMA journal_mode=DELETE');}
  finally{copy.close();}
}

export async function writeSnapshot(libraryDir:string,destination:string):Promise<string>{
  const parent=resolve(destination);
  await mkdir(parent,{recursive:true});
  const staging=await mkdtemp(join(parent,stagingPrefix));
  const library=join(staging,'library'),database=join(library,'library.sqlite');
  try{
    await mkdir(library);
    await copyDatabase(join(libraryDir,'library.sqlite'),database);
    for(const name of attachmentDirectories){
      const from=join(libraryDir,name);
      if(existsSync(from))await cp(from,join(library,name),{recursive:true});
    }
    const now=new Date().toISOString();
    const manifest={app:'kasaneri',snapshotVersion:1,schemaVersion:readSnapshotSchemaVersion(database),
      librarySha256:await databaseHash(database),exportedAt:now};
    await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
    const base=join(parent,SNAPSHOT_PREFIX+now.replace(/[:.]/g,'-'));
    const result=existsSync(base)?base+'-'+basename(staging).slice(stagingPrefix.length):base;
    await rename(staging,result);
    return result;
  }catch(error){
    if(dirname(staging)===parent&&basename(staging).startsWith(stagingPrefix)){
      await rm(staging,{recursive:true,force:true}).catch(()=>{});
    }
    throw error;
  }
}

export async function validateSnapshot(folder:string):Promise<string>{
  const manifestPath=join(folder,'manifest.json');
  if(!existsSync(manifestPath))throw Error(t('没有找到 manifest.json，请选择快照文件夹本身。'));
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(!['kasaneri','leafloop','IncrementalReading'].includes(manifest?.app))throw Error(t('不是本程序的快照。'));
  const library=join(folder,'library'),database=join(library,'library.sqlite');
  if(!existsSync(database))throw Error(t('快照缺少资料库文件。'));
  if(manifest.librarySha256&&await databaseHash(database)!==manifest.librarySha256)
    throw Error(t('快照校验失败（sha256 不匹配）。'));
  readSnapshotSchemaVersion(database);
  return library;
}

export async function restoreSnapshot(folder:string,libraryDir:string,closeLibrary:()=>Promise<void>):Promise<string>{
  const live=resolve(libraryDir),parent=dirname(live);
  const manifest=join(folder,'manifest.json'),source=join(folder,'library');
  if(!existsSync(manifest))throw Error(t('没有找到 manifest.json，请选择快照文件夹本身。'));
  const prefix='.ir-restore-';
  const stage=await mkdtemp(join(parent,prefix)),prepared=join(stage,'library');
  try{
    await mkdir(prepared);
    await copyFile(manifest,join(stage,'manifest.json'));
    for(const entry of snapshotEntries){
      const from=join(source,entry);
      if(existsSync(from))await cp(from,join(prepared,entry),{recursive:true});
    }
    await validateSnapshot(stage);
    await closeLibrary();
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const previous=join(parent,`import-backup-${stamp}-${randomUUID().slice(0,8)}`);
    await rename(live,previous);
    try{await rename(prepared,live);}
    catch(error){
      try{await rename(previous,live);}
      catch(rollbackError){
        throw new Error(t('无法自动恢复原资料库。原资料库保存在 {0}',previous),{cause:new AggregateError([error,rollbackError])});
      }
      throw error;
    }
    return previous;
  }finally{
    if(dirname(stage)===parent&&basename(stage).startsWith(prefix))await rm(stage,{recursive:true,force:true}).catch(()=>{});
  }
}
