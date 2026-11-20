import { t } from '../core/i18n';
import { ChangeSet, Compartment, countColumn, EditorSelection, EditorState, MapMode, StateEffect, StateField, Transaction, type ChangeDesc, type Range as DecorationRange } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, dropCursor, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyField, historyKeymap, insertNewlineKeepIndent, invertedEffects, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import katex from 'katex';
// N12（1.87）：加载 mhchem 扩展，支持化学式 \ce{} 与单位 \pu{}（KaTeX 官方扩展，副作用导入即注册）
import 'katex/contrib/mhchem';
import { locateAnchor } from '../content/anchors';
import { formatAssetEmbed,type AssetEmbed } from '../core/image-occlusion';
import { attachmentCharacter,documentOffset,projectDocument,projectedOffset,readLegacyDocument,validAttachmentDocument,
  type AttachmentDocument,type AttachmentObject } from '../core/attachment-document';
import type { Anchor, Asset } from '../core/model';
import { positionBox } from './image-occlusion';
import { setIcon } from './icons';

export interface AttachmentTarget {
  token:string;
  from:number;
  url:string;
  filename:string;
  assetId:string;
  isImage:boolean;
  masked:boolean;
  rename:(name:string)=>void;
  removeReference:()=>void;
}

export type EditorMode='live'|'source'|'reading';

export interface EditorOptions {
  value:string;
  document?:AttachmentDocument;
  label:string;
  section:'question'|'answer';
  anchors:Anchor[];
  highlights?:{extract:boolean;cloze:boolean;topic?:boolean};
  textOnlyCursor?:boolean;
  readOnly?:boolean;
  mode?:EditorMode;
  snapshot?:any;
  onChange:(value:string,typing:boolean,document:AttachmentDocument)=>void;
  /** 音频/视频是否自动播放（全局开关，来自设置） */
  audioAutoplay?:boolean;
  onNavigate:(id:string)=>void;
  /** 同一位置有多条锚点时，交给界面弹出选择框 */
  onNavigateChoice?:(ids:string[],at:{x:number,y:number})=>void;
  onInsertMenu:(event:MouseEvent,attachment:()=>void,fileLink:()=>void)=>void;
  onImageContext?:(event:MouseEvent,attachment:AttachmentTarget)=>void;
  onAttachments:(files:File[])=>Promise<Asset[]>;
  onError:(message:string)=>void;
  /**
   * 2026-11-20：拖动高亮棍改锚点边界。at 是来源正文里的字符位置（按行吸附后的行首/行尾）。
   * 传 null 表示这次拖动取消了。
   */
  /** ids 是这次要一起挪的锚点（重叠时可能是多张卡）；at/origin 是来源正文里的字符位置，按 origin→at 的差值平移。 */
}
const renderer=new MarkdownIt({html:true,linkify:true,breaks:true}).disable('code');
const fileLink=/^file:\/\//i;
function renderFormula(formula:string,displayMode:boolean):string{
  return katex.renderToString(formula,{displayMode,throwOnError:false,strict:false});
}

const inlineMath=/\\\([^\n]+?\\\)|\$(?!\$)[^\n$]+?\$(?!\$)/y;
renderer.inline.ruler.before('escape','kasaneri_math',(state,silent)=>{
  const from=state.pos;
  if(state.src[from]==='$'&&state.src[from-1]==='$')return false;
  inlineMath.lastIndex=from;
  const match=inlineMath.exec(state.src);
  if(!match||inlineMath.lastIndex>state.posMax)return false;
  const fence=match[0][0]==='$'?1:2;
  if(!silent)state.push('kasaneri_math','',0).content=match[0].slice(fence,-fence);
  state.pos=inlineMath.lastIndex;
  return true;
});
renderer.renderer.rules.kasaneri_math=(tokens,index)=>renderFormula(tokens[index].content,false);
const validateWebLink=renderer.validateLink.bind(renderer);
renderer.validateLink=url=>validateWebLink(url)||fileLink.test(url);
renderer.renderer.rules.link_open=(tokens,index,options,_env,output)=>{
  const href=tokens[index].attrGet('href');
  // Preserve the target while DOMPurify strips file: hrefs from rendered Markdown.
  if(typeof href==='string'&&fileLink.test(href))tokens[index].attrSet('data-file-link',href);
  return output.renderToken(tokens,index,options);
};

function externalUrl(value:string):string|null{
  if(!/^(?:https?|file):\/\//i.test(value))return null;
  try{return new URL(value).href;}catch{return null;}
}

function decorateExternalLink(link:HTMLAnchorElement,url:string):void{
  link.removeAttribute('href');
  if(!link.title)link.title=url;
  link.dataset.editorLink=url;
  const marker=document.createElement('span');
  marker.className='external-link-mark';
  marker.textContent='↗';
  marker.setAttribute('aria-hidden','true');
  link.append(marker);

}

const assets=new Map<string,Promise<Asset>>();
const discardedWidgets=new WeakSet<HTMLElement>();
const editorMedia=new WeakMap<EditorView,Map<string,HTMLMediaElement>>();
const autoplayStarted=new WeakSet<HTMLMediaElement>();
function startAutomaticPlayback(media:HTMLMediaElement):void{
  const visible=()=>media.isConnected&&!media.closest('.is-answer-hidden');
  if(!visible()||autoplayStarted.has(media))return;
  autoplayStarted.add(media);
  void media.play().catch(()=>{
    if(visible())media.addEventListener('canplay',()=>{if(visible())void media.play().catch(()=>{});},{once:true});
  });
}
const redraw=StateEffect.define<void>();
const focusChanged=StateEffect.define<boolean>();
const focusedField=StateField.define<boolean>({create:()=>false,update:(value,tr)=>{for(const effect of tr.effects)if(effect.is(focusChanged))value=effect.value;return value;}});

function mapAttachments(objects:AttachmentObject[],changes:ChangeDesc):AttachmentObject[]{
  if(changes.empty||!objects.length)return objects;
  return objects.flatMap(object=>{
    const at=changes.mapPos(object.at,1,MapMode.TrackAfter);
    return at===null?[]:at===object.at?[object]:[{...object,at}];
  });
}
const setAttachmentObjects=StateEffect.define<AttachmentObject[]>({map:mapAttachments});
const attachmentField=StateField.define<AttachmentObject[]>({
  create:()=>[],
  update:(objects,tr)=>{
    const replacement=tr.effects.find(effect=>effect.is(setAttachmentObjects));
    return replacement?.value??mapAttachments(objects,tr.changes);
  },
  toJSON:objects=>objects,
  fromJSON:value=>Array.isArray(value)?value:[],
});
const clipboardAttachmentType='application/x-kasaneri-attachments';

function assetInfo(id:string):Promise<Asset> {
  let result=assets.get(id);
  if(!result){
    result=window.reading.request<Asset>('asset',{id});assets.set(id,result);
    if(assets.size>512)assets.delete(assets.keys().next().value!);
  }
  return result;
}

class RichWidget extends WidgetType {
  constructor(readonly type:'math'|'markdown'|'media'|'link',readonly value:string,
    readonly onNavigate:(id:string)=>void,
    readonly autoplay=false,readonly onImageContext?:EditorOptions['onImageContext'],readonly attachment?:AttachmentObject,readonly mediaReadOnly=false,
    readonly math?:{from:number;block:boolean;indent:number;quoted:boolean;formula:string}){
    super();
  }
  eq(other:RichWidget):boolean { return this.type===other.type&&this.value===other.value&&this.autoplay===other.autoplay&&
    this.attachment?.at===other.attachment?.at&&this.attachment?.embed===other.attachment?.embed&&this.mediaReadOnly===other.mediaReadOnly&&
    this.math?.from===other.math?.from&&this.math?.block===other.math?.block&&this.math?.indent===other.math?.indent&&
    this.math?.quoted===other.math?.quoted&&this.math?.formula===other.math?.formula; }
  toDOM(view:EditorView):HTMLElement {
    const wrapper=document.createElement('span');
    wrapper.className='reading-rich reading-rich-'+this.type;
    if(this.type==='math'){
      if(this.math?.block){
        wrapper.classList.add('reading-rich-math-block');
        if(this.math.quoted)wrapper.classList.add('reading-rich-quoted-math');
        if(this.math.indent){
          wrapper.classList.add('md-indented-math');
          wrapper.style.setProperty('--md-indent-size',String(this.math.indent));
          const lastGuide=lastIndentGuideColumn(this.math.indent);
          if(lastGuide>=0){
            wrapper.classList.add('md-indent-guide');
            wrapper.style.setProperty('--md-guide-last-column',String(lastGuide));
          }
        }
      }
      const display=this.value.startsWith('$$')||this.value.startsWith('\\[');
      try{wrapper.innerHTML=renderFormula(this.math!.formula,display);}
      catch{wrapper.textContent=this.value;}
    }else if(this.type==='markdown'){
      wrapper.innerHTML=DOMPurify.sanitize(renderer.render(this.value));
      for(const link of wrapper.querySelectorAll('a')){
        const url=externalUrl(link.dataset.fileLink||link.getAttribute('href')||'');
        if(url)decorateExternalLink(link,url);
      }
    }else if(this.type==='link'){
      const match=this.value.match(/^\[\[([^|\]]+)(?:\|([^\]]*))?\]\]$/);
      const link=document.createElement('a');
      link.href='#';
      link.textContent=match?.[2]||match?.[1]||this.value;
      link.onclick=event=>{event.preventDefault();if(match)this.onNavigate(match[1]);};
      wrapper.append(link);
    }else{
      const object=this.attachment;
      const embed=object?.embed;
      if(!object||!embed)return wrapper;
      wrapper.classList.add('reading-media');
      // 不先写「载入附件…」再换内容——切卡片时那行字会闪一下；留同高空位，加载完直接画上去
      wrapper.textContent='';wrapper.style.minHeight='22px';
      const id=embed.assetId;
      assetInfo(id).then(asset=>{
        if(discardedWidgets.has(wrapper))return;
        if(!asset){wrapper.textContent=t('附件缺失');return;}
        wrapper.replaceChildren();
        const url=window.reading.mediaUrl(id),filename=embed.name||asset.filename;
        const isImage=asset.mime.startsWith('image/');
        const current=()=>!discardedWidgets.has(wrapper)&&view.dom.isConnected&&!view.state.readOnly&&
          view.state.field(attachmentField).find(entry=>entry.at===object.at&&entry.embed===embed);
        const updateEmbed=(patch:Partial<AssetEmbed>)=>{
          const item=current();if(!item)return;
          const objects=view.state.field(attachmentField).map(entry=>entry===item?{...entry,embed:{...embed,...patch}}:entry);
          view.dispatch({effects:setAttachmentObjects.of(objects),userEvent:'input.attachment',annotations:isolateHistory.of('full')});
        };
        wrapper.oncontextmenu=event=>{
          const item=current();
          if(!item||!this.onImageContext)return;
          event.preventDefault();event.stopPropagation();
          const image=wrapper.querySelector('img');
          this.onImageContext(event,{
            from:projectedOffset(view.state.field(attachmentField),item.at),token:formatAssetEmbed(embed),
            url:image?.src||url,filename,assetId:id,isImage,masked:!!embed.mask,
            rename:name=>{const next=name.trim();if(next&&next!==filename)updateEmbed({name:next});},
            removeReference:()=>{
              if(!current())return;
              view.dispatch({changes:{from:item.at,to:item.at+1},selection:{anchor:item.at},
                userEvent:'delete',annotations:isolateHistory.of('full')});
              view.focus();
            },
          });
        };
        if(isImage){
          const image=document.createElement('img');
          const requestedWidth=Number(embed.display.match(/^\d+/)?.[0])||0;
          image.loading='lazy';image.decoding='async';image.src=url+'?preview='+(requestedWidth>1600?3200:1600);image.alt=filename;
          image.draggable=false;
          image.onload=()=>view.requestMeasure();
          const savedWidth=embed.display.match(/^(\d+)(?:x\d+)?$/)?.[1];
          if(savedWidth)image.style.width=savedWidth+'px';
          const commitWidth=(width:number)=>{if(String(width)!==embed.display)updateEmbed({display:String(width)});};
          const handle=document.createElement('button');handle.className='image-resize-handle';
          handle.setAttribute('aria-label',t('拖动调整图片大小'));
          handle.onpointerdown=event=>{
            if(event.button!==0||view.state.readOnly)return;
            event.preventDefault();event.stopPropagation();handle.setPointerCapture(event.pointerId);
            if(!current())return;
            const original=image.getBoundingClientRect(),x=event.clientX,y=event.clientY;
            let width=Math.round(original.width);
            wrapper.classList.add('is-resizing');
            const move=(move:PointerEvent)=>{
              if(move.pointerId!==event.pointerId)return;
              const dx=move.clientX-x,dy=(move.clientY-y)*(image.naturalWidth/(image.naturalHeight||1));
              width=Math.max(64,Math.min(4096,Math.round(original.width+(Math.abs(dx)>=Math.abs(dy)?dx:dy))));
              image.style.width=width+'px';
            };
            const finish=()=>{
              window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);
              window.removeEventListener('pointercancel',finish);window.removeEventListener('blur',finish);
              wrapper.classList.remove('is-resizing');commitWidth(width);
            };
            window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);
            window.addEventListener('pointercancel',finish);window.addEventListener('blur',finish);
          };
          handle.onkeydown=event=>{
            if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
            event.preventDefault();event.stopPropagation();
            commitWidth(Math.max(64,Math.min(4096,Math.round(image.getBoundingClientRect().width)+(event.key==='ArrowLeft'?-20:20))));
          };
          wrapper.classList.add('reading-image');
          if(embed.mask){
            const frame=document.createElement('span');frame.className='reading-image-frame';
            const mask=document.createElement('span');mask.className='reading-image-mask';mask.setAttribute('aria-hidden','true');
            positionBox(mask,embed.mask);
            frame.append(image,mask);wrapper.append(frame);
          }else wrapper.append(image);
          wrapper.append(handle);
          handle.hidden=this.mediaReadOnly;
        }else if(asset.mime.startsWith('audio/')||asset.mime.startsWith('video/')){
          const tag=asset.mime.startsWith('audio/')?'audio':'video';
          // Each editor owns its players, even when both sections reference the same file.
          let mediaCache=editorMedia.get(view);
          if(!mediaCache){mediaCache=new Map();editorMedia.set(view,mediaCache);}
          let media=mediaCache.get(asset.id);
          if(!media||media.tagName.toLowerCase()!==tag){
            media=document.createElement(tag);media.controls=true;media.preload='metadata';media.src=url;
            if(media instanceof HTMLVideoElement){media.style.width='640px';media.style.aspectRatio='16 / 9';}
            media.onloadedmetadata=()=>view.requestMeasure();
            mediaCache.set(asset.id,media);
            if(mediaCache.size>24)mediaCache.delete(mediaCache.keys().next().value!);
          }
          // 全局开关打开时自动播放。
          // 照 Anki 的做法——先只显示一个圆形 ▶ 按钮（不带进度条，所以没有播放动画可闪）。
          // 2026-11-18：改成“始终”先显示这个圆钮，与自动播放开关无关；
          // 用户手动点过一次之后，才展开原生控件（进度条/音量），并记住这个状态（同一个 <audio> 元素复用）。
          const expanded=media.dataset.expanded==='1';
          media.controls=expanded;
          if(!expanded){
            const play=document.createElement('button');
            play.type='button';play.className='media-play';play.textContent='▶';play.title=t('播放 / 重播（点开可调进度）');
            play.onclick=event=>{
              event.stopPropagation();
              media!.dataset.expanded='1';media!.controls=true;play.remove();
              const result=media!.play?.();if(result)void result.catch(()=>{});
            };
            wrapper.append(play);
          }
          wrapper.append(media);
          if(this.autoplay){
            media.dataset.autoPlayback='';
            startAutomaticPlayback(media);
          }
        }else{
          const link=document.createElement('a');
          link.textContent=filename;link.href=url;link.download=filename;
          wrapper.append(link);
        }
        view.requestMeasure();
      }).catch(()=>{wrapper.textContent=t('附件载入失败');});
    }
    const math=this.math;
    if(math)wrapper.onmousedown=event=>{
      if(view.state.readOnly||event.button!==0||event.shiftKey||event.ctrlKey||event.metaKey)return;
      event.preventDefault();
      const delimiter=this.value.startsWith('\\')||this.value.startsWith('$$')?2:1;
      // 2026-11-19：点公式内部，光标落在源码末尾（闭合符号之前），方便接着写
      view.dispatch({selection:{anchor:math.from+this.value.length-delimiter}});
      view.focus();
    };
    if(['link','media'].includes(this.type))wrapper.addEventListener('mousedown',event=>event.stopPropagation());
    return wrapper;
  }
  ignoreEvent():boolean {return ['link','media'].includes(this.type);}
  destroy(dom:HTMLElement):void {
    discardedWidgets.add(dom);
    for(const media of dom.querySelectorAll('audio,video')){
      const player=media as HTMLMediaElement;player.pause();
    }
    for(const image of dom.querySelectorAll('img'))image.removeAttribute('src');
  }
}

const codeLine=Decoration.line({class:'md-code-line'});
const firstCodeLine=Decoration.line({class:'md-code-line-start'});
const lastCodeLine=Decoration.line({class:'md-code-line-end'});
const hiddenCodeFence=Decoration.replace({});
const hiddenMarkdownMarker=Decoration.replace({});

/**
 * 2026-11-20：高亮棍。锚点区间跨行时，首行/末行各一根；同一条线上有多根时按顺序往左错开，
 * 让「重叠之外的部分」也能各自看见自己的棍。棍可上下拖动，拖动即改锚点边界（按行吸附）。
 */
class TaskCheckbox extends WidgetType {
  constructor(readonly from:number,readonly checked:boolean,readonly readOnly:boolean){
    super();
  }

  eq(other:TaskCheckbox):boolean{
    return this.from===other.from&&this.checked===other.checked&&this.readOnly===other.readOnly;
  }

  toDOM(view:EditorView):HTMLElement{
    const checkbox=view.dom.ownerDocument.createElement('input');
    checkbox.type='checkbox';
    checkbox.className='md-task-checkbox';
    checkbox.checked=this.checked;
    checkbox.disabled=this.readOnly;
    checkbox.setAttribute('aria-label',t(this.checked?'已完成任务':'未完成任务'));
    checkbox.addEventListener('mousedown',event=>event.preventDefault());
    checkbox.addEventListener('change',()=>{
      if(view.state.readOnly)return;
      view.dispatch({changes:{from:this.from+1,to:this.from+2,insert:checkbox.checked?'x':' '},userEvent:'input.task'});
    });
    return checkbox;
  }
}

class CodeBlockCopy extends WidgetType {
  constructor(readonly code:string,readonly language:string){
    super();
  }

  eq(other:CodeBlockCopy):boolean {
    return this.code===other.code&&this.language===other.language;
  }

  toDOM(view:EditorView):HTMLElement {
    const document=view.dom.ownerDocument;
    const button=document.createElement('button');
    button.type='button';
    button.className='md-code-copy';
    if(this.language){
      const label=document.createElement('span');
      label.className='md-code-language';
      label.textContent=this.language;
      button.append(label);
    }
    const glyph=document.createElement('span');
    button.append(glyph);
    const update=(label:string,iconName:'copy'|'check')=>{
      button.title=label;
      button.setAttribute('aria-label',label);
      setIcon(glyph,iconName);
    };
    const reset=()=>update(t('复制代码'),'copy');
    let timer=0;
    reset();
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',async()=>{
      try{
        await navigator.clipboard.writeText(this.code);
        update(t('已复制'),'check');
      }catch{
        update(t('复制失败'),'copy');
      }
      window.clearTimeout(timer);
      timer=window.setTimeout(reset,1500);
    });
    return button;
  }
}

const highlighting=HighlightStyle.define([
  {tag:tags.heading1,fontSize:'1.8em',fontWeight:'700'},
  {tag:tags.heading2,fontSize:'1.5em',fontWeight:'650'},
  {tag:tags.heading3,fontSize:'1.25em',fontWeight:'650'},
  {tag:tags.heading,fontWeight:'650'},
  {tag:tags.strong,fontWeight:'700'},
  {tag:tags.emphasis,fontStyle:'italic'},
  {tag:tags.strikethrough,textDecoration:'line-through'},
  {tag:tags.link,color:'var(--markdown-link)',textDecoration:'underline'},
  {tag:tags.monospace,fontFamily:'var(--font-monospace)',color:'var(--text-normal)'},
  {tag:tags.quote,color:'var(--text-muted)'},
  {tag:tags.processingInstruction,color:'var(--text-faint)'},
]);

const highlightDelimiter={resolve:'Highlight',mark:'HighlightMark'};

const indentationWidth=4;
function lastIndentGuideColumn(columns:number):number{
  return (Math.ceil(columns/indentationWidth)-1)*indentationWidth;
}
const wrappingMath=StateField.define<boolean>({
  create:()=>false,
  update(previous,tr){
    if(tr.isUserEvent('input.type.math'))return true;
    return previous&&!tr.docChanged&&(!tr.selection||tr.newSelection.eq(tr.startState.selection));
  },
});

function continueIndentedParagraph(view:EditorView):boolean{
  const {state}=view,{main}=state.selection;
  if(state.readOnly||!main.empty||!/^[ \t]/.test(state.doc.lineAt(main.head).text))return false;
  for(let node=syntaxTree(state).resolveInner(main.head,-1);node.parent;node=node.parent){
    if(/^(FencedCode|ListItem|Blockquote|Table|HTMLBlock)$/.test(node.name))return false;
  }
  return insertNewlineKeepIndent(view);
}

function changeIndentation(view:EditorView,outdent=false):boolean{
  const {state}=view;
  if(state.readOnly)return false;
  const width=state.facet(indentUnit).length;
  const update=state.changeByRange(range=>{
    const first=state.doc.lineAt(range.from),last=state.doc.lineAt(range.to);
    const endLine=last.number-(first.number<last.number&&range.to===last.from?1:0);
    const edits:Array<{from:number;to:number;insert:string}>=[];
    for(let number=first.number;number<=endLine;number++){
      const line=state.doc.line(number);
      const indent=/^[ \t]*/.exec(line.text)![0];
      const column=countColumn(indent,state.tabSize);
      const target=outdent?Math.max(0,column-(column%width||width)):column+width-column%width;
      let keep=0,keptColumn=0;
      while(keep<indent.length){
        const next=keptColumn+(indent[keep]==='\t'?state.tabSize-keptColumn%state.tabSize:1);
        if(next>target)break;
        keptColumn=next;keep++;
      }
      if(keep!==indent.length||keptColumn!==target)edits.push({
        from:line.from+keep,to:line.from+indent.length,insert:' '.repeat(target-keptColumn),
      });
    }
    const changes=state.changes(edits);
    if(range.empty)return {changes,range:EditorSelection.cursor(changes.mapPos(range.head,1))};
    const from=changes.mapPos(range.from,-1),to=changes.mapPos(range.to,1);
    return {changes,range:range.anchor<=range.head?EditorSelection.range(from,to):EditorSelection.range(to,from)};
  });
  view.dispatch({...update,userEvent:outdent?'delete.dedent':'input.indent',scrollIntoView:true});
  return true;
}

export class ReadingEditor {
  readonly view:EditorView;
  private options:EditorOptions;
  private readonly editability=new Compartment();
  private destroyed=false;
  private cursorFrame=0;
  private readonly mouseEvents=new AbortController();
  private mouseSelecting=false;
  private mousePress:{x:number;y:number;sourceMath:number|null}|null=null;
  private selectionFrame=0;

  /** 2026-11-20：锚点在文档里的位置（每次重绘更新），悬停时据此画把手。 */
  private anchorRanges=new Map<string,{from:number;to:number;type:string}>();
  /** 当前悬停的锚点 id；null 表示没悬停。 */
  private hoverAnchor:string|null=null;
  private draggingAnchor=false;
  private undoPending=false;
  private mousePoint:{x:number;y:number;target:Element|null}|null=null;

  constructor(host:HTMLElement,options:EditorOptions){
    this.options=options;
    const initial=options.document?.objects.length?options.document:readLegacyDocument(options.value);
    const decorationField=StateField.define<DecorationSet>({
      create:state=>this.decorations(state),
      update:(old,tr)=>tr.docChanged||tr.selection||tr.effects.some(effect=>effect.is(redraw)||effect.is(setAttachmentObjects))
        ||syntaxTree(tr.startState)!==syntaxTree(tr.state)?this.decorations(tr.state):old,
      provide:field=>EditorView.decorations.from(field),
    });
    const extensions=[
      history(),focusedField,wrappingMath,this.editability.of(this.modeExtensions()),EditorView.lineWrapping,markdown({base:markdownLanguage,extensions:{
        // Users indent paragraphs with Tab. Fences explicitly mark source code.
        remove:['IndentedCode'],
        defineNodes:['Highlight','HighlightMark'],
        parseInline:[{name:'Highlight',parse(cx,next,at){
          if(next!==61||cx.char(at+1)!==61||cx.char(at-1)===61||cx.char(at+2)===61)return -1;
          return cx.addDelimiter(highlightDelimiter,at,at+2,!/\s/.test(String.fromCharCode(cx.char(at+2))),!/\s/.test(String.fromCharCode(cx.char(at-1))));
        }}],
      }}),syntaxHighlighting(highlighting),attachmentField.init(()=>initial.objects),decorationField,dropCursor(),
      invertedEffects.of(tr=>tr.startState.field(attachmentField)!==tr.state.field(attachmentField)?[setAttachmentObjects.of(tr.startState.field(attachmentField))]:[]),
      EditorView.atomicRanges.of(view=>view.state.field(decorationField).update({
        filter:(_from,_to,value)=>value===hiddenMarkdownMarker||value.spec.widget?.type==='media',
      })),
      EditorState.transactionFilter.of(tr=>this.undoPending&&!tr.isUserEvent('undo.workspace')&&
        (tr.docChanged||tr.effects.some(effect=>effect.is(setAttachmentObjects)))?[]:tr),
      EditorState.phrases.of({
        'Control character':t('控制字符'),'close':t('关闭'),'Fold line':t('折叠行'),'Unfold line':t('展开行'),
        'Folded lines':t('已折叠行'),'Unfolded lines':t('已展开行'),'to':t('至'),
        'folded code':t('已折叠代码'),'unfold':t('展开'),
      }),
      EditorView.contentAttributes.of({'aria-label':options.label,spellcheck:'false',tabindex:'0'}),
      EditorState.tabSize.of(indentationWidth),indentUnit.of(' '.repeat(indentationWidth)),
      keymap.of([
        {key:'Enter',run:continueIndentedParagraph},
        {key:'Tab',run:view=>changeIndentation(view),shift:view=>changeIndentation(view,true)},
        ...defaultKeymap,...historyKeymap,
      ]),
      EditorView.inputHandler.of((view,from,to,input)=>{
        if(view.state.readOnly||input!=='$'||from===to||view.composing)return false;
        const selection=view.state.selection.main;
        if(from!==selection.from||to!==selection.to)return false;
        view.dispatch({changes:[{from,insert:'$'},{from:to,insert:'$'}],
          selection:EditorSelection.single(selection.anchor+1,selection.head+1),userEvent:'input.type.math'});
        return true;
      }),
      EditorView.updateListener.of(update=>{
        // 每次重绘后检查高亮棍有没有顶到左边缘：顶到了就先把 ">" 藏起来，只留 "|"
        if(update.transactions.some(tr=>tr.isUserEvent('undo.workspace')))return;
        const objects=update.state.field(attachmentField);
        if(update.docChanged||objects!==update.startState.field(attachmentField)){
          const document={text:update.state.doc.toString(),objects};
          options.onChange(projectDocument(document),update.transactions.every(tr=>tr.isUserEvent('input.type')),document);
        }
      }),
      EditorView.domEventHandlers({
        focus:(_,view)=>{queueMicrotask(()=>{if(!this.destroyed)view.dispatch({effects:[focusChanged.of(true),redraw.of()]});});return false;},
        blur:(_,view)=>{queueMicrotask(()=>{if(!this.destroyed)view.dispatch({effects:[focusChanged.of(false),redraw.of()]});});return false;},
        // Ctrl（macOS 为 Cmd）+ 点击摘录/检测卡高亮 → 打开对应卡片（类似 Obsidian 的 Ctrl+点击链接）
        mousedown:(event)=>{
          if(event.button===0&&event.ctrlKey&&(event.target as Element)?.closest('[data-editor-link]')){
            event.preventDefault();return true;
          }
          if(!event.ctrlKey&&!event.metaKey)return false;
          // 沿祖先链收集所有被点中的锚点；高亮被关掉时这些 mark 根本不存在，自然也跳不了
          const start=event.target as HTMLElement|null;
          const ids:string[]=[];let node:HTMLElement|null=start;
          while(node&&node!==this.view?.contentDOM){
            const id=node.getAttribute?.('data-anchor-node');
            if(id&&!ids.includes(id))ids.push(id);
            node=node.parentElement;
          }
          if(!ids.length)return false;
          event.preventDefault();event.stopPropagation();
          if(ids.length===1)this.options.onNavigate(ids[0]!);
          else if(this.options.onNavigateChoice)this.options.onNavigateChoice(ids,{x:event.clientX,y:event.clientY});
          else this.options.onNavigate(ids[0]!);
          return true;
        },
        click:(event)=>{
          const link=(event.target as Element)?.closest<HTMLElement>('[data-editor-link]');
          const url=link?.dataset.editorLink;
          if(!url)return false;
          event.preventDefault();
          if(event.button!==0||!event.ctrlKey)return true;
          if(fileLink.test(url))void window.reading.request('openFileLink',{url}).catch(error=>options.onError(error instanceof Error?error.message:String(error)));
          else window.open(url,'_blank','noopener,noreferrer');
          return true;
        },
        mousemove:event=>{
          this.view.dom.classList.toggle('is-link-modifier',event.ctrlKey);
          if(options.textOnlyCursor)this.updateMousePointer(event);
          return false;
        },
        mouseleave:()=>{this.clearMousePointer();return false;},
        contextmenu:(event,view)=>{
          if(view.state.readOnly)return false;
          const at=view.posAtCoords({x:event.clientX,y:event.clientY})??view.state.selection.main.head;
          event.preventDefault();
          options.onInsertMenu(event,()=>this.pickAttachments(at),()=>void this.insertFileLink(at));
          return true;
        },
        copy:event=>this.copyObjects(event,false),
        cut:event=>this.copyObjects(event,true),
        paste:event=>this.handleFiles(event.clipboardData?.files,event)||this.pasteObjects(event),
        drop:(event,view)=>{
          const files=event.dataTransfer?.files;
          if(!files?.length)return false;
          const position=view.posAtCoords({x:event.clientX,y:event.clientY});
          if(position!==null)view.dispatch({selection:{anchor:position}});
          return this.handleFiles(files,event);
        },
        dragover:event=>{
          if(Array.from(event.dataTransfer?.types||[]).includes('Files')){event.preventDefault();return true;}
          return false;
        },
      }),
    ];
    let state:EditorState;
    try{
      state=options.snapshot?.doc===initial.text
        ?EditorState.fromJSON(options.snapshot,{extensions},{history:historyField,attachments:attachmentField})
        :EditorState.create({doc:initial.text,extensions});
    }catch{state=EditorState.create({doc:initial.text,extensions});}
    this.view=new EditorView({state,parent:host});
    const {signal}=this.mouseEvents;
    const updateLinkModifier=(event:KeyboardEvent)=>this.view.dom.classList.toggle('is-link-modifier',event.ctrlKey);
    window.addEventListener('keydown',updateLinkModifier,{capture:true,signal});
    window.addEventListener('keyup',updateLinkModifier,{capture:true,signal});
    window.addEventListener('blur',()=>this.view.dom.classList.remove('is-link-modifier'),{signal});
    const finish=()=>{
      if(!this.mousePress)return;
      this.mousePress=null;
      this.mouseSelecting=false;
      this.scheduleSelectionRedraw();
    };
    this.view.contentDOM.addEventListener('mousedown',event=>{
      if(event.button!==0||event.ctrlKey||event.metaKey||this.view.state.readOnly||this.options.mode==='source')return;
      const x=event.clientX,y=event.clientY;
      const math=event.target instanceof Element&&event.target.closest('.math-source');
      this.mousePress={x,y,sourceMath:math?this.view.posAtCoords({x,y}):null};
    },{capture:true,signal});
    window.addEventListener('mousemove',event=>{
      const start=this.mousePress;
      if(!start)return;
      if(!(event.buttons&1)){finish();return;}
      if(this.mouseSelecting||Math.hypot(event.clientX-start.x,event.clientY-start.y)<3)return;
      this.mouseSelecting=true;
      this.scheduleSelectionRedraw();
    },{capture:true,signal});
    this.view.contentDOM.addEventListener('dragend',finish,{signal});
    window.addEventListener('mouseup',event=>{if(event.button===0)finish();},{capture:true,signal});
    window.addEventListener('pointercancel',finish,{signal});
    window.addEventListener('blur',finish,{signal});
  }


  private scheduleSelectionRedraw(){
    cancelAnimationFrame(this.selectionFrame);
    this.selectionFrame=requestAnimationFrame(()=>{
      this.selectionFrame=0;
      this.view.dispatch({effects:redraw.of()});
    });
  }

  private modeExtensions(){
    const mode=this.options.mode??'live';
    const readOnly=!!this.options.readOnly||mode==='reading';
    return [EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly),EditorView.editorAttributes.of({'data-editor-mode':mode})];
  }

  setMode(mode:EditorMode):void{
    if((this.options.mode??'live')===mode)return;
    this.options.mode=mode;
    this.view.dispatch({effects:[this.editability.reconfigure(this.modeExtensions()),redraw.of()]});
  }

  private updateMousePointer(event:MouseEvent):void {
    this.mousePoint={x:event.clientX,y:event.clientY,target:event.target instanceof Element?event.target:null};
    if(this.cursorFrame)return;
    this.cursorFrame=requestAnimationFrame(()=>{
      this.cursorFrame=0;
      if(this.destroyed||!this.mousePoint)return;
      const {x,y,target}=this.mousePoint;
      const interactive=target?.closest('a:not([data-editor-link]),button,input,textarea,audio,video,.reading-media');
      this.view.dom.classList.toggle('is-over-text',!interactive&&this.hitsText(x,y));
    });
  }

  private hitsText(x:number,y:number):boolean {
    const document=this.view.dom.ownerDocument;
    const caretDocument=document as Document&{
      caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;
      caretRangeFromPoint?:(x:number,y:number)=>Range|null;
    };
    const caret=caretDocument.caretPositionFromPoint?.(x,y);
    const legacy=caret?null:caretDocument.caretRangeFromPoint?.(x,y);
    const node=caret?.offsetNode||legacy?.startContainer;
    const offset=caret?.offset??legacy?.startOffset??0;
    if(!node||node.nodeType!==Node.TEXT_NODE||!this.view.contentDOM.contains(node))return false;
    const text=node.textContent||'',range=document.createRange();
    for(const index of [offset-1,offset]){
      if(index<0||index>=text.length)continue;
      range.setStart(node,index);range.setEnd(node,index+1);
      for(const rect of Array.from(range.getClientRects())){
        if(rect.width>0&&x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom)return true;
      }
    }
    return false;
  }

  private clearMousePointer():void {
    if(this.cursorFrame)cancelAnimationFrame(this.cursorFrame);
    this.cursorFrame=0;this.mousePoint=null;this.view?.dom.classList.remove('is-over-text');
  }

  private handleFiles(files:FileList|null|undefined,event:Event):boolean {
    if(this.view.state.readOnly)return false;
    if(!files?.length)return false;
    event.preventDefault();
    const {from,to}=this.view.state.selection.main;
    void this.insertFiles(Array.from(files),from,to,true);
    return true;
  }
  private pickAttachments(at:number):void{
    if(this.destroyed||this.view.state.readOnly)return;
    const input=document.createElement('input');
    input.type='file';input.multiple=true;input.hidden=true;
    input.addEventListener('change',()=>{
      const files=Array.from(input.files||[]);
      input.remove();
      if(files.length)void this.insertFiles(files,at,at,false);
    },{once:true});
    input.addEventListener('cancel',()=>input.remove(),{once:true});
    document.body.append(input);
    input.click();
  }
  private async insertFileLink(at:number):Promise<void>{
    const before=this.view.state.doc;
    try{
      const file=await window.reading.request<{name:string;url:string}|null>('pickFileLink');
      if(!file||this.destroyed||this.view.state.readOnly)return;
      if(this.view.state.doc!==before)at=this.view.state.selection.main.head;
      const name=file.name.replace(/[\r\n]/g,' ').replace(/[\\[\]`*_~!<&]/g,'\\$&');
      const insert='['+name+'](<'+file.url+'>)';
      this.view.dispatch({changes:{from:at,insert},selection:{anchor:at+insert.length},userEvent:'input'});
      this.view.focus();
    }catch(error){this.options.onError(error instanceof Error?error.message:String(error));}
  }

  private async insertFiles(files:File[],from:number,to:number,replace:boolean):Promise<void>{
    if(this.destroyed||this.view.state.readOnly)return;
    const before=this.view.state.doc;
    try{
      const filesInLibrary=await this.options.onAttachments(files);
      if(this.destroyed||this.view.state.readOnly||!filesInLibrary.length)return;
      if(this.view.state.doc!==before){
        const selection=this.view.state.selection.main;
        from=replace?selection.from:selection.head;
        to=replace?selection.to:selection.head;
      }
      const insert='\n'+filesInLibrary.map(()=>attachmentCharacter).join('\n')+'\n';
      const objects=filesInLibrary.map((asset,index)=>({at:index*2+1,embed:{assetId:asset.id,display:'',boxes:[],mask:null}}));
      this.insertDocument(from,to,{text:insert,objects});
      this.view.focus();
    }catch(error){this.options.onError(error instanceof Error?error.message:String(error));}
  }

  private insertDocument(from:number,to:number,document:AttachmentDocument):void{
    const state=this.view.state;
    const changes=state.changes({from,to,insert:document.text});
    const objects=mapAttachments(state.field(attachmentField),changes)
      .concat(document.objects.map(entry=>({...entry,at:entry.at+from}))).sort((a,b)=>a.at-b.at);
    this.view.dispatch({changes,effects:setAttachmentObjects.of(objects),selection:{anchor:from+document.text.length},
      userEvent:'input.paste',annotations:isolateHistory.of('full')});
  }

  private copyObjects(event:ClipboardEvent,cut:boolean):boolean{
    const state=this.view.state,{from,to}=state.selection.main;
    const objects=state.field(attachmentField).filter(entry=>entry.at>=from&&entry.at<to)
      .map(entry=>({...entry,at:entry.at-from}));
    if(!objects.length||!event.clipboardData)return false;
    const text=state.doc.sliceString(from,to);
    event.preventDefault();
    event.clipboardData.setData('text/plain',text.replaceAll(attachmentCharacter,''));
    event.clipboardData.setData(clipboardAttachmentType,JSON.stringify({text,objects}));
    if(cut&&!state.readOnly)this.view.dispatch({changes:{from,to},userEvent:'delete.cut',annotations:isolateHistory.of('full')});
    return true;
  }

  private pasteObjects(event:ClipboardEvent):boolean{
    if(this.view.state.readOnly)return false;
    const raw=event.clipboardData?.getData(clipboardAttachmentType);
    if(!raw)return false;
    let document:AttachmentDocument;
    try{document=JSON.parse(raw) as AttachmentDocument;}catch{return false;}
    if(!validAttachmentDocument(document))return false;
    event.preventDefault();
    const {from,to}=this.view.state.selection.main;
    this.insertDocument(from,to,document);
    return true;
  }

  private decorations(state:EditorState):DecorationSet {
    const text=state.doc.toString(),selection=state.selection.main,objects=state.field(attachmentField);
    const tree=syntaxTree(state);
    const sourceMode=this.options.mode==='source';
    const editing=!state.readOnly&&state.field(focusedField)&&!this.mouseSelecting;
    const head=selection.head;
    // A caret next to a closing delimiter is still at the formatted span's end.
    const inside=(from:number,to:number,includeStart=false)=>editing&&selection.empty&&(includeStart?head>=from:head>from)&&head<=to;
    const touches=(from:number,to:number)=>!selection.empty&&selection.from<to&&selection.to>from;
    const selectedMarker=(from:number,to:number)=>editing&&touches(from,to);
    const result:DecorationRange<Decoration>[]=[];
    const replaced:Array<[number,number]>=[];
    const listMarkerLines=new Set<number>();
    const overlaps=(from:number,to:number)=>replaced.some(([a,b])=>from<b&&to>a);
    const within=(position:number,names:RegExp)=>{
      for(let syntax=tree.resolveInner(position,1);syntax.parent;syntax=syntax.parent){
        if(names.test(syntax.name))return true;
      }
      return false;
    };
    const inCode=(position:number)=>within(position,/Code|HTMLBlock/);
    const addRich=(from:number,to:number,type:RichWidget['type'],value:string,block=false,showSource=false,object?:AttachmentObject,quotePrefix?:RegExp)=>{
      const formulaStart=type==='math'?from+text.slice(from,to).indexOf(value):from;
      if(overlaps(from,to)||(type!=='media'&&(sourceMode||inCode(formulaStart))))return;
      let math:RichWidget['math'];
      if(type==='math'){
        const fence=value.startsWith('$$')||value.startsWith('\\')?2:1;
        let formula=value.slice(fence,-fence);
        if(quotePrefix)formula=formula.split('\n').map((line,index)=>index?line.replace(quotePrefix,''):line).join('\n');
        math={from:formulaStart,block,formula,quoted:!!quotePrefix,
          indent:block&&!quotePrefix?countColumn(text.slice(from,formulaStart),state.tabSize):0};
      }
      if(showSource){
        if(math){
          result.push(Decoration.mark({class:'math-source'}).range(from,to));
          for(const token of value.matchAll(/\\[A-Za-z]+|\\[()[\]]|\$\$?|[{}]|\d+(?:\.\d+)?/g)){
            const text=token[0],className=/^\\[A-Za-z]/.test(text)?'math-command':/^\d/.test(text)?'math-number':/[{}]/.test(text)?'math-brace':'md-syntax-marker';
            result.push(Decoration.mark({class:className}).range(math.from+token.index!,math.from+token.index!+text.length));
          }
        }
        return;
      }
      const widget=new RichWidget(type,value,this.options.onNavigate,!!this.options.audioAutoplay,
        this.options.onImageContext,object,type==='media'&&state.readOnly,math);
      result.push(Decoration.replace({widget,block}).range(from,to));
      replaced.push([from,to]);
    };
    for(const object of objects){
      const {at}=object,line=state.doc.lineAt(at),block=line.text===attachmentCharacter;
      addRich(at,at+1,'media','',block,false,object);
    }
    // Render inactive tables as a whole before replacing individual math spans.
    if(!sourceMode)tree.iterate({enter:node=>{
      if(node.name==='Table'&&!overlaps(node.from,node.to)){
        let source=inside(node.from,node.to,true);
        if(!source&&editing&&touches(node.from,node.to))node.node.cursor().iterate(part=>{
          if(source||!touches(part.from,part.to))return false;
          if(part.name==='TableDelimiter')source=true;
        });
        if(!source){
          addRich(node.from,node.to,'markdown',text.slice(node.from,node.to),true);
          return false;
        }
      }
    }});
    for(const match of text.matchAll(/\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$\$[\s\S]+?\$\$|(?<![\\$])\$(?!\$)[^\n$]+?\$(?!\$)/g)){
      const from=match.index!,to=from+match[0].length;
      if(within(from,/^Link$/))continue;
      const first=state.doc.lineAt(from),last=state.doc.lineAt(to);
      const display=match[0].startsWith('$$')||match[0].startsWith('\\[');
      const leading=text.slice(first.from,from),trailing=text.slice(to,last.to);
      let quotePrefix:RegExp|undefined;
      if(display&&/^[ \t]*(?:>[ \t]*)+$/.test(leading)&&within(from,/^Blockquote$/)){
        const depth=leading.match(/>/g)!.length;
        const prefix=new RegExp('^(?:[ \t]*>[ \t]?){'+depth+'}');
        if(!trailing.trim()&&match[0].split('\n').slice(1).every(line=>prefix.test(line)))quotePrefix=prefix;
      }
      const block=display&&!trailing.trim()&&(!leading.trim()||!!quotePrefix);
      const start=block?first.from:from,end=block?last.to:to;
      const fence=match[0].startsWith('$$')||match[0].startsWith('\\')?2:1;
      const sourceMath=this.mousePress?.sourceMath;
      const draggingSource=sourceMath!=null&&sourceMath>=start&&sourceMath<=end;
      const editingSelection=editing&&!selection.empty&&[selection.anchor,head].some(at=>at>from&&at<to);
      const active=inside(start,end,block)||selectedMarker(from,from+fence)||selectedMarker(to-fence,to)||draggingSource||editingSelection||
        // 2026-11-19：只要选区跨过公式就展开源码（拖动框选时也要能选中公式内部，不限于编辑态）
        touches(start,end)||(editing&&state.field(wrappingMath)&&touches(from,to));
      addRich(start,end,'math',match[0],block,active,undefined,quotePrefix);
    }
    if(!sourceMode)tree.iterate({enter:node=>{
      if(node.name==='HorizontalRule'&&!inside(node.from,node.to,true)&&!selectedMarker(node.from,node.to)&&!overlaps(node.from,node.to)){
        result.push(Decoration.line({class:'md-rule'}).range(state.doc.lineAt(node.from).from),Decoration.replace({}).range(node.from,node.to));
        return false;
      }
      if(node.name==='Blockquote'){
        const first=state.doc.lineAt(node.from),last=state.doc.lineAt(node.to);
        for(let line=first.number;line<=last.number;line++)result.push(Decoration.line({class:'md-quote'}).range(state.doc.line(line).from));
      }
      if(node.name==='FencedCode'){
        const block=node.node;
        const [opening,closing]=block.getChildren('CodeMark');
        if(!opening)return false;

        const first=state.doc.lineAt(opening.from),last=state.doc.lineAt(block.to);
        for(let number=first.number;number<=last.number;number++){
          result.push(codeLine.range(state.doc.line(number).from));
        }
        result.push(firstCodeLine.range(first.from),lastCodeLine.range(last.from));

        // Keep each source line editable so clicks, arrow keys and selections use CodeMirror's positions.
        const active=inside(first.from,last.to,true)||selectedMarker(opening.from,first.to)||
          (!!closing&&selectedMarker(closing.from,last.to));
        if(!active){
          result.push(hiddenCodeFence.range(opening.from,first.to));
          if(closing)result.push(hiddenCodeFence.range(closing.from,last.to));

          const code=block.getChildren('CodeText').map(part=>text.slice(part.from,part.to)).join('');
          const info=block.getChild('CodeInfo');
          const language=info?text.slice(info.from,info.to).split(/\s+/,1)[0]:'';
          result.push(Decoration.widget({widget:new CodeBlockCopy(code,language),side:1}).range(first.to));
        }
        return false;
      }
      if(node.name==='Table'&&replaced.some(([from,to])=>from===node.from&&to===node.to))return false;
      if(node.name==='Link'){
        const markers=node.node.getChildren('LinkMark');
        const [open,close,paren]=markers;
        const target=node.node.getChild('URL');
        if(open&&close&&paren&&target){
          if(text.slice(node.from,node.to).includes('\n')){
            result.push(Decoration.mark({class:'plain-bracket-text'}).range(node.from,node.to));
            return false;
          }
          const address=text.slice(target.from,target.to).replace(/^<|>$/g,'').replace(/\\([()])/g,'$1');
          const url=externalUrl(address);
          if(url&&open.to<close.from&&!overlaps(node.from,node.to)){
            const source=inside(node.from,node.to)||markers.some(mark=>selectedMarker(mark.from,mark.to))||selectedMarker(close.from,node.to);
            result.push(Decoration.mark({class:source?'md-editor-link':'md-editor-link md-editor-link-preview',
              attributes:{'data-editor-link':url}}).range(open.to,close.from));
            if(!source)result.push(hiddenMarkdownMarker.range(open.from,open.to),hiddenMarkdownMarker.range(close.from,node.to));
          }
        }
      }
      // `[文字]` 这类没有 URL 的方括号不该按链接着色（本项目没有双链，方括号就是普通字符）。
      // 外部链接和附件由各自的控件渲染。
      if(node.name==='Link'&&!node.node.getChild('URL')&&!overlaps(node.from,node.to)&&text[node.to]!=='('&&!inside(node.from,node.to)){
        result.push(Decoration.mark({class:'plain-bracket-text'}).range(node.from,node.to));
      }
      if(node.name==='InlineCode'&&!overlaps(node.from,node.to)){
        result.push(Decoration.mark({class:'md-inline-code'}).range(node.from,node.to));
      }
      if(node.name==='Highlight'&&!overlaps(node.from,node.to)){
        result.push(Decoration.mark({class:'md-highlight'}).range(node.from,node.to));
      }
      if(node.name==='Task'){
        const marker=node.node.getChild('TaskMarker'),bullet=node.node.parent?.getChild('ListMark');
        if(marker&&bullet&&!overlaps(bullet.from,marker.to)&&!inside(bullet.from,marker.to,true)&&!selectedMarker(bullet.from,marker.to)){
          const checked=/x/i.test(text[marker.from+1]);
          const widget=new TaskCheckbox(marker.from,checked,state.readOnly);
          result.push(Decoration.replace({widget}).range(bullet.from,marker.to));
          if(checked&&marker.to<node.to)result.push(Decoration.mark({class:'md-task-done'}).range(marker.to,node.to));
        }
      }
      if(node.name==='ListMark'){
        listMarkerLines.add(state.doc.lineAt(node.from).from);
        const item=node.node.parent;
        if(item?.parent?.name==='BulletList'&&!item.getChild('Task')&&!overlaps(node.from,node.to)&&
          !inside(node.from,node.to,true)&&!selectedMarker(node.from,node.to)){
          result.push(Decoration.mark({class:'md-list-bullet'}).range(node.from,node.to));
        }
      }
      if(['HeaderMark','EmphasisMark','CodeMark','HighlightMark','StrikethroughMark','QuoteMark'].includes(node.name)&&!overlaps(node.from,node.to)){
        const parent=node.node.parent||node.node;
        let end=node.to;
        if((node.name==='HeaderMark'||node.name==='QuoteMark')&&text[end]===' ')end++;
        const show=inside(parent.from,parent.to)||(editing&&touches(parent.from,parent.to)&&
          parent.getChildren(node.name).some(mark=>selectedMarker(mark.from,mark.to)));
        result.push((show?Decoration.mark({class:'md-syntax-marker'}):hiddenMarkdownMarker).range(node.from,end));
      }
    }});
    for(const match of text.matchAll(/\[(?:\.\.\.|…)\]/g)){
      const from=match.index!,to=from+match[0].length;
      if(!overlaps(from,to)&&!inCode(from))result.push(Decoration.mark({class:'plain-cloze-placeholder'}).range(from,to));
    }
    let lineStart=0;
    for(const line of state.doc.iterLines()){
      if(!overlaps(lineStart,lineStart+1)){
        const leading=/^[ \t]+/.exec(line)?.[0];
        if(leading){
          const columns=countColumn(leading,state.tabSize);
          const lastGuide=lastIndentGuideColumn(columns);
          result.push(Decoration.line({class:lastGuide>=0&&!listMarkerLines.has(lineStart)?'md-indent-guide md-wrap-indent':'md-wrap-indent',
            attributes:{style:'--md-indent-size:'+columns+';--md-guide-last-column:'+lastGuide},
          }).range(lineStart));
        }
      }
      lineStart+=line.length+1;
    }
    const source=this.options.anchors.length?projectDocument({text,objects}):text;
    // 先把能定位的锚点算出来，第二步再画（棍要按「同一行有几根」错开，需要彼此的区间）
    const placed:Array<{anchor:Anchor;type:string;from:number;to:number}>=[];
    for(const anchor of this.options.anchors){
      if(anchor.section&&anchor.section!==this.options.section)continue;
      const type=anchor.highlight||'extract';if(this.options.highlights?.[type]===false)continue;
      const start=locateAnchor(source,anchor);
      const from=documentOffset(objects,start),to=documentOffset(objects,start+anchor.quote.length,true);
      // 同一段文字可能有多条锚点（重复摘录/检测卡），这里不去重，让点击时能列出候选卡片
      if(from<0||to<=from)continue;
      placed.push({anchor,type,from,to});
      result.push(Decoration.mark({class:'irtree-extracted irtree-extracted-'+type,
        // 把目标节点 id 写到 DOM 上，配合 Ctrl+点击跳转
        attributes:anchor.nodeId?{'data-anchor-node':anchor.nodeId}:undefined}).range(from,to));
    }
    return Decoration.set(result,true);
  }

  focus():void {this.view.focus();}
  snapshot():any {return this.view.state.toJSON({history:historyField,attachments:attachmentField});}

  setUndoPending(pending:boolean){this.undoPending=pending;}

  restoreDocument(document:AttachmentDocument){
    const view=this.view,before=view.state.doc.toString(),after=document.text;
    let from=0,end=0;
    while(from<before.length&&from<after.length&&before[from]===after[from])from++;
    while(end<before.length-from&&end<after.length-from&&before[before.length-1-end]===after[after.length-1-end])end++;
    const change=ChangeSet.of({from,to:before.length-end,insert:after.slice(from,after.length-end)},before.length);
    const scroll=view.scrollSnapshot().map(change);
    const effects=[setAttachmentObjects.of(document.objects),...(scroll?[scroll]:[])];
    view.dispatch({changes:change,selection:view.state.selection.map(change),effects,
      annotations:Transaction.addToHistory.of(false),userEvent:'undo.workspace'});
  }
  selectedText():string{
    const {state}=this.view,{from,to}=state.selection.main;
    return state.doc.sliceString(from,to).replaceAll(attachmentCharacter,'');
  }
  sourcePosition(at:number):number{return projectedOffset(this.view.state.field(attachmentField),at);}
  editorPosition(at:number):number{return documentOffset(this.view.state.field(attachmentField),at);}
  /** 选区两侧切换 `**加粗**` / `*斜体*`（Ctrl+B / Ctrl+I）。已包裹则去掉。 */
  toggleWrap(marker:string):void{
    const view=this.view;
    if(view.state.readOnly)return;
    const {from,to}=view.state.selection.main;
    const doc=view.state.doc.toString();
    if(from===to){
      const insert=marker+marker;
      view.dispatch({changes:{from,to,insert},selection:{anchor:from+marker.length},userEvent:'input.format',annotations:isolateHistory.of('full')});
      view.focus();return;
    }
    const selected=doc.slice(from,to);
    const outsideBefore=doc.slice(Math.max(0,from-marker.length),from),outsideAfter=doc.slice(to,to+marker.length);
    if(outsideBefore===marker&&outsideAfter===marker){
      view.dispatch({changes:[{from:from-marker.length,to:from,insert:''},{from:to,to:to+marker.length,insert:''}],
        selection:{anchor:from-marker.length,head:to-marker.length},userEvent:'input.format',annotations:isolateHistory.of('full')});
      view.focus();return;
    }
    if(selected.length>=marker.length*2&&selected.startsWith(marker)&&selected.endsWith(marker)){
      const inner=selected.slice(marker.length,-marker.length);
      view.dispatch({changes:[{from,to:from+marker.length},{from:to-marker.length,to}],selection:{anchor:from,head:from+inner.length},userEvent:'input.format',annotations:isolateHistory.of('full')});
      view.focus();return;
    }
    view.dispatch({changes:[{from,insert:marker},{from:to,insert:marker}],selection:{anchor:from+marker.length,head:to+marker.length},
      userEvent:'input.format',annotations:isolateHistory.of('full')});
    view.focus();
  }
  setMediaVisible(visible:boolean):void{
    for(const media of this.view.dom.querySelectorAll<HTMLMediaElement>('audio,video')){
      if(!visible){media.pause();autoplayStarted.delete(media);}
      else if(media.hasAttribute('data-auto-playback'))startAutomaticPlayback(media);
    }
  }
  setAnchors(anchors:Anchor[]):void {this.options.anchors=anchors;this.view.dispatch({effects:redraw.of()});}
  setHighlights(value:{extract:boolean;cloze:boolean}){this.options.highlights=value;this.view.dispatch({effects:redraw.of()});}
  selectSource(anchor:Anchor):boolean {
    const {state}=this.view;
    const source=projectDocument({text:state.doc.toString(),objects:state.field(attachmentField)});
    const start=locateAnchor(source,anchor);
    if(start<0)return false;
    const at=this.editorPosition(start);
    this.view.dispatch({selection:{anchor:at,head:at+anchor.quote.length},effects:EditorView.scrollIntoView(at,{y:'center'})});
    this.view.focus();return true;
  }
  destroy():void {
    this.destroyed=true;
    this.mouseEvents.abort();
    cancelAnimationFrame(this.selectionFrame);
    this.clearMousePointer();
    this.view.destroy();
  }
}
