import { t } from '../core/i18n';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyField, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import katex from 'katex';
// N12（1.87）：加载 mhchem 扩展，支持化学式 \ce{} 与单位 \pu{}（KaTeX 官方扩展，副作用导入即注册）
import 'katex/contrib/mhchem';
import { locateAnchor } from '../core/card';
import { assetEmbeds,formatAssetEmbed,parseAssetEmbed } from '../core/image-occlusion';
import type { Anchor, Asset } from '../core/model';
import { positionBox } from './image-occlusion';

export interface ImageTarget {token:string;from:number;url:string;filename:string}

export interface EditorOptions {
  value:string;
  label:string;
  section:'question'|'answer';
  anchors:Anchor[];
  highlights?:{extract:boolean;cloze:boolean};
  textOnlyCursor?:boolean;
  readOnly?:boolean;
  snapshot?:any;
  onChange:(value:string,typing:boolean)=>void;
  /** 音频/视频是否自动播放（全局开关，来自设置） */
  audioAutoplay?:boolean;
  onNavigate:(id:string)=>void;
  /** 同一位置有多条锚点时，交给界面弹出选择框 */
  onNavigateChoice?:(ids:string[],at:{x:number,y:number})=>void;
  onAttachmentMenu:(event:MouseEvent,choose:()=>void)=>void;
  onImageContext?:(event:MouseEvent,image:ImageTarget)=>void;
  onAttachments:(files:File[])=>Promise<string[]>;
  onError:(message:string)=>void;
}
const renderer=new MarkdownIt({html:true,linkify:true,breaks:true});
const assets=new Map<string,Promise<Asset>>();
const discardedWidgets=new WeakSet<HTMLElement>();
// 音频/视频播放器按附件 id 复用，切卡片时不重建（避免控件动画重播的闪）
const mediaCache=new Map<string,HTMLMediaElement>();
const redraw=StateEffect.define<void>();
const focusChanged=StateEffect.define<boolean>();
const focusedField=StateField.define<boolean>({create:()=>false,update:(value,tr)=>{for(const effect of tr.effects)if(effect.is(focusChanged))value=effect.value;return value;}});

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
    readonly onNavigate:(id:string)=>void,readonly autoplay=false,readonly onImageContext?:EditorOptions['onImageContext']){
    super();
  }
  eq(other:RichWidget):boolean { return this.type===other.type&&this.value===other.value&&this.autoplay===other.autoplay; }
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
    }else if(this.type==='external'){
      const match=this.value.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      const link=document.createElement('a');link.href=match?.[2]||this.value;
      link.textContent=match?.[1]||this.value;link.target='_blank';link.rel='noopener noreferrer';wrapper.append(link);
    }else if(this.type==='link'){
      const match=this.value.match(/^\[\[([^|\]]+)(?:\|([^\]]*))?\]\]$/);
      const link=document.createElement('a');
      link.href='#';
      link.textContent=match?.[2]||match?.[1]||this.value;
      link.onclick=event=>{event.preventDefault();if(match)this.onNavigate(match[1]);};
      wrapper.append(link);
    }else{
      const embed=parseAssetEmbed(this.value);
      if(!embed){wrapper.textContent=this.value;return wrapper;}
      wrapper.classList.add('reading-media');
      // 不先写「载入附件…」再换内容——切卡片时那行字会闪一下；留同高空位，加载完直接画上去
      wrapper.textContent='';wrapper.style.minHeight='22px';
      const id=embed.assetId;
      assetInfo(id).then(asset=>{
        if(discardedWidgets.has(wrapper))return;
        if(!asset){wrapper.textContent=t('附件缺失');return;}
        wrapper.replaceChildren();
        const url=window.reading.mediaUrl(id);
        if(asset.mime.startsWith('image/')){
          const image=document.createElement('img');
          const requestedWidth=Number(embed.display.match(/^\d+/)?.[0])||0;
          image.loading='lazy';image.decoding='async';image.src=url+'?preview='+(requestedWidth>1600?3200:1600);image.alt=asset.filename;
          image.draggable=false;
          image.onload=()=>view.requestMeasure();
          const savedWidth=embed.display.match(/^(\d+)(?:x\d+)?$/)?.[1];
          if(savedWidth)image.style.width=savedWidth+'px';
          const tokenPosition=():number|undefined=>{
            if(discardedWidgets.has(wrapper)||!view.dom.isConnected)return;
            const text=view.state.doc.toString(),near=view.posAtDOM(wrapper);
            const positions:number[]=[];
            for(let at=text.indexOf(this.value);at>=0;at=text.indexOf(this.value,at+1))positions.push(at);
            positions.sort((a,b)=>Math.abs(a-near)-Math.abs(b-near));
            return positions[0];
          };
          const commitWidth=(width:number|null,knownPosition?:number)=>{
            if(!view.dom.isConnected||view.state.readOnly)return;
            const from=knownPosition??tokenPosition();
            if(from===undefined||view.state.doc.sliceString(from,from+this.value.length)!==this.value)return;
            const insert=formatAssetEmbed({...embed,display:width?String(width):''});
            if(insert===this.value)return;
            view.dispatch({changes:{from,to:from+this.value.length,insert},selection:{anchor:Math.max(0,from-1)},
              userEvent:'input.resize-image',annotations:isolateHistory.of('full')});
            view.focus();
          };
          const handle=document.createElement('button');handle.className='image-resize-handle';
          handle.setAttribute('aria-label',t('拖动调整图片大小；双击恢复原始大小'));
          handle.onpointerdown=event=>{
            if(event.button!==0||view.state.readOnly)return;
            event.preventDefault();event.stopPropagation();handle.setPointerCapture(event.pointerId);
            const sourcePosition=tokenPosition();if(sourcePosition===undefined)return;
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
              wrapper.classList.remove('is-resizing');commitWidth(width,sourcePosition);
            };
            window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);
            window.addEventListener('pointercancel',finish);window.addEventListener('blur',finish);
          };
          handle.onkeydown=event=>{
            if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;
            event.preventDefault();event.stopPropagation();
            commitWidth(event.key==='Home'?null:Math.max(64,Math.min(4096,Math.round(image.getBoundingClientRect().width)+(event.key==='ArrowLeft'?-20:20))));
          };
          handle.ondblclick=event=>{event.preventDefault();commitWidth(null);};
          wrapper.classList.add('reading-image');
          if(embed.mask){
            const frame=document.createElement('span');frame.className='reading-image-frame';
            const mask=document.createElement('span');mask.className='reading-image-mask';mask.setAttribute('aria-hidden','true');
            positionBox(mask,embed.mask);
            frame.append(image,mask);wrapper.append(frame);
          }else{
            wrapper.append(image);
            image.oncontextmenu=event=>{
              if(view.state.readOnly||!this.onImageContext)return;
              const from=tokenPosition();if(from===undefined)return;
              event.preventDefault();event.stopPropagation();
              this.onImageContext(event,{from,token:this.value,url:image.src,filename:asset.filename});
            };
          }
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
          link.textContent=asset.filename;link.href=url;link.download=asset.filename;
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
    const decorationField=StateField.define<DecorationSet>({
      create:state=>this.decorations(state),
      update:(old,tr)=>tr.docChanged||tr.selection||tr.effects.some(effect=>effect.is(redraw))
        ||syntaxTree(tr.startState)!==syntaxTree(tr.state)?this.decorations(tr.state):old,
      provide:field=>EditorView.decorations.from(field),
    });
    const extensions=[
      history(),focusedField,EditorState.readOnly.of(!!options.readOnly),EditorView.editable.of(!options.readOnly),EditorView.lineWrapping,markdown({base:markdownLanguage}),syntaxHighlighting(highlighting),decorationField,
      EditorState.phrases.of({
        'Control character':t('控制字符'),'close':t('关闭'),'Fold line':t('折叠行'),'Unfold line':t('展开行'),
        'Folded lines':t('已折叠行'),'Unfolded lines':t('已展开行'),'to':t('至'),
        'folded code':t('已折叠代码'),'unfold':t('展开'),
      }),
      EditorView.contentAttributes.of({'aria-label':options.label,spellcheck:'false',tabindex:'0'}),
      keymap.of([...defaultKeymap,...historyKeymap]),
      EditorView.updateListener.of(update=>{
        if(update.docChanged)options.onChange(update.state.doc.toString(),update.transactions.every(tr=>tr.isUserEvent('input.type')));
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
          options.onAttachmentMenu(event,()=>this.pickAttachments(at));
          return true;
        },
        paste:(event)=>this.handleFiles(event.clipboardData?.files,event),
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
      state=options.snapshot?.doc===options.value
        ?EditorState.fromJSON(options.snapshot,{extensions},{history:historyField})
        :EditorState.create({doc:options.value,extensions});
    }catch{state=EditorState.create({doc:options.value,extensions});}
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
  private async insertFiles(files:File[],from:number,to:number,replace:boolean):Promise<void>{
    if(this.destroyed||this.view.state.readOnly)return;
    const before=this.view.state.doc;
    try{
      const links=await this.options.onAttachments(files);
      if(this.destroyed||this.view.state.readOnly||!links.length)return;
      if(this.view.state.doc!==before){
        const selection=this.view.state.selection.main;
        from=replace?selection.from:selection.head;
        to=replace?selection.to:selection.head;
      }
      const insert='\n'+links.join('\n')+'\n';
      this.view.dispatch({
        changes:{from,to,insert},selection:{anchor:from+insert.length},userEvent:'input.paste',
      });
      this.view.focus();
    }catch(error){this.options.onError(error instanceof Error?error.message:String(error));}
  }

  private decorations(state:EditorState):DecorationSet {
    const text=state.doc.toString(),selection=state.selection.main;
    // 光标落在公式边界也算"编辑中"（±1 字符容差）。
    // 原因：光标在 `\]` 右侧时旧逻辑判定为公式外 → 立刻渲染，导致 `]` 永远点不到、
    // 也没法把光标放到公式末尾。Obsidian 的体验是"点渲染块先进入源码，离开一点才恢复渲染"。
    const inside=(from:number,to:number)=>!state.readOnly&&state.field(focusedField)&&
      (selection.empty?selection.from>=from-1&&selection.from<=to+1:selection.from<=to+1&&selection.to>=from-1);
    const result:any[]=[];
    const replaced:Array<[number,number]>=[];
    const overlaps=(from:number,to:number)=>replaced.some(([a,b])=>from<b&&to>a);
    const inCode=(position:number)=>{
      let syntax=syntaxTree(state).resolveInner(position,1);
      while(syntax.parent){
        if(/Code|HTMLBlock/.test(syntax.name))return true;
        syntax=syntax.parent;
      }
      return false;
    };
    const addRich=(from:number,to:number,type:RichWidget['type'],value:string,block=false)=>{
      if(overlaps(from,to)||inCode(from))return;
      const widget=new RichWidget(type,value,this.options.onNavigate,!!this.options.audioAutoplay,this.options.onImageContext);
      const active=inside(from,to);
      if(active){
        if(type==='media')result.push(Decoration.widget({widget,block:true,side:1}).range(state.doc.lineAt(to).to));
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
    for(const match of text.matchAll(assetEmbeds)){
      const from=match.index!,to=from+match[0].length,line=state.doc.lineAt(from);
      const block=text.slice(line.from,line.to).trim()===match[0];
      addRich(block?line.from:from,block?line.to:to,'media',match[0],block);
    }
    for(const match of text.matchAll(/\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$\$[\s\S]+?\$\$|(?<![\\$])\$(?!\$)[^\n$]+?\$(?!\$)/g)){
      const from=match.index!,to=from+match[0].length;
      const first=state.doc.lineAt(from),last=state.doc.lineAt(to);
      const block=(match[0].startsWith('$$')||match[0].startsWith('\\['))&&text.slice(first.from,last.to).trim()===match[0];
      addRich(block?first.from:from,block?last.to:to,'math',match[0],block);
    }
    // N18（1.87）：`[[...]]` 不做特殊渲染——本项目不是 Obsidian、没有双链笔记功能，
    // 一律按原文显示。附件引用统一带 `!` 前缀（走上面的媒体规则），不受影响。
    for(const match of text.matchAll(/(?<!!)\[[^\]]+\]\(https?:\/\/[^\s)]+\)/g)){
      addRich(match.index!,match.index!+match[0].length,'external',match[0]);
    }
    syntaxTree(state).iterate({enter:node=>{
      if(node.name==='Table'&&!inside(node.from,node.to)){
        addRich(node.from,node.to,'markdown',text.slice(node.from,node.to),true);
      }
      // `[文字]` 这类没有 URL 的方括号不该按链接着色（本项目没有双链，方括号就是普通字符）。
      // 只保留真正的链接 `[x](url)`（已由上面的 external 规则渲染）与附件 `![[asset:…]]`。
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
    for(const anchor of this.options.anchors){
      if(anchor.section&&anchor.section!==this.options.section)continue;
      const type=anchor.highlight||'extract';if(this.options.highlights?.[type]===false)continue;
      const from=locateAnchor(text,anchor),to=from+anchor.quote.length;
      // 同一段文字可能有多条锚点（重复摘录/检测卡），这里不再去重，让点击时能列出候选卡片
  if(from>=0)result.push(Decoration.mark({class:'irtree-extracted irtree-extracted-'+type,
        // 把目标节点 id 写到 DOM 上，配合 Ctrl+点击跳转
        attributes:anchor.nodeId?{'data-anchor-node':anchor.nodeId}:undefined}).range(from,to));
    }
    return Decoration.set(result,true);
  }

  focus():void {this.view.focus();}
  snapshot():any {return this.view.state.toJSON({history:historyField});}
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
      view.dispatch({changes:{from,to,insert:inner},selection:{anchor:from,head:from+inner.length},userEvent:'input.format',annotations:isolateHistory.of('full')});
      view.focus();return;
    }
    view.dispatch({changes:{from,to,insert:marker+selected+marker},selection:{anchor:from+marker.length,head:to+marker.length},
      userEvent:'input.format',annotations:isolateHistory.of('full')});
    view.focus();
  }
  setAnchors(anchors:Anchor[]):void {this.options.anchors=anchors;this.view.dispatch({effects:redraw.of()});}
  setHighlights(value:{extract:boolean;cloze:boolean}){this.options.highlights=value;this.view.dispatch({effects:redraw.of()});}
  selectSource(anchor:Anchor):boolean {
    const at=locateAnchor(this.view.state.doc.toString(),anchor);
    if(at<0)return false;
    this.view.dispatch({selection:{anchor:at,head:at+anchor.quote.length},effects:EditorView.scrollIntoView(at,{y:'center'})});
    this.view.focus();return true;
  }
  destroy():void {this.destroyed=true;this.clearMousePointer();this.view.destroy();}
}
