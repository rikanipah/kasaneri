import { t } from '../core/i18n';
import type sharp from 'sharp';
import {mkdir,rename,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {Repository} from './database';
let engine:Promise<typeof sharp>|null=null;
function imageEngine():Promise<typeof sharp>{
  if(!engine)engine=import('sharp').then(module=>{const processor=module.default;
    processor.cache({memory:8,files:0,items:16});processor.concurrency(1);return processor;});
  return engine;
}
const jobs=new Map<string,Promise<{relativePath:string;mime:string}>>();
let sequence=Promise.resolve();

export function imagePreview(repository:Repository,id:string,bound=1600):Promise<{relativePath:string;mime:string}> {
  const size=bound===3200?3200:1600,key=id+':'+size;
  const existing=jobs.get(key);if(existing)return existing;
  const job=sequence.then(async()=>{
    const asset=repository.getAsset(id);if(!asset)throw Error(t('附件不存在。'));
    const original={relativePath:join('assets',asset.relativePath),mime:asset.mime};
    if(!/^image\/(png|jpeg|webp|avif|bmp)$/.test(asset.mime))return original;
    const relativePath=join('cache','images',id+'-'+size+'-v1.webp'),target=join(repository.dataDir,relativePath);
    try{await stat(target);return {relativePath,mime:'image/webp'};}catch{}
    const input=join(repository.dataDir,original.relativePath);
    const sharp=await imageEngine();
    const metadata=await sharp(input).metadata();
    if((metadata.pages||1)>1||((metadata.width||0)<=size&&(metadata.height||0)<=size))return original;
    await mkdir(join(repository.dataDir,'cache','images'),{recursive:true});
    const temporary=target+'.partial';
    try{
      await sharp(input).rotate().resize({width:size,height:size,fit:'inside',withoutEnlargement:true})
        .webp({quality:90,effort:3}).toFile(temporary);
      await rename(temporary,target);
    }catch(error){await rm(temporary,{force:true});throw error;}
    return {relativePath,mime:'image/webp'};
  });
  sequence=job.then(()=>{},()=>{});jobs.set(key,job);
  void job.finally(()=>jobs.delete(key)).catch(()=>{});
  return job;
}
