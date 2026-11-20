import { t } from '../core/i18n';
import { createHash } from 'node:crypto';
import { existsSync, copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { cardParts, readAnchor } from '../core/card';
import { locateAnchor, makeAnchor } from '../content/anchors';
import type { Asset, NodeInput, NodeKind } from '../core/model';
import type { Repository } from './database';

export function mimeType(filename:string):string {
  const types:Record<string,string>={
    '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml',
    '.webp':'image/webp','.avif':'image/avif','.bmp':'image/bmp','.mp3':'audio/mpeg','.m4a':'audio/mp4',
    '.wav':'audio/wav','.ogg':'audio/ogg','.flac':'audio/flac','.mp4':'video/mp4','.webm':'video/webm',
    '.mov':'video/quicktime','.mkv':'video/x-matroska','.ogv':'video/ogg','.pdf':'application/pdf',
  };
  return types[extname(filename).toLowerCase()]||'application/octet-stream';
}

export function importAsset(repository:Repository,source:string):Asset {
  const path=realpathSync(source);
  const hash=createHash('sha256'),descriptor=openSync(path,'r'),buffer=Buffer.allocUnsafe(1024*1024);
  let mime=mimeType(path);
  let size:number;
  try{
    size=fstatSync(descriptor).size;
    let length=readSync(descriptor,buffer,0,buffer.length,null);
    if(mime==='application/octet-stream'&&length>=12
      &&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'){
      mime='image/webp';
    }
    for(;length;length=readSync(descriptor,buffer,0,buffer.length,null)){
      hash.update(buffer.subarray(0,length));
    }
  }finally{closeSync(descriptor);}
  const id=hash.digest('hex');
  const existing=repository.getAsset(id);
  if(existing){
    if(existing.mime==='application/octet-stream'&&mime==='image/webp'){
      repository.query('UPDATE assets SET mime=? WHERE id=?').run(mime,id);
      return {...existing,mime};
    }
    return existing;
  }
  const extension=extname(path).toLowerCase().replace(/[^a-z0-9.]/g,'').slice(0,12);
  const relativePath=id+extension;
  const directory=join(repository.dataDir,'assets');
  mkdirSync(directory,{recursive:true});
  const target=join(directory,relativePath);
  if(!existsSync(target))copyFileSync(path,target);
  const asset={id,filename:basename(path),mime,size,relativePath};
  repository.registerAsset(asset);
  return asset;
}

function idValue(value:unknown):string|null {
  if(typeof value==='string'&&value.trim())return value.trim();
  return Number.isSafeInteger(value)?String(value):null;
}

export function importVault(repository:Repository,vaultPath:string):{count:number;warnings:string[]} {
  if(repository.getSetting('importComplete'))return {count:0,warnings:[]};
  const root=realpathSync(vaultPath);
  const files:string[]=[];
  function walk(directory:string):void {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
      const path=join(directory,entry.name);
      if(entry.isDirectory())walk(path);
      else if(entry.isFile())files.push(path);
    }
  }
  walk(root);
  const index=['kasaneri-tree','leafloop-tree','incremental-reading-tree']
    .map(name=>join(root,'.obsidian','plugins',name,'data.json')).find(existsSync);
  const legacy=index?JSON.parse(readFileSync(index,'utf8').replace(/^\uFEFF/,'')):{};
  const oldNodes:Array<any>=Array.isArray(legacy.nodes)?legacy.nodes:[];
  const oldByPath=new Map(oldNodes.map(node=>[node.path,node]));
  const oldOrder=new Map(oldNodes.map((node,index)=>[node.id,index]));
  const byPath=new Map<string,NodeInput>();
  const warnings:string[]=[];
  const nodes:NodeInput[]=[];
  let position=0;
  const folderIds=new Map<string,string>();
  for(const folder of Array.isArray(legacy.folders)?legacy.folders:[]) {
    if(typeof folder.id!=='string'||typeof folder.title!=='string')continue;
    const id='folder:'+folder.id;
    folderIds.set(folder.id,id);
    nodes.push({id,parentId:null,sourceId:null,kind:'folder',title:folder.title,content:'',answer:'',
      anchor:null,position:position++});
  }
  for(const path of files.filter(path=>extname(path).toLowerCase()==='.md')){
    const relativePath=relative(root,path).split(sep).join('/');
    const old=oldByPath.get(relativePath);
    const text=readFileSync(path,'utf8').replace(/^\uFEFF/,'');
    const match=text.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
    let props:Record<string,any>={};
    if(match?.index===0) {
      try{props=parse(match[1])||{};}catch(error){
        if(old)throw Error(t('笔记属性无法解析：{0}',relativePath));
        warnings.push(t('跳过属性异常的未登记笔记：{0}',relativePath));
        continue;
      }
    }
    const id=idValue(props['渐进阅读编号'])||idValue(old?.id);
    if(!id)continue;
    const parentId=Object.hasOwn(props,'渐进阅读父级编号')
      ?idValue(props['渐进阅读父级编号']):idValue(old?.parent);
    const type=props['渐进阅读类型']||old?.type;
    const kind:NodeKind=type==='cloze'?'cloze':type==='topic'||!parentId?'topic':'material';
    const body=text.slice(match?.index===0?match[0].length:0);
    const parts=kind==='cloze'?cardParts(body):{content:body,answer:''};
    const node:NodeInput={
      id,parentId:parentId||folderIds.get(String(props['渐进阅读目录']))||null,
      sourceId:parentId,kind,
      title:String(props['渐进阅读标题']||old?.title||basename(path,'.md')),
      ...parts,anchor:readAnchor(props['渐进阅读来源']??old?.source),
      position:position++,metadata:{...props,originalPath:relativePath},
    };
    byPath.set(relativePath,node);
    nodes.push(node);
  }
  const byId=new Map<string,NodeInput>();
  const ordered=[...nodes.filter(node=>node.kind==='folder'),...nodes.filter(node=>node.kind!=='folder').sort((a,b)=>
    (oldOrder.get(a.id)??Number.MAX_SAFE_INTEGER)-(oldOrder.get(b.id)??Number.MAX_SAFE_INTEGER)||a.id.localeCompare(b.id))];
  ordered.forEach((node,index)=>{node.position=index;});
  for(const node of nodes){
    if(byId.has(node.id))throw Error(t('存在重复材料编号：{0}',node.id));
    byId.set(node.id,node);
  }
  for(const node of nodes){
    if(node.parentId&&!byId.has(node.parentId)){warnings.push(t('缺失父级，已放到顶层：{0}',node.title));node.parentId=null;}
    if(node.sourceId&&!byId.has(node.sourceId))node.sourceId=null;
    const seen=new Set([node.id]);
    for(let parent=node.parentId;parent;parent=byId.get(parent)?.parentId||null){
      if(seen.has(parent)){warnings.push(t('循环关系，已放到顶层：{0}',node.title));node.parentId=null;break;}
      seen.add(parent);
    }
  }
  const byName=new Map<string,string[]>();
  for(const path of files){
    const name=basename(path);
    const list=byName.get(name)||[];
    list.push(path);byName.set(name,list);
  }
  const resolveReference=(reference:string,notePath:string):string|null=>{
    if(/^(https?:|data:|asset:)/i.test(reference))return null;
    let decoded:string;
    try{decoded=decodeURIComponent(reference);}catch{return null;}
    const candidates=[resolve(dirnameOf(notePath),decoded),resolve(root,decoded)];
    for(const candidate of candidates){
      if(candidate.startsWith(root+sep)&&existsSync(candidate))return candidate;
    }
    const matching=byName.get(basename(decoded))||[];
    return matching.length===1?matching[0]:null;
  };
  const rewrite=(text:string,node:NodeInput):string=>{
    const original=join(root,String(node.metadata?.originalPath||''));
    const mapWiki=(token:string,target:string,alias?:string,embed=false):string=>{
      const parts=target.split('#');
      const rawPath=parts[0];
      const maybeNote=resolveReference(extname(rawPath)?rawPath:rawPath+'.md',original);
      const destination=maybeNote?byPath.get(relative(root,maybeNote).split(sep).join('/')):null;
      if(destination&&!embed)return '[['+destination.id+'|'+(alias||destination.title)+']]';
      const resource=resolveReference(rawPath,original);
      if(!resource||extname(resource).toLowerCase()==='.md')return token;
      const asset=importAsset(repository,resource);
      return (embed?'!':'')+'[[asset:'+asset.id+(alias?'|'+alias:'')+']]';
    };
    let result=text.replace(/(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
      (all,bang,target,alias)=>mapWiki(all,target,alias,bang==='!'));
    result=result.replace(/(!?)\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
      (all,bang,label,target)=>{
        const resource=resolveReference(target,original);
        if(!resource||extname(resource).toLowerCase()==='.md')return all;
        const asset=importAsset(repository,resource);
        return (bang?'!':'')+'[[asset:'+asset.id+(label?'|'+label:'')+']]';
      });
    return result;
  };
  const originalBodies=new Map(nodes.map(node=>[node.id,{content:node.content,answer:node.answer}]));
  for(const node of nodes){
    if(node.kind==='folder')continue;
    node.content=rewrite(node.content,node);
    node.answer=rewrite(node.answer,node);
  }
  for(const node of nodes){
    if(!node.anchor||!node.sourceId)continue;
    const source=byId.get(node.sourceId),original=originalBodies.get(node.sourceId);
    if(!source||!original)continue;
    const section=node.anchor.section==='answer'?'answer':'content';
    const at=locateAnchor(original[section],node.anchor);
    if(at<0)continue;
    const start=rewrite(original[section].slice(0,at),source).length;
    const quote=rewrite(node.anchor.quote,source);
    if(source[section].slice(start,start+quote.length)===quote)
      node.anchor=makeAnchor(source[section],start,start+quote.length,node.anchor.section);
  }
  const count=repository.importData(nodes,root);
  repository.setSetting('importWarnings',warnings);
  const appearanceFile=join(root,'.obsidian/appearance.json');
  if(existsSync(appearanceFile)){
    try{
      const appearance=JSON.parse(readFileSync(appearanceFile,'utf8'));
      repository.setSetting('theme',appearance.theme==='moonstone'?'light':'dark');
      if(Number.isFinite(appearance.baseFontSize))repository.setSetting('fontSize',appearance.baseFontSize);
    }catch{/* Appearance has no effect on imported material. */}
  }
  const workspaceFile=join(root,'.obsidian/workspace.json');
  if(existsSync(workspaceFile)){
    try{
      const workspace=JSON.parse(readFileSync(workspaceFile,'utf8'));
      const leaves:any[]=[workspace.main];
      let active:string|undefined;
      while(leaves.length){const leaf=leaves.pop();if(!leaf)continue;
        if(leaf.id===workspace.active)active=leaf.state?.state?.file;
        if(Array.isArray(leaf.children))leaves.push(...leaf.children);
      }
      const last=byPath.get(active||'')||byPath.get('开始阅读.md');
      if(last)repository.setSetting('lastNode',last.id);
      if(workspace.left?.width)repository.setSetting('sidebarWidth',workspace.left.width);
    }catch{/* The last viewed note is optional. */}
  }
  return {count,warnings};
}

function dirnameOf(path:string):string { return resolve(path,'..'); }
