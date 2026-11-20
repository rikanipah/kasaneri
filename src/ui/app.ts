import {arrangeContextMenu,loadContextMenus} from './context-menu-settings';
import {localizeMarkup} from './localize-markup';
import { t } from '../core/i18n';
import { ReadingEditor,type AttachmentTarget,type EditorMode } from './editor';
import { readLegacyDocument,type AttachmentDocument,type CardDocuments } from '../core/attachment-document';
import {editImageOcclusion} from './image-occlusion';
import {DirectoryTree} from './tree';
import {bindTreeFilters,bindTreeSearch,bindTreeSort,updateTreeFilters,updateTreeToggle,type TreeType} from './tree-controls';
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
import {isDirty,cardPresentation,type Draft} from './draft';
import {createNavigationHistory} from './navigation';
import {createUndoStack,type UndoEntry} from './undo-stack';
import type { StudyService } from '../study/study';
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
const trash=new TrashDialog(request,(id,parentId)=>void enqueue(async()=>{
  await refreshAnchors();
  await tree.refresh([null,parentId,id]);
  if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
  await refreshRelations();await refreshCounts();
  if(browser.visible)void browser.refresh();
}));
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
  // 2026-11-17：待办暂停/已搁置 不在右上角显示，改到「卡片标签」里看
  if(flags?.buried){badge.hidden=true;badge.textContent='';return;}
  if(!id){badge.hidden=true;badge.textContent='';return;}
  if(flags?.dismissed){badge.hidden=false;badge.textContent=t('已完成');badge.title=t('这张卡片已完成：保留内容，不再出现在待办队列');return;}
  if(isCard){
    if(flags?.reviewEnabled!==false){badge.hidden=true;badge.textContent='';return;}
    if(flags?.pushEnabled===false||flags?.reviewed){badge.hidden=true;badge.textContent='';return;}
    else{badge.textContent=t('待办中');badge.title=t('这张检测卡在待办队列里（复习尚未开启）');}
    badge.hidden=false;return;
  }
  if(flags?.pushEnabled===false){badge.hidden=true;badge.textContent='';return;}
  badge.hidden=true;badge.textContent='';
}
const cardFlags=new Map<string,{enabled?:boolean;reviewEnabled?:boolean;pushEnabled?:boolean;buried?:boolean;buriedReview?:boolean;buriedTodo?:boolean;hold?:boolean;reviewed?:boolean;dismissed?:boolean}>();
// 2026-11-19：锚点缓存——切卡时先用缓存把高亮画出来，新请求回来再覆盖，不必每次等 IPC。
const anchorCache=new Map<string,Anchor[]>();
// 内嵌终端（每卡片一个对话框，PTY 生命周期由对话框管理）。
const terminal=new TerminalDialog();
async function openCardInfo(id:string){try{await enqueue(save);await statistics.openCard(id);}catch(error){message((error as Error).message);}}
async function openStatistics(folderId?:string){try{await enqueue(save);await statistics.openOverview(folderId);}catch(error){message((error as Error).message);}}
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
let editorMode:EditorMode='live';
const editorModeButton=$<HTMLButtonElement>('editor-mode');
const editorModes={
  live:{label:'实时编辑',next:'source'},
  source:{label:'源码模式',next:'reading'},
  reading:{label:'浏览模式',next:'live'},
} as const;
function setEditorMode(mode:EditorMode){
  editorMode=mode;
  editorModeButton.textContent=t(editorModes[mode].label);
  editors?.question.setMode(mode);
  editors?.answer?.setMode(mode);
  const menuItem=document.getElementById('menu-editor-mode');
  if(menuItem)menuItem.textContent=t(editorModes[mode].label);
}
editorModeButton.onclick=()=>setEditorMode(editorModes[editorMode].next);

// 2026-11-19：窗口太窄时，右下角这一排按钮会挤成一团——把它们（卡片标签 / 实时编辑 / 优先级）
// 统一收进「更多」菜单，宽回来再放出去；图标与选项本身不变。
function applyCompactStudyTools(){
  const narrow=innerWidth<1200;
  document.body.classList.toggle('compact-study-tools',narrow);
  for(const id of ['menu-card-tags','menu-editor-mode','menu-priority'] as const){
    const item=document.getElementById(id) as HTMLButtonElement|null;
    if(item)item.hidden=!narrow;
  }
}
window.addEventListener('resize',applyCompactStudyTools);
applyCompactStudyTools();
// 这些菜单项只在窄窗口出现；老 index.html 里可能没有，取不到就直接跳过（不能因此让界面起不来）
$<HTMLButtonElement>('menu-card-tags')?.addEventListener('click',()=>{hideStudyMenu();$('card-tags').click();});
$<HTMLButtonElement>('menu-editor-mode')?.addEventListener('click',()=>{hideStudyMenu();setEditorMode(editorModes[editorMode].next);});
$<HTMLButtonElement>('menu-priority')?.addEventListener('click',()=>{hideStudyMenu();$('study-priority').click();});
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
let highlights={extract:true,cloze:true,topic:true};

// 2026-11-20：判定逻辑搬到 ui/draft.ts（纯函数），这里只负责喂当前状态
function presentationFor(draft:Draft){
  return cardPresentation(draft,{
    studyMode:study?study.mode:null,
    studyItemId:study?.item?.id??null,
    editing:studyEditing,
    answerShown,
    hasImageMask:hasImageMask(draft.content),
  });
}

for(const [id,name] of Object.entries({'toggle-directory':'panel-right-close','toggle-review':'play','toggle-reading':'book-open','open-browser':'panels-top-left','open-add-card':'square-plus','open-shortcuts':'keyboard','open-settings':'settings',minimize:'minus',maximize:'maximize-2',close:'x'}))setIcon($(id),name as IconName);

// 2026-11-17：所有功能键（button）都不接受焦点——Tab/Shift+Tab 不会停在按钮上，点击也不留焦点框
for(const button of document.querySelectorAll<HTMLElement>('button,summary'))button.tabIndex=-1;
document.addEventListener('focusin',event=>{
  const target=event.target as HTMLElement|null;
  if(target&&target.closest('button,summary'))target.blur();
});
document.addEventListener('mousedown',event=>{
  const target=event.target as HTMLElement|null;
  if(target&&target.closest('button,summary'))event.preventDefault();
},true);
new MutationObserver(records=>{
  for(const record of records)for(const node of record.addedNodes){
    if(!(node instanceof HTMLElement))continue;
    const buttons=node.matches('button,summary')?[node as HTMLElement]:[...node.querySelectorAll<HTMLElement>('button,summary')];
    for(const button of buttons)button.tabIndex=-1;
  }
}).observe(document.body,{childList:true,subtree:true});
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
  let saved=false;
  while(isDirty(draft)){
    const {content,answer,documents}=draft;
    const result=await request<{revision:number}>('save',{id:draft.note.id,revision:draft.note.revision,
      content:documents.content.text,answer:documents.answer.text,documents});
    draft.note.revision=result.revision;
    draft.note.content=content;draft.note.answer=answer;draft.note.documents=documents;
    draft.savedContent=content;draft.savedAnswer=answer;
    saved=true;
  }
  // 2026-11-19：正文改动后锚点区间已被搬移，重新取一次，别让编辑器还画着旧范围
  if(saved)void refreshAnchors();
}
const undoStack=createUndoStack();
const recordUndo=(entry:UndoEntry)=>undoStack.push(entry);
function undoLatest(){
  void enqueue(async()=>{
    const entry=undoStack.latest();
    if(!entry)return;
    const workspace=$('editor-stack');
    const focused=focusedEditor(),focusId=current?.note.id;
    const currentEditors=entry.text?.id===focusId?editors:null;
    if(currentEditors){
      currentEditors.question.setUndoPending(true);
      currentEditors.answer?.setUndoPending(true);
    }else workspace.inert=true;
    try{
      await entry.run(()=>undoStack.remove(entry));
    }finally{
      if(currentEditors){
        currentEditors.question.setUndoPending(false);
        currentEditors.answer?.setUndoPending(false);
      }else workspace.inert=false;
      if(focused&&focusId===current?.note.id&&currentEditors!==editors)editors?.[focused.section]?.view.focus();
      renderStudyControls();
    }
  });
}
function changed(draft:Draft,section:'question'|'answer',value:string,typing:boolean,document:AttachmentDocument):void{
  const previous=section==='answer'?draft.answer:draft.content;
  const now=Date.now();
  if(undoStack.coalesceText({id:draft.note.id,section,previous,value,now}))return;
  {
    const beforeDocument=section==='answer'?draft.documents.answer:draft.documents.content;
    const text={id:draft.note.id,section,before:previous,beforeDocument,after:value,typedAt:typing?now:0};
    recordUndo({text,run:async applied=>{
      await save();
      const note=await request<Material|null>('get',{id:text.id});
      const key=text.section==='answer'?'answer':'content';
      if(!note||note[key]!==text.after||browser.hasUnsavedEdit(note.id,note.content,note.answer))
        throw Error(t('正文已变化，无法撤销这次编辑。'));
      const documents={...(note.documents??{content:readLegacyDocument(note.content),answer:readLegacyDocument(note.answer)}),
        [key]:text.beforeDocument};
      const {revision}=await request<{revision:number}>('save',{id:note.id,revision:note.revision,
        content:documents.content.text,answer:documents.answer.text,documents});
      applied();
      const editor=editors?.[text.section];
      if(current?.note.id===note.id&&editor){
        const content=key==='content'?text.before:note.content,answer=key==='answer'?text.before:note.answer;
        current.note={...note,revision,content,answer,documents};
        current.content=current.savedContent=content;
        current.answer=current.savedAnswer=answer;
        current.documents=documents;
        editor.restoreDocument(text.beforeDocument);
        applyStudyPresentation();
      }else{
        drafts.delete(note.id);
        if(current?.note.id===note.id)await open(note.id,undefined,true,'preserve');
      }
      await browser.reloadEdit(note.id);
      if(browser.visible)void browser.refresh();
      await refreshCounts();
    }});
  }
  if(section==='answer'){draft.answer=value;draft.documents={...draft.documents,answer:document};}
  else{draft.content=value;draft.documents={...draft.documents,content:document};}
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
const navHistory=createNavigationHistory(200);
async function open(id:string,source?:Anchor,force=false,treeScroll:'center'|'preserve'|'selected'='center'):Promise<void>{
  await save();
  navHistory.record(id,current?.note.id);
  if(studyEditing&&study?.item?.id!==id)studyEditing=false;
  if(current?.note.id===id&&!force){
    if(treeScroll==='preserve')tree.selectNode(id);
    else if(treeScroll==='center'&&tree.selectedNode()?.id!==id)await tree.reveal(id);
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
  }catch(error){
    // 2026-11-20：挂载中途抛错时，把还没提交的覆盖层清掉，别让工作区留一片空白 + 一张半成品卡片。
    for(const child of [...workspace.children])if(child.classList.contains('workspace-stage')&&!child.classList.contains('is-committed'))child.remove();
    throw error;
  }finally{
    workspace.inert=wasInert;
    window.reading.setEditorCard('workspace',current?.note.id??null);
  }
}
async function mountEditor(note:Material,source:Anchor|undefined,treeScroll:'center'|'preserve'|'selected'):Promise<void>{
  const {id}=note;
  const stored=drafts.get(id);
  const draft:Draft=stored&&stored.note.revision===note.revision?stored:{
    note,content:note.content,answer:note.answer,savedContent:note.content,savedAnswer:note.answer,
    documents:note.documents??{content:readLegacyDocument(note.content),answer:readLegacyDocument(note.answer)},
  };
  draft.note=note;
  activeFolderId=note.folderId;
  // 记录这张卡的复习/待办开关状态，用于右上角小字
  void request<{enabled?:boolean;reviewEnabled?:boolean}|null>('nodeStudy',{id}).then(value=>{
    if(value)cardFlags.set(id,value);
    applyCardBadge();
  }).catch(()=>{});
  // 2026-11-19：锚点改成「不阻塞挂载」——先用缓存的锚点建编辑器，请求回来再补上（高亮/跳转会稍后出现）。
  const anchorsPromise=request<Array<{id:string;anchor:Anchor}>>('anchors',{id}).catch(()=>[] as Array<{id:string;anchor:Anchor}>);
  const cachedAnchors=anchorCache.get(id)??[];
  const [storedHighlights,storedSplit]=await Promise.all([
    request<{extract?:boolean;cloze?:boolean;topic?:boolean}|null>('settingGet',{key:'highlights:'+id}).catch(()=>null),
    note.kind==='cloze'?request<number|null>('settingGet',{key:'cardSplit:'+note.id}).catch(()=>null):Promise.resolve(null),
  ]);
  const anchors=cachedAnchors.length?cachedAnchors.map(anchor=>({id,anchor})):[];
  highlights={extract:storedHighlights?.extract??true,cloze:storedHighlights?.cloze??true,topic:storedHighlights?.topic??true};
  const splitValue=Number(storedSplit)||50;
  void anchorsPromise.then(list=>{
    anchorCache.set(id,list.map(entry=>entry.anchor));
    if(current?.note.id!==id)return;
    const values=list.map(entry=>entry.anchor);
    editors?.question.setAnchors(values);
    editors?.answer?.setAnchors(values);
  });
  disposeEditors();
  current=draft;
  drafts.delete(id);drafts.set(id,draft);pruneDrafts();
  const workspace=$('workspace');
  // 2026-11-19：先在一个覆盖层里把新编辑器建好，再一次性替换——否则切卡（读完/稍后/1-4 等）
  // 会先清空工作区再重绘，看起来就是闪一帧。
  const stage=document.createElement('div');
  stage.className='workspace-stage';
  workspace.append(stage);
  const commitStage=()=>{
    for(const child of [...workspace.children])if(child!==stage)child.remove();
    stage.classList.add('is-committed');
  };
  const presentation=presentationFor(draft);
  const make=(host:HTMLElement,section:'question'|'answer')=>new ReadingEditor(host,{
    value:section==='answer'?draft.answer:draft.content,
    document:section==='answer'?draft.documents.answer:draft.documents.content,
    label:note.kind==='cloze'?(section==='answer'?t('答案区'):t('编辑区')):t('笔记正文'),
    section,anchors:anchors.map(entry=>entry.anchor),highlights,textOnlyCursor:note.kind==='cloze',
    // 复习（cards）里检测卡默认只读，点「编辑」解锁；待办（reading）里默认可直接编辑，
    // 因为阅读材料时经常要顺手改字/补内容，不必先点编辑。
    readOnly:presentation.readOnly,mode:editorMode,
    audioAutoplay:!!configuration.settings.audioAutoplay,
    snapshot:section==='answer'?draft.answerState:draft.questionState,
    onChange:(value,typing,document)=>changed(draft,section,value,typing,document),
    onNavigate:target=>void enqueue(()=>open(target)),
    // 重复高亮——同一段文字有多张卡片时弹出选择框
    onNavigateChoice:(ids,at)=>void showLinkPicker(ids,at),
    onInsertMenu:showEditorInsertMenu,
    onImageContext:(event,image)=>showWorkspaceAttachmentMenu(draft,section,event,image),
    onAttachments:files=>window.reading.importFiles(files),
    onError:message,
  });
  if(note.kind==='cloze'){
    // 首帧隐藏——复习（检测卡）且答案未揭开时，创建 DOM 时就带上隐藏态，
    // 不再等 applyStudyPresentation() 事后补类（那样中间的 await 会让浏览器先画一帧答案，造成闪烁）。
    const previewHidden=presentation.hideAnswer;
    // 先把保存的比例读出来，再建 DOM——否则卡片先按 50/50 画一帧、再被改成保存值，会看到分隔条/文字跳一下
    const storedRatio=splitValue;
    const card=document.createElement('div');card.className='test-card';
    card.classList.toggle('answer-collapsed',previewHidden);
    card.classList.toggle('is-mask-covered',presentation.coverMask);stage.append(card);
    // 所有检测卡默认上下 5:5（以前是 65:35）；用户拖动过的卡仍按各自保存值
    let ratio=storedRatio;
    const applySplit=()=>{
      ratio=Math.max(15,Math.min(85,ratio));
      card.style.gridTemplateRows=`minmax(0,${ratio}fr) var(--split-size) minmax(0,${100-ratio}fr)`;
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
    const host=document.createElement('div');host.className='material-editor';stage.append(host);
    if(draft.answer.trim()){
      host.classList.add('has-extra-answer');const q=document.createElement('div'),a=document.createElement('div'),rule=document.createElement('hr');rule.className='material-extra-rule';a.className='material-extra-answer';host.append(q,rule,a);editors={question:make(q,'question'),answer:make(a,'answer')};
    }else editors={question:make(host,'question')};
  }
  // 新编辑器已经建好，这一下才替换旧内容（同一帧内完成，中间不会露出空白工作区）
  commitStage();
  await breadcrumbs(note);
  // 2026-11-19：关系面板不阻塞切卡（它只是右侧/记忆树的展示数据）
  void refreshRelations();
  if(treeScroll==='preserve')tree.selectNode(id);
  else if(treeScroll==='center')await tree.reveal(id);
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
// 卡片标签（标签）——底部状态栏右侧，可添加/移除，浏览卡片里能按属性检索
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
    // 2026-11-19：搁置按状态分叫法——记忆搁置 / 待办搁置 / 两者都有
    const flags=cardFlags.get(id);
    const buriedLabel=flags?.buriedReview&&flags?.buriedTodo?t('已搁置（记忆 / 待办）'):flags?.buriedReview?t('记忆搁置'):flags?.buriedTodo?t('待办搁置'):null;
    chip.textContent=tag==='leech'&&leechCount?tag+'('+leechCount+')':tag==='buried'&&buriedLabel?buriedLabel:tagLabel(tag);chip.title=tag;
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
  anchorCache.set(id,anchors);
  editors.question.setAnchors(anchors);
  editors.answer?.setAnchors(anchors);
}
// 2026-11-19：Alt+A / Alt+S 的落点与内容规则——
//   落点看「目录树聚焦项」，新卡是它的子级（聚焦检测卡就生成子检测卡）；没有聚焦就落默认文件夹；
//   有选区才带正文与回原文的锚点，没选区就生成空的提取 / 检测卡（未命名）。
async function createExcerpt(draft:Draft|null,section:'question'|'answer',kind:'extract'|'cloze',from:number,to:number):Promise<void>{
  const source=draft?(section==='answer'?draft.answer:draft.content):'';
  const selected=to>from?source.slice(from,to):'';
  const hasSelection=!!selected.trim();
  void enqueue(async()=>{
    if(draft&&current!==draft)return;
    if(draft)await save();
    if(draft&&(section==='answer'?draft.answer:draft.content)!==source)return;
    const focus=tree.selectedNode();
    // 2026-11-19：有选区时，选区所在的那张卡就是父级（即使目录树聚焦被点空白清掉）；
    // 没有选区才看聚焦项，聚焦也没有就落默认文件夹。
    const parentId=await safeParentId(focus?.id??(hasSelection&&draft?draft.note.id:null));
    const payload:any={parentId,kind:kind==='cloze'?'cloze':'material'};
    if(hasSelection){
      if(draft&&parentId===draft.note.id){
        // 常规：父级就是选区来源，带锚点，能跳回原文
        Object.assign(payload,{from,to,section,revision:draft.note.revision});
        if(kind==='cloze')Object.assign(payload,{content:source,answer:selected});
      }else{
        // 父级不是选区来源（或没有来源卡）：只带正文，不带锚点
        if(kind==='cloze')Object.assign(payload,{content:source.slice(0,from)+'[...]'+source.slice(to),answer:selected});
        else payload.content=selected;
      }
    }
    const result=await request<{node:Material;undoable:boolean}>('create',payload);
    recordCreation(result.node);
    await tree.refresh([parentId,focus?.parentId??null],parentId);
    await refreshRelations();
    await refreshCounts();
    // 建完不跳走，接着读手头这张；需要改新卡时在目录树里选中它。
    message(kind==='cloze'?t('已生成检测卡。'):t('已摘录为提取。'));
    if(draft)await refreshAnchors();
    // 新建的提取/检测卡不再立刻进入重命名——标题跟随工作区正文自动生成，需要改名时右键或选中后 F12
  });
}
/** 2026-11-19：目录树可能残留一个已被删除的选中项（行没了但选中还记着），
 *  这时退回默认文件夹，避免 create 直接报「父级已删除」。 */
async function safeParentId(id:string|null|undefined):Promise<string>{
  if(id){
    const node=await request<TreeNode|null>('get',{id});
    if(node)return id;
  }
  return 'folder:unfiled';
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
async function newNode(kind:'folder'|'topic'|'material'|'cloze',parentId:string|null,content?:string,
  anchor?:{from:number;to:number;section:'question'|'answer';revision:number},{jump}:{jump?:boolean}={}):Promise<void>{
  const title=kind==='folder'?await ask(t('新建文件夹'),''):untitledCard[kind];
  if(!title)return;
  if(kind!=='folder'&&browser.visible)await browser.close();
  await enqueue(async()=>{
    await save();
    // 2026-11-19：父级可能已被删掉（目录树残留选中），退回默认文件夹而不是报「父级已删除」
    const target=await safeParentId(parentId);
    // 父级被换成默认文件夹时锚点就不成立（来源不是默认文件夹），只保留正文
    const useAnchor=anchor&&target===parentId;
    const {node}=await request<{node:Material}>('create',{parentId:target,kind,title,content,...(useAnchor?anchor:{})});
    recordCreation(node);
    await tree.refresh([target],parentId&&parentId!=='folder:unfiled'?parentId:undefined);
    // 2026-11-20：新建主题不跳走（与 Alt+A/Alt+S 新建的提取/检测卡一致）——只有「没选区、也没聚焦项，
    // 于是落到默认文件夹」时才打开这张空主题，方便直接开始写。其余情况留在当前卡片继续读。
    const shouldJump=kind==='folder'?false:kind==='topic'?!!jump:true;
    if(kind==='folder'){activeFolderId=node.id;await tree.reveal(node.id);}
    else if(shouldJump)await open(node.id);
    else if(anchor)await refreshAnchors();
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
  // Give the dialog a stable focus target on return when no editor is active.
  if(!focusedEditor()){
    const destination=tree.host.getClientRects().length?tree.host:$('editor-stack');
    destination.focus({preventScroll:true});
  }
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
async function refreshMovedNode(id:string,previous:string|null,parentId:string|null,otherParents:Array<string|null>=[]){
  await tree.refresh([previous,parentId,...otherParents]);
  await tree.reveal(id);
  if(current){
    const live=await request<Material|null>('get',{id:current.note.id});
    if(live){current.note=live;activeFolderId=live.folderId;await breadcrumbs(live);}
  }
  await refreshRelations();
  await refreshCounts();
}

async function moveGroup(ids:string[],parentId:string|null,peerId?:string,includeFolders=false,allowCardParent=false):Promise<void>{
  await save();
  const previous=await request<Array<{id:string;parentId:string|null}>>('moveCards',{ids,parentId,peerId,includeFolders,allowCardParent});
  if(!previous.length)return;
  const [first,...others]=previous;
  const refresh=async()=>{
    await refreshMovedNode(first.id,first.parentId,parentId,others.map(item=>item.parentId));
    if(ids.length>1&&includeFolders)tree.selectMany(ids);
    if(browser.visible)void browser.refresh();
  };
  recordUndo({run:async applied=>{
    await save();
    await request('restoreMovedCards',{previous,expectedParentId:parentId});
    applied();
    await refresh();
  }});
  await refresh();
}

async function remove(node:TreeNode,mode:'single'|'branch'='branch'):Promise<void>{
  // 删文件夹＝文件夹和里面所有内容一起进垃圾桶，恢复时整棵子树一起回来。
  // 确认框可在「设置 → 删除」里关掉（默认关＝直接删，仍可用 Ctrl+Z 撤销或到垃圾桶恢复）
  if(configuration.settings.confirmDelete){
    const confirmed=await ask(node.kind==='folder'?t('删除文件夹'):t(mode==='single'?'仅删除此卡':'删除全部卡片'),'',
      t('删除「{0}」？{1}可撤销（Ctrl+Z）或到垃圾桶恢复。',node.title,node.hasChildren?(mode==='single'?t('子级卡片会保留并移到上一级。'):t('里面的内容会一起进垃圾桶，恢复时整棵子树一起回来。')):''));
    if(!confirmed)return;
  }
  await enqueue(async()=>{
    await save();
    const wasCurrent=current?.note.id===node.id;
    const result=await request<{destinationId:string|null}>('remove',{id:node.id,mode});drafts.delete(node.id);
    recordUndo({run:async applied=>{
      await save();
      const restored=await request<{parentId:string|null;title:string}>('trashRestore',{id:node.id});
      applied();
      await refreshAnchors();
      await tree.refresh([null,restored.parentId,result.destinationId,node.id]);
      await tree.reveal(node.id);
      // 2026-11-17：撤销删除后回到被删的那张卡，而不是队列里的下一张
      if(study){
        study=await request<StudySnapshot>('reviewFocus',{id:node.id}).catch(()=>null)??await request<StudySnapshot>('reviewRefresh');
        await presentStudy();
        // 会话没能切回这张卡（队列已空/会话已结束）时，至少把工作区打开到它
        if(study?.item?.id!==node.id)await open(node.id,undefined,true);
        // 画面切回被删的卡片后，目录树重新定位并选中它
        await tree.reveal(node.id);
      }
      else if(!current&&node.kind!=='folder')await open(node.id,undefined,false,'preserve');
      await refreshRelations();
      await refreshCounts();
      if(browser.visible)void browser.refresh();
      message(t('已撤销删除：「{0}」',restored.title));
    }});
    // 2026-11-17：复习/待办里删卡时不要先清空或重画工作区——那会闪一下（看着像跳到别的卡片），
    // 交给下面的 reviewRefresh + presentStudy 一次性换成下一张。
    if(!study&&wasCurrent){
      emptyWorkspace(t('从目录树中选择卡片。'));
    }
    await refreshAnchors();
    await tree.refresh([null,node.parentId,result.destinationId]);
    if(!study){
      if(current){
        const live=await request<Material|null>('get',{id:current.note.id});
        if(live){current.note=live;activeFolderId=live.folderId;await breadcrumbs(live);}
        else{activeFolderId=null;emptyWorkspace(t('从目录树中选择卡片。'));}
      }
      else if(activeFolderId===node.id)activeFolderId=null;
    }
    await refreshCounts();
    if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
    await refreshRelations();
    if(browser.visible)void browser.refresh();
  });
}
/** 仿 Obsidian「Move file」——屏幕中间弹出搜索框，输入过滤目录，回车移动。 */
async function showMovePicker(node:TreeNode):Promise<void>{
  const selected=tree.selectedForMove(node);
  return chooseMoveFolder(parentId=>selected.length>1?moveGroup(selected.map(item=>item.id),parentId,undefined,true):moveNode(node,parentId));
}
// 批量删除：多选后一次删掉，撤销时整批恢复
async function removeMany(nodes:TreeNode[]):Promise<void>{
  const targets=nodes.filter(node=>node.id);
  if(!targets.length)return;
  if(configuration.settings.confirmDelete){
    const confirmed=await ask(t('删除全部卡片'),'',t('删除选中的 {0} 项？可撤销（Ctrl+Z）或到垃圾桶恢复。',targets.length));
    if(!confirmed)return;
  }
  await enqueue(async()=>{
    await save();
    const ids=targets.map(node=>node.id);
    const parents=new Set<string|null>([null]);
    for(const node of targets)parents.add(node.parentId);
    for(const node of targets){
      const result=await request<{destinationId:string|null}>('remove',{id:node.id,mode:'branch'});
      parents.add(result.destinationId);
      drafts.delete(node.id);
    }
    recordUndo({run:async applied=>{
      await save();
      for(const id of ids)await request<{parentId:string|null;title:string} | null>('trashRestore',{id}).catch(()=>null);
      applied();
      await refreshAnchors();
      await tree.refresh([...parents]);
      await refreshRelations();
      await refreshCounts();
      if(browser.visible)void browser.refresh();
      message(t('已撤销删除：{0} 项',ids.length));
    }});
    const currentGone=!!current&&ids.includes(current.note.id);
    if(!study&&currentGone)emptyWorkspace(t('从目录树中选择卡片。'));
    await refreshAnchors();
    await tree.refresh([...parents]);
    await refreshCounts();
    await refreshRelations();
    if(browser.visible)void browser.refresh();
    message(t('已删除 {0} 项，可用 Ctrl+Z 撤销。',ids.length));
  });
}
/** 多选右键：只给批量操作 */
function showSelectionMenu(nodes:TreeNode[],event:MouseEvent):void{
  const menu=$('context-menu');menu.replaceChildren();
  const item=(label:string,run:()=>void,danger=false)=>{
    const button=document.createElement('button');button.type='button';button.dataset.action=label;
    button.setAttribute('role','menuitem');button.textContent=t(label);
    if(danger)button.className='danger';
    button.onclick=()=>{menu.hidden=true;run();};menu.append(button);return button;
  };
  const title=document.createElement('div');title.className='context-menu-title';
  title.textContent=t('已选 {0} 项',nodes.length);menu.append(title);
  item('移至…',()=>void showMovePicker(nodes[0]!));
  item('删除所有卡片',()=>void removeMany(nodes),true);
  if(arrangeContextMenu(menu,'selection'))positionContextMenu(menu,event);else menu.hidden=true;
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

/** §13.3：Alt+D（blank 分支）无聚焦无选区时的落点：在「文件管理」配置的默认文件夹里新建主题（无配置则落「默认」），并打开便于直接写。 */
async function createTopicInDefaultFolder(content?:string):Promise<void>{
  let parentId:string|null=null;
  try{const saved=await request<{folderId?:string}|null>('settingGet',{key:'defaultTopicFolder'});parentId=saved?.folderId||null;}catch{}
  if(parentId){
    const folder=await request<TreeNode|null>('get',{id:parentId});
    if(folder?.kind!=='folder')parentId=null;
  }
  await newNode('topic',parentId??'folder:unfiled',content,undefined,{jump:!content?.trim()});
}

function showEditorInsertMenu(event:MouseEvent,attachment:()=>void,fileLink:()=>void):void{
  const menu=$('context-menu');
  menu.replaceChildren();
  for(const [label,action] of [['插入附件…',attachment],['插入外部文件链接…',fileLink]] as const){
    const button=document.createElement('button');
    button.type='button';button.textContent=t(label);button.dataset.action=label;button.setAttribute('role','menuitem');
    button.onclick=()=>{menu.hidden=true;action();};
    menu.append(button);
  }
  if(arrangeContextMenu(menu,'editor'))positionContextMenu(menu,event);else menu.hidden=true;
}
function showAttachmentMenu(event:MouseEvent,attachment:AttachmentTarget,occlude?:()=>Promise<void>):void{
  const menu=$('context-menu');menu.replaceChildren();
  const add=(label:string,run:()=>void|Promise<void>,danger=false)=>{
    const button=document.createElement('button');button.type='button';button.dataset.action=label;
    button.textContent=t(label);button.setAttribute('role','menuitem');button.classList.toggle('danger',danger);
    button.onclick=()=>{menu.hidden=true;void Promise.resolve().then(run).catch(error=>message(String(error)));};
    menu.append(button);
  };
  const name=document.createElement('label');name.className='image-menu-name';
  const label=document.createElement('span');label.textContent=t('名字');
  const input=document.createElement('input');input.type='text';input.value=attachment.filename;input.spellcheck=false;
  name.append(label,input);menu.append(name);
  input.onchange=()=>attachment.rename(input.value);
  input.onkeydown=event=>{
    if(event.isComposing||event.key!=='Enter')return;
    event.preventDefault();
    attachment.rename(input.value);menu.hidden=true;
  };
  if(attachment.isImage){
    add('打开原图',async()=>{await request('openImageAsset',{id:attachment.assetId});});
    add('复制图片',async()=>{await request('copyImageAsset',{id:attachment.assetId});message(t('已复制'));});
    if(!attachment.masked&&occlude)add('图片遮挡…',occlude);
  }
  add('在系统文件管理器中打开',async()=>{await request('revealAttachment',{id:attachment.assetId});});
  add(attachment.isImage?'移除图片引用':'从正文移除附件',attachment.removeReference,true);
  if(arrangeContextMenu(menu,'image'))positionContextMenu(menu,event);else menu.hidden=true;
}
function showWorkspaceAttachmentMenu(draft:Draft,section:'question'|'answer',event:MouseEvent,image:AttachmentTarget):void{
  showAttachmentMenu(event,image,()=>enqueue(async()=>{
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
    }));
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
  const items:Array<readonly [string,()=>void]>=[
    ['关联检测子卡片',()=>relationsPanel.openPicker(id,'memory')],
    ['新建检测子卡片(空)',()=>void createMemoryChild(id,'cloze')],
    ['新建提取子卡片(空)',()=>void createMemoryChild(id,'material')],
    ['关联卡片…',()=>relationsPanel.openPicker(id)],
  ];
  if(kind==='topic')items.unshift(['新建主题子卡片',()=>void createMemoryChild(id,'topic')]);
  return items;
}
function relationContext(targetId:string,kind:TreeNode['kind'],relation:CardRelationKey|null,event:MouseEvent):void{
  const menu=$('context-menu');menu.replaceChildren();
  const items:Array<readonly [string,()=>void]>=[
    ['打开',()=>openMemoryCard(targetId)],
    ['在目录树中定位',()=>void enqueue(()=>tree.reveal(targetId))],
    ['卡片信息',()=>void openCardInfo(targetId)],
  ];
  if(kind!=='folder')items.push(...memoryActions(targetId,kind));
  if(relation)items.push(['移除关联',()=>void enqueue(async()=>{
    await request('removeCardRelation',{id:targetId,relation});
    await refreshAfterLink(relation.kind);
  })]);
  if(kind!=='folder')items.push(['移除所有关联',()=>void enqueue(async()=>{
    await request('removeAllCardRelations',{id:targetId});
    await refreshAfterLink('memory');
  })]);
  for(const [label,action] of items){
    const item=document.createElement('button');item.type='button';item.textContent=t(label);item.dataset.action=label;
    item.setAttribute('role','menuitem');
    item.onclick=()=>{menu.hidden=true;action();};
    menu.append(item);
  }
  if(arrangeContextMenu(menu,'relation'))positionContextMenu(menu, event);else menu.hidden=true;
}
function openMemoryCard(id:string){
  void enqueue(async()=>{await save();await request('cardWindow',{id});});
}
async function refreshAfterLink(kind:'memory'|'related'){
  if(kind==='memory'&&study){
    const before=study.item?.id;study=await request<StudySnapshot>('reviewRefresh');
    if(before!==study.item?.id)await presentStudy();else await refreshCounts();
  }
  await refreshRelations();
}
function linkCards(ids:string[],target:string,kind:'memory'|'related'){
  void enqueue(async()=>{
    try{
      for(const id of ids)if(id!==target)await request(kind==='memory'?'addMemoryChild':'addRelatedCard',{id:target,targetId:id});
    }finally{await refreshAfterLink(kind);}
  });
}
const relationsPanel=new CardRelationsPanel($('card-relations'),$('relation-picker'),{
  add:(id,targetId,kind)=>linkCards([targetId],id,kind),
  dragged:()=>tree.draggedCards().map(node=>node.id),
  link:linkCards,
  open:openMemoryCard,
  context:relationContext,
  error:message,
});
function refreshRelations():Promise<void>{
  return relationsPanel.show(!soloCard&&current!==null&&current.note.kind!=='folder'?current.note.id:null);
}
function context(node:TreeNode|null,event:MouseEvent,inBrowser=false,extra:Array<[string,()=>void]> = []):void{
  // 2026-11-19：目录树多选（Shift/Ctrl）时右键走批量菜单，不再是单卡菜单
  if(node&&!inBrowser){
    const selected=tree.selectedForMove(node);
    if(selected.length>1&&selected.some(item=>item.id===node.id)){showSelectionMenu(selected,event);return;}
  }
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
      // §13.4：右键新建主题要跳（快捷键 Alt+D 有聚焦时才不跳）
      item('新建主题',()=>void newNode('topic',node.id,undefined,undefined,{jump:true}));
      item('新建提取',()=>void newNode('material',node.id));
      item('新建检测卡',()=>void newNode('cloze',node.id));
      item('牌组统计',()=>void openStatistics(node.id));
      item('设置',()=>void openDeckSettings(node.id));
    }else{
      const createChild=(kind:'topic'|'material'|'cloze')=>inBrowser
        // §13.4：右键的同类新建主题同样要跳（浏览窗口里这条路也走 newNode）
        ? newNode(kind,node.id,undefined,undefined,kind==='topic'?{jump:true}:{})
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
    if(node.kind==='folder')item('删除文件夹',()=>void remove(node),true);
    else{
      item('仅删除此卡',()=>void remove(node,'single'),true);
      item('删除全部卡片',()=>void remove(node),true);
    }
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
    await refreshAnchors();
    await tree.refresh([null]);
    await refreshCounts();
    if(browser.visible)void browser.refresh();
    message(t('已从垃圾桶恢复这张卡片。'));
  }));
  if(arrangeContextMenu(menu,'browser'))positionContextMenu(menu,event);else menu.hidden=true;
}
const directoryPane=$<HTMLDetailsElement>('directory-tree-pane');
const directoryToggle=$<HTMLButtonElement>('directory-toggle-all');
const tree=new DirectoryTree($('tree'),{
  select:node=>void enqueue(async()=>{
    if(node.kind==='folder'){
      activeFolderId=node.id;
      if(browser.visible)browser.filterFolder(node.id);
    }else await open(node.id,undefined,false,'selected');
  }),
  context,rename:node=>void rename(node),
  move:(nodes,parentId,peerId,allowCardParent)=>void enqueue(()=>moveGroup(nodes.map(node=>node.id),parentId,peerId,true,allowCardParent)),
  canRelate:nodes=>!!current&&nodes.some(node=>node.id!==current?.note.id),
  relate:nodes=>{if(current)linkCards(nodes.map(node=>node.id),current.note.id,'related');},
  deselect:()=>{activeFolderId=null;},
},directoryToggle);
directoryToggle.onclick=event=>{
  event.preventDefault();
  const expand=!directoryPane.open||!tree.hasExpandedBranches();
  directoryToggle.disabled=true;
  void enqueue(async()=>{
    try{
      if(expand){directoryPane.open=true;await tree.expandAll();}
      else tree.collapseAll();
    }finally{directoryToggle.disabled=false;}
  });
};
directoryPane.addEventListener('toggle',()=>updateTreeToggle(directoryToggle,directoryPane.open&&tree.hasExpandedBranches()));
for(const button of document.querySelectorAll<HTMLElement>('.tree-sort-button'))setIcon(button,'list-ordered');
bindTreeSort($('directory-sort'),'ir.directoryTree.sort',sort=>tree.setSort(sort));
// 2026-11-17：两棵树表头的搜索。按标题检索卡片，选中后打开并定位到目录树。
for(const button of document.querySelectorAll<HTMLElement>('.tree-search-button'))setIcon(button,'search');
const searchTreeCards=(query:string)=>request<TreeNode[]>('search',{query});
const openTreeSearchResult=(id:string)=>void enqueue(()=>open(id));
bindTreeSearch($('directory-search'),searchTreeCards,openTreeSearchResult);
bindTreeSearch($('memory-search'),searchTreeCards,openTreeSearchResult);

const treeDivider=$('tree-divider'),directoryPanel=$('directory-pane');
let treeSplit=62;
function resizeTrees(value:number){
  treeSplit=Math.round(Math.max(15,Math.min(85,value)));
  directoryPanel.style.setProperty('--directory-ratio',String(treeSplit/100));
  treeDivider.setAttribute('aria-valuenow',String(treeSplit));
}
try{
  const saved=localStorage.getItem('ir.treeSplit');
  if(saved!==null&&Number.isFinite(Number(saved)))treeSplit=Number(saved);
}catch{}
resizeTrees(treeSplit);
function saveTreeSplit(){try{localStorage.setItem('ir.treeSplit',String(treeSplit));}catch{}}
treeDivider.onpointerdown=event=>{
  if(event.button!==0)return;
  treeDivider.setPointerCapture(event.pointerId);
};
treeDivider.onpointermove=event=>{
  if(!treeDivider.hasPointerCapture(event.pointerId))return;
  const bounds=directoryPanel.getBoundingClientRect();
  const available=bounds.height-treeDivider.offsetHeight;
  if(available>0)resizeTrees((event.clientY-bounds.top-treeDivider.offsetHeight/2)/available*100);
};
treeDivider.onlostpointercapture=saveTreeSplit;
treeDivider.onkeydown=event=>{
  if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
  event.preventDefault();
  resizeTrees(treeSplit+(event.key==='ArrowUp'?-3:3));
  saveTreeSplit();
};
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
  const editor=editors?.question;if(!editor)return 0;
  const view=editor.view;
  if(view.hasFocus)return editor.sourcePosition(view.state.selection.main.head);
  try{const block=view.lineBlockAtHeight(0);if(block.from>0)return editor.sourcePosition(block.from);}catch{}
  return 0;
}
// 滚动到指定字符偏移（不移动光标与选区，避免打断阅读状态）。
function scrollEditorTo(position:number){
  const editor=editors?.question;if(!editor)return;
  const view=editor.view;
  try{
    const target=Math.max(0,Math.min(editor.editorPosition(position),view.state.doc.length));
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
  if(event.target===editorModeButton&&(event.key==='Enter'||event.code==='Space'))return;
  const key=shortcutFromEvent(event),matching=COMMANDS.filter(command=>configuration.shortcuts[command.id]===key&&key);
  const isActual=study?.item?.id===current?.note.id;
  const editable=(event.target as Element)?.closest('input,textarea,[contenteditable="true"]');
  const command=matching.find(candidate=>{
    // 2026-11-19：待办里要先 Alt+E 进入编辑，摘录/检测卡/新建主题才生效；其余情况照旧
    if(candidate.id==='extract'||candidate.id==='cloze'||candidate.id==='blank'){
      if(study?.mode==='reading'&&study.item&&study.item.id===current?.note.id&&!studyEditing)return false;
      return true;
    }
    if(candidate.scope==='editor')return !!focusedEditor();
    // 编辑键（默认 E）在编辑态也要可用，否则按进去就出不来了；其余 card 快捷键仍禁止
    if(candidate.scope==='card'){
      if(candidate.id==='editCard')return !!study&&isActual&&(study.item?.kind==='fsrs'||study.item?.kind==='reading');
      return !!study&&isActual&&study.item?.kind==='fsrs'&&!studyEditing;
    }
    if(candidate.scope==='reading')return !!study&&isActual&&study.item?.kind==='reading'&&((( !editable&&!studyEditing))||key.includes('+'));
    // 搁置只在复习/待办中（非编辑态）触发
    if(candidate.id==='buryCard')return !!study&&isActual&&!studyEditing&&!editable&&!event.repeat;
    if(candidate.id==='deleteCurrentCard')return !!current&&!soloWindow&&!browser.visible
      &&!(event.target as Element)?.closest('input,textarea,select');
    if(candidate.id==='undoReview')return false;
    return true;
  });
  if(!command)return;
  event.preventDefault();event.stopImmediatePropagation();
  const action=command.id;
  if(action==='extract'||action==='cloze'){
    const focused=focusedEditor();
    // 2026-11-19：没有打开的卡片时也允许生成空卡（落点看聚焦项 / 默认文件夹）。
    if(!current){void createExcerpt(null,'question',action,0,0);return;}
    const from=focused?focused.editor.sourcePosition(focused.editor.view.state.selection.main.from):0;
    const to=focused?focused.editor.sourcePosition(focused.editor.view.state.selection.main.to):0;
    void createExcerpt(current,focused?focused.section:'question',action,from,to);
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
  else if(action==='enrollCard'&&study?.item)enrollCard(study.item.id);
  else if(action==='blank'&&!event.repeat){
    const parent=tree.selectedNode();
    const focused=focusedEditor();
    const content=focused?.editor.selectedText();
    // 2026-11-19：新建主题也带锚点（黄色高亮）——前提是焦点就在这张卡上、选区非空
    const selection=focused?.editor.view.state.selection.main;
    const anchored=!!focused&&!!parent&&!!current&&parent.id===current.note.id&&!!selection&&selection.from!==selection.to;
    if(anchored){
      void newNode('topic',parent!.id,content,{
        from:focused!.editor.sourcePosition(selection!.from),
        to:focused!.editor.sourcePosition(selection!.to),
        section:focused!.section,revision:current!.note.revision,
      });
    }else if(parent)void newNode('topic',parent.id,content);
    else void createTopicInDefaultFolder(content);
  }
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
  else if(action==='collapseAll')void enqueue(async()=>tree.collapseAll());
  else if(action==='deleteCurrentCard'&&!event.repeat&&current)void remove(current.note);
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
async function navigateBack():Promise<void>{await navHistory.back(id=>open(id));}
/** 前进到下一个界面；没有"刚返回过"的历史就不做任何事（不是猜下一张）。 */
async function navigateForward():Promise<void>{await navHistory.forward(id=>open(id));}
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
    const {hideAnswer:hidden,coverMask}=presentationFor(current);
    answer.classList.toggle('is-answer-hidden',hidden);const host=answer.querySelector<HTMLElement>('.card-editor');if(host){host.inert=hidden;host.setAttribute('aria-hidden',String(hidden));}
    // 答案未揭开时，**整个下半区（含分隔条与提示文字）都不显示**，题目占满全高；
    // 点「显示答案」后才恢复上下分区。此前只是隐藏编辑器、留着空面板和提示，用户觉得不该出现。
    const card=answer.closest<HTMLElement>('.test-card');
    card?.classList.toggle('answer-collapsed',hidden);
    card?.classList.toggle('is-mask-covered',coverMask);
    editors?.answer?.setMediaVisible(!hidden);
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
    study,current:current?.note??null,answerShown,busy:studyBusy,editing:studyEditing,canUndo:undoStack.size()>0,highlights,
  },{
    shortcutTitle,ratingAvailable,grade:gradeStudy,revealAnswer,
    returnToCard:id=>void enqueue(()=>open(id,undefined,true)),
    refresh:()=>void enqueue(async()=>{study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}),
    enroll:id=>void enrollCard(id),
  });
}
/** 2026-11-19：待办里把检测卡「加入复习」——按钮与快捷键 5 共用同一条路径。 */
function enrollCard(id:string){
  void enqueue(async()=>{
    await save();
    await request('setStudyEnabled',{id,enabled:true});
    study=await request<StudySnapshot>('reviewRefresh');
    // 2026-11-19：「加入复习」也是待办的评价，撤销要能把卡片退回待办暂停
    recordUndo({run:async applied=>{
      await save();
      await request('setStudyEnabled',{id,enabled:false});
      study=await request<StudySnapshot>('reviewRefresh');
      applied();
      if(study)await presentStudy();else await refreshCounts();
    }});
    await presentStudy();
  });
}
function revealAnswer(){if(!study?.item||study.item.kind!=='fsrs'||study.item.id!==current?.note.id)return;answerShown=true;applyStudyPresentation();}
async function presentStudy(){
  if(!study)return;answerShown=false;studyEditing=false;hideStudyMenu();
  if(study.item)await open(study.item.id,undefined,true);
  else if(study.mode==='reading')emptyWorkspace(t('当前没有可处理的待办卡片。'));
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
  else emptyWorkspace(t('从目录树中选择卡片。'));
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
      // 阅读点随评价请求一起提交（不能单独发 setReadingPosition——它会让
      // reading_state.revision+1，随后评价校验判定"复习状态已改变，请刷新"）。
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
      }else{
        // 2026-11-19：「置于末尾」也能撤销——把它从队尾拿回来，重新作为当前卡片
        recordUndo({run:async applied=>{
          await save();
          study=await request<StudySnapshot|null>('readingUnqueue',{id:item.id});
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
async function setItemPriority(node:TreeNode,priority:number|null):Promise<boolean>{
  if(node.priority===priority)return false;
  const active=study,item=active?.item;
  const reading=active&&item?.kind==='reading'&&item.id===node.id&&current?.note.id===node.id
    ?{sessionId:active.sessionId,token:item.token,revision:item.revision,position:currentReadingPosition()}:undefined;
  if(reading)await save();
  const reordered=await request<StudySnapshot|undefined>('setPriority',{id:node.id,priority,reading});
  node.priority=priority;tree.update(node);
  if(current?.note.id===node.id)current.note.priority=priority;
  if(!reordered)return false;
  study=reordered;
  await presentStudy();
  return true;
}
async function refreshStudyAfterSettings(){
  if(!study)return;
  const previous=study.item?.id;
  study=await request<StudySnapshot>('reviewRefresh');
  if(study.item?.id!==previous)await presentStudy();
  else applyStudyPresentation();
}
const preferences=new PreferencesDialog(async(draft,node,priority)=>{
  const result=await request<Configuration>('configSave',{settings:draft.settings,shortcuts:draft.shortcuts});
  const reordered=node&&await setItemPriority(node,priority);
  configuration=result;applyConfiguration();
  if(!reordered){
    await refreshCounts();
    await refreshStudyAfterSettings();
  }
  return result;
},async(folderId,overrides)=>{
  await save();const result=await request<DeckConfiguration>('deckConfigSave',{folderId,overrides});
  await refreshStudyAfterSettings();return result;
},()=>void window.reading.openBrowserWindow('conflict').catch(()=>{}),async(node,priority)=>{
  const reordered=await setItemPriority(node,priority);
  if(study&&!reordered){study=await request<StudySnapshot>('reviewRefresh');applyStudyPresentation();}
});
const browser=new CardBrowser($('card-browser'),$('browser-rule'),$('browser-filters'),{
  onInsertMenu:showEditorInsertMenu,onImageContext:showAttachmentMenu,
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
  move:ids=>chooseMoveFolder(parentId=>moveGroup(ids,parentId)),
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
      await refreshAnchors();
      await tree.refresh([null]);
      await refreshCounts();
      if(study){study=await request<StudySnapshot>('reviewRefresh');await presentStudy();}
      if(browser.visible)void browser.refresh();
    }});
    if(current&&removed.some(item=>item.id===current?.note.id))emptyWorkspace(t('从目录树中选择卡片。'));
    await refreshAnchors();
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
  else{
    configuration=await request<Configuration>('configGet');
    applyConfiguration();
    await refreshCounts();
  }
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
  // 2026-11-19：复习与待办走同一条路径——平时只读，按「编辑」/Alt+E 才进入编辑，再按一次退出。
  studyEditing=!studyEditing;
  if(studyEditing){
    if(editorMode==='reading')setEditorMode('live');
    if(study.item.kind==='fsrs')answerShown=true;
    await open(study.item.id,undefined,true);
  }
  else{
    const previous=study.item.id;study=await request<StudySnapshot>('reviewRefresh');
    if(study.item?.id===previous)await open(previous,undefined,true);else await presentStudy();
  }
}
function applyConfiguration(){fontSize=configuration.settings.fontSize;document.documentElement.style.setProperty('--text-size',fontSize+'px');document.documentElement.dataset.theme='dark';applyCustomCss(configuration.settings.customCss);}
/** 外观自定义 CSS——写进一个 <style>，留空则移除。 */
function applyCustomCss(css:string|undefined){
  const text=(css||'').trim();
  let style=document.getElementById('custom-css') as HTMLStyleElement|null;
  if(!text){style?.remove();return;}
  if(!style){style=document.createElement('style');style.id='custom-css';document.head.append(style);}
  style.textContent=text;
}
async function openPreferences(tab:PreferenceTab|'settings'){await enqueue(save);preferences.open(tab==='settings'?'general':tab,configuration,tree.selectedNode()||current?.note||null);}
async function openDeckSettings(folderId:string){
  await enqueue(save);
  const [deck,node]=await Promise.all([request<DeckConfiguration>('deckConfig',{folderId}),request<TreeNode|null>('get',{id:folderId})]);
  if(node)preferences.openDeck(deck,configuration,node);
}
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
  if(studyBusy||studyEditing||!study?.item||study.item.id!==current?.note.id)return;
  const {sessionId,item}=study;
  studyBusy=true;renderStudyControls();
  void enqueue(async()=>{
    try{
      await save();
      const {change,study:next}=await request<ReturnType<StudyService['buryActive']>>('buryCard',{sessionId,token:item.token,revision:item.revision});
      study=next;
      recordUndo({run:async applied=>{
        await save();
        study=await request<StudySnapshot|null>('undoBuryCard',{change,sessionId});
        applied();cardFlags.delete(item.id);
        if(study)await presentStudy();else{await open(item.id,undefined,true);await refreshCounts();}
      }});
      cardFlags.set(item.id,{...(cardFlags.get(item.id)||{}),buried:true});
      await presentStudy();
      flashCardNotice(t('已搁置到下一个日切点'));
    }finally{studyBusy=false;renderStudyControls();}
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
  const {sessionId,item}=study;
  // 2026-11-17：暂停时把排程快照一起带回来，撤销时原样写回（不再走「取消暂停＝当新卡」那条路）
  const {change,study:next}=await request<{change:{id:string;before:unknown;after:unknown}|null;study:StudySnapshot}>('pauseCard',{sessionId,token:item.token,revision:item.revision});
  study=next;
  recordUndo({run:async applied=>{
    const restored=await request<StudySnapshot|null>('undoPauseCard',{change,sessionId});
    applied();
    study=restored;
    cardFlags.set(item.id,{...(cardFlags.get(item.id)||{}),reviewEnabled:true,pushEnabled:true});
    if(study){
      await presentStudy();
      await tree.reveal(item.id);
    }else{
      await open(item.id,undefined,true);
    }
    applyCardBadge();
    message(study?.pauseUndoStale
      ? t('卡片期间已有新的排程变化，未覆盖新状态；已按当前状态保持待办暂停。')
      : t('已撤销：卡片恢复暂停前的排程。'));
  }});
  cardFlags.set(item.id,{...(cardFlags.get(item.id)||{}),reviewEnabled:false,pushEnabled:true});
  // 2026-11-17：待办暂停后直接呈现队列里的下一张，不再把已暂停的卡片重新打开。
  await presentStudy();
  applyCardBadge();
  // 2026-11-17：只保留工作区左下角那条短提示，右上角黄色横幅不再弹（和左下角重复）
  flashCardNotice(t('上张卡片已进入待办暂停'));
});}$('study-pause-review').onclick=pauseReview;
$('study-bury').onclick=buryCurrent;
$('study-undo').onclick=undoLatest;
// 优先级弹窗——显示当前值，输入 0–9 后回车保存（ask 的输入框在表单里，回车即提交）。
$('study-priority').onclick=()=>void enqueue(async()=>{
  const item=study?.item,node=current?.note;
  if(item?.kind!=='reading'||node?.id!==item.id)return;
  const text=await ask(t('设置优先级（0–9，0 绝对优先、1 最高、9 最低）'),String(item.priority));
  if(text===null)return;
  const parsed=Number(text);
  if(!text.trim()||!Number.isInteger(parsed)||parsed<0||parsed>9){message(t('优先级需为 0–9 的整数。'));return;}
  if(parsed!==item.priority)await setItemPriority(node,parsed);
});
$('study-edit').onclick=()=>void enqueue(toggleStudyEditing);
$('study-more').onclick=()=>{const menu=$('study-more-menu');menu.hidden=!menu.hidden;$('study-more').setAttribute('aria-expanded',String(!menu.hidden));};
$('study-browse').onclick=()=>{hideStudyMenu();void window.reading.openBrowserWindow(undefined,current?.note.id||null).catch(()=>{});};
// 更多里的「退出复习」已移除（用 Alt+R 或侧栏按钮退出）
for(const button of $('highlight-controls').querySelectorAll<HTMLButtonElement>('button'))button.onclick=()=>{
  if(!current)return;const key=button.dataset.highlight;
  if(key==='all'){const value=!(highlights.extract&&highlights.cloze&&highlights.topic);highlights={extract:value,cloze:value,topic:value};}
  else highlights={...highlights,[key!]:!highlights[key as 'extract'|'cloze'|'topic']};
  editors?.question.setHighlights(highlights);editors?.answer?.setHighlights(highlights);renderStudyControls();void request('settingSet',{key:'highlights:'+current.note.id,value:highlights});
};
function applyDirectoryTypes(){updateTreeFilters($('directory-filters'),directoryTypes);}
bindTreeFilters($('directory-filters'),type=>void enqueue(async()=>{
  directoryTypes=directoryTypes.includes(type)?directoryTypes.filter(value=>value!==type):[...directoryTypes,type];
  applyDirectoryTypes();await tree.setTypes(directoryTypes);await request('settingSet',{key:'directoryTypes',value:directoryTypes});
}));
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
  // 2026-11-19：正文/答案支持 Ctrl+B / Ctrl+I（和主编辑区一致）
  for(const area of [contentInput,answerInput]){
    area.addEventListener('keydown',event=>{
      if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
      const key=event.key.toLowerCase();
      if(key!=='b'&&key!=='i')return;
      event.preventDefault();
      const wrap=key==='b'?'**':'*';
      const start=area.selectionStart,end=area.selectionEnd;
      const selected=area.value.slice(start,end)||t('文字');
      area.setRangeText(wrap+selected+wrap,start,end,'select');
      area.dispatchEvent(new Event('input',{bubbles:true}));
    });
  }
  // 2026-11-19：类型下拉支持输入「/」展开搜索，输入文字过滤，回车锁定
  const kindSearch=document.createElement('input');kindSearch.type='text';
  kindSearch.placeholder=t('输入 / 搜索类型');kindSearch.hidden=true;
  const allKinds=[...kindSelect.options].map(option=>({value:option.value,label:option.textContent||''}));
  const applyKindFilter=(query:string)=>{
    const text=query.trim().toLowerCase();
    for(const option of [...kindSelect.options]){
      const match=allKinds.find(item=>item.value===option.value);
      option.hidden=!!text&&!!match&&!match.label.toLowerCase().includes(text);
    }
    const first=[...kindSelect.options].find(option=>!option.hidden);
    if(first)kindSelect.value=first.value;
  };
  kindSearch.addEventListener('input',()=>{applyKindFilter(kindSearch.value);syncKind();});
  kindSearch.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();kindSearch.hidden=true;kindSearch.value='';applyKindFilter('');kindSelect.focus();}
    if(event.key==='Escape'){event.preventDefault();kindSearch.hidden=true;kindSearch.value='';applyKindFilter('');}
  });
  kindSelect.addEventListener('keydown',event=>{
    if(event.key==='/'){event.preventDefault();kindSearch.hidden=false;kindSearch.focus();}
  });
  const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent=t('添加');
  const hint=document.createElement('p');hint.className='add-hint';
  hint.textContent=t('Ctrl+Enter 添加 · Esc 关闭窗口。添加后会清空正文，方便连续添加。');
  const footer=document.createElement('div');footer.className='add-actions';footer.append(submit);
  // 「类型」这一栏同时放下拉和它的搜索框（搜索框平时隐藏，选中下拉后按 / 才出现）
  const kindField=document.createElement('div');kindField.className='add-kind';
  kindField.append(kindSelect,kindSearch);
  form.append(heading,field(t('类型'),kindField),field(t('位置'),folderSelect),field(t('标题'),titleInput),field(t('正文'),contentInput),answerField,footer,hint);
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
  // 2026-11-20：浅色主题已归档到 archive/theme-light/，界面固定深色（忽略数据库里残留的 theme）
  document.documentElement.dataset.theme='dark';
  void theme;
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
