import { t } from '../core/i18n';
import { EditorState, MapMode, StateEffect, StateField, type ChangeDesc, type Range as DecorationRange } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, dropCursor, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyField, historyKeymap, invertedEffects, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import katex from 'katex';
// N12（1.87）：加载 mhchem 扩展，支持化学式 \ce{} 与单位 \pu{}（KaTeX 官方扩展，副作用导入即注册）
import 'katex/contrib/mhchem';
import { locateAnchor } from '../core/card';
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

export interface EditorOptions {
  value:string;
  document?:AttachmentDocument;
  label:string;
  section:'question'|'answer';
  anchors:Anchor[];
  highlights?:{extract:boolean;cloze:boolean};
  textOnlyCursor?:boolean;
  readOnly?:boolean;
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
}
const renderer=new MarkdownIt({html:true,linkify:true,breaks:true});
const fileLink=/^file:\/\//i;
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

function decorateExternalLink(link:HTMLAnchorElement,url:string,onError:(message:string)=>void):void{
  link.href=url;
  if(!link.title)link.title=url;
  link.target='_blank';
  link.rel='noopener noreferrer';
  const marker=document.createElement('span');
  marker.className='external-link-mark';
  marker.textContent='↗';
  marker.setAttribute('aria-hidden','true');
  link.append(marker);
  if(fileLink.test(url))link.addEventListener('click',event=>{
    event.preventDefault();
    void window.reading.request('openFileLink',{url}).catch(error=>onError(error instanceof Error?error.message:String(error)));
  });
}

interface ExternalLink {url:string;label:string}
const assets=new Map<string,Promise<Asset>>();
const discardedWidgets=new WeakSet<HTMLElement>();
// 音频/视频播放器按附件 id 复用，切卡片时不重建（避免控件动画重播的闪）
const mediaCache=new Map<string,HTMLMediaElement>();
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
  constructor(readonly type:'math'|'markdown'|'media'|'link'|'external',readonly value:string,
    readonly onNavigate:(id:string)=>void,readonly onError:(message:string)=>void,
    readonly autoplay=false,readonly onImageContext?:EditorOptions['onImageContext'],readonly external?:ExternalLink,readonly attachment?:AttachmentObject){
    super();
  }
  eq(other:RichWidget):boolean { return this.type===other.type&&this.value===other.value&&this.autoplay===other.autoplay&&
    this.attachment?.at===other.attachment?.at&&this.attachment?.embed===other.attachment?.embed; }
  toDOM(view:EditorView):HTMLElement {
    const wrapper=document.createElement('span');
    wrapper.className='reading-rich reading-rich-'+this.type;
    if(this.type==='math'){
      const display=this.value.startsWith('$$')||this.value.startsWith('\\[');
      const delimiterLength=this.value.startsWith('\\')||this.value.startsWith('$$')?2:1;
      const formula=this.value.slice(delimiterLength,-delimiterLength);
      try{wrapper.innerHTML=katex.renderToString(formula,{displayMode:display,throwOnError:false,strict:false});}
      catch{wrapper.textContent=this.value;}
    }else if(this.type==='markdown'){
      wrapper.innerHTML=DOMPurify.sanitize(renderer.render(this.value));
      for(const link of wrapper.querySelectorAll('a')){
        const url=externalUrl(link.dataset.fileLink||link.getAttribute('href')||'');
        if(url)decorateExternalLink(link,url,this.onError);
      }
    }else if(this.type==='external'&&this.external){
      const link=document.createElement('a');
      link.innerHTML=DOMPurify.sanitize(renderer.renderInline(this.external.label),{ALLOWED_TAGS:['code','em','strong'],ALLOWED_ATTR:[]});
      decorateExternalLink(link,this.external.url,this.onError);
      wrapper.append(link);
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
          handle.hidden=view.state.readOnly;
        }else if(asset.mime.startsWith('audio/')||asset.mime.startsWith('video/')){
          // 播放器按附件 id 缓存复用——切卡片时不再销毁重建，避免控件重新加载/动画重播造成的闪。
          const tag=asset.mime.startsWith('audio/')?'audio':'video';
          let media=mediaCache.get(asset.id);
          if(!media||media.tagName.toLowerCase()!==tag){
            media=document.createElement(tag);media.controls=true;media.preload='metadata';media.src=url;
            if(media instanceof HTMLVideoElement){media.style.width='640px';media.style.aspectRatio='16 / 9';}
            media.onloadedmetadata=()=>view.requestMeasure();
            mediaCache.set(asset.id,media);
            if(mediaCache.size>24)mediaCache.delete(mediaCache.keys().next().value!);
          }
          // 全局开关打开时自动播放。
          // 照 Anki 的做法——自动播放时只显示一个圆形 ▶ 按钮（不带进度条，所以没有播放动画可闪）；
          // 想重播/拖进度时点它，才展开原生控件。
          if(this.autoplay){
            media.autoplay=true;
            media.controls=false;
            const play=document.createElement('button');
            play.type='button';play.className='media-play';play.textContent='▶';play.title=t('播放 / 重播（点开可调进度）');
            play.onclick=event=>{event.stopPropagation();media!.controls=true;play.remove();const result=media!.play?.();if(result)void result.catch(()=>{});};
            wrapper.append(play);
            // 清掉 旧版 的 220ms 延迟自动播放（当时为防闪加的补丁；播放器缓存复用已经解决闪，
            // 保留 preload=metadata 和 canplay 重试即可）。
            const startPlayback=()=>{const result=media!.play?.();if(result)void result.catch(()=>{media!.addEventListener('canplay',()=>void media!.play?.().catch(()=>{}),{once:true});});};
            startPlayback();
          }
          wrapper.append(media);
        }else{
          const link=document.createElement('a');
          link.textContent=filename;link.href=url;link.download=filename;
          wrapper.append(link);
        }
        view.requestMeasure();
      }).catch(()=>{wrapper.textContent=t('附件载入失败');});
    }
    if(this.type==='math')wrapper.onmousedown=event=>{
      if(view.state.readOnly||event.button!==0)return;
      event.preventDefault();const near=view.posAtDOM(wrapper),text=view.state.doc.toString();
      const positions=[...text.matchAll(new RegExp(this.value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))].map(match=>match.index!);
      const at=positions.sort((a,b)=>Math.abs(a-near)-Math.abs(b-near))[0];
      if(at!==undefined){view.dispatch({selection:{anchor:at+(this.value.startsWith('\\')||this.value.startsWith('$$')?2:1)}});view.focus();}
    };
    if(['link','external','media'].includes(this.type))wrapper.addEventListener('mousedown',event=>event.stopPropagation());
    return wrapper;
  }
  ignoreEvent():boolean {return ['link','external','media'].includes(this.type);}
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
  {tag:tags.link,color:'var(--text-accent)',textDecoration:'underline'},
  {tag:tags.monospace,fontFamily:'Consolas,monospace',color:'var(--code-color)'},
  {tag:tags.quote,color:'var(--text-muted)'},
  {tag:tags.processingInstruction,color:'var(--text-faint)'},
]);

export class ReadingEditor {
  readonly view:EditorView;
  private options:EditorOptions;
  private destroyed=false;
  private cursorFrame=0;
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
      history(),focusedField,EditorState.readOnly.of(!!options.readOnly),EditorView.editable.of(!options.readOnly),EditorView.lineWrapping,markdown({base:markdownLanguage}),syntaxHighlighting(highlighting),attachmentField.init(()=>initial.objects),decorationField,dropCursor(),
      invertedEffects.of(tr=>tr.startState.field(attachmentField)!==tr.state.field(attachmentField)?[setAttachmentObjects.of(tr.startState.field(attachmentField))]:[]),
      EditorView.atomicRanges.of(view=>view.state.field(decorationField).update({filter:(_from,_to,value)=>value.spec.widget?.type==='media'})),
      EditorState.phrases.of({
        'Control character':t('控制字符'),'close':t('关闭'),'Fold line':t('折叠行'),'Unfold line':t('展开行'),
        'Folded lines':t('已折叠行'),'Unfolded lines':t('已展开行'),'to':t('至'),
        'folded code':t('已折叠代码'),'unfold':t('展开'),
      }),
      EditorView.contentAttributes.of({'aria-label':options.label,spellcheck:'false',tabindex:'0'}),
      keymap.of([...defaultKeymap,...historyKeymap]),
      EditorView.updateListener.of(update=>{
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
        mousemove:event=>{
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
  }

  private updateMousePointer(event:MouseEvent):void {
    this.mousePoint={x:event.clientX,y:event.clientY,target:event.target instanceof Element?event.target:null};
    if(this.cursorFrame)return;
    this.cursorFrame=requestAnimationFrame(()=>{
      this.cursorFrame=0;
      if(this.destroyed||!this.mousePoint)return;
      const {x,y,target}=this.mousePoint;
      const interactive=target?.closest('a,button,input,textarea,audio,video,.reading-media');
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
    if(this.options.readOnly)return false;
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
    const editing=!state.readOnly&&state.field(focusedField);
    // 光标落在公式边界也算"编辑中"（±1 字符容差）。
    // 原因：光标在 `\]` 右侧时旧逻辑判定为公式外 → 立刻渲染，导致 `]` 永远点不到、
    // 也没法把光标放到公式末尾。Obsidian 的体验是"点渲染块先进入源码，离开一点才恢复渲染"。
    const inside=(from:number,to:number)=>editing&&
      (selection.empty?selection.from>=from-1&&selection.from<=to+1:selection.from<=to+1&&selection.to>=from-1);
    const result:DecorationRange<Decoration>[]=[];
    const replaced:Array<[number,number]>=[];
    const overlaps=(from:number,to:number)=>replaced.some(([a,b])=>from<b&&to>a);
    const within=(position:number,names:RegExp)=>{
      for(let syntax=syntaxTree(state).resolveInner(position,1);syntax.parent;syntax=syntax.parent){
        if(names.test(syntax.name))return true;
      }
      return false;
    };
    const inCode=(position:number)=>within(position,/Code|HTMLBlock/);
    const addRich=(from:number,to:number,type:RichWidget['type'],value:string,block=false,external?:ExternalLink,object?:AttachmentObject)=>{
      if(overlaps(from,to)||(type!=='media'&&inCode(from)))return;
      const widget=new RichWidget(type,value,this.options.onNavigate,this.options.onError,!!this.options.audioAutoplay,this.options.onImageContext,external,object);
      if(type!=='media'&&inside(from,to)){
        if(type==='math'){
          result.push(Decoration.mark({class:'math-source'}).range(from,to));
          for(const token of value.matchAll(/\\[A-Za-z]+|\\[()[\]]|\$\$?|[{}]|\d+(?:\.\d+)?/g)){
            const text=token[0],className=/^\\[A-Za-z]/.test(text)?'math-command':/^\d/.test(text)?'math-number':/[{}]/.test(text)?'math-brace':'md-syntax-marker';
            result.push(Decoration.mark({class:className}).range(from+token.index!,from+token.index!+text.length));
          }
        }
        return;
      }
      result.push(Decoration.replace({widget,block}).range(from,to));
      replaced.push([from,to]);
    };
    for(const object of objects){
      const {at}=object,line=state.doc.lineAt(at),block=line.text===attachmentCharacter;
      addRich(at,at+1,'media','',block,undefined,object);
    }
    for(const match of text.matchAll(/\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$\$[\s\S]+?\$\$|(?<![\\$])\$(?!\$)[^\n$]+?\$(?!\$)/g)){
      const from=match.index!,to=from+match[0].length;
      if(within(from,/^Link$/))continue;
      const first=state.doc.lineAt(from),last=state.doc.lineAt(to);
      const block=(match[0].startsWith('$$')||match[0].startsWith('\\['))&&text.slice(first.from,last.to).trim()===match[0];
      addRich(block?first.from:from,block?last.to:to,'math',match[0],block);
    }
    syntaxTree(state).iterate({enter:node=>{
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
        const active=editing&&selection.from<=last.to&&selection.to>=first.from;
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
      if(node.name==='Table'&&!inside(node.from,node.to)&&!overlaps(node.from,node.to)){
        addRich(node.from,node.to,'markdown',text.slice(node.from,node.to),true);
        return false;
      }
      if(node.name==='Link'){
        const [open,close,paren]=node.node.getChildren('LinkMark');
        const target=node.node.getChild('URL');
        if(open&&close&&paren&&target){
          const address=text.slice(target.from,target.to).replace(/^<|>$/g,'').replace(/\\([()])/g,'$1');
          const url=externalUrl(address);
          if(url){
            addRich(node.from,node.to,'external',text.slice(node.from,node.to),false,{url,label:text.slice(open.to,close.from)});
            return false;
          }
        }
      }
      // `[文字]` 这类没有 URL 的方括号不该按链接着色（本项目没有双链，方括号就是普通字符）。
      // 外部链接和附件由各自的控件渲染。
      if(node.name==='Link'&&!overlaps(node.from,node.to)&&text[node.to]!=='('&&!inside(node.from,node.to)){
        result.push(Decoration.mark({class:'plain-bracket-text'}).range(node.from,node.to));
      }
      if(['HeaderMark','EmphasisMark','CodeMark'].includes(node.name)&&!overlaps(node.from,node.to)){
        const parent=node.node.parent||node.node;
        let end=node.to;
        if(node.name==='HeaderMark'&&text[end]===' ')end++;
        result.push((inside(parent.from,parent.to)?Decoration.mark({class:'md-syntax-marker'}):Decoration.replace({})).range(node.from,end));
      }
    }});
    for(const match of text.matchAll(/\[(?:\.\.\.|…)\]/g)){
      const from=match.index!,to=from+match[0].length;
      if(!overlaps(from,to)&&!inCode(from))result.push(Decoration.mark({class:'plain-cloze-placeholder'}).range(from,to));
    }
    const source=this.options.anchors.length?projectDocument({text,objects}):text;
    for(const anchor of this.options.anchors){
      if(anchor.section&&anchor.section!==this.options.section)continue;
      const type=anchor.highlight||'extract';if(this.options.highlights?.[type]===false)continue;
      const start=locateAnchor(source,anchor);
      const from=documentOffset(objects,start),to=documentOffset(objects,start+anchor.quote.length,true);
      // 同一段文字可能有多条锚点（重复摘录/检测卡），这里不再去重，让点击时能列出候选卡片
  if(from>=0)result.push(Decoration.mark({class:'irtree-extracted irtree-extracted-'+type,
        // 把目标节点 id 写到 DOM 上，配合 Ctrl+点击跳转
        attributes:anchor.nodeId?{'data-anchor-node':anchor.nodeId}:undefined}).range(from,to));
    }
    return Decoration.set(result,true);
  }

  focus():void {this.view.focus();}
  snapshot():any {return this.view.state.toJSON({history:historyField,attachments:attachmentField});}
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
  destroy():void {this.destroyed=true;this.clearMousePointer();this.view.destroy();}
}
