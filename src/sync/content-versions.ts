import { t } from '../core/i18n';
import { createHash } from 'node:crypto';
import type { Anchor, NodeKind } from '../core/model';

export type CardContent={
  kind:NodeKind;
  parentId:string|null;
  sourceId:string|null;
  title:string;
  content:string;
  answer:string;
  anchor:Anchor|null;
  position:number;
  priority:number|null;
};

export type ContentVersion={
  id:string;
  nodeId:string;
  parents:string[];
  value:CardContent|null;
  /** 版本首次入库时间（毫秒）。不参与版本编号，只用于合并时挑选较新的版本。 */
  createdAt?:number;
};

export const CONTENT_BATCH_SIZE=200;
export const isVersionId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);

export function validateContentVersion(version:ContentVersion):void{
  if(!isVersionId(version?.id)||typeof version.nodeId!=='string'||!version.nodeId||
      !Array.isArray(version.parents)||!version.parents.every(isVersionId)||
      (version.createdAt!==undefined&&(!Number.isSafeInteger(version.createdAt)||version.createdAt<0))){
    throw Error(t('收到无效的卡片版本。'));
  }
  const value=version.value;
  if(value===null)return;
  if(!value||!['folder','topic','material','cloze'].includes(value.kind)||
      ![value.title,value.content,value.answer].every(text=>typeof text==='string')||
      !Number.isSafeInteger(value.position)||
      (value.priority!==null&&!Number.isInteger(value.priority))||
      ![value.parentId,value.sourceId].every(id=>id===null||(typeof id==='string'&&id.length>0))){
    throw Error(t('收到无效的卡片内容。'));
  }
  const anchor=value.anchor;
  if(anchor!==null&&(!anchor||![anchor.quote,anchor.prefix,anchor.suffix].every(text=>typeof text==='string')||
      (anchor.start!==undefined&&!Number.isSafeInteger(anchor.start))||
      (anchor.section!==undefined&&!['question','answer'].includes(anchor.section))||
      (anchor.highlight!==undefined&&!['extract','cloze'].includes(anchor.highlight)))){
    throw Error(t('收到无效的摘录锚点。'));
  }
}

function normalizeContent(value:CardContent|null):CardContent|null{
  if(!value)return null;
  const anchor=value.anchor;
  return {
    kind:value.kind,parentId:value.parentId,sourceId:value.sourceId,title:value.title,content:value.content,
    answer:value.answer,position:value.position,priority:value.priority,
    anchor:anchor?{quote:anchor.quote,prefix:anchor.prefix,suffix:anchor.suffix,
      start:anchor.start,section:anchor.section,highlight:anchor.highlight}:null,
  };
}

export function makeContentVersion(nodeId:string,parents:readonly string[],value:CardContent|null,createdAt?:number):ContentVersion{
  const orderedParents=[...new Set(parents)].sort();
  const content=normalizeContent(value);
  const id=createHash('sha256').update(JSON.stringify(['ir-card-content-v1',nodeId,orderedParents,content])).digest('hex');
  return createdAt===undefined?{id,nodeId,parents:orderedParents,value:content}:{id,nodeId,parents:orderedParents,value:content,createdAt};
}

export function inspectContentVersions(nodeId:string,versions:readonly ContentVersion[]){
  const known=new Map<string,ContentVersion>();
  const superseded=new Set<string>();
  for(const version of versions){
    const expected=makeContentVersion(nodeId,version.parents,version.value,version.createdAt);
    if(version.nodeId!==nodeId||version.id!==expected.id)throw Error(t('卡片版本与校验值不一致。'));
    known.set(version.id,expected);
    for(const parent of expected.parents)superseded.add(parent);
  }
  const missing=[...superseded].filter(id=>!known.has(id)).sort();
  const heads=[...known.values()].filter(version=>!superseded.has(version.id)).sort((a,b)=>a.id.localeCompare(b.id));
  return {missing,heads};
}

// 1.191：Anki 式自动合并。本机没有未推送改动、远端却送来分叉版本时，取较新的那一版（createdAt 大者，
// 相同则版本号大者），把分叉头一起记为父版本。两边都用同一规则，得到同一个合并版本，下一轮自然收敛。
export function mergeContentVersions(nodeId:string,heads:readonly ContentVersion[]):ContentVersion{
  if(heads.length<2)throw Error(t('合并至少需要两个卡片版本。'));
  const newest=[...heads].sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||b.id.localeCompare(a.id))[0];
  return makeContentVersion(nodeId,heads.map(head=>head.id),newest.value);
}

export function chooseContentVersion(nodeId:string,versions:readonly ContentVersion[],expectedHeads:readonly string[],choice:string){
  const {missing,heads}=inspectContentVersions(nodeId,versions);
  const ids=heads.map(version=>version.id).sort();
  const expected=[...new Set(expectedHeads)].sort();
  if(missing.length||ids.length<2||ids.length!==expected.length||ids.some((id,index)=>id!==expected[index])){
    throw Error(t('卡片版本已经变化，请重新查看冲突详情。'));
  }
  const selected=heads.find(version=>version.id===choice);
  if(!selected)throw Error(t('所选卡片版本无效。'));
  return makeContentVersion(nodeId,ids,selected.value);
}
