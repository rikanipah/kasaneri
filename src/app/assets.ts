import { t } from '../core/i18n';
import {createReadStream,existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import type {Asset} from '../core/model';

type RequestDatabase=<T>(action:string,payload:unknown)=>Promise<T>;
export type IncomingAttachment={path?:string;name:string;bytes?:Uint8Array};

export async function importAttachments(dataDir:string,files:IncomingAttachment[],call:RequestDatabase):Promise<Asset[]>{
  const imported:Asset[]=[];
  for(const file of files){
    if(file.path){imported.push(await call<Asset>('importAsset',{path:file.path}));continue;}
    if(!file.bytes||file.bytes.byteLength>200*1024*1024)throw Error(t('附件过大。'));
    const incoming=resolve(dataDir,'.incoming');
    await mkdir(incoming,{recursive:true});
    const temporary=await mkdtemp(join(incoming,'asset-'));
    const path=join(temporary,basename(file.name)||'attachment');
    try{
      await writeFile(path,file.bytes);
      imported.push(await call<Asset>('importAsset',{path}));
    }finally{
      if(dirname(temporary)===incoming)await rm(temporary,{recursive:true,force:true});
    }
  }
  return imported;
}

export function assetHandler(libraryDir:string,call:RequestDatabase){
  return async(request:Request):Promise<Response>=>{
    try{
      const url=new URL(request.url),id=url.pathname.slice(1);
      if(!/^[a-f0-9]{64}$/.test(id))return new Response('Invalid attachment',{status:404});
      const asset=await call<Asset|undefined>('asset',{id});
      if(!asset)return new Response('Attachment missing',{status:404});
      let file=join(libraryDir,'assets',asset.relativePath),mime=asset.mime;
      if(url.searchParams.has('preview')&&asset.mime.startsWith('image/')){
        try{
          const preview=await call<{relativePath:string;mime:string}>('preview',{id,bound:Number(url.searchParams.get('preview'))});
          // Preview paths are relative to the library, and a missing preview falls back to the original.
          const candidate=join(libraryDir,preview.relativePath);
          if(existsSync(candidate)){file=candidate;mime=preview.mime;}
        }catch{}
      }
      const size=(await stat(file)).size;
      const headers:Record<string,string>={'Content-Type':mime,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=86400'};
      const range=request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
      let start=0,end=size-1,status=200;
      if(range&&size){
        if(!range[1]){start=Math.max(0,size-Number(range[2]));}
        else{start=Number(range[1]);end=range[2]?Math.min(end,Number(range[2])):end;}
        if(start>end||start>=size)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
        status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
      }
      headers['Content-Length']=String(size?end-start+1:0);
      const body=size?Readable.toWeb(createReadStream(file,{start,end})) as ReadableStream<Uint8Array>:null;
      return new Response(body,{status,headers});
    }catch{return new Response('Attachment unavailable',{status:404});}
  };
}
