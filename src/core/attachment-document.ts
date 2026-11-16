import { markdownLanguage } from '@codemirror/lang-markdown';
import { assetEmbeds, formatAssetEmbed, parseAssetEmbed, validImageBox, type AssetEmbed } from './image-occlusion';

export const attachmentCharacter='\uFFFC';
export interface AttachmentObject {at:number;embed:AssetEmbed}
export interface AttachmentDocument {text:string;objects:AttachmentObject[]}
export interface CardDocuments {content:AttachmentDocument;answer:AttachmentDocument}

// Legacy Markdown is accepted at import and sync boundaries. The document editor
// and database store the objects separately from the text.
export function readLegacyDocument(source:string):AttachmentDocument{
  if(!source.includes('![[asset:'))return {text:source,objects:[]};
  const matches=[...source.matchAll(assetEmbeds)];
  if(!matches.length)return {text:source,objects:[]};
  const tree=markdownLanguage.parser.parse(source);
  let text='',cursor=0;
  const objects:AttachmentObject[]=[];
  for(const match of matches){
    const offset=match.index!;
    let literal=false;
    for(let node=tree.resolveInner(offset,1);node.parent;node=node.parent){
      if(/Code|HTMLBlock/.test(node.name)){literal=true;break;}
    }
    if(literal)continue;
    const embed=parseAssetEmbed(match[0]);
    if(!embed)continue;
    text+=source.slice(cursor,offset);
    objects.push({at:text.length,embed});
    text+=attachmentCharacter;
    cursor=offset+match[0].length;
  }
  return {text:text+source.slice(cursor),objects};
}

export function readStoredDocument(text:string,encoded:unknown):AttachmentDocument{
  return {text,objects:typeof encoded==='string'&&encoded!=='[]'?JSON.parse(encoded) as AttachmentObject[]:[]};
}

export function projectDocument(document:AttachmentDocument):string{
  let result='',cursor=0;
  for(const {at,embed} of document.objects){
    result+=document.text.slice(cursor,at)+formatAssetEmbed(embed);
    cursor=at+1;
  }
  return result+document.text.slice(cursor);
}

export function projectedOffset(objects:readonly AttachmentObject[],offset:number):number{
  let result=offset;
  for(const {at,embed} of objects){
    if(at>=offset)break;
    result+=formatAssetEmbed(embed).length-1;
  }
  return result;
}

export function documentOffset(objects:readonly AttachmentObject[],offset:number,after=false):number{
  let expansion=0;
  for(const {at,embed} of objects){
    const start=at+expansion;
    if(offset<=start)break;
    const length=formatAssetEmbed(embed).length;
    if(offset<start+length)return at+Number(after);
    expansion+=length-1;
  }
  return offset-expansion;
}

export function validAttachmentDocument(document:AttachmentDocument):boolean{
  if(!document||typeof document.text!=='string'||!Array.isArray(document.objects))return false;
  let last=-1;
  for(const entry of document.objects){
    if(!entry||!Number.isInteger(entry.at)||entry.at<=last||document.text[entry.at]!==attachmentCharacter)return false;
    const embed=entry.embed;
    if(!embed||typeof embed.assetId!=='string'||!/^[a-f0-9]{64}$/.test(embed.assetId)||
      typeof embed.display!=='string'||!Array.isArray(embed.boxes)||!embed.boxes.every(validImageBox)||
      !(embed.mask===null||validImageBox(embed.mask))||
      (embed.name!==undefined&&typeof embed.name!=='string'))return false;
    last=entry.at;
  }
  return true;
}
