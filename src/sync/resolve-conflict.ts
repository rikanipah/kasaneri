import { t } from '../core/i18n';
import type { Repository } from '../data/database';
import { applyLeechEffect,collectSyncOps,syncedReviewColumns, type SyncConflict, type SyncOp } from './engine';
import {parseSchedule,readSchedule,sameSchedule,selectStudyChange,studyChangePrefix} from './study-changes';
import type { SyncConflictChoice, SyncConflictResolution } from '../core/model';

export const conflictResolutionKey=(file:string)=>'syncResolution:'+file;
export const isConflictFile=(file:unknown):file is string=>
  typeof file==='string'&&/^[0-9TZ-]+_[a-f0-9]{20}\.json$/.test(file);
export interface SyncDecision {pair:[string,string];operationId:string;at:number;round?:number}
export const isStudyDecision=(item:SyncDecision)=>item.pair.some(id=>id.startsWith(studyChangePrefix));
const prefix='syncDecision:';
const pairOf=(left:string,right:string):[string,string]=>left<right?[left,right]:[right,left];
const decisionKey=(pair:[string,string])=>prefix+JSON.stringify(pair);
const roundOf=(decision:SyncDecision)=>decision.round??0;
const disputeKey=(pair:[string,string],selected:string,round:number)=>'syncDecisionDispute:'+JSON.stringify(round?[...pair,selected,round]:[...pair,selected]);
function activeDispute(repository:Repository,current:SyncDecision):{local:SyncDecision;incoming:SyncDecision}|null{
  const other=current.pair.find(id=>id!==current.operationId);
  return other?repository.getSetting(disputeKey(current.pair,other,roundOf(current))) as {local:SyncDecision;incoming:SyncDecision}|null:null;
}
export function syncDecisionFor(repository:Repository,conflict:SyncConflict):SyncConflictResolution|null{
  if(!conflict?.local?.id||!conflict?.incoming?.id)return null;
  const decision=repository.getSetting(decisionKey(pairOf(conflict.local.id,conflict.incoming.id))) as SyncDecision|null;
  if(!decision)return null;
  return {choice:decision.operationId===conflict.local.id?'local':'incoming',at:decision.at,operationId:decision.operationId};
}
export function collectSyncDecisions(repository:Repository):SyncDecision[]{
  return repository.query("SELECT value FROM settings WHERE key GLOB 'syncDecision:*' ORDER BY key").all()
    .map(row=>JSON.parse(String(row.value)));
}
export function syncDecisionDispute(repository:Repository,conflict:SyncConflict):{local:SyncDecision;incoming:SyncDecision}|null{
  if(!conflict?.local?.id||!conflict?.incoming?.id)return null;
  const pair=pairOf(conflict.local.id,conflict.incoming.id);
  const current=repository.getSetting(decisionKey(pair)) as SyncDecision|null;
  return current?activeDispute(repository,current):null;
}

function reviewSchedule(state:string){
  const parsed=JSON.parse(state);
  const due=Date.parse(parsed?.dueAt??parsed?.due);
  const stage=Number(parsed?.state);
  if(!Number.isFinite(due)||![0,1,2,3].includes(stage))throw Error(t('冲突中的复习排程不完整。'));
  return {state,due,stage};
}
function readingSchedule(state:unknown):number[]{
  const row=state as Record<string,unknown>|null;
  const values=['due_at','interval_ms','reps','last_read_at','enabled'].map(key=>row?.[key]);
  if(values.some(value=>typeof value!=='number'||!Number.isFinite(value)))
    throw Error(t('冲突中的阅读排程不完整。'));
  return values as number[];
}

function applySelection(repository:Repository,incoming:SyncOp,local:SyncOp,selected:SyncOp):void{
    const node=repository.getNode(incoming.nodeId);
    if(!node||node.kind==='folder')throw Error(t('卡片已删除。'));
    if(incoming.kind==='schedule'){selectStudyChange(repository,incoming,local,selected);return;}
    const choice=selected.id===local.id?'local':'incoming';
    if(incoming.kind==='fsrs'){
      const current=repository.query('SELECT state,due_at,stage FROM review_cards WHERE node_id=?').get(node.id);
      const onDevice=reviewSchedule(local.afterState);
      const fromPeer=reviewSchedule(incoming.afterState);
      const matches=(value:ReturnType<typeof reviewSchedule>)=>
        current?.state===value.state&&current.due_at===value.due&&current.stage===value.stage;
      if(node.kind!=='cloze'||(!matches(onDevice)&&!matches(fromPeer)))
        throw Error(t('卡片的复习排程已变化，旧冲突不能覆盖。'));
      const next=choice==='local'?onDevice:fromPeer;
      const currentOp=matches(onDevice)?local:incoming;
      if(currentOp.id!==selected.id)applyLeechEffect(repository,currentOp,'previous');
      const cols=syncedReviewColumns(repository,JSON.parse(next.state),selected.reviewedAt,next.due);
      repository.query('UPDATE review_cards SET state=?,due_at=?,stage=?,day_learning=?,learning_step=?,algorithm_version=COALESCE(?,algorithm_version),revision=revision+1,updated_at=? WHERE node_id=?')
        .run(next.state,next.due,cols.stage,cols.dayLearning,cols.learningStep,selected.algorithmVersion,Date.now(),node.id);
      applyLeechEffect(repository,selected);
    }else if(incoming.kind==='reading'){
      const current=repository.query('SELECT * FROM reading_state WHERE node_id=?').get(node.id);
      const review=repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(node.id);
      if(!current||(node.kind==='cloze'&&review?.enabled))throw Error(t('卡片的推送方式已改变。'));
      const onDevice=readingSchedule(JSON.parse(local.afterState));
      const fromPeer=readingSchedule(JSON.parse(incoming.afterState));
      const actual=readingSchedule(current);
      const matches=(value:number[])=>value.every((item,index)=>item===actual[index]);
      if(!matches(onDevice)&&!matches(fromPeer))throw Error(t('卡片的阅读排程已变化，旧冲突不能覆盖。'));
      const next=choice==='local'?onDevice:fromPeer;
      repository.query('UPDATE reading_state SET due_at=?,interval_ms=?,reps=?,last_read_at=?,enabled=?,revision=revision+1 WHERE node_id=?')
        .run(...next,node.id);
    }else throw Error(t('无法识别冲突类型。'));
}

export function applySyncDecisions(repository:Repository,values:unknown):{applied:number;errors:string[]}{
  if(!Array.isArray(values)||values.length>200)throw Error(t('同步选择批次无效。'));
  const errors:string[]=[];
  let applied=0;
  for(const value of values){
    try{
      if(!Array.isArray(value?.pair)||value.pair.length!==2||
        !value.pair.every((id:unknown)=>typeof id==='string'&&/^[\w:-]{8,80}$/.test(id))||
        value.pair[0]===value.pair[1]||!value.pair.includes(value.operationId)||
        !Number.isFinite(value.at)||value.at<=0||
        (value.round!==undefined&&(!Number.isSafeInteger(value.round)||value.round<0)))throw Error(t('同步选择格式无效。'));
      const pair=pairOf(value.pair[0],value.pair[1]),key=decisionKey(pair);
      const event:SyncDecision={pair,operationId:value.operationId,at:value.at,round:value.round??0};
      repository.transaction(()=>{
        const current=repository.getSetting(key) as SyncDecision|null;
        if(current){
          if(roundOf(current)>roundOf(event))return;
          if(roundOf(current)===roundOf(event)){
            if(current.operationId===event.operationId)return;
            const conflictKey=disputeKey(pair,event.operationId,roundOf(event));
            if(!repository.getSetting(conflictKey))repository.setSetting(conflictKey,{local:current,incoming:event});
            return;
          }
        }
        const logs=collectSyncOps(repository,pair);
        const selected=logs.find(op=>op.id===event.operationId);
        const other=logs.find(op=>op.id!==event.operationId);
        if(!selected||!other||selected.nodeId!==other.nodeId||selected.kind!==other.kind||selected.undoneAt||other.undoneAt)
          throw Error(t('双方原始操作尚未齐全，或其中一条已撤销。'));
        applySelection(repository,selected,other,selected);
        repository.setSetting(key,event);
        applied++;
      });
      const current=repository.getSetting(key) as SyncDecision|null;
      if(current&&roundOf(current)===roundOf(event)&&current.operationId!==event.operationId)
        errors.push(t('两端选择不同，已保留双方选择，请在冲突详情再次选择。'));
    }catch(error){errors.push(error instanceof Error?error.message:String(error));}
  }
  return {applied,errors:[...new Set(errors)]};
}

/**
 * 2026-11-21：排程冲突只有在「本机当前排程仍是双方之一」时才能应用。
 * 卡片在那之后又复习/改过（两边都已过期）时，记录永远不可能生效，属于陈旧记录：
 * 保留在列表里只会让人点了报错，应当在同步时归档到 conflicts/resolved/。
 */
export function isObsoleteConflict(repository:Repository,conflict:SyncConflict):boolean{
  const incoming=conflict?.incoming,local=conflict?.local;
  if(!incoming||!local||incoming.kind!==local.kind)return false;
  const nodeId=String(conflict.nodeId||'');
  if(!nodeId)return false;
  const at=Number(conflict.opAt||(conflict as unknown as {at?:number}).at||0);

  // ① 排程冲突：本机还停在某一侧就仍然可用，否则看卡片是否在冲突之后又更新过。
  if(incoming.kind==='schedule'){
    const current=readSchedule(repository,nodeId);
    if(!current)return false;
    let a,b;
    try{a=parseSchedule(local.afterState);b=parseSchedule(incoming.afterState);}catch{return false;}
    if(sameSchedule(current,a)||sameSchedule(current,b))return false;
    return latestCardActivity(repository,nodeId)>at;
  }

  // ② 评分冲突：只有本机当前状态正好是某一边时才能覆盖（和 applySelection 的判定一致）。
  if(incoming.kind==='fsrs'){
    const row=repository.query('SELECT state,due_at,stage FROM review_cards WHERE node_id=?').get(nodeId);
    if(!row)return false;
    const matches=(state:string)=>{
      try{const value=reviewSchedule(state);
        return row.state===value.state&&Number(row.due_at)===value.due&&Number(row.stage)===value.stage;
      }catch{return false;}
    };
    if(matches(local.afterState)||matches(incoming.afterState))return false;
    return latestCardActivity(repository,nodeId)>at;
  }

  // ③ 阅读冲突：同上，按 reading_state 的五个字段比对。
  if(incoming.kind==='reading'){
    const row=repository.query('SELECT due_at,interval_ms,reps,last_read_at,enabled FROM reading_state WHERE node_id=?').get(nodeId);
    if(!row)return false;
    const actual=readingSchedule(row);
    const matches=(state:string)=>{
      try{return readingSchedule(JSON.parse(state)).every((item,index)=>item===actual[index]);}catch{return false;}
    };
    if(matches(local.afterState)||matches(incoming.afterState))return false;
    return Number(row.last_read_at||0)>at;
  }

  return false;
}

/** 这张卡最近一次复习/阅读的时间；用来判断冲突记录是否已被后续操作覆盖。 */
function latestCardActivity(repository:Repository,nodeId:string):number{
  let review=0,reading=0;
  try{
    const row=repository.query('SELECT state FROM review_cards WHERE node_id=?').get(nodeId);
    const state=JSON.parse(String(row?.state||'{}'));
    review=state?.lastReviewAt?Date.parse(String(state.lastReviewAt)):0;
  }catch{review=0;}
  try{reading=Number(repository.query('SELECT last_read_at FROM reading_state WHERE node_id=?').get(nodeId)?.last_read_at||0);}catch{reading=0;}
  return Math.max(Number.isFinite(review)?review:0,reading);
}

export function resolveSyncConflict(repository:Repository,file:string,conflict:SyncConflict,choice:SyncConflictChoice):SyncConflictResolution{
  if(!isConflictFile(file)||!['local','incoming'].includes(choice))throw Error(t('冲突选择无效。'));
  const incoming=conflict?.incoming,local=conflict?.local;
  if(!incoming||!local||incoming.id===local.id||incoming.kind!==local.kind||
    incoming.nodeId!==conflict.nodeId||local.nodeId!==conflict.nodeId)
    throw Error(t('这份记录缺少双方原始操作，无法应用。'));
  return repository.transaction(()=>{
    const key=conflictResolutionKey(file);
    const previous=repository.getSetting(key) as SyncConflictResolution|null;
    const selected=choice==='local'?local:incoming;
    const pair=pairOf(local.id,incoming.id),sharedKey=decisionKey(pair);
    const shared=repository.getSetting(sharedKey) as SyncDecision|null;
    const reselect=shared&&activeDispute(repository,shared);
    if(shared&&!reselect){
      if(shared.operationId!==selected.id)throw Error(t('这份冲突已经选择过。'));
      return {choice,at:shared.at,operationId:shared.operationId};
    }
    if(!shared&&previous&&previous.operationId!==selected.id)throw Error(t('这份冲突已经选择过。'));
    const logs=collectSyncOps(repository,[incoming.id,local.id]);
    const isCurrent=(op:SyncOp)=>logs.some(row=>row.id===op.id&&row.kind===op.kind&&row.nodeId===op.nodeId&&
      row.afterState===op.afterState&&row.reviewedAt===op.reviewedAt&&!row.undoneAt);
    if(!isCurrent(incoming)||!isCurrent(local))throw Error(t('原始操作已改变或撤销，无法应用。'));
    if(!previous||reselect)applySelection(repository,incoming,local,selected);
    const result=!reselect&&previous?previous:{choice,at:Date.now(),operationId:selected.id};
    repository.setSetting(key,result);
    repository.setSetting(sharedKey,{pair,operationId:selected.id,at:result.at,round:shared?roundOf(shared)+1:0});
    return result;
  });
}
