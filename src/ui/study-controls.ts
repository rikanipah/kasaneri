import { t, getLocale } from '../core/i18n';
import type {StudySnapshot,TreeNode} from '../core/model';
import type {CommandId} from '../core/settings';
import {setIcon} from './icons';

const element=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;

export type StudyAnswer={rating?:1|2|3|4;action?:'read'|'later'|'soon'|'dismiss'};
type ShortcutTitle=(label:string,command:CommandId)=>string;

interface StudyControlsState {
  study:StudySnapshot|null;
  current:Pick<TreeNode,'id'|'kind'>|null;
  answerShown:boolean;
  busy:boolean;
  editing:boolean;
  canUndo:boolean;
  highlights:{extract:boolean;cloze:boolean};
}

interface StudyControlsActions {
  shortcutTitle:ShortcutTitle;
  ratingAvailable(rating:1|2|3|4):boolean;
  grade(answer:StudyAnswer):void;
  revealAnswer():void;
  returnToCard(id:string):void;
  refresh():void;
  enroll(id:string):void;
}

function intervalText(dueAt:number):string{
  const minutes=Math.max(1,Math.round((dueAt-Date.now())/60000));
  if(minutes<60)return t('{0} 分',minutes);
  if(minutes<1440)return t('{0} 小时',+(minutes/60).toFixed(1));
  return t('{0} 天',+(minutes/1440).toFixed(1));
}

export function renderStudyToggles(study:StudySnapshot|null,shortcutTitle:ShortcutTitle):void{
  for(const [id,mode,label,start,exit,graphic,command] of [
    ['toggle-review','cards',t('复习'),t('进入复习'),t('退出复习'),'play','toggleReview'],
    ['toggle-reading','reading',t('待办'),t('进入待办'),t('退出待办'),'book-open','toggleReading'],
  ] as const){
    const button=element(id),active=study?.mode===mode;
    const action=active?exit:start;
    const title=active&&study.folderId?action+' · '+study.folderTitle:label;
    button.setAttribute('aria-pressed',String(active));
    button.setAttribute('aria-label',action);
    button.title=shortcutTitle(title,command);
    button.classList.toggle('is-active',active);
    setIcon(button,active?'square':graphic);
  }
}

export function renderStudyCounts(study:StudySnapshot|null,answerShown:boolean):void{
  const host=element('study-counts');
  host.replaceChildren();
  host.removeAttribute('aria-label');
  if(!study||study.item?.kind==='fsrs'&&answerShown)return;
  const counts=study.counts;
  if(study.mode==='reading'){
    host.textContent=t('待处理 {0}',counts.readingDue);
    host.setAttribute('aria-label',t('全部文件夹待处理 {0}',counts.readingDue));
    return;
  }
  const scope=study.folderId?'「'+study.folderTitle+'」':t('全部牌组');
  host.setAttribute('aria-label',t('{0}新卡 {1}，学习中 {2}，到期复习 {3}',scope,counts.new,counts.learning,counts.review));
  for(const key of ['new','learning','review'] as const){
    if(key!=='new'){
      const plus=document.createElement('span');plus.textContent=' + ';plus.className='study-count-plus';host.append(plus);
    }
    const number=document.createElement('span');
    number.className='count-'+key;number.textContent=String(counts[key]);
    number.classList.toggle('is-current',study.item?.kind==='fsrs'&&study.item.state===key);
    host.append(number);
  }
}

export function renderStudyBar(state:StudyControlsState,actions:StudyControlsActions):void{
  const {study,current,answerShown,busy,editing,canUndo,highlights}=state;
  const item=study?.item;
  element('study-controls').hidden=!study&&!current;
  const filters=element('highlight-controls');
  filters.hidden=!current||current.kind==='cloze';
  for(const button of filters.querySelectorAll<HTMLButtonElement>('button')){
    const key=button.dataset.highlight as 'all'|'extract'|'cloze';
    button.setAttribute('aria-pressed',String(key==='all'?highlights.extract&&highlights.cloze:highlights[key]));
  }
  document.body.classList.toggle('study-cards-mode',study?.mode==='cards');
  const buttons=element('study-buttons');buttons.replaceChildren();
  element('study-more').hidden=!study;
  const priority=element<HTMLButtonElement>('study-priority');
  priority.hidden=item?.kind!=='reading';
  if(item?.kind==='reading')priority.textContent=t('优先级 {0}',item.priority);
  const edit=element<HTMLButtonElement>('study-edit');
  // 1.199：待办（材料）也显示左下角「编辑」，快捷键同样是 Alt+E。
  edit.hidden=!item||item.id!==current?.id;
  edit.textContent=item?.kind==='reading'?t('编辑'):(editing?t('完成编辑'):t('编辑'));edit.disabled=busy;
  const pause=document.getElementById('study-pause') as HTMLButtonElement|null;
  if(pause){pause.hidden=item?.kind!=='fsrs';pause.disabled=busy;}
  element<HTMLButtonElement>('study-undo').disabled=busy||!canUndo;
  renderStudyCounts(study,answerShown);
  if(!study)return;
  element('study-status-text').textContent=t('{0} · {1} · 本次已处理 {2}',study.folderTitle,t(item?(item.kind==='fsrs'?'检测卡':'材料'):'当前已完成'),study.completed);

  function addChoice(label:string,run:()=>void,style='',command?:CommandId,dueAt?:number):HTMLButtonElement{
    const choice=document.createElement('div');choice.className='study-choice';
    if(dueAt!==undefined){
      const interval=document.createElement('small');interval.className='study-interval';interval.textContent=intervalText(dueAt);choice.append(interval);
    }
    const button=document.createElement('button');button.className='study-action '+style;button.disabled=busy||editing;
    const text=document.createElement('span');text.textContent=label;button.append(text);
    if(command)button.title=actions.shortcutTitle(label,command);
    button.onclick=run;choice.append(button);buttons.append(choice);
    return button;
  }

  if(!item){
    const check=addChoice(t('检查到期卡片'),actions.refresh);
    if(study.nextDueAt&&study.nextDueAt>Date.now())check.title=t('下次到期：{0}',new Date(study.nextDueAt).toLocaleString(getLocale()));
    return;
  }
  if(item.id!==current?.id){addChoice(t('返回当前复习卡片'),()=>actions.returnToCard(item.id),'primary');return;}
  if(item.kind==='reading'){
    addChoice(t('读完'),()=>actions.grade({action:'read'}),'grade-good','readDone',item.pushPreview?.read);
    addChoice(t('稍后'),()=>actions.grade({action:'later'}),'','readLater',item.pushPreview?.later);
    addChoice(t('置于末尾'),()=>actions.grade({action:'soon'}),'','readSoon');
    addChoice(t('完成'),()=>actions.grade({action:'dismiss'}),'','readDismiss');
    if(item.isTest)addChoice(t('加入复习'),()=>actions.enroll(item.id),'','toggleReview');
    return;
  }
  if(!answerShown){addChoice(t('显示答案'),actions.revealAnswer,'primary','showAnswer');return;}
  for(const [rating,label,style,command] of [
    [1,t('重来'),'grade-again','again'],[2,t('困难'),'grade-hard','hard'],
    [3,t('良好'),'grade-good','good'],[4,t('简单'),'grade-easy','easy'],
  ] as const){
    if(!actions.ratingAvailable(rating))continue;
    const preview=item.preview.find(result=>result.rating===rating);
    addChoice(label,()=>actions.grade({rating}),style,command,preview?.dueAt);
  }
}
