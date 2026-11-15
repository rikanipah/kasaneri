export interface ImageBox {
  id:string;
  x:number;
  y:number;
  width:number;
  height:number;
}

export interface AssetEmbed {
  assetId:string;
  display:string;
  boxes:ImageBox[];
  mask:ImageBox|null;
}

type Section='question'|'answer';

export interface ImageOcclusionInput {
  id:string;
  section:Section;
  from:number;
  token:string;
  revision:number;
  boxes:ImageBox[];
}

interface ImageOcclusionChange {
  id:string;
  section:Section;
  before:string;
  after:string;
}

export interface ImageOcclusionUndo {
  changes:ImageOcclusionChange[];
  created:string[];
}

export const assetEmbeds=/!\[\[asset:([a-f0-9]{64})(?:\|([^\]\r\n]*))?\]\]/g;

export function validImageBox(box:unknown):box is ImageBox {
  if(!box||typeof box!=='object')return false;
  const {id,x,y,width,height}=box as ImageBox;
  return typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id)&&[x,y,width,height].every(Number.isFinite)
    &&x>=0&&y>=0&&width>0&&height>0&&x+width<=1+1e-9&&y+height<=1+1e-9;
}

function parseBox(value:string):ImageBox|null {
  const [id,...coords]=value.split(',');
  if(coords.length!==4||coords.some(coord=>!coord.trim()))return null;
  const [x,y,width,height]=coords.map(Number);
  const box={id,x,y,width,height};
  return validImageBox(box)?box:null;
}

export function parseAssetEmbed(token:string):AssetEmbed|null {
  const match=token.match(/^!\[\[asset:([a-f0-9]{64})(?:\|([^\]\r\n]*))?\]\]$/);
  if(!match)return null;
  const embed:AssetEmbed={assetId:match[1],display:match[2]||'',boxes:[],mask:null};
  const parts=embed.display.split('|'),attribute=parts.at(-1)!;
  if(attribute.startsWith('ir-mask=')){
    embed.mask=parseBox(attribute.slice('ir-mask='.length));
    if(embed.mask)embed.display=parts.slice(0,-1).join('|');
  }else if(attribute.startsWith('ir-boxes=')){
    const boxes=attribute.slice('ir-boxes='.length).split(';').map(parseBox);
    if(boxes.every(box=>box!==null)&&new Set(boxes.map(box=>box.id)).size===boxes.length){
      embed.boxes=boxes;
      embed.display=parts.slice(0,-1).join('|');
    }
  }
  return embed;
}

function encodeBox({id,x,y,width,height}:ImageBox):string {
  return [id,x,y,width,height].join(',');
}

export function formatAssetEmbed(embed:AssetEmbed):string {
  const options=embed.display?'|'+embed.display:'';
  const mask=embed.mask?'|ir-mask='+encodeBox(embed.mask):'';
  const boxes=embed.boxes.length?'|ir-boxes='+embed.boxes.map(encodeBox).join(';'):'';
  return '![[asset:'+embed.assetId+options+mask+boxes+']]';
}

export function hasImageMask(content:string):boolean {
  return content.includes('|ir-mask=')&&[...content.matchAll(assetEmbeds)].some(match=>!!parseAssetEmbed(match[0])?.mask);
}

export function studyReady(kind:string,content:string,answer:string):number {
  return Number(kind!=='folder'&&!!content.trim()&&(kind!=='cloze'||!!answer.trim()||hasImageMask(content)));
}
