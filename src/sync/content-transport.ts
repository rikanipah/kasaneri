import { t } from '../core/i18n';
import { CONTENT_BATCH_SIZE, isVersionId, type ContentVersion } from './content-versions';
import { CONTENT_ASSET_PATH } from './content-assets';

export const CONTENT_IDS_PATH='/sync/content/ids';
export const CONTENT_READ_PATH='/sync/content/read';

type ApplyReport={applied:number;merged:number;conflicts:number;pending:number;missingAssets:string[]};

async function pullAsset(
  id:string,
  post:(path:string,payload:unknown)=>Promise<any>,
  call:<T=any>(action:string,payload?:unknown)=>Promise<T>,
):Promise<boolean>{
  let offset=0;
  try{
    for(;;){
      const {chunk}=await post(CONTENT_ASSET_PATH,{id,offset});
      if(chunk===null)return false;
      const accepted=await call<{nextOffset:number;done:boolean}>('syncContentAssetReceive',{id,chunk});
      if(accepted.done)return true;
      offset=accepted.nextOffset;
    }
  }finally{await call('syncContentAssetAbort',{id});}
}

export async function pullContentVersions(
  post:(path:string,payload:unknown)=>Promise<any>,
  call:<T=any>(action:string,payload?:unknown)=>Promise<T>,
  supportsAssets=false,
):Promise<{received:number;applied:number;merged:number;conflicts:number;pending:number;attachments:number}>{
  let after:string|null=null;
  let received=0;
  do{
    const page=await post(CONTENT_IDS_PATH,{after});
    const ids:unknown=page?.ids;
    if(!Array.isArray(ids)||ids.length>CONTENT_BATCH_SIZE||
        ids.some((id,index)=>!isVersionId(id)||id<=(index?ids[index-1]:after??''))||
        (page.nextAfter!==null&&(!ids.length||page.nextAfter!==ids[ids.length-1]))){
      throw Error(t('对端返回的卡片版本分页无效。'));
    }
    const missing=await call<string[]>('syncContentMissing',{ids});
    if(missing.length){
      const response=await post(CONTENT_READ_PATH,{ids:missing});
      const versions:ContentVersion[]|undefined=response?.versions;
      if(!Array.isArray(versions)||versions.length!==missing.length||
          versions.some((version,index)=>version?.id!==missing[index])){
        throw Error(t('对端未返回所请求的卡片版本。'));
      }
      await call('syncContentReceive',{versions});
      received+=versions.length;
    }
    after=page.nextAfter;
  }while(after!==null);
  let report=await call<ApplyReport>('syncContentApply');
  let applied=report.applied,merged=report.merged,attachments=0;
  const attempted=new Set<string>();
  while(supportsAssets){
    const needed=report.missingAssets.filter(id=>!attempted.has(id));
    if(!needed.length)break;
    let downloaded=0;
    for(const id of needed){
      attempted.add(id);
      if(await pullAsset(id,post,call))downloaded++;
    }
    if(!downloaded)break;
    attachments+=downloaded;
    report=await call<ApplyReport>('syncContentApply');
    applied+=report.applied;merged+=report.merged;
  }
  return {received,applied,merged,attachments,conflicts:report.conflicts,pending:report.pending};
}
