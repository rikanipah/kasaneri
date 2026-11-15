import { t } from '../core/i18n';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Asset } from '../core/model';
import type { Repository } from '../data/database';
import { isVersionId } from './content-versions';

export const CONTENT_ASSET_PATH='/sync/content/asset';
const chunkSize=256*1024;
const mimePattern=/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;

type AssetChunk=Pick<Asset,'filename'|'mime'|'size'>&{offset:number;data:string};
type Transfer={metadata:Omit<AssetChunk,'offset'|'data'>;path:string;offset:number;hash:Hash};

function safeRelativePath(id:string,path:string):boolean{
  return path===id||(path.startsWith(id)&&/^\.[a-z0-9.]{1,11}$/u.test(path.slice(id.length)));
}

export function localContentAsset(repository:Repository,id:string):{asset:Asset;path:string}|null{
  if(!isVersionId(id))return null;
  const asset=repository.getAsset(id);
  if(!asset||!safeRelativePath(id,asset.relativePath))return null;
  const path=join(repository.dataDir,'assets',asset.relativePath);
  try{
    const file=lstatSync(path,{throwIfNoEntry:false});
    return file?.isFile()&&file.size===asset.size?{asset,path}:null;
  }catch{return null;}
}

export class ContentAssets {
  private transfers=new Map<string,Transfer>();
  constructor(private repository:Repository){}

  read(id:string,offset:number):AssetChunk|null{
    const local=localContentAsset(this.repository,id);
    if(!local)return null;
    const {asset:{filename,mime,size},path}=local;
    if(!Number.isSafeInteger(offset)||offset<0||offset>size)throw Error(t('附件读取位置无效。'));
    const buffer=Buffer.alloc(Math.min(chunkSize,size-offset));
    const file=openSync(path,'r');
    try{
      let length=0;
      while(length<buffer.length){
        const read=readSync(file,buffer,length,buffer.length-length,offset+length);
        if(!read)return null;
        length+=read;
      }
    }finally{closeSync(file);}
    return {filename,mime,size,offset,data:buffer.toString('base64')};
  }

  receive(id:string,chunk:AssetChunk):{nextOffset:number;done:boolean}{
    if(!isVersionId(id)||!chunk||typeof chunk.filename!=='string'||!chunk.filename||
        /[\x00-\x1f\x7f/\\]/u.test(chunk.filename)||chunk.filename.length>255||
        typeof chunk.mime!=='string'||chunk.mime.length>127||!mimePattern.test(chunk.mime)||
        !Number.isSafeInteger(chunk.size)||chunk.size<0||!Number.isSafeInteger(chunk.offset)||
        chunk.offset<0||chunk.offset>chunk.size||typeof chunk.data!=='string'||
        chunk.data.length>Math.ceil(chunkSize/3)*4){
      throw Error(t('收到无效的附件分片。'));
    }
    const {filename,mime,size,offset,data}=chunk;
    const bytes=Buffer.from(data,'base64');
    if(bytes.length!==Math.min(chunkSize,size-offset)||bytes.toString('base64')!==data||
        (!bytes.length&&size!==0))throw Error(t('附件分片长度或编码不符。'));
    const directory=join(this.repository.dataDir,'assets');
    let transfer=this.transfers.get(id);
    if(!transfer){
      if(offset!==0)throw Error(t('附件分片应从开头接收。'));
      mkdirSync(directory,{recursive:true});
      const path=join(directory,'.sync-'+randomUUID()+'.partial');
      writeFileSync(path,'',{flag:'wx'});
      transfer={metadata:{filename,mime,size},path,offset:0,hash:createHash('sha256')};
      this.transfers.set(id,transfer);
    }
    if(transfer.offset!==offset||transfer.metadata.size!==size||
        transfer.metadata.filename!==filename||transfer.metadata.mime!==mime){
      throw Error(t('附件分片位置或信息发生变化。'));
    }
    appendFileSync(transfer.path,bytes);
    transfer.hash.update(bytes);
    const nextOffset=transfer.offset+=bytes.length;
    if(nextOffset<size)return {nextOffset,done:false};
    if(transfer.hash.digest('hex')!==id){this.abort(id);throw Error(t('附件 SHA-256 校验失败。'));}
    const existing=this.repository.getAsset(id);
    const extension=extname(filename).toLowerCase().replace(/[^a-z0-9.]/gu,'').slice(0,12);
    const relativePath=existing&&safeRelativePath(id,existing.relativePath)?existing.relativePath:id+extension;
    renameSync(transfer.path,join(directory,relativePath));
    this.transfers.delete(id);
    this.repository.query(`INSERT INTO assets(id,filename,mime,size,relative_path) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET mime=excluded.mime,size=excluded.size,relative_path=excluded.relative_path`)
      .run(id,filename,mime,size,relativePath);
    return {nextOffset,done:true};
  }

  abort(id:string):void{
    const transfer=this.transfers.get(id);
    if(!transfer)return;
    this.transfers.delete(id);
    rmSync(transfer.path,{force:true});
  }

  close():void{
    for(const id of this.transfers.keys())this.abort(id);
  }
}
