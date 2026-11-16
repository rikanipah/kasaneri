import {arrangeContextMenu,loadContextMenus} from './context-menu-settings';
import {localizeMarkup} from './localize-markup';
import { t } from '../core/i18n';
import { ReadingEditor,type ImageTarget } from './editor';
import {editImageOcclusion} from './image-occlusion';
import { DirectoryTree,type TreeType } from './tree';
import {setIcon,type IconName} from './icons';
import {tagFromLabel,tagLabel} from '../core/tags';
import {CardBrowser} from './browser';
import type {Schedule} from '../sync/study-changes';
import {CardRelationsPanel} from './card-relations';
import {StatisticsDialog} from './statistics';
import {renderStudyBar,renderStudyCounts,renderStudyToggles,type StudyAnswer} from './study-controls';
import {TrashDialog} from './trash';
import {TerminalDialog} from './terminal';
import {PreferencesDialog,type Configuration,type PreferenceTab} from './preferences';
import {COMMANDS,DEFAULT_SETTINGS,DEFAULT_SHORTCUTS,shortcutFromEvent,type CommandId} from '../core/settings';
import {hasImageMask,parseAssetEmbed,type ImageOcclusionUndo} from '../core/image-occlusion';
import type { AgainChildCandidate,AgainChildSelection,Anchor,Material,NodeKind,TreeNode,FolderCounts,StudySnapshot,DeckConfiguration,LaunchRequest,CardRelationKey } from '../core/model';

localizeMarkup();
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const request=<T=any>(action:string,payload?:unknown)=>window.reading.request<T>(action,payload);
const statistics=new StatisticsDialog(request,change=>{
  recordUndo({run:async applied=>{
    await save();
    await request('setPrerequisite',{...change,mode:change.expected,expected:change.mode});
    applied();
    await refreshPrerequisiteQueues();
  }});
  void enqueue(refreshPrerequisiteQueues);
});
const trash=new TrashDialog(request,()=>void enqueue(refreshRelations));
function shortcutKey(id:CommandId):string{try{return configuration?.shortcuts?.[id]||'';}catch{return '';}}
function shortcutTitle(label:string,id:CommandId):string{const key=shortcutKey(id),text=t(label);return key?t('{0}（快捷键 {1}）',text,key):text;}
// 卡片状态徽标（右上角小字），替代此前的顶部提示
function applyCardBadge():void{
  const badge=document.getElementById('card-state-badge');
  if(!badge)return;
  const id=current?.note.id;
  const flags=id?cardFlags.get(id):undefined;
  // 状态口径——搁置/完成/留存判定优先；检测卡复习停了但有待办历史（含 Anki 暂停）叫「待办暂停」，
  // 新建还没复习过的检测卡在待办里叫「待办中」；主题/提取待办停用叫「已搁置」；点「完成」叫「已完成」。
  const isCard=current?.note.kind==='cloze';
  if(flags?.hold){badge.hidden=false;badge.textContent=t('留存判定');badge.title=t('留存判定：暂存点，可在浏览卡片里取消或删除');return;}
  if(flags?.buried){badge.hidden=false;badge.textContent=t('已搁置');badge.title=t('已搁置到明天（下一个日切点会自动回到队列）');return;}
  if(!id){badge.hidden=true;badge.textContent='';return;}
  if(flags?.dismissed){badge.hidden=false;badge.textContent=t('已完成');badge.title=t('这张卡片已完成：保留内容，不再出现在待办队列');return;}
  if(isCard){
    if(flags?.reviewEnabled!==false){badge.hidden=true;badge.textContent='';return;}
    if(flags?.pushEnabled===false||flags?.reviewed){badge.textContent=t('待办暂停');badge.title=t('这张检测卡的复习已暂停（Anki 迁移的暂停卡也在这里），仍可在待办里读到');}
    else{badge.textContent=t('待办中');badge.title=t('这张检测卡在待办队列里（复习尚未开启）');}
    badge.hidden=false;return;
  }
  if(flags?.pushEnabled===false){badge.hidden=false;badge.textContent=t('已搁置');badge.title=t('这张主题／提取的待办已停用（不会出现在待办队列）');return;}
  badge.hidden=true;badge.textContent='';
}
const cardFlags=new Map<string,{enabled?:boolean;reviewEnabled?:boolean;pushEnabled?:boolean;buried?:boolean;hold?:boolean;reviewed?:boolean;dismissed?:boolean}>();
// 内嵌终端（每卡片一个对话框，PTY 生命周期由对话框管理）。
const terminal=new TerminalDialog();
async function openCardInfo(id:string){try{await enqueue(save);await statistics.openCard(id);}catch(error){message((error as Error).message);}}
async function openStatistics(folderId?:string){try{await enqueue(save);await statistics.openOverview(folderId);}catch(error){message((error as Error).message);}}
interface Draft {
  note:Material;
  content:string;
  answer:string;
  savedContent:string;
  savedAnswer:string;
  questionState?:any;
  answerState?:any;
}
const drafts=new Map<string,Draft>();
let current:Draft|null=null;
let editors:{question:ReadingEditor;answer?:ReadingEditor}|null=null;
let queue=Promise.resolve();
let timer:ReturnType<typeof setTimeout>;
let fontSize=16;
let configuration:Configuration={settings:{...DEFAULT_SETTINGS},shortcuts:{...DEFAULT_SHORTCUTS},algorithm:''};
let activeFolderId:string|null=null;
let study:StudySnapshot|null=null;
let studyOrigin:string|null=null;
let answerShown=false;
let studyBusy=false;
let studyEditing=false;
let directoryCollapsed=false;
let browserOrigin:string|null=null;
// 独立编辑窗口（?card=<id>）——只显示这一张卡，隐藏目录树/功能栏。
const soloCard=new URLSearchParams(location.search).get('card');
// 独立浏览窗口（?browser=1）与独立添加卡片窗口（?add=1）
const soloBrowser=new URLSearchParams(location.search).get('browser')==='1';
const soloAdd=new URLSearchParams(location.search).get('add')==='1';
const soloAddFolder=new URLSearchParams(location.search).get('folderId');
const soloBrowseStatus=new URLSearchParams(location.search).get('status')==='conflict'?'conflict' as const:undefined;
// 主窗口会带上目录树当前选中的卡片，浏览窗口打开时默认选中它
const soloBrowseCard=new URLSearchParams(location.search).get('select');
const soloWindow=soloBrowser||soloAdd;
let directoryTypes:TreeType[]=[];
let highlights={extract:true,cloze:true};

function cardPresentation(draft:Draft){
  const reviewing=study?.mode==='cards'&&study.item?.id===draft.note.id&&draft.note.kind==='cloze';
  const readOnly=reviewing&&!studyEditing,coverMask=reviewing&&!answerShown;
  return {readOnly,coverMask,hideAnswer:coverMask||(readOnly&&!draft.answer.trim()&&hasImageMask(draft.content))};
}

for(const [id,name] of Object.entries({'toggle-directory':'panel-right-close','toggle-review':'play','toggle-reading':'book-open','open-browser':'panels-top-left','open-add-card':'square-plus','open-shortcuts':'keyboard','open-settings':'settings',minimize:'minus',maximize:'maximize-2',close:'x'}))setIcon($(id),name as IconName);

let noticeTimer:ReturnType<typeof setTimeout>|undefined;
// 提示显示在工作区右上角，3.5 秒后自动消失（避免长期占位）
function message(text:string):void{$('notice').textContent=text;$('notice').hidden=!text;
  if(noticeTimer)clearTimeout(noticeTimer);
  if(text)noticeTimer=setTimeout(()=>{$('notice').hidden=true;$('notice').textContent='';},3500);}
function enqueue(action:()=>Promise<void>):Promise<void>{
  queue=queue.then(action).catch(error=>message(error.message||String(error)));
  return queue;
}
function dirty(draft:Draft):boolean{return draft.content!==draft.savedContent||draft.answer!==draft.savedAnswer;}

async function save():Promise<void>{
  clearTimeout(timer);
  const draft=current;
  if(!draft)return;
  while(dirty(draft)){
    const content=draft.content,answer=draft.answer;
    const result=await request<{revision:number}>('save',{id:draft.note.id,revision:draft.note.revision,content,answer});
    draft.note.revision=result.revision;
    draft.note.content=content;draft.note.answer=answer;
    draft.savedContent=content;draft.savedAnswer=answer;
  }
}
type UndoEntry={run:(applied:()=>void)=>Promise<void>;text?:{
  id:string;section:'question'|'answer';before:string;after:string;typedAt:number;
}};
const undoHistory:UndoEntry[]=[];
function recordUndo(entry:UndoEntry){
  undoHistory.push(entry);
  if(undoHistory.length>100)undoHistory.shift();
}
function undoLatest(){
  void enqueue(async()=>{
    const entry=undoHistory.at(-1);
    if(!entry)return;
    const workspace=$('editor-stack');
    const focused=focusedEditor(),focusId=current?.note.id;
    workspace.inert=true;
    try{
      await entry.run(()=>{
        const index=undoHistory.indexOf(entry);
        if(index!==-1)undoHistory.splice(index,1);
      });
    }finally{
      workspace.inert=false;
      if(focused&&focusId===current?.note.id)editors?.[focused.section]?.view.focus();
      renderStudyControls();
    }
  });
}
function changed(draft:Draft,section:'question'|'answer',value:string,typing:boolean):void{
  const previous=section==='answer'?draft.answer:draft.content;
  const now=Date.now(),last=undoHistory.at(-1)?.text;
  if(typing&&last&&last.id===draft.note.id&&last.section===section&&
    last.after===previous&&now-last.typedAt<500){
    last.after=value;last.typedAt=now;
  }else{
    const text={id:draft.note.id,section,before:previous,after:value,typedAt:typing?now:0};
    recordUndo({text,run:async applied=>{
      await save();
      const note=await request<Material|null>('get',{id:text.id});
      const key=text.section==='answer'?'answer':'content';
      if(!note||note[key]!==text.after||browser.hasUnsavedEdit(note.id,note.content,note.answer))
        throw Error(t('正文已变化，无法撤销这次编辑。'));
      await request('save',{id:note.id,revision:note.revision,content:note.content,answer:note.answer,[key]:text.before});
      applied();
      drafts.delete(note.id);
      if(current?.note.id===note.id){
        emptyWorkspace('');
        await open(note.id,undefined,true);
      }
      await browser.reloadEdit(note.id);
      if(browser.visible)void browser.refresh();
      await refreshCounts();
    }});
  }
  if(section==='answer')draft.answer=value;else draft.content=value;
  clearTimeout(timer);
  timer=setTimeout(()=>{void enqueue(async()=>{await save();await refreshCounts();});},350);
}

function disposeEditors():void{
  if(current&&editors){
    current.questionState=editors.question.snapshot();
    current.answerState=editors.answer?.snapshot();
    editors.question.destroy();editors.answer?.destroy();
  }
  editors=null;
}
function pruneDrafts():void{
  while(drafts.size>12){
    const entry=[...drafts.keys()].find(id=>id!==current?.note.id);
    if(!entry)break;drafts.delete(entry);
  }
}
// 界面导航历史（Ctrl+Alt+←/→ 在打开过的卡片之间前后跳）
const navStack:string[]=[];let navIndex=-1;let navRestoring=false;
async function open(id:string,source?:Anchor,force=false,treeScroll:'center'|'preserve'='center'):Promise<void>{
  await save();
  if(!navRestoring&&current?.note.id!==id){
    navStack.splice(navIndex+1);navStack.push(id);navIndex=navStack.length-1;
    if(navStack.length>200){navStack.shift();navIndex=navStack.length-1;}
  }
  if(studyEditing&&study?.item?.id!==id)studyEditing=false;
  if(current?.note.id===id&&!force){
    if(treeScroll==='preserve')tree.selectNode(id);
    else if(tree.selectedNode()?.id!==id)await tree.reveal(id);
    browser.markActive(id,current.note.folderId);
    if(source)selectSource(source);
    return;
  }
  const workspace=$('workspace'),wasInert=workspace.inert;
  workspace.inert=true;
  try{
    await save();
    const note=await window.reading.readEditorCard('workspace',id);
    if(note&&note.kind!=='folder')await mountEditor(note,source,treeScroll);
  }finally{
    workspace.inert=wasInert;
    window.reading.setEditorCard('workspace',current?.note.id??null);
  }
}
async function mountEditor(note:Material,source:Anchor|undefined,treeScroll:'center'|'preserve'):Promise<void>{
  const {id}=note;
  const stored=drafts.get(id);
  const draft:Draft=stored&&stored.note.revision===note.revision?stored:{
    note,content:note.content,answer:note.answer,savedContent:note.content,savedAnswer:note.answer,
  };
  draft.note=note;
  activeFolderId=note.folderId;
  // 记录这张卡的复习/待办开关状态，用于右上角小字
  void request<{enabled?:boolean;reviewEnabled?:boolean}|null>('nodeStudy',{id}).then(value=>{
    if(value)cardFlags.set(id,value);
    applyCardBadge();
  }).catch(()=>{});
  const anchors=await request<Array<{id:string;anchor:Anchor}>>('anchors',{id});
  highlights=await request('settingGet',{key:'highlights:'+id})||{extract:true,cloze:true};
  // 检测卡的上下比例也要在清空工作区之前读好——否则清空后还要 await 一次，
  // 浏览器会先画一帧空白工作区，表现就是切换卡片时闪一下。
  const storedSplit=note.kind==='cloze'?(Number(await request('settingGet',{key:'cardSplit:'+note.id}))||50):50;
  disposeEditors();
  current=draft;
  drafts.delete(id);drafts.set(id,draft);pruneDrafts();
  const workspace=$('workspace');workspace.replaceChildren();
  const presentation=cardPresentation(draft);
  const make=(host:HTMLElement,section:'question'|'answer')=>new ReadingEditor(host,{
    value:section==='answer'?draft.answer:draft.content,
    label:note.kind==='cloze'?(section==='answer'?t('答案'):t('检测内容')):t('笔记正文'),
    section,anchors:anchors.map(entry=>entry.anchor),highlights,textOnlyCursor:note.kind==='cloze',
    // 复习（cards）里检测卡默认只读，点「编辑」解锁；待办（reading）里默认可直接编辑，
    // 因为阅读材料时经常要顺手改字/补内容，不必先点编辑。
    readOnly:presentation.readOnly,
    audioAutoplay:!!configuration.settings.audioAutoplay,
    snapshot:section==='answer'?draft.answerState:draft.questionState,
    onChange:(value,typing)=>changed(draft,section,value,typing),
    onNavigate:target=>void enqueue(()=>open(target)),
    // 重复高亮——同一段文字有多张卡片时弹出选择框
    onNavigateChoice:(ids,at)=>void showLinkPicker(ids,at),
    onAttachmentMenu:showAttachmentMenu,
    onImageContext:(event,image)=>showImageMenu(draft,section,event,image),
    onAttachments:async files=>{
      const attachments=await window.reading.importFiles(files);
      return attachments.map(asset=>'![[asset:'+asset.id+']]');
    },
    onError:message,
  });
  if(note.kind==='cloze'){
    // 首帧隐藏——复习（检测卡）且答案未揭开时，创建 DOM 时就带上隐藏态，
    // 不再等 applyStudyPresentation() 事后补类（那样中间的 await 会让浏览器先画一帧答案，造成闪烁）。
    const previewHidden=presentation.hideAnswer;
    // 先把保存的比例读出来，再建 DOM——否则卡片先按 50/50 画一帧、再被改成保存值，会看到分隔条/文字跳一下
    const storedRatio=storedSplit;
    const card=document.createElement('div');card.className='test-card';
    card.classList.toggle('answer-collapsed',previewHidden);
    card.classList.toggle('is-mask-covered',presentation.coverMask);workspace.append(card);
    // 所有检测卡默认上下 5:5（以前是 65:35）；用户拖动过的卡仍按各自保存值
    let ratio=storedRatio;
    const applySplit=()=>{
      ratio=Math.max(15,Math.min(85,ratio));
      card.style.gridTemplateRows=`minmax(0,${ratio}fr) 8px minmax(0,${100-ratio}fr)`;
      rule.setAttribute('aria-valuenow',String(Math.round(ratio)));
    };
    const storeSplit=()=>void request('settingSet',{key:'cardSplit:'+note.id,value:ratio});
    const pane=(section:'question'|'answer')=>{
      const area=document.createElement('section');area.className='card-pane '+section;
      if(section==='answer')area.dataset.answerHint=t('点击「显示答案」或按空格后显示');
      const host=document.createElement('div');host.className='card-editor';
      // 答案区首帧就带上隐藏态 + inert，避免内容先可见再被遮住（闪烁）
      if(section==='answer'&&previewHidden){area.classList.add('is-answer-hidden');host.inert=true;host.setAttribute('aria-hidden','true');}
      area.append(host);card.append(area);
      return make(host,section);
    };
    const question=pane('question');
    const rule=document.createElement('div');rule.className='card-rule';rule.tabIndex=0;
    rule.setAttribute('role','separator');rule.setAttribute('aria-orientation','horizontal');
    rule.setAttribute('aria-label',t('拖动调整检测内容和答案的高度'));
    rule.setAttribute('aria-valuemin','15');rule.setAttribute('aria-valuemax','85');
    rule.onpointerdown=event=>{
      if(event.button!==0)return;
      event.preventDefault();rule.setPointerCapture(event.pointerId);rule.classList.add('is-dragging');
      rule.onpointermove=move=>{const bounds=card.getBoundingClientRect();ratio=(move.clientY-bounds.top)/bounds.height*100;applySplit();};
      const finish=()=>{rule.onpointermove=null;rule.onpointerup=null;rule.onpointercancel=null;rule.classList.remove('is-dragging');storeSplit();};
      rule.onpointerup=finish;rule.onpointercancel=finish;
    };
    rule.onkeydown=event=>{
      if(!['ArrowUp','ArrowDown','Home'].includes(event.key))return;
      event.preventDefault();ratio=event.key==='Home'?65:ratio+(event.key==='ArrowUp'?-5:5);applySplit();storeSplit();
    };
    rule.ondblclick=()=>{ratio=65;applySplit();storeSplit();};
    card.append(rule);applySplit();
    const answer=pane('answer');
    editors={question,answer};
  }else{
    const host=document.createElement('div');host.className='material-editor';workspace.append(host);
    if(draft.answer.trim()){
      host.classList.add('has-extra-answer');const q=document.createElement('div'),a=document.createElement('div'),rule=document.createElement('hr');rule.className='material-extra-rule';host.append(q,rule,a);editors={question:make(q,'question'),answer:make(a,'answer')};
    }else editors={question:make(host,'question')};
  }
  await breadcrumbs(note);
  await refreshRelations();
  if(treeScroll==='preserve')tree.selectNode(id);
  else await tree.reveal(id);
  browser.markActive(note.id,note.folderId);
  applyStudyPresentation();
  message('');
  if(source)selectSource(source);
  if(!tagsPanel.hidden)void renderCardTags();
}
function selectSource(source:Anchor):void{
  if(source.section==='answer'&&editors?.answer)editors.answer.selectSource(source);
  else if(!editors?.question.selectSource(source))editors?.answer?.selectSource(source);
}
// N16（1.83）：顶部路径栏显示**完整层级**——文件夹也显示出来（可点击跳到该目录），
// 最后一段是当前卡片。以前把文件夹过滤掉了，只能看到卡片名，看不出归属。
async function breadcrumbs(note:Material):Promise<void>{
  const path=await request<TreeNode[]>('path',{id:note.id});
  const nav=$('breadcrumbs');nav.replaceChildren();
  for(const node of path){
    const slash=document.createElement('span');slash.className='slash';slash.textContent='/';nav.append(slash);
    if(node.id===note.id){
      const name=document.createElement('span');name.className='current';name.textContent=node.title;
 nav.append(name);
    }else if(node.kind==='folder'){
      const button=document.createElement('button');button.className='breadcrumb-folder';button.textContent=node.title;
      button.title=t('打开这个文件夹');
      button.onclick=()=>void enqueue(async()=>{activeFolderId=node.id;await tree.reveal(node.id);});
      nav.append(button);
    }else{
      const button=document.createElement('button');button.textContent=node.title;
      button.onclick=()=>void enqueue(()=>open(node.id));nav.append(button);
    }
  }
}
// 卡片属性（标签）——底部状态栏右侧，可添加/移除，浏览卡片里能按属性检索
const tagsPanel=$('card-tags-panel'),tagsList=$('card-tags-list'),tagsInput=$<HTMLInputElement>('card-tags-input');
async function renderCardTags():Promise<void>{
  const id=current?.note.id;tagsList.replaceChildren();
  if(!id)return;
  const tags=await request<string[]>('cardTags',{id});
  // leech 后面带累计重来次数，看得出循环了几轮
  const leechCount=tags.includes('leech')?await request<number>('leechCount',{id}):0;
  for(const tag of tags){
    const chip=document.createElement('span');chip.className='card-tag';
    // 内部标签显示中文（leech 保持原样），点 × 删的仍是原来的标签值
    chip.textContent=tag==='leech'&&leechCount?tag+'('+leechCount+')':tagLabel(tag);chip.title=tag;
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.title=t('移除属性');
    remove.onclick=()=>void enqueue(async()=>{await request('removeCardTag',{id,tag});await renderCardTags();});
    chip.append(remove);tagsList.append(chip);
  }
}
function toggleCardTags(show?:boolean):void{
  const open=show??tagsPanel.hidden;
  tagsPanel.hidden=!open;
  if(open){void renderCardTags();tagsInput.value='';tagsInput.focus();}
}
$('card-tags').onclick=event=>{event.stopPropagation();toggleCardTags();};
tagsInput.onkeydown=event=>{
  if(event.key!=='Enter')return;event.preventDefault();
  // 写「留存判定」「已搁置」等于写 hold / buried
  const tag=tagFromLabel(tagsInput.value),id=current?.note.id;
  if(!tag||!id)return;
  tagsInput.value='';
  void enqueue(async()=>{await request('addCardTag',{id,tag});await renderCardTags();tagsInput.focus();});
};
document.addEventListener('pointerdown',event=>{
  if(!(event.target as HTMLElement).closest('#card-tags,#card-tags-panel'))tagsPanel.hidden=true;
});
/** 只刷新当前卡片的锚点高亮，不重新挂载编辑器（光标、滚动、选区都保留）。 */
async function refreshAnchors():Promise<void>{
  if(!current)return;
  const id=current.note.id;
  const list=await request<Array<{id:string;anchor:Anchor}>>('anchors',{id});
  if(current?.note.id!==id||!editors)return;
  const anchors=list.map(entry=>entry.anchor);
  editors.question.setAnchors(anchors);
  editors.answer?.setAnchors(anchors);
}
async function createExcerpt(draft:Draft,section:'question'|'answer',kind:'extract'|'cloze'|'blank',from:number,to:number):Promise<void>{
  const source=section==='answer'?draft.answer:draft.content;
  if(kind!=='blank'&&(from===to||!source.slice(from,to).trim()))return;
  void enqueue(async()=>{
    if(current!==draft)return;
    await save();
    if((section==='answer'?draft.answer:draft.content)!==source)return;
    // Alt+S（选区生成检测卡）不再把新卡正文挖成 [...…]，而是整段原文照抄过去，
    // 选中的文字放进答案区；来源锚点仍保留，方便跳回原文。
    const selected=source.slice(from,to);
    const result=await request<{node:Material;undoable:boolean}>('create',{
      parentId:draft.note.id,kind:kind==='cloze'?'cloze':'material',from:kind==='blank'?undefined:from,
      to:kind==='blank'?undefined:to,section,revision:draft.note.revision,
      ...(kind==='cloze'?{content:source,answer:selected}:{}),
    });
    recordCreation(result.node);
    await tree.refresh([draft.note.id]);
    await refreshCounts();
    // Alt+A / Alt+S / Alt+D 建完不再跳到新卡——接着读手头这张，只在原文上补锚点、
    // 目录里多出一行。需要改新卡时，选中它右键或用「在目录树中定位」。
    message(kind==='blank'?t('已新建提取。'):kind==='cloze'?t('已生成检测卡。'):t('已摘录为提取。'));
    await refreshAnchors();
    // 新建的提取/检测卡不再立刻进入重命名——标题跟随工作区正文自动生成，需要改名时右键或选中后 F12
  });
}
const prompt=$<HTMLDialogElement>('prompt');
async function ask(heading:string,initial:string,description?:string):Promise<string|null>{
  $('prompt-title').textContent=heading;
  $('prompt-text').textContent=description||'';$('prompt-text').hidden=!description;
  const input=$<HTMLInputElement>('prompt-input');input.value=initial;input.hidden=!!description;input.required=!description;
  const accept=$<HTMLButtonElement>('prompt-accept');
  accept.textContent=description?t('删除'):t('确定');
  // 回车提交。表单里第一个按钮是「取消」，浏览器的隐式提交会去点它，
  // 所以这里自己接住 Enter，直接触发「确定」；拼音选词时的回车不算。
  input.onkeydown=event=>{
    if(event.isComposing||event.key!=='Enter')return;
    event.preventDefault();
    accept.click();
  };
  prompt.returnValue='';prompt.showModal();if(!description){input.focus();input.select();}
  return new Promise(resolve=>prompt.addEventListener('close',()=>{
    resolve(prompt.returnValue==='accept'?(description?'confirmed':input.value.trim()||null):null);
  },{once:true}));
}
const untitledCard={topic:t('未命名主题'),material:t('未命名提取'),cloze:t('未命名检测卡')};
async function newNode(kind:'folder'|'topic'|'material'|'cloze',parentId:string|null):Promise<void>{
  const title=kind==='folder'?await ask(t('新建文件夹'),''):untitledCard[kind];
  if(!title)return;
  if(kind!=='folder'&&browser.visible)await browser.close();
  await enqueue(async()=>{
    await save();
    const {node}=await request<{node:Material}>('create',{parentId,kind,title});
    recordCreation(node);
    await tree.refresh([parentId]);
    if(kind==='folder'){activeFolderId=node.id;await tree.reveal(node.id);}else await open(node.id);
    await refreshCounts();applyStudyPresentation();
    // 同上，新建主题/提取/检测卡不弹重命名；文件夹仍需命名
  });
}

// ===== 从卡片启动外部程序/终端 =====
// 启动配置存在 nodes.metadata.launch={command,args?,cwd?}。
// 运行本身由主进程执行（渲染层在沙盒里，见 main.ts 'reading:launch'）。
async function loadLaunch(id:string):Promise<LaunchRequest|undefined>{
  const note=await request<Material>('get',{id});
  return note.metadata?.launch as LaunchRequest|undefined;
}
async function launchCurrent(id:string):Promise<void>{
  try{
    const launch=await loadLaunch(id);if(!launch)return;
    const result=await window.reading.launch(launch);
    message(result.ok?(t('已启动：{0}',launch.command)):t('未能启动'));
  }catch(error){message(error instanceof Error?error.message:String(error));}
}
async function setLaunch(id:string):Promise<void>{
  const current=await loadLaunch(id);
  const value=await ask(t('启动程序'),current?.command||'cmd','');
  if(value===null)return;
  const command=value.trim()||'cmd';
  // 只存 command；args/cwd 暂不提供界面录入（metadata.launch 的完整结构在 model.ts 注释里说明）。
  await request('nodeMetadata',{id,patch:{launch:{command}}});
  message(t('已保存启动命令：{0}',command));
}
async function rename(node:TreeNode):Promise<void>{
  const title=await ask(t('修改显示名'),node.title);
  if(!title)return;
  await saveName(node,title);
}
function saveName(node:TreeNode,title:string):Promise<void>{
  return enqueue(async()=>{
    await save();await request('rename',{id:node.id,title});
    node.title=title;tree.update(node);
    const cached=drafts.get(node.id);if(cached)cached.note.title=title;
    if(current)await breadcrumbs(current.note);
    await refreshRelations();
    if(browser.visible)void browser.refresh();
  });
}
function recordCreation(node:TreeNode){
  recordUndo({run:async applied=>{
    await save();
    const result=await request<{parentId:string|null;anchor:Anchor|null}>('undoCreation',{id:node.id});
    applied();
    drafts.delete(node.id);
    const wasOpen=current?.note.id===node.id;
    if(wasOpen)emptyWorkspace(t('从目录树中选择卡片。'));
    if(activeFolderId===node.id)activeFolderId=null;
    await tree.refresh([result.parentId]);
    const parent=result.parentId?await request<Material|null>('get',{id:result.parentId}):null;
    if(parent?.kind==='folder')await tree.reveal(parent.id);
    else if(parent&&wasOpen)await open(parent.id,result.anchor||undefined);
    if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
    await refreshRelations();
    await refreshAnchors();
    await refreshCounts();
    if(browser.visible)void browser.refresh();
  }});
}
async function moveNode(node:TreeNode,parentId:string|null){
  await save();
  const live=await request<Material|null>('get',{id:node.id});
  if(!live)throw Error(t('卡片已删除。'));
  const previous=live.parentId;
  if(previous===parentId)return;
  await request('move',{id:node.id,parentId});
  recordUndo({run:async applied=>{
    await save();
    await request('restoreMove',{id:node.id,parentId:previous,expectedParentId:parentId});
    applied();
    await refreshMovedNode(node.id,parentId,previous);
    message(t('已把「{0}」移回原处。',node.title));
  }});
  await refreshMovedNode(node.id,previous,parentId);
}
async function refreshMovedNode(id:string,previous:string|null,parentId:string|null){
  await tree.refresh([previous,parentId]);
  await tree.reveal(id);
  if(current){
    const live=await request<Material|null>('get',{id:current.note.id});
    if(live){current.note=live;activeFolderId=live.folderId;await breadcrumbs(live);}
  }
  await refreshCounts();
}

async function remove(node:TreeNode):Promise<void>{
  // 删文件夹＝文件夹和里面所有内容一起进垃圾桶，恢复时整棵子树一起回来。
  // 确认框可在「设置 → 删除」里关掉（默认关＝直接删，仍可用 Ctrl+Z 撤销或到垃圾桶恢复）
  if(configuration.settings.confirmDelete){
    const confirmed=await ask(node.kind==='folder'?t('删除文件夹'):t('删除卡片'),'',
      t('删除「{0}」？{1}可撤销（Ctrl+Z）或到垃圾桶恢复。',node.title,node.hasChildren?t('里面的内容会一起进垃圾桶，恢复时整棵子树一起回来。'):''));
    if(!confirmed)return;
  }
  await enqueue(async()=>{
    await save();
    const result=await request<{destinationId:string|null}>('remove',{id:node.id});drafts.delete(node.id);
    recordUndo({run:async applied=>{
      await save();
      const restored=await request<{parentId:string|null;title:string}>('trashRestore',{id:node.id});
      applied();
      await tree.refresh([null,restored.parentId,result.destinationId]);
      await tree.reveal(node.id);
      if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
      await refreshRelations();
      await refreshCounts();
      if(browser.visible)void browser.refresh();
      message(t('已撤销删除：「{0}」',restored.title));
    }});
    if(current?.note.id===node.id){
      emptyWorkspace(t('从目录树中选择材料。'));
    }
    await tree.refresh([null,node.parentId,result.destinationId]);
    if(current){
      const live=await request<Material|null>('get',{id:current.note.id});
      if(live){current.note=live;activeFolderId=live.folderId;await breadcrumbs(live);}
      else{activeFolderId=null;emptyWorkspace(t('从目录树中选择材料。'));}
    }
    else if(activeFolderId===node.id)activeFolderId=null;
    await refreshCounts();
    if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
    await refreshRelations();
    if(browser.visible)void browser.refresh();
  });
}
/** 仿 Obsidian「Move file」——屏幕中间弹出搜索框，输入过滤目录，回车移动。 */
async function showMovePicker(node:TreeNode):Promise<void>{
  return chooseMoveFolder(parentId=>moveNode(node,parentId));
}
async function chooseMoveFolder(move:(parentId:string)=>Promise<void>):Promise<void>{
  document.getElementById('move-picker')?.remove();
  // folders() 只给 {id,title,parentId}，这里在渲染层拼出完整路径
  const raw=await request<Array<{id:string;title:string;parentId:string|null}>>('folders');
  const byId=new Map(raw.map(folder=>[folder.id,folder]));
  const pathOf=(start:any)=>{const parts:string[]=[];const seen=new Set<string>();let cursor=start;
    while(cursor&&!seen.has(cursor.id)){seen.add(cursor.id);parts.unshift(cursor.title);cursor=cursor.parentId?byId.get(cursor.parentId):null;}
    return parts.join('/');};
  const folders=raw.map(folder=>({id:folder.id,path:pathOf(folder)})).sort((a,b)=>a.path.localeCompare(b.path));
  const overlay=document.createElement('div');overlay.id='move-picker';
  const box=document.createElement('div');box.className='move-box';
  const input=document.createElement('input');input.type='search';input.placeholder=t('输入文件夹名称…');input.className='move-input';
  const list=document.createElement('div');list.className='move-list';
  const footer=document.createElement('p');footer.className='move-footer';footer.textContent=t('↑↓ 选择 · Enter 移动 · Shift+Enter 新建文件夹并移入 · Esc 取消');
  box.append(input,list,footer);overlay.append(box);document.body.append(overlay);
  let cursor=0;
  const render=(keyword:string)=>{
    list.replaceChildren();
    // 输入框支持用 / 逐级定位，例如输入 Anime/1 就匹配 Anime/1在看
    const segments=keyword.split('/').map(part=>part.trim().toLowerCase()).filter(Boolean);
    const matches=folders.filter(folder=>{
      if(!segments.length)return true;
      const parts=folder.path.toLowerCase().split('/');
      let index=0;
      for(const segment of segments){
        let found=-1;
        for(let at=index;at<parts.length;at+=1){if(parts[at]!.startsWith(segment)){found=at;break;}}
        if(found<0)return false;
        index=found+1;
      }
      return true;
    });
    cursor=Math.max(0,Math.min(cursor,matches.length-1));
    matches.forEach((folder,index)=>{
      const row=document.createElement('button');row.type='button';row.className='move-row'+(index===cursor?' is-active':'');
      row.textContent=folder.path;row.onclick=()=>void commit(folder.id);
      list.append(row);
    });
    if(!matches.length){const empty=document.createElement('p');empty.className='preference-hint';empty.textContent=t('没有匹配的文件夹（Shift+Enter 新建）');list.append(empty);}
    list.dataset.count=String(matches.length);
  };
  const commit=(parentId:string)=>{
    overlay.remove();
    return enqueue(()=>move(parentId));
  };
  input.oninput=()=>{cursor=0;render(input.value.trim());};
  input.onkeydown=event=>{
    const rows=list.querySelectorAll<HTMLButtonElement>('.move-row');
    if(event.key==='ArrowDown'){event.preventDefault();cursor=Math.min(rows.length-1,cursor+1);render(input.value.trim());}
    else if(event.key==='ArrowUp'){event.preventDefault();cursor=Math.max(0,cursor-1);render(input.value.trim());}
    else if(event.key==='Escape'){event.preventDefault();overlay.remove();}
    else if(event.key==='Enter'){
      event.preventDefault();
      if(event.shiftKey){
        void enqueue(async()=>{
          const name=input.value.trim()||t('新建文件夹');
          await save();
          const {node:created}=await request<{node:Material}>('create',{kind:'folder',parentId:null,title:name});
          recordCreation(created);
          overlay.remove();await move(created.id);
        });
        return;
      }
      const rows=list.querySelectorAll<HTMLButtonElement>('.move-row');
      const row=rows[cursor];
      if(row){const match=folders.find(folder=>folder.path===row.textContent);if(match)void commit(match.id);}
    }
  };
  overlay.addEventListener('pointerdown',event=>{if(event.target===overlay)overlay.remove();});
  render('');input.focus();
}

/** Alt+F —— 在「文件管理」配置的默认文件夹里新建主题（没配置就用当前选中的文件夹）。 */
async function newTopicInDefault():Promise<void>{
  let parentId:string|null=null;
  try{const saved=await request<{folderId?:string}|null>('settingGet',{key:'defaultTopicFolder'});parentId=saved?.folderId||null;}catch{}
  if(!parentId)parentId=activeFolderId||current?.note.folderId||null;
  await newNode('topic',parentId);
}

function showAttachmentMenu(event:MouseEvent,choose:()=>void):void{
  const menu=$('context-menu');
  menu.replaceChildren();
  const button=document.createElement('button');
  button.type='button';button.textContent=t('插入附件…');button.dataset.action='插入附件…';button.setAttribute('role','menuitem');
  button.onclick=()=>{menu.hidden=true;choose();};
  menu.append(button);
  if(arrangeContextMenu(menu,'editor'))positionContextMenu(menu, event);else menu.hidden=true;
}
function showImageMenu(draft:Draft,section:'question'|'answer',event:MouseEvent,image:ImageTarget):void{
  const menu=$('context-menu');menu.replaceChildren();
  const button=document.createElement('button');
  button.type='button';button.textContent=t('图片遮挡…');button.dataset.action='图片遮挡…';button.setAttribute('role','menuitem');
  button.onclick=()=>{
    menu.hidden=true;
    void enqueue(async()=>{
      if(current!==draft)return;
      await save();
      const embed=parseAssetEmbed(image.token);
      const text=section==='answer'?draft.answer:draft.content;
      if(!embed||text.slice(image.from,image.from+image.token.length)!==image.token)
        throw Error(t('图片位置已变化，请重新打开图片。'));
      const boxes=await editImageOcclusion(image.url,image.filename,embed.boxes);
      if(!boxes)return;
      const sourceId=draft.note.id;
      const undo=await request<ImageOcclusionUndo>('saveImageOcclusion',{
        id:sourceId,section,from:image.from,token:image.token,revision:draft.note.revision,boxes,
      });
      if(!undo.changes.length&&!undo.created.length)return;
      recordUndo({run:async applied=>{
        await save();
        if(browser.visible){
          for(const id of new Set([...undo.created,...undo.changes.map(change=>change.id)])){
            const note=await request<Material|null>('get',{id});
            if(note&&browser.hasUnsavedEdit(id,note.content,note.answer))throw Error(t('请先保存浏览器里的卡片编辑。'));
          }
        }
        await request('undoImageOcclusion',undo);
        applied();
        await refreshOcclusionViews(sourceId,undo,true);
      }});
      await refreshOcclusionViews(sourceId,undo);
      if(undo.created.length)message(t('已生成 {0} 张检测卡',undo.created.length));
    });
  };
  menu.append(button);if(arrangeContextMenu(menu,'image'))positionContextMenu(menu, event);else menu.hidden=true;
}
async function refreshOcclusionViews(sourceId:string,undo:ImageOcclusionUndo,undone=false):Promise<void>{
  const changed=new Set([...undo.created,...undo.changes.map(change=>change.id)]);
  for(const id of changed)drafts.delete(id);
  const id=current?.note.id;
  if(id&&changed.has(id)){
    const next=undone&&undo.created.includes(id)?sourceId:id;
    await open(next,undefined,true,'preserve');
  }
  const source=await request<Material|null>('get',{id:sourceId});
  await tree.refresh([source?.parentId??null,sourceId]);
  if(browser.visible){
    for(const id of changed)await browser.reloadEdit(id);
    void browser.refresh();
  }
  await refreshPrerequisiteQueues();
}
function positionContextMenu(menu:HTMLElement,event:MouseEvent):void{
  menu.hidden=false;
  menu.style.left=Math.max(0,Math.min(event.clientX,innerWidth-menu.offsetWidth-6))+'px';
  menu.style.top=Math.max(0,Math.min(event.clientY,innerHeight-menu.offsetHeight-6))+'px';
}
async function createMemoryChild(id:string,kind:'topic'|'material'|'cloze',
  title=kind==='cloze'?t('未命名检测子卡片'):untitledCard[kind]):Promise<void>{
  if(browser.visible)await browser.close();
  await enqueue(async()=>{
    await save();
    const {node}=await request<{node:Material}>('createMemoryChild',{id,kind,title});
    recordCreation(node);
    await tree.refresh([node.parentId]);
    await open(node.id);
    editors?.question.focus();
    await refreshCounts();
  });
}
function memoryActions(id:string,kind:'topic'|'material'|'cloze'){
  const label=kind==='cloze'?'新建检测子卡片':kind==='topic'?'新建主题子卡片':'新建提取子卡片';
  return [
    [label,()=>void createMemoryChild(id,kind)],
    ['关联卡片…',()=>relationsPanel.openPicker(id)],
  ] as const;
}
function relationContext(targetId:string,kind:TreeNode['kind'],relation:CardRelationKey|null,event:MouseEvent):void{
  const menu=$('context-menu');menu.replaceChildren();
  const items:Array<readonly [string,()=>void]>=[
    ['打开',()=>void enqueue(()=>open(targetId))],
    ['在目录树中定位',()=>void enqueue(()=>tree.reveal(targetId))],
    ['卡片信息',()=>void openCardInfo(targetId)],
  ];
  if(kind!=='folder')items.push(...memoryActions(targetId,kind));
  if(relation)items.push(['解除关系',()=>void enqueue(async()=>{
    await request('removeCardRelation',{id:targetId,relation});
    await refreshRelations();
  })]);
  for(const [label,action] of items){
    const item=document.createElement('button');item.type='button';item.textContent=t(label);item.dataset.action=label;
    item.setAttribute('role','menuitem');
    item.onclick=()=>{menu.hidden=true;action();};
    menu.append(item);
  }
  if(arrangeContextMenu(menu,'relation'))positionContextMenu(menu, event);else menu.hidden=true;
}
const relationsPanel=new CardRelationsPanel($('card-relations'),$('relation-picker'),{
  add:(id,targetId)=>void enqueue(async()=>{
    await request('addRelatedCard',{id,targetId});
    await refreshRelations();
  }),
  open:id=>void enqueue(()=>open(id)),
  context:relationContext,
  error:message,
});
function refreshRelations():Promise<void>{
  return relationsPanel.show(!soloCard&&current!==null&&current.note.kind!=='folder'?current.note.id:null);
}
function context(node:TreeNode|null,event:MouseEvent,inBrowser=false,extra:Array<[string,()=>void]> = []):void{
  const menu=$('context-menu');menu.replaceChildren();
  const item=(text:string,action:()=>void,danger=false,id=text)=>{
    const button=document.createElement('button');button.textContent=t(text);button.dataset.action=id;button.className=danger?'danger':'';
    button.onclick=()=>{menu.hidden=true;action();};menu.append(button);return button;
  };
  if(!node){
    item('新建文件夹',()=>void newNode('folder',null));
  }else{
    item(shortcutTitle('修改显示名','rename'),()=>void rename(node),false,'修改显示名');
    // 把卡片/文件夹移动到任意目录（居中搜索框，仿 Obsidian 的 Move file）
    item('移至…',()=>void showMovePicker(node));
    // 目录树右键不再提供留存判定——它在工作区底部「更多」里（Shift+- 也能按）。
    // 浏览卡片的右键菜单保留，那里是表格操作的习惯入口。
    if(inBrowser&&node.kind!=='folder')item('留存判定 / 取消',()=>void enqueue(async()=>{
      const state=await request<{hold?:boolean}|null>('nodeStudy',{id:node.id});
      const hold=!state?.hold;
      await request('setCardHold',{id:node.id,hold});
      if(current?.note.id===node.id){cardFlags.set(node.id,{...(cardFlags.get(node.id)||{}),hold});applyCardBadge();}
      message(hold?t('已加入留存判定。'):t('已取消留存判定。'));
    }));
    if(node.kind==='folder'){
      activeFolderId=node.id;
      item('进入复习',()=>void enqueue(()=>startStudy('cards',node.id)));
      item('新建子文件夹',()=>void newNode('folder',node.id));
      item('新建主题',()=>void newNode('topic',node.id));
      item('新建提取',()=>void newNode('material',node.id));
      item('新建检测卡',()=>void newNode('cloze',node.id));
      item('牌组统计',()=>void openStatistics(node.id));
      item('复习设置',()=>void openDeckSettings(node.id));
    }else{
      const createChild=(kind:'topic'|'material'|'cloze')=>inBrowser
        ? newNode(kind,node.id)
        : createMemoryChild(node.id,kind,untitledCard[kind]);
      if(node.kind==='topic')item('新建子主题',()=>void createChild('topic'));
      item('新建提取',()=>void createChild('material'));
      item('新建检测卡',()=>void createChild('cloze'));
      for(const [label,action] of memoryActions(node.id,node.kind as 'topic'|'material'|'cloze'))item(label,action);
      // SM 术语——topic=主题，material=提取（extract），cloze=检测卡。
      for(const [kind,label] of [['topic',t('主题')],['material',t('提取')],['cloze',t('检测卡')]] as const)if(node.kind!==kind)item('转换为'+label,()=>void enqueue(async()=>{
        await save();await request('changeKind',{id:node.id,kind});await tree.refresh([node.parentId]);
        if(current?.note.id===node.id)await open(node.id,undefined,true);if(browser.visible)void browser.refresh();
        await refreshRelations();
        if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}await refreshCounts();
      }));
      item('卡片信息',()=>void openCardInfo(node.id));
      if(node.kind==='cloze')item('记录一次遗忘',()=>void enqueue(async()=>{
        await save();
        const eventId=await request<string>('recordForgotten',{id:node.id});
        recordUndo({run:async applied=>{
          await save();
          study=await request<StudySnapshot|null>('reviewUndo',{eventId});
          applied();
          if(study)await presentStudy();
          else await refreshCounts();
          if(browser.visible)void browser.refresh();
        }});
        if(study){
          const previous=study.item?.id;
          study=await request<StudySnapshot>('reviewRefresh');
          if(previous!==study.item?.id||previous===node.id&&current?.note.id===node.id)await presentStudy();
          else renderStudyControls();
        }
        await refreshCounts();
        if(browser.visible)void browser.refresh();
        message(t('已记录一次遗忘，可按 Ctrl+Z 撤销。'));
      }));
      if(node.kind==='cloze')item('重置记忆信息…',()=>void enqueue(async()=>{
        if(!await ask(t('重置记忆信息'),'',t('将「{0}」重置为 FSRS 新卡？保留历史复习记录。',node.title)))return;
        await save();
        const change=await request<{id:string;before:Schedule;after:Schedule}>('resetMemory',{id:node.id});
        const refresh=async()=>{
          if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
          else await refreshCounts();
          if(browser.visible)void browser.refresh();
        };
        recordUndo({run:async applied=>{
          await save();
          await request('restoreStudyEnabledBatch',{changes:[change]});
          applied();await refresh();
        }});
        await refresh();
        message(t('已重置为新卡，可按 Ctrl+Z 撤销。'));
      }));
      // —— 启动外部程序/终端。菜单项同步创建占位，异步拿到 metadata 后改文案/显隐，
      // 保证"运行启动命令"始终排在"设置启动命令"前面，不被异步打乱顺序。——
      const launchRun=item('运行启动命令',()=>void launchCurrent(node.id));launchRun.hidden=true;
      const launchSet=item('设置启动命令…',()=>void setLaunch(node.id));
      void loadLaunch(node.id).then(launch=>{launchRun.hidden=!launch;launchSet.textContent=launch?t('修改启动命令…'):t('设置启动命令…');});
      // —— 内嵌终端。cwd 取卡片 launch 配置的工作目录，缺省为主进程的程序数据目录。——
      item('内嵌终端',()=>void enqueue(async()=>{const launch=await loadLaunch(node.id);terminal.open(launch?.cwd);}));
      // 去掉「返回父卡与摘录来源」（目录树本身可以导航，菜单不必再占一项）。
      let state={enabled:true,reviewEnabled:false,pushEnabled:true};
      const toggle=item(node.kind==='cloze'?'加入复习':'搁置',()=>void enqueue(async()=>{
        await save();await request('setStudyEnabled',{id:node.id,enabled:node.kind==='cloze'?!state.reviewEnabled:!state.pushEnabled});await refreshCounts();
        if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
        if(browser.visible)void browser.refresh();
      }));
      toggle.dataset.action=node.kind==='cloze'?'加入／暂停复习':'搁置／恢复待办';
      const push=node.kind==='cloze'?item('搁置',()=>void enqueue(async()=>{await save();await request('setPushEnabled',{id:node.id,enabled:!state.pushEnabled});await refreshCounts();if(study){study=await request('reviewRefresh');await presentStudy();}if(browser.visible)void browser.refresh();})):null;
      if(push)push.dataset.action='搁置／恢复待办';
      void request<typeof state>('nodeStudy',{id:node.id}).then(value=>{if(value){state=value;toggle.textContent=node.kind==='cloze'?(state.reviewEnabled?t('暂停复习'):t('加入复习')):(state.pushEnabled?t('搁置'):t('恢复待办'));if(push){push.hidden=state.reviewEnabled;push.textContent=state.pushEnabled?t('搁置'):t('恢复待办');}}});
    }
    // 场景相关的额外项（浏览卡片里的「冲突文件…」等）
    for(const [label,action] of extra)item(label,action);
    menu.append(document.createElement('hr'));
    item(node.kind==='folder'?'删除文件夹':'删除卡片',()=>void remove(node),true);
  }
  if(arrangeContextMenu(menu,inBrowser?'browser':node?.kind??'blank'))positionContextMenu(menu, event);else menu.hidden=true;
}
/** 浏览卡片里右键垃圾桶中的卡片（冲突筛选会显示它们）。给「冲突文件…」和「恢复卡片」。 */
function browserTrashContext(row:{id:string;kind:NodeKind;deletedAt:string|null},event:MouseEvent):void{
  const menu=$('context-menu');menu.replaceChildren();
  const item=(text:string,action:()=>void)=>{const button=document.createElement('button');button.textContent=t(text);button.dataset.action=text;
    button.onclick=()=>{menu.hidden=true;action();};menu.append(button);};
  if(browser.hasConflict(row.id))item('冲突文件…',()=>void browser.openConflict(row.id));
  item('恢复卡片',()=>void enqueue(async()=>{
    await save();
    await request('trashRestore',{id:row.id});
    await tree.refresh([null]);
    await refreshCounts();
    if(browser.visible)void browser.refresh();
    message(t('已从垃圾桶恢复这张卡片。'));
  }));
  if(arrangeContextMenu(menu,'browser'))positionContextMenu(menu,event);else menu.hidden=true;
}
const tree=new DirectoryTree($('tree'),{
  select:node=>void enqueue(async()=>{
    if(node.kind==='folder'){
      activeFolderId=node.id;tree.selectNode(node.id);
      if(browser.visible)browser.filterFolder(node.id);
    }else await open(node.id,undefined,false,'preserve');
  }),
  context,rename:node=>void rename(node),
  move:(node,parentId)=>void enqueue(()=>moveNode(node,parentId)),
  deselect:()=>{activeFolderId=null;},
});
// 按住 Ctrl（macOS Cmd）时给 body 打 ctrl-down，让摘录高亮显示成"可点链接"的指针，
// 用户一眼就能看出 Ctrl 是否生效；松开或窗口失焦立即还原。
document.addEventListener('keydown',event=>{
  if(event.key==='Control'||event.key==='Meta')document.body.classList.add('ctrl-down');
});
document.addEventListener('keyup',event=>{
  if(event.key==='Control'||event.key==='Meta')document.body.classList.remove('ctrl-down');
});
window.addEventListener('blur',()=>document.body.classList.remove('ctrl-down'));
// 某些情况下按键事件被编辑器吃掉，用 mousemove 兜底同步状态
document.addEventListener('mousemove',event=>{
  document.body.classList.toggle('ctrl-down',event.ctrlKey||event.metaKey);
},{passive:true});
document.addEventListener('pointerdown',event=>{
  if(!(event.target as HTMLElement).closest('#context-menu'))$('context-menu').hidden=true;
  if(!(event.target as HTMLElement).closest('#study-more,#study-more-menu'))hideStudyMenu();
  // 点重来菜单以外的地方就收起它
  if(againMenu&&!(event.target as HTMLElement).closest('#again-menu,#study-buttons'))closeAgainMenu();
});
function focusedEditor(){
  if(editors?.answer?.view.hasFocus)return {editor:editors.answer,section:'answer' as const};
  if(editors?.question.view.hasFocus)return {editor:editors.question,section:'question' as const};
  return null;
}
// ===== 阅读点。字符偏移存 reading_state.reading_position。=====
// 取当前阅读位置：编辑器有焦点用光标偏移，否则用视口首行行首。
function currentReadingPosition():number{
  const view=editors?.question?.view;if(!view)return 0;
  if(view.hasFocus)return view.state.selection.main.head;
  try{const block=view.lineBlockAtHeight(0);if(block.from>0)return block.from;}catch{}
  return 0;
}
// 滚动到指定字符偏移（不移动光标与选区，避免打断阅读状态）。
function scrollEditorTo(position:number){
  const view=editors?.question?.view;if(!view)return;
  try{
    const target=Math.max(0,Math.min(position,view.state.doc.length));
    const line=view.lineBlockAt(target);
    view.scrollDOM.scrollTop=Math.max(0,line.top-40);
  }catch{/* 文档空或位置越界时忽略 */}
}
function showSwitcher(){const dialog=$<HTMLDialogElement>('switcher');if(!dialog.open)dialog.showModal();$<HTMLInputElement>('search-input').focus();}
document.addEventListener('keydown',event=>{
  if(event.isComposing||document.querySelector('dialog[open]'))return;
  if((event.target as Element)?.closest('input,textarea,select'))return;
  const shortcut=configuration.shortcuts.undoReview;
  if(!shortcut||shortcutFromEvent(event)!==shortcut)return;
  event.preventDefault();event.stopImmediatePropagation();undoLatest();
},true);
document.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Escape'){$('context-menu').hidden=true;hideStudyMenu();closeAgainMenu();}
  if(document.querySelector('dialog[open]'))return;
  const key=shortcutFromEvent(event),matching=COMMANDS.filter(command=>configuration.shortcuts[command.id]===key&&key);
  const isActual=study?.item?.id===current?.note.id;
  const editable=(event.target as Element)?.closest('input,textarea,[contenteditable="true"]');
  const command=matching.find(candidate=>{
    if(candidate.scope==='editor')return !!focusedEditor();
    // 编辑键（默认 E）在编辑态也要可用，否则按进去就出不来了；其余 card 快捷键仍禁止
    if(candidate.scope==='card'){
      if(candidate.id==='editCard')return !!study&&isActual&&(study.item?.kind==='fsrs'||study.item?.kind==='reading');
      return !!study&&isActual&&study.item?.kind==='fsrs'&&!studyEditing;
    }
    if(candidate.scope==='reading')return !!study&&isActual&&study.item?.kind==='reading'&&(!editable||key.includes('+'));
    // 搁置只在复习/待办中（非编辑态）触发
    if(candidate.id==='buryCard')return !!study&&isActual&&!studyEditing&&!editable;
    if(candidate.id==='undoReview')return false;
    return true;
  });
  if(!command)return;
  event.preventDefault();event.stopImmediatePropagation();
  const action=command.id;
  if(action==='extract'||action==='cloze'||action==='blank'){
    const focused=focusedEditor();if(!focused||!current)return;
    const {from,to}=focused.editor.view.state.selection.main;
    void createExcerpt(current,focused.section,action==='extract'?'extract':action==='cloze'?'cloze':'blank',from,to);
  }else if(action==='toggleReview')void enqueue(toggleStudy);
  else if(action==='toggleReading')void enqueue(()=>toggleStudy('reading'));
  else if(action==='toggleDirectory')toggleDirectory();
  // 浏览卡片改为独立窗口——主窗口的工作区、滚动位置与未保存草稿都不受影响
  else if(action==='browse')void window.reading.openBrowserWindow(undefined,current?.note.id||null).catch(()=>{});
  else if(action==='showAnswer')revealAnswer();
  else if(['again','hard','good','easy'].includes(action)){if(answerShown)gradeStudy({rating:({again:1,hard:2,good:3,easy:4} as any)[action]});}
  else if(action==='readDone')gradeStudy({action:'read'});
  else if(action==='readLater')gradeStudy({action:'later'});
  else if(action==='readSoon')gradeStudy({action:'soon'});
  else if(action==='readDismiss')gradeStudy({action:'dismiss'});
  else if(action==='newTopicDefault')void newTopicInDefault();
  else if(action==='navBack')void navigateBack();
  else if(action==='navForward')void navigateForward();
  else if(action==='stopCard')pauseCard();
  else if(action==='pauseReview')pauseReview();
  else if(action==='buryCard')buryCurrent();
  // N11（1.83）：按工作区当前卡片在目录树里定位（展开父级并选中）
  else if(action==='revealInTree'){if(current?.note)void enqueue(()=>tree.reveal(current!.note.id));}
  // N4：编辑键与点「编辑」完全同一条路径（会先把答案显示出来，否则编辑答案看不到内容）
  else if(action==='editCard'){if(study?.item)void enqueue(toggleStudyEditing);}
  else if(action==='bold'||action==='italic'){const focused=focusedEditor();if(focused)focused.editor.toggleWrap(action==='bold'?'**':'*');}
  else if(action==='addCard')void window.reading.openAddCardWindow(activeFolderId||current?.note.folderId||null).catch(()=>{});
  else if(action==='search')showSwitcher();
  else if(action==='save')void enqueue(async()=>{await save();await refreshCounts();});
  else if(action==='rename'){const node=tree.selectedNode()||current?.note;if(node)void rename(node);}
  else if(action==='settings'||action==='shortcuts')void openPreferences(action);
},true);
// 点击/编辑工作区时，把目录树和记忆树都聚焦到当前这张卡
let treeSyncFrame=0;
$('workspace').addEventListener('pointerdown',()=>{
  const id=current?.note.id;
  if(!id||tree.selectedNode()?.id===id)return;
  if(treeSyncFrame)return;
  treeSyncFrame=requestAnimationFrame(()=>{
    treeSyncFrame=0;
    const target=current?.note.id;
    if(!target)return;
    // reveal 会展开祖先并选中该行；记忆树面板本身跟随当前卡，这里只需保证目录树同步
    void tree.reveal(target).catch(()=>{});
  });
},true);
$('workspace').addEventListener('wheel',event=>{
  if(!event.ctrlKey||!event.deltaY)return;
  event.preventDefault();event.stopPropagation();
  fontSize=Math.max(10,Math.min(48,fontSize+(event.deltaY<0?1:-1)));
  configuration.settings.fontSize=fontSize;
  document.documentElement.style.setProperty('--text-size',fontSize+'px');
  void request('settingSet',{key:'fontSize',value:fontSize});
},{passive:false,capture:true});
let searchTimer:ReturnType<typeof setTimeout>;
$<HTMLInputElement>('search-input').oninput=()=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(async()=>{
    const query=$<HTMLInputElement>('search-input').value;
    try{
      const entries=await request<TreeNode[]>('search',{query});
      if($<HTMLInputElement>('search-input').value!==query)return;
      const results=$('search-results');results.replaceChildren();
      for(const node of entries){
        const button=document.createElement('button');button.textContent=node.title;
        button.onclick=()=>{$<HTMLDialogElement>('switcher').close();void enqueue(()=>open(node.id));};results.append(button);
      }
    }catch(error){message(String(error));}
  },150);
};
$('resize').onpointerdown=event=>{
  const element=event.currentTarget as HTMLElement;element.setPointerCapture(event.pointerId);
  element.onpointermove=move=>document.documentElement.style.setProperty('--sidebar-width',Math.max(175,Math.min(520,innerWidth-move.clientX))+'px');
  element.onpointerup=()=>{
    element.onpointermove=null;element.onpointerup=null;
    void request('settingSet',{key:'sidebarWidth',value:parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'))});
  };
};
$('minimize').onclick=()=>window.reading.windowAction('minimize');
// niri 等 Wayland 平铺合成器不支持最小化，点击会卡住窗口——Linux 上直接隐藏该按钮
if(window.reading.platform==='linux')$('minimize').hidden=true;
$('maximize').onclick=()=>window.reading.windowAction('maximize');
$('close').onclick=()=>window.reading.windowAction('close');
window.reading.onCloseRequested(()=>{
  const occlusion=$<HTMLDialogElement>('image-occlusion');
  if(occlusion.open)occlusion.close();
  void enqueue(async()=>{
    document.body.inert=true;
    try{
      await save();
      if(!soloCard&&!soloWindow){
        await browser.flushEdit();
        const lastId=current?.note.id||null;
        // 本机聚焦的卡片写进 state/ui-state.json（每台机器独立），数据库里的 lastNode 只作旧版迁移。
        await request('settingSet',{key:'lastNode',value:lastId});
        void window.reading.uiStateSet('lastNode',lastId).catch(()=>{});
      }
      window.reading.confirmClose();
    }catch(error){
      document.body.inert=false;
      throw error;
    }
  });
});
window.addEventListener('error',event=>message(event.message));
window.addEventListener('unhandledrejection',event=>message(String(event.reason?.message||event.reason)));

/** 当同一处高亮对应多张卡片时，在鼠标位置弹出一个小选择框。 */
async function showLinkPicker(ids:string[],at:{x:number;y:number}):Promise<void>{
  document.getElementById('link-picker')?.remove();
  const box=document.createElement('div');box.id='link-picker';box.setAttribute('role','menu');
  const title=document.createElement('p');title.textContent=t('这里有多张卡片，跳到：');box.append(title);
  for(const id of ids){
    let label=id;
    try{const node=await request<TreeNode>('get',{id});if(node)label=(node.kind==='cloze'?t('检测卡 · '):node.kind==='material'?t('提取 · '):t('主题 · '))+node.title;}catch{/* 取不到标题就显示 id */}
    const button=document.createElement('button');button.type='button';button.textContent=label;
    button.onclick=()=>{box.remove();void enqueue(()=>open(id));};
    box.append(button);
  }
  box.style.left=Math.max(8,Math.min(window.innerWidth-260,at.x+6))+'px';
  box.style.top=Math.max(8,Math.min(window.innerHeight-160,at.y+6))+'px';
  document.body.append(box);
  const dismiss=(event:PointerEvent)=>{if(!box.contains(event.target as Node)){box.remove();document.removeEventListener('pointerdown',dismiss);}};
  setTimeout(()=>document.addEventListener('pointerdown',dismiss),0);
  document.addEventListener('keydown',function escape(event){if(event.key==='Escape'){box.remove();document.removeEventListener('keydown',escape);}},{once:true});
}

/** 返回上一个界面；只有历史里确实有上一张时才动。 */
async function navigateBack():Promise<void>{
  if(navIndex<=0)return;
  navRestoring=true;
  try{navIndex--;await open(navStack[navIndex]!);}finally{navRestoring=false;}
}
/** 前进到下一个界面；没有"刚返回过"的历史就不做任何事（不是猜下一张）。 */
async function navigateForward():Promise<void>{
  if(navIndex<0||navIndex>=navStack.length-1)return;
  navRestoring=true;
  try{navIndex++;await open(navStack[navIndex]!);}finally{navRestoring=false;}
}
async function refreshCounts(){
  tree.setCounts(await request<Record<string,FolderCounts>>('folderCounts'));
  renderStudyCounts(study,answerShown);
}
async function refreshPrerequisiteQueues(){
  if(study){
    const previous=study.item?.id;
    study=await request<StudySnapshot>('reviewRefresh');
    if(previous!==study.item?.id&&(!current||current.note.id===previous||current.note.id===study.item?.id)){
      await presentStudy();
      return;
    }
    applyStudyPresentation();
  }
  await refreshCounts();
}
function emptyWorkspace(text:string){disposeEditors();current=null;void relationsPanel.show(null);window.reading.setEditorCard('workspace',null);$('workspace').replaceChildren();const empty=document.createElement('div');empty.className='empty';empty.textContent=text;$('workspace').append(empty);$('breadcrumbs').replaceChildren();renderStudyControls();}
function applyStudyPresentation(){
  // 复习（检测卡）时答案默认不显示——只认"当前处于复习模式 + 是检测卡"，
  // 不再依赖卡片是否已加载完成（此前异步打开时空档期会把答案露出来）。
  const answer=$('workspace').querySelector<HTMLElement>('.card-pane.answer');
  if(answer&&current){
    const {hideAnswer:hidden,coverMask}=cardPresentation(current);
    answer.classList.toggle('is-answer-hidden',hidden);const host=answer.querySelector<HTMLElement>('.card-editor');if(host){host.inert=hidden;host.setAttribute('aria-hidden',String(hidden));}
    // 答案未揭开时，**整个下半区（含分隔条与提示文字）都不显示**，题目占满全高；
    // 点「显示答案」后才恢复上下分区。此前只是隐藏编辑器、留着空面板和提示，用户觉得不该出现。
    const card=answer.closest<HTMLElement>('.test-card');
    card?.classList.toggle('answer-collapsed',hidden);
    card?.classList.toggle('is-mask-covered',coverMask);
  }
  renderStudyToggles(study,shortcutTitle);
  renderStudyControls();
  // 侧栏与更多菜单的快捷键提示（统一从 configuration.shortcuts 反查）
  const hint=(elementId:string,label:string,commandId:CommandId)=>{
    const element=document.getElementById(elementId);if(!element)return;
    element.setAttribute('title',shortcutTitle(label,commandId));
  };
  hint('open-browse',t('浏览卡片'),'browse');hint('open-add-card',t('添加卡片'),'addCard');hint('open-shortcuts',t('快捷键'),'shortcuts');
  hint('open-settings',t('设置'),'settings');hint('toggle-directory',t('目录树'),'toggleDirectory');
  hint('study-undo',t('撤销上次'),'undoReview');hint('study-pause',t('留存判定'),'stopCard');
  hint('study-pause-review',t('待办暂停'),'pauseReview');
  // 「只暂停复习」只在复习（检测卡）模式出现；「返回阅读」已移除
  const reviewOnly=['study-pause-review'];
  for(const id of reviewOnly){const element=document.getElementById(id) as HTMLButtonElement|null;if(element)element.hidden=study?.item?.kind!=='fsrs';}
  // 留存判定对所有卡片都可选（检测卡与非检测卡）
  {const element=document.getElementById('study-pause') as HTMLButtonElement|null;if(element)element.hidden=false;}
  // 菜单项右侧显示快捷键名
  const menuKey=(id:string,commandId:CommandId)=>{
    const element=document.getElementById(id) as HTMLButtonElement|null;if(!element)return;
    const key=shortcutKey(commandId);element.querySelector('.menu-shortcut')?.remove();
    if(!key)return;const tag=document.createElement('span');tag.className='menu-shortcut';tag.textContent=key;element.append(tag);
  };
  menuKey('study-pause','stopCard');menuKey('study-pause-review','pauseReview');
  menuKey('study-undo','undoReview');hint('study-edit',t('编辑'),'editCard');
  // 右上角小字替代顶部提示
  applyCardBadge();
}
function renderStudyControls(){
  renderStudyBar({
    study,current:current?.note??null,answerShown,busy:studyBusy,editing:studyEditing,canUndo:undoHistory.length>0,highlights,
  },{
    shortcutTitle,ratingAvailable,grade:gradeStudy,revealAnswer,
    returnToCard:id=>void enqueue(()=>open(id,undefined,true)),
    refresh:()=>void enqueue(async()=>{study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}),
    enroll:id=>void enqueue(async()=>{
      await save();
      await request('setStudyEnabled',{id,enabled:true});
      study=await request<StudySnapshot>('reviewRefresh');
      await presentStudy();
    }),
  });
}
function revealAnswer(){if(!study?.item||study.item.kind!=='fsrs'||study.item.id!==current?.note.id)return;answerShown=true;applyStudyPresentation();}
async function presentStudy(){
  if(!study)return;answerShown=false;studyEditing=false;hideStudyMenu();
  if(study.item)await open(study.item.id,undefined,true);
  else emptyWorkspace(study.folderId?t('「{0}」当前没有到期检测卡。',study.folderTitle):t('当前没有到期卡片。可以继续编辑材料，或等待下一次学习步骤。'));
  // 恢复阅读点（只对材料卡；打开后再滚动，避免被 open 的重置覆盖）。
  if(study.item?.kind==='reading'){
    const state=await request<{readingPosition?:number}|null>('nodeStudy',{id:study.item.id});
    if(state?.readingPosition)scrollEditorTo(state.readingPosition);
  }
  // auto-postpone 提示（放 open 之后，避免被清空）。
  if(study.postponed)message(t('待办积压超出上限，已自动延后 {0} 项低优先级材料。',study.postponed));
  applyStudyPresentation();await refreshCounts();
}
async function startStudy(mode:'cards'|'reading'='cards',folderId?:string){
  await save();
  if(browser.visible){await browser.flushEdit();browser.hide();}
  if(!study)studyOrigin=current?.note.id||null;
  study=await request<StudySnapshot>('reviewStart',{mode,folderId});await presentStudy();
}
async function stopStudy(){
  await save();await request('reviewStop');study=null;answerShown=false;studyEditing=false;hideStudyMenu();
  const target=studyOrigin||current?.note.id;studyOrigin=null;
  if(target&&await request('get',{id:target}))await open(target,undefined,true);
  else emptyWorkspace(t('从目录树中选择材料。'));
  applyStudyPresentation();await refreshCounts();
}
async function toggleStudy(mode:'cards'|'reading'='cards',folderId?:string){if(study?.mode===mode)await stopStudy();else await startStudy(mode,folderId);}
function ratingAvailable(rating?:number):boolean{
  if(rating===2)return configuration.settings.showHardRating;
  if(rating===4)return configuration.settings.showEasyRating;
  return true;
}
// 重来目标选择——在「重来」按钮上方弹一个小菜单，勾选子卡后再按一次 1 确认
let againMenu:{choices:AgainChildCandidate[];selected:Set<string>}|null=null;
function closeAgainMenu(){document.getElementById('again-menu')?.remove();againMenu=null;}
function openAgainMenu(choices:AgainChildCandidate[]){
  closeAgainMenu();
  const menu=document.createElement('div');menu.id='again-menu';menu.className='again-menu';menu.setAttribute('role','menu');
  const title=document.createElement('p');title.className='again-menu-title';title.textContent=t('选择要一起重来的子卡（再按一次 1 确认）');menu.append(title);
  for(const choice of choices){
    const row=document.createElement('label');row.className='again-menu-row';
    const box=document.createElement('input');box.type='checkbox';box.value=choice.id;
    box.onchange=()=>{if(!againMenu)return;if(box.checked)againMenu.selected.add(choice.id);else againMenu.selected.delete(choice.id);};
    const text=document.createElement('span');text.textContent=choice.title;
    row.append(box,text);menu.append(row);
  }
  const hint=document.createElement('p');hint.className='again-menu-hint';hint.textContent=t('不勾选 = 只重来当前卡；Esc 取消');
  menu.append(hint);document.body.append(menu);
  const anchor=$('study-buttons').getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,anchor.left+anchor.width/2-menu.offsetWidth/2))+'px';
  menu.style.top=Math.max(8,anchor.top-menu.offsetHeight-8)+'px';
  againMenu={choices,selected:new Set()};
}
function confirmAgainMenu(){
  const ctx=againMenu;if(!ctx)return;
  const selected=ctx.choices.filter(choice=>ctx.selected.has(choice.id)).map(({id,revision})=>({id,revision}));
  closeAgainMenu();
  gradeStudy({rating:1,againChildren:selected});
}
function gradeStudy(input:StudyAnswer&{againChildren?:AgainChildSelection[]}){
  if(studyBusy||studyEditing||!study?.item||study.item.id!==current?.note.id)return;
  if(study.item.kind==='fsrs'&&(!answerShown||!ratingAvailable(input.rating)))return;
  // 重来小菜单开着时，再按一次「重来」（或快捷键 1）= 确认所选子卡一起重来
  if(input.rating===1&&againMenu){confirmAgainMenu();return;}
  const snapshot=study,item=study.item;studyBusy=true;renderStudyControls();
  void enqueue(async()=>{
    try{
      await save();
      const submission={sessionId:snapshot.sessionId,token:item.token,revision:item.revision};
      let againChildren:AgainChildSelection[]|undefined=input.againChildren;
      if(item.kind==='fsrs'&&input.rating===1&&!againChildren){
        const choices=await request<AgainChildCandidate[]>('reviewAgainDependents',submission);
        if(choices.length){
          // 不弹对话框，改为在「重来」按钮上方弹小菜单；勾选后再按 1 确认
          openAgainMenu(choices);
          return;
        }
      }
      // 阅读点随评分请求一起提交（不能单独发 setReadingPosition——它会让
      // reading_state.revision+1，随后评分校验判定"复习状态已改变，请刷新"）。
      const position=item.kind==='reading'?currentReadingPosition():undefined;
      study=await request<StudySnapshot>('reviewGrade',{...submission,...input,againChildren,...(position===undefined?{}:{position})});
      if(input.action!=='soon'){
        recordUndo({run:async applied=>{
          await save();
          study=await request<StudySnapshot|null>('reviewUndo',{eventId:item.token});
          applied();
          if(study)await presentStudy();
          else await refreshCounts();
        }});
      }
      await presentStudy();
      // leech 自动进入待办暂停时给个短暂提示
      if(item.kind==='fsrs'&&input.rating){
        const state=await request<{reviewEnabled?:boolean;pushEnabled?:boolean}|null>('nodeStudy',{id:item.id});
        if(state&&state.reviewEnabled===false&&state.pushEnabled===true)flashCardNotice(t('上张卡片已进入待办暂停'));
      }
    }
    finally{studyBusy=false;renderStudyControls();}
  });
}
const preferences=new PreferencesDialog(async(draft,node,priority)=>{
  const result=await request<Configuration>('configSave',{settings:draft.settings,shortcuts:draft.shortcuts});
  if(node){await request('setPriority',{id:node.id,priority});node.priority=priority;tree.update(node);if(current?.note.id===node.id)current.note.priority=priority;}
  configuration=result;applyConfiguration();await refreshCounts();
  if(study){study=await request<StudySnapshot>('reviewRefresh');applyStudyPresentation();}
  return result;
},async(folderId,overrides)=>{
  await save();const result=await request<DeckConfiguration>('deckConfigSave',{folderId,overrides});
  if(study){study=await request<StudySnapshot>('reviewRefresh');applyStudyPresentation();}return result;
},()=>void window.reading.openBrowserWindow('conflict').catch(()=>{}));
const browser=new CardBrowser($('card-browser'),$('browser-rule'),$('browser-filters'),{
  run:enqueue,
  beforeOpen:async()=>{await save();if(study)await stopStudy();browserOrigin=current?.note.id||null;},
  beforeQuery:save,
  // 单击只选中（不再在下方打开编辑区），双击才在新窗口里编辑这张卡。
  select:async id=>{if(!id)emptyWorkspace(t('没有匹配的卡片。'));},
  openWindow:id=>void request('cardWindow',{id}).catch(()=>{}),
  setEnabled:async(ids,enabled)=>{
    if(!ids.length)return;
    await save();
    const changes=await request<{id:string;before:Schedule;after:Schedule}[]>('setStudyEnabledBatch',{ids,enabled});
    if(changes.length)recordUndo({run:async applied=>{
      await save();
      await request('restoreStudyEnabledBatch',{changes});
      applied();
      await refreshCounts();
      if(browser.visible)void browser.refresh();
    }});
    await refreshCounts();
  },
  move:ids=>chooseMoveFolder(async parentId=>{
    await save();
    const previous=await request<{id:string;parentId:string|null}[]>('moveCards',{ids,parentId});
    if(!previous.length)return;
    const refresh=async()=>{
      await refreshMovedNode(previous[0]!.id,previous[0]!.parentId,parentId);
      await tree.refresh(previous.slice(1).map(item=>item.parentId));
      if(browser.visible)void browser.refresh();
    };
    recordUndo({run:async applied=>{
      await save();
      await request('restoreMovedCards',{previous,expectedParentId:parentId});
      applied();
      await refresh();
    }});
    await refresh();
  }),
  remove:ids=>enqueue(async()=>{
    if(!ids.length)return;
    await save();
    const targets:Material[]=[];
    for(const id of ids){
      const note=await request<Material|null>('get',{id});
      if(note)targets.push(note);
    }
    if(!targets.length)return;
    // 父子卡片一起选中时只删最上层——删除会级联整棵子树，撤销也按批次整棵恢复，
    // 否则先删子再删父，撤销会把子卡片恢复到默认文件夹里。
    const selected=new Set(targets.map(note=>note.id));
    const roots:Material[]=[];
    for(const note of targets){
      const chain=await request<TreeNode[]>('path',{id:note.id}).catch(()=>[]);
      if(chain.some(node=>node.id!==note.id&&selected.has(node.id)))continue;
      roots.push(note);
    }
    if(!roots.length)return;
    const confirmed=await ask(t('删除卡片'),'',t('删除选中的 ')+roots.length+t(' 张卡片')+
      (roots.length<targets.length?t('（其中 {0} 张是子卡片，随父级一起删除）',(targets.length-roots.length)):'')+
      t('？有冲突的卡片会写一条删除版本，两端都按删除处理。删除后可 Ctrl+Z 撤销。'));
    if(!confirmed)return;
    const removed:Array<{id:string;parentId:string|null}>=[];
    for(const note of roots){
      try{
        if(browser.hasConflict(note.id)&&!note.hasChildren)await window.reading.syncDiscardContent(note.id);
        else await request('remove',{id:note.id});
        drafts.delete(note.id);
        removed.push({id:note.id,parentId:note.parentId});
      }catch{/* 单张失败不影响其余选中项 */}
    }
    if(!removed.length)return;
    recordUndo({run:async applied=>{
      await save();
      for(const item of removed)await request('trashRestore',{id:item.id});
      applied();
      await tree.refresh([null]);
      await refreshCounts();
      if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
      if(browser.visible)void browser.refresh();
    }});
    if(current&&removed.some(item=>item.id===current?.note.id))emptyWorkspace(t('从目录树中选择材料。'));
    await tree.refresh([null]);
    await refreshCounts();
    if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
    await refreshRelations();
    if(browser.visible)void browser.refresh();
    message(t('已删除 {0} 张卡片，可按 Ctrl+Z 撤销。',removed.length));
  }),
  saveEdit:async input=>{
    await save();
    const before=await request<Material|null>('get',{id:input.id});
    if(!before)throw Error(t('卡片已删除。'));
    const result=await request<{revision:number}>('save',input);
    if(before.content!==input.content||before.answer!==input.answer){
      recordUndo({run:async applied=>{
        await save();
        const latest=await request<Material|null>('get',{id:input.id});
        if(!latest||latest.content!==input.content||latest.answer!==input.answer||
          browser.hasUnsavedEdit(input.id,input.content,input.answer))throw Error(t('正文已变化，请先处理未保存的编辑。'));
        await request('save',{id:input.id,revision:latest.revision,content:before.content,answer:before.answer});
        applied();
        drafts.delete(input.id);
        if(current?.note.id===input.id)await open(input.id,undefined,true);
        await browser.reloadEdit(input.id);
        void browser.refresh();
        await refreshCounts();
      }});
    }
    drafts.delete(input.id);
    if(current?.note.id===input.id)await open(input.id,undefined,true);
    return result;
  },
  context:(row,event)=>void enqueue(async()=>{
    await save();
    if(row.deletedAt){browserTrashContext(row,event);return;}
    const note=await request<Material>('get',{id:row.id});
    if(note)context(note,event,true,browser.hasConflict(row.id)?[['冲突文件…',()=>void browser.openConflict(row.id)]]:[]);
  }),
  info:id=>void openCardInfo(id),
  contentChanged:async id=>{
    drafts.delete(id);
    if(current?.note.id===id)await open(id,undefined,true);
    await refreshCounts();
  },
  closed:async()=>{if(soloBrowser){window.reading.closeCardWindow();return;}if(!current&&browserOrigin&&await request('get',{id:browserOrigin}))await open(browserOrigin);browserOrigin=null;},
  // 独立浏览窗口里的按钮是「关窗」，不是「回到编辑」
  closeLabel:soloBrowser?t('关闭窗口'):t('回到编辑'),
  visibility:visible=>{document.body.classList.toggle('browser-open',visible);$('open-browser').classList.toggle('is-active',visible);$('open-browser').setAttribute('aria-pressed',String(visible));applyDirectory();},
});
window.reading.onSyncedContent((applied,parentId,nodeId)=>void enqueue(async()=>{
  if(soloCard||soloWindow)return;
  if(applied){
    // 只刷新新卡所在的那一支，避免整棵树重建把工作区闪一下
    if(parentId)await tree.refresh([parentId]);else await tree.reset();
    // 子窗口新建的卡片也要能 Ctrl+Z 撤销
    if(nodeId){const created=await request<Material|null>('get',{id:nodeId});if(created)recordCreation(created);}
    await refreshCounts();await refreshRelations();
  }
  else await refreshCounts();
  if(browser.visible)void browser.refresh();
}));
function applyDirectory(){
  document.body.classList.toggle('directory-collapsed',directoryCollapsed);
  const collapsed=directoryCollapsed||browser.visible;
  const button=$('toggle-directory');button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',collapsed?t('展开目录树'):t('收起目录树'));setIcon(button,collapsed?'panel-right-open':'panel-right-close');
}
function toggleDirectory(){
  if(browser.visible){void browser.close().then(()=>{directoryCollapsed=false;applyDirectory();void request('settingSet',{key:'directoryCollapsed',value:false});});return;}
  directoryCollapsed=!directoryCollapsed;applyDirectory();void request('settingSet',{key:'directoryCollapsed',value:directoryCollapsed});
}
function hideStudyMenu(){$('study-more-menu').hidden=true;$('study-more').setAttribute('aria-expanded','false');}
async function toggleStudyEditing(){
  if(studyBusy||!study?.item||study.item.id!==current?.note.id)return;
  await save();
  // 待办里的材料本来就能编辑——按钮/Alt+E 直接打开当前材料并聚焦编辑区。
  if(study.item.kind==='reading'){await open(study.item.id,undefined,true);return;}
  studyEditing=!studyEditing;
  if(studyEditing){answerShown=true;await open(study.item.id,undefined,true);}
  else{
    const previous=study.item.id;study=await request<StudySnapshot>('reviewRefresh');
    if(study.item?.id===previous)await open(previous,undefined,true);else await presentStudy();
  }
}
function applyConfiguration(){fontSize=configuration.settings.fontSize;document.documentElement.style.setProperty('--text-size',fontSize+'px');document.documentElement.dataset.theme=configuration.settings.theme;applyCustomCss(configuration.settings.customCss);}
/** 外观自定义 CSS——写进一个 <style>，留空则移除。 */
function applyCustomCss(css:string|undefined){
  const text=(css||'').trim();
  let style=document.getElementById('custom-css') as HTMLStyleElement|null;
  if(!text){style?.remove();return;}
  if(!style){style=document.createElement('style');style.id='custom-css';document.head.append(style);}
  style.textContent=text;
}
async function openPreferences(tab:PreferenceTab|'settings'){await enqueue(save);preferences.open(tab==='settings'?'general':tab,configuration,tree.selectedNode()||current?.note||null);}
async function openDeckSettings(folderId:string){await enqueue(save);preferences.openDeck(await request<DeckConfiguration>('deckConfig',{folderId}),configuration);}
// 工具栏的复习/待办/统计按目录树当前聚焦的牌组打开；聚焦的是卡片就用它所属的文件夹。
const focusedDeck=()=>activeFolderId||undefined;
$('toggle-review').onclick=()=>void enqueue(()=>toggleStudy('cards',focusedDeck()));
$('toggle-reading').onclick=()=>void enqueue(()=>toggleStudy('reading',focusedDeck()));
$('toggle-directory').onclick=toggleDirectory;
$('open-browser').onclick=()=>void window.reading.openBrowserWindow(undefined,tree.selectedNode()?.id||current?.note.id||null).catch(()=>{});
// 功能栏「添加卡片」——与 Ctrl+Shift+N 同一条路径，带上当前文件夹
$('open-add-card').onclick=()=>void window.reading.openAddCardWindow(activeFolderId||current?.note.folderId||null).catch(()=>{});
$('open-statistics').onclick=()=>void openStatistics(focusedDeck());
$('open-trash').onclick=()=>void trash.open();
$('open-settings').onclick=()=>void openPreferences('settings');
$('open-shortcuts').onclick=()=>void openPreferences('shortcuts');

// 更多菜单里的三个状态
// - 待办暂停（原「只停复习」）：暂停复习，卡片进入待办继续读；leech 会自动进入这个状态
// - 留存判定：不确定要不要留在 IR 时收进暂存点（复习/待办都停），之后可在浏览卡片取消或删除
// - 搁置到明天：只把到期日推到下一个日切点
function flashCardNotice(text:string):void{
  const existing=document.getElementById('card-notice-flash');
  if(existing)existing.remove();
  const notice=document.createElement('div');
  notice.id='card-notice-flash';notice.className='card-notice-flash';notice.textContent=text;
  document.body.append(notice);
  setTimeout(()=>notice.remove(),3200);
}
// 搁置（菜单项与快捷键 `=` 共用）
function buryCurrent():void{
  const id=study?.item?.id||current?.note.id;
  if(!id)return;
  void enqueue(async()=>{
    try{
      await request('buryCard',{id});
      cardFlags.set(id,{...(cardFlags.get(id)||{}),buried:true});
      applyCardBadge();hideStudyMenu();
      flashCardNotice(t('已搁置到下一个日切点'));
    }catch(error){message((error as Error).message);}
  });
}
function pauseCard():void{void enqueue(async()=>{
  hideStudyMenu();
  const id=study?.item?.id||current?.note.id;
  if(!id)return;
  await save();
  const state=await request<{hold?:boolean}|null>('nodeStudy',{id});
  const hold=!state?.hold;
  await request('setCardHold',{id,hold});
  cardFlags.set(id,{...(cardFlags.get(id)||{}),hold,reviewEnabled:false,enabled:false});
  applyCardBadge();
  message(hold?t('已加入留存判定：先放进暂存点，之后可在浏览卡片里取消或删除。'):t('已取消留存判定：卡片回到待办/复习流程。'));
  recordUndo({run:async applied=>{
    await request('setCardHold',{id,hold:!hold});
    applied();
    cardFlags.set(id,{...(cardFlags.get(id)||{}),hold:!hold});
    applyCardBadge();
    message(!hold?t('已撤销：卡片回到留存判定。'):t('已撤销：卡片已加入留存判定。'));
  }});
});}
$('study-pause').onclick=pauseCard;
$('study-pause').onclick=pauseCard;
// 「只停复习」只把卡片移出复习队列，仍留在待办里
function pauseReview():void{void enqueue(async()=>{
  hideStudyMenu();
  if(!study?.item||study.item.kind!=='fsrs')return;
  await save();
  const id=study.item.id;
  await request('setStudyEnabled',{id,enabled:false});
  study=await request<StudySnapshot>('reviewRefresh');await presentStudy();
  if(current?.note.id===id)await open(id,undefined,true);
  cardFlags.set(id,{...(cardFlags.get(id)||{}),reviewEnabled:false,pushEnabled:true});
  applyCardBadge();
  flashCardNotice(t('上张卡片已进入待办暂停'));
  message(t('已进入待办暂停：暂停复习，卡片仍留在待办里继续读。'));
});}$('study-pause-review').onclick=pauseReview;
// 搁置到明天（只对检测卡有意义）
$('study-bury').onclick=()=>{
  const id=current?.note.id;
  if(!id)return;
  void enqueue(async()=>{
    try{
      await request('buryCard',{id});
      cardFlags.set(id,{...(cardFlags.get(id)||{}),buried:true});
      applyCardBadge();
      hideStudyMenu();
      message(t('已搁置到明天（下一个日切点会自动回到队列）。'));
    }catch(error){message((error as Error).message);}
  });
};
$('study-undo').onclick=undoLatest;
// 优先级弹窗——显示当前值，输入 0–9 后回车保存（ask 的输入框在表单里，回车即提交）。
$('study-priority').onclick=()=>void enqueue(async()=>{
  if(!study?.item||study.item.kind!=='reading')return;
  const current=study.item.priority;
  const text=await ask(t('设置优先级（0–9，0 绝对优先、1 最高、9 最低）'),String(current));
  if(text===null)return;
  const parsed=Number(text);
  if(!Number.isInteger(parsed)||parsed<0||parsed>9){message(t('优先级需为 0–9 的整数。'));return;}
  await request('setPriority',{id:study.item.id,priority:parsed});
  const node=await request<TreeNode>('get',{id:study.item.id});if(node)tree.update(node);
  study=await request<StudySnapshot>('reviewRefresh');await presentStudy();
});
$('study-edit').onclick=()=>void enqueue(toggleStudyEditing);
$('study-more').onclick=()=>{const menu=$('study-more-menu');menu.hidden=!menu.hidden;$('study-more').setAttribute('aria-expanded',String(!menu.hidden));};
$('study-browse').onclick=()=>{hideStudyMenu();void window.reading.openBrowserWindow(undefined,current?.note.id||null).catch(()=>{});};
// 更多里的「退出复习」已移除（用 Alt+R 或侧栏按钮退出）
for(const button of $('highlight-controls').querySelectorAll<HTMLButtonElement>('button'))button.onclick=()=>{
  if(!current)return;const key=button.dataset.highlight;if(key==='all'){const value=!(highlights.extract&&highlights.cloze);highlights={extract:value,cloze:value};}else highlights={...highlights,[key!]:!highlights[key as 'extract'|'cloze']};
  editors?.question.setHighlights(highlights);editors?.answer?.setHighlights(highlights);renderStudyControls();void request('settingSet',{key:'highlights:'+current.note.id,value:highlights});
};
function applyDirectoryTypes(){for(const button of $('directory-filters').querySelectorAll<HTMLButtonElement>('button'))button.setAttribute('aria-pressed',String(directoryTypes.includes(button.dataset.type as TreeType)));}
for(const button of $('directory-filters').querySelectorAll<HTMLButtonElement>('button'))button.onclick=()=>void enqueue(async()=>{
  const type=button.dataset.type as TreeType;directoryTypes=directoryTypes.includes(type)?directoryTypes.filter(value=>value!==type):[...directoryTypes,type];
  applyDirectoryTypes();await tree.setTypes(directoryTypes);await request('settingSet',{key:'directoryTypes',value:directoryTypes});
});
setInterval(()=>{
  if(document.hidden||document.querySelector('dialog[open]')||studyBusy)return;
  void enqueue(async()=>{await refreshCounts();if(study&&!study.item){study=await request<StudySnapshot>('reviewRefresh');if(study.item)await presentStudy();else renderStudyControls();}});
},15000);

// ===== 独立「添加卡片」窗口（?add=1）=====
// 仿 Anki 的「添加」：先选类型与位置，再写正文/答案；添加后清空正文但不关窗，方便连续添加。
async function mountAddCardWindow():Promise<void>{
  document.body.classList.add('solo-add');
  const workspace=$('workspace');workspace.replaceChildren();
  const raw=await request<Array<{id:string;title:string;parentId:string|null}>>('folders');
  const byId=new Map(raw.map(folder=>[folder.id,folder]));
  const pathOf=(start:{id:string;title:string;parentId:string|null}|null|undefined)=>{
    const parts:string[]=[];const seen=new Set<string>();let cursor:{id:string;title:string;parentId:string|null}|null|undefined=start;
    while(cursor&&!seen.has(cursor.id)){seen.add(cursor.id);parts.unshift(cursor.title);cursor=cursor.parentId?byId.get(cursor.parentId):null;}
    return parts.join('/');
  };
  const folders=raw.map(folder=>({id:folder.id,path:pathOf(folder)})).sort((a,b)=>a.path.localeCompare(b.path));
  const form=document.createElement('form');form.id='add-card-form';form.autocomplete='off';
  const heading=document.createElement('h2');heading.textContent=t('添加卡片');
  const field=(label:string,control:HTMLElement)=>{const wrapper=document.createElement('label');wrapper.className='add-field';
    const span=document.createElement('span');span.textContent=label;wrapper.append(span,control);return wrapper;};
  const kindSelect=document.createElement('select');kindSelect.name='kind';
  for(const [value,label] of [['cloze',t('检测卡')],['material',t('提取（问答卡）')],['topic',t('主题')]] as const){
    const option=document.createElement('option');option.value=value;option.textContent=label;kindSelect.append(option);
  }
  const folderSelect=document.createElement('select');folderSelect.name='folder';
  for(const folder of folders){const option=document.createElement('option');option.value=folder.id;option.textContent=folder.path;folderSelect.append(option);}
  // 主窗口按 Ctrl+Shift+N 时会带上当前文件夹；没有就用第一个文件夹，避免建卡时还要再选一次
  const preferred=soloAddFolder&&folders.some(folder=>folder.id===soloAddFolder)?soloAddFolder:folders[0]?.id;
  if(preferred)folderSelect.value=preferred;
  const titleInput=document.createElement('input');titleInput.type='text';titleInput.placeholder=t('留空则按正文自动生成');
  const contentInput=document.createElement('textarea');contentInput.rows=6;
  contentInput.placeholder=t('正文（Markdown）。检测卡请在要挖空的位置写 [...]');
  const answerInput=document.createElement('textarea');answerInput.rows=2;answerInput.placeholder=t('答案（检测卡必填，否则不进复习队列）');
  const answerField=field(t('答案'),answerInput);
  const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent=t('添加');
  const hint=document.createElement('p');hint.className='add-hint';
  hint.textContent=t('Ctrl+Enter 添加 · Esc 关闭窗口。添加后会清空正文，方便连续添加。');
  const footer=document.createElement('div');footer.className='add-actions';footer.append(submit);
  form.append(heading,field(t('类型'),kindSelect),field(t('位置'),folderSelect),field(t('标题'),titleInput),field(t('正文'),contentInput),answerField,footer,hint);
  workspace.append(form);
  const syncKind=()=>{answerField.hidden=kindSelect.value!=='cloze';};
  kindSelect.onchange=syncKind;syncKind();
  if(!folders.length){
    hint.textContent=t('还没有文件夹：请回主窗口右键目录空白处新建文件夹，再回来添加卡片。');
    submit.disabled=true;
  }
  let busy=false;
  const add=async()=>{
    if(busy||!folders.length)return;
    const kind=kindSelect.value as 'topic'|'material'|'cloze';
    const parentId=folderSelect.value||null;
    const content=contentInput.value,answer=kind==='cloze'?answerInput.value:'',title=titleInput.value.trim();
    if(!title&&!content.trim()&&!answer.trim()){message(t('请先填写正文或标题。'));contentInput.focus();return;}
    busy=true;
    try{
      await enqueue(async()=>{
        await request('create',{parentId,kind,...(title?{title}:{}),content,answer});
        contentInput.value='';answerInput.value='';titleInput.value='';
        message(t('已添加，可继续添加下一张。'));
        contentInput.focus();
      });
    }finally{busy=false;}
  };
  form.onsubmit=event=>{event.preventDefault();void add();};
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();window.reading.closeCardWindow();return;}
    if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();void add();}
  });
  contentInput.focus();
}

void enqueue(async()=>{
  configuration=await request<Configuration>('configGet');applyConfiguration();
  await loadContextMenus().catch(()=>{});
  // 独立浏览窗口（?browser=1）与独立添加窗口（?add=1）只做最小初始化：
  // 不建目录树、不查牌组计数、不恢复上次打开的卡片——这两扇窗打开慢主要慢在这里。
  if(soloWindow){
    if(soloAdd)await mountAddCardWindow();
    else{
      document.body.classList.add('solo-browser');
      // browser.open() 内部会 enqueue，在 init 这个任务里不能 await（会自锁）；菜单与折叠状态只有主窗口需要
      void browser.open(soloBrowseStatus,soloBrowseCard);
    }
    performance.mark('reading-ready');
    return;
  }
  directoryCollapsed=!!await request('settingGet',{key:'directoryCollapsed'});applyDirectory();
  const [size,theme,width,dbLast,localLast]=await Promise.all([
    request<number>('settingGet',{key:'fontSize'}),request<string>('settingGet',{key:'theme'}),
    request<number>('settingGet',{key:'sidebarWidth'}),request<string>('settingGet',{key:'lastNode'}),
    window.reading.uiStateGet('lastNode').catch(()=>null),
  ]);
  // 优先用本机上次关闭时聚焦的卡片；没有本机记录时才回退到数据库里的旧值（升级迁移）。
  const last=typeof localLast==='string'&&localLast?localLast:dbLast;
  if(typeof last==='string'&&last)void window.reading.uiStateSet('lastNode',last).catch(()=>{});
  if(size){fontSize=Math.max(10,Math.min(48,size));document.documentElement.style.setProperty('--text-size',fontSize+'px');}
  if(theme)document.documentElement.dataset.theme=theme;
  if(width)document.documentElement.style.setProperty('--sidebar-width',width+'px');
  const savedTypes=await request('settingGet',{key:'directoryTypes'});directoryTypes=Array.isArray(savedTypes)?savedTypes.filter(type=>['topic','material','cloze'].includes(type)):[];
  applyDirectoryTypes();await tree.setTypes(directoryTypes);
  await refreshCounts();
  // 独立编辑窗口（?card=<id>）只打开这一张卡，隐藏目录树与功能栏。
  if(soloCard){
    document.body.classList.add('solo-card');
    if(await request('get',{id:soloCard}))await open(soloCard);
    else emptyWorkspace(t('这张卡片已被删除。'));
  }else if(last&&await request('get',{id:last}))await open(last);
  else{
    const roots=await request<{items:TreeNode[]}>('children',{});
    const first=roots.items[0];
    if(first){activeFolderId=first.id;await tree.reveal(first.id);emptyWorkspace(t('展开文件夹选择内容，或在文件夹内右键新建。'));}
    else emptyWorkspace(t('右键目录空白处新建文件夹。'));
  }
  performance.mark('reading-ready');
});
