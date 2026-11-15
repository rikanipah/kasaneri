import { t } from '../core/i18n';
import {makeAnchor,titleFrom} from '../core/card';
import {
  assetEmbeds,formatAssetEmbed,parseAssetEmbed,validImageBox,
  type ImageOcclusionInput,type ImageOcclusionUndo,
} from '../core/image-occlusion';
import type {Material} from '../core/model';
import type {Repository} from './database';

function sectionText(note:Material,section:ImageOcclusionInput['section']):string {
  return section==='answer'?note.answer:note.content;
}

function saveSection(repository:Repository,note:Material,section:ImageOcclusionInput['section'],text:string):void {
  repository.save({id:note.id,revision:note.revision,content:note.content,answer:note.answer,
    [section==='answer'?'answer':'content']:text});
}

export function saveImageOcclusion(repository:Repository,input:ImageOcclusionInput,register:(id:string)=>void):ImageOcclusionUndo {
  if(!input||typeof input.token!=='string'||!Number.isSafeInteger(input.from)||input.from<0||
    !['question','answer'].includes(input.section)||!Array.isArray(input.boxes)||!input.boxes.every(validImageBox)||
    new Set(input.boxes.map(box=>box.id)).size!==input.boxes.length)throw Error(t('遮挡框无效。'));
  const embed=parseAssetEmbed(input.token);
  if(!embed||embed.mask)throw Error(t('请选择正文里的原图。'));
  return repository.transaction(()=>{
    const source=repository.getNode(input.id);
    if(!source||source.kind==='folder'||source.revision!==input.revision)throw Error(t('来源卡片已变化，请重新打开图片。'));
    const before=sectionText(source,input.section),end=input.from+input.token.length;
    if(before.slice(input.from,end)!==input.token)throw Error(t('图片位置已变化，请重新打开图片。'));
    const asset=repository.getAsset(embed.assetId);
    if(!asset?.mime.startsWith('image/'))throw Error(t('图片附件不可用。'));

    const undo:ImageOcclusionUndo={changes:[],created:[]};
    const token=formatAssetEmbed({...embed,boxes:input.boxes});
    const after=before.slice(0,input.from)+token+before.slice(end);
    if(after!==before){
      saveSection(repository,source,input.section,after);
      undo.changes.push({id:source.id,section:input.section,before,after});
    }

    const linked=new Map<string,string>();
    if(embed.boxes.length){
      const rows=repository.query(`
        SELECT id,json_extract(anchor,'$.quote') AS box FROM nodes
        WHERE source_id=? AND kind='cloze' AND deleted_at IS NULL
          AND json_extract(anchor,'$.quote') IN(SELECT value FROM json_each(?))
        ORDER BY position,id
      `).all(source.id,JSON.stringify(embed.boxes.map(box=>box.id)));
      for(const row of rows)linked.set(String(row.box),String(row.id));
    }
    for(const [index,box] of input.boxes.entries()){
      const id=linked.get(box.id);
      if(!id){
        const at=input.from+token.indexOf(box.id);
        const anchor={...makeAnchor(after,at,at+box.id.length,input.section),highlight:'cloze' as const};
        const title=t('{0} · 遮挡 {1}',titleFrom(asset.filename.replace(/\.[^.]+$/,'')),(index+1));
        const content=formatAssetEmbed({...embed,boxes:[],mask:box});
        const card=repository.createImageOcclusionCard(source,title,content,anchor);
        register(card.id);
        undo.created.push(card.id);
        continue;
      }
      const oldBox=embed.boxes.find(item=>item.id===box.id)!;
      if(oldBox.x===box.x&&oldBox.y===box.y&&oldBox.width===box.width&&oldBox.height===box.height)continue;
      const card=repository.getNode(id)!;
      const matches=[...card.content.matchAll(assetEmbeds)].filter(match=>
        match[1]===embed.assetId&&parseAssetEmbed(match[0])?.mask?.id===box.id);
      if(matches.length!==1)throw Error(t('检测卡里的遮挡图片已改变，请恢复该图片后再调整框。'));
      const match=matches[0],at=match.index!;
      const updated=formatAssetEmbed({...parseAssetEmbed(match[0])!,mask:box});
      const content=card.content.slice(0,at)+updated+card.content.slice(at+match[0].length);
      if(content!==card.content){
        saveSection(repository,card,'question',content);
        undo.changes.push({id,section:'question',before:card.content,after:content});
      }
    }
    return undo;
  });
}

export function undoImageOcclusion(repository:Repository,undo:ImageOcclusionUndo):void {
  repository.transaction(()=>{
    for(const change of undo.changes){
      const note=repository.getNode(change.id);
      if(!note||sectionText(note,change.section)!==change.after)throw Error(t('图片或卡片已变化，无法撤销遮挡。'));
      saveSection(repository,note,change.section,change.before);
    }
    for(const id of undo.created)repository.undoCreation(id);
  });
}
