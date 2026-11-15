import { t } from '../core/i18n';
import {createHash,randomUUID} from 'node:crypto';
import type {Repository} from '../data/database';
import type {SyncOp} from './engine';

export const studyChangeSession='sync-schedule-v1';
export const studyChangePrefix='schedule:';
type Reading={enabled:number;due_at:number;interval_ms:number;reps:number;last_read_at:number|null};
type Review={enabled:number;due_at:number;stage:number;state:string;algorithm_version:string};
// 1.194：hold（留存判定）和 buried（已搁置）也随排程一起同步；旧版对端/旧操作里没有这两项。
export type Schedule={reading:Reading;review:Review|null;leech:boolean;hold?:boolean;buried?:boolean};
type UndoTarget={id:string;kind:'fsrs'|'reading';at:number};
// 1.194：tags 只同步 hold/buried 标签，不碰排程本身（复习时清除 buried、取消留存判定等场景）。
type Change={action:'queue'|'undo'|'snapshot'|'tags';target?:UndoTarget};

export function readSchedule(db:Repository,id:string):Schedule|null{
  const reading=db.query(`SELECT enabled,due_at,interval_ms,reps,last_read_at FROM reading_state
    WHERE node_id=?`).get(id) as Reading|undefined;
  if(!reading)return null;
  const review=db.query('SELECT enabled,due_at,stage,state,algorithm_version FROM review_cards WHERE node_id=?').get(id) as Review|undefined;
  const tag=(name:string)=>!!db.query('SELECT 1 FROM node_tags WHERE node_id=? AND tag=?').get(id,name);
  return {reading,review:review??null,leech:tag('leech'),hold:tag('hold'),buried:tag('buried')};
}

function finite(value:unknown):value is number{return typeof value==='number'&&Number.isFinite(value);}
export function parseSchedule(text:string):Schedule{
  const value=JSON.parse(text) as Schedule;
  const reading=value?.reading,review=value?.review;
  if(!reading||![0,1].includes(reading.enabled)||![reading.due_at,reading.interval_ms,reading.reps].every(finite)||
    !(reading.last_read_at===null||finite(reading.last_read_at))||typeof value.leech!=='boolean'||
    (value.hold!==undefined&&typeof value.hold!=='boolean')||(value.buried!==undefined&&typeof value.buried!=='boolean')||
    (review!==null&&(!review||![0,1].includes(review.enabled)||![0,1,2,3].includes(review.stage)||!finite(review.due_at)||
      typeof review.state!=='string'||typeof review.algorithm_version!=='string'||!JSON.parse(review.state))))
    throw Error(t('同步中的排程状态无效。'));
  return value;
}

export function writeSchedule(db:Repository,id:string,value:Schedule):void{
  const r=value.reading;
  db.query('UPDATE reading_state SET enabled=?,due_at=?,interval_ms=?,reps=?,last_read_at=?,revision=revision+1 WHERE node_id=?')
    .run(r.enabled,r.due_at,r.interval_ms,r.reps,r.last_read_at,id);
  if(value.review){
    const c=value.review;
    db.query('UPDATE review_cards SET enabled=?,due_at=?,stage=?,state=?,algorithm_version=?,updated_at=?,revision=revision+1 WHERE node_id=?')
      .run(c.enabled,c.due_at,c.stage,c.state,c.algorithm_version,Date.now(),id);
  }
  if(value.leech)db.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'leech')").run(id);
  else db.query("DELETE FROM node_tags WHERE node_id=? AND tag='leech'").run(id);
  // 旧操作/旧对端没有 hold/buried 字段：保持本机标签不动，避免升级时把用户状态清掉。
  const tag=(name:string,on:boolean|undefined)=>{
    if(on===undefined)return;
    if(on)db.query('INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,?)').run(id,name);
    else db.query('DELETE FROM node_tags WHERE node_id=? AND tag=?').run(id,name);
  };
  tag('hold',value.hold);tag('buried',value.buried);
}

function sameReviewProgress(a:Review|null,b:Review|null):boolean{
  if(!a||!b)return a===b;
  return a.stage===b.stage&&(a.stage===0||
    (a.state===b.state&&a.due_at===b.due_at&&a.algorithm_version===b.algorithm_version));
}
function sameReadingProgress(a:Reading,b:Reading):boolean{
  return a.reps===b.reps&&a.interval_ms===b.interval_ms&&a.last_read_at===b.last_read_at&&
    (a.last_read_at===null||a.due_at===b.due_at);
}
function sameTag(a:boolean|undefined,b:boolean|undefined):boolean{
  return a===undefined||b===undefined||a===b;
}
export function sameSchedule(a:Schedule,b:Schedule):boolean{
  return a.leech===b.leech&&sameTag(a.hold,b.hold)&&sameTag(a.buried,b.buried)&&
    a.review?.enabled===b.review?.enabled&&a.reading.enabled===b.reading.enabled&&
    sameReviewProgress(a.review,b.review)&&sameReadingProgress(a.reading,b.reading);
}

/** 1.194：只同步标签变化（hold / buried），排程字段两边保持一致，所以不会跟评分/排程操作互相覆盖。 */
export function recordTagChange(db:Repository,id:string,at:number,before:Schedule,after:Schedule):void{
  if(sameTag(before.hold,after.hold)&&sameTag(before.buried,after.buried))return;
  store(db,makeChange(id,at,before,after,{action:'tags'}));
}

function store(db:Repository,op:SyncOp):boolean{
  return !!db.query(`INSERT OR IGNORE INTO study_operations
    (event_id,session_id,node_id,kind,reviewed_at,before_state,after_state) VALUES(?,?,?,?,?,?,?)`)
    .run(op.id,studyChangeSession,op.nodeId,'schedule',op.reviewedAt,op.beforeState,
      JSON.stringify({schedule:op.afterState,details:op.details})).changes;
}

function makeChange(nodeId:string,at:number,before:Schedule,after:Schedule,details:Change,id=studyChangePrefix+randomUUID()):SyncOp{
  return {id,kind:'schedule',nodeId,reviewedAt:at,beforeState:JSON.stringify(before),afterState:JSON.stringify(after),
    details:JSON.stringify(details),rating:null,action:details.action,algorithmVersion:null,undoneAt:null};
}

export function recordStudyChange(db:Repository,id:string,at:number,before:Schedule,after:Schedule,target?:UndoTarget):void{
  if(target||!sameSchedule(before,after))store(db,makeChange(id,at,before,after,target?{action:'undo',target}:{action:'queue'}));
}

export function studyChangeRows(db:Repository,ids:string[]){
  return db.query(`SELECT * FROM study_operations WHERE session_id=? AND event_id IN(SELECT value FROM json_each(?))`)
    .all(studyChangeSession,JSON.stringify(ids));
}

export function studyChangeFromRow(row:ReturnType<typeof studyChangeRows>[number]):SyncOp{
  const {schedule,details}=JSON.parse(String(row.after_state)) as {schedule:string;details:string};
  return {id:String(row.event_id),kind:'schedule',nodeId:String(row.node_id),reviewedAt:Number(row.reviewed_at),
    beforeState:String(row.before_state),afterState:schedule,details,
    rating:null,action:(JSON.parse(details) as Change).action,algorithmVersion:null,undoneAt:null};
}

function change(op:SyncOp):Change{
  const details=JSON.parse(op.details) as Change;
  if(!details||!['queue','undo','snapshot','tags'].includes(details.action))throw Error(t('同步排程操作无效。'));
  if(details.target){
    const target=details.target;
    if(!['fsrs','reading'].includes(target.kind)||typeof target.id!=='string'||!/^[\w:-]{8,80}$/.test(target.id)||
      !Number.isSafeInteger(target.at)||target.at<=0)throw Error(t('撤销引用无效。'));
  }
  if(details.action==='undo'&&!details.target)throw Error(t('撤销缺少原操作。'));
  return details;
}

function setUndo(db:Repository,op:SyncOp,target:UndoTarget,undone:boolean){
  const table=target.kind==='fsrs'?'review_log':'reading_log';
  const value=undone?target.at:null;
  db.query(`UPDATE ${table} SET undone_at=? WHERE event_id=? AND node_id=?`).run(value,target.id,op.nodeId);
  db.query('UPDATE study_operations SET undone_at=? WHERE event_id=? AND node_id=?').run(value,target.id,op.nodeId);
}

export function applyStudyChange(db:Repository,op:SyncOp,current:Schedule){
  const details=change(op),before=parseSchedule(op.beforeState),after=parseSchedule(op.afterState);
  if(details.action==='tags'){
    if(!store(db,op))return {status:'skipped' as const};
    const tag=(name:string,on:boolean|undefined)=>{
      if(on===undefined)return;
      if(on)db.query('INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,?)').run(op.nodeId,name);
      else db.query('DELETE FROM node_tags WHERE node_id=? AND tag=?').run(op.nodeId,name);
    };
    tag('hold',after.hold);tag('buried',after.buried);
    return {status:'applied' as const};
  }
  if(!!current.review!==!!after.review||!!before.review!==!!after.review)return {status:'skipped' as const};
  if(!store(db,op)||details.action==='snapshot')return {status:'skipped' as const};
  if(!sameSchedule(current,before)&&!sameSchedule(current,after)){
    // Freeze the local side so a choice can be synchronized using the existing decision protocol.
    let target:UndoTarget|undefined;
    if(details.target){
      const table=details.target.kind==='fsrs'?'review_log':'reading_log';
      if(db.query(`SELECT undone_at FROM ${table} WHERE event_id=? AND node_id=?`).get(details.target.id,op.nodeId)?.undone_at)
        target=details.target;
    }
    const id=studyChangePrefix+createHash('sha256').update(JSON.stringify([op.id,current,target])).digest('hex');
    const local=makeChange(op.nodeId,op.reviewedAt,current,current,{action:'snapshot',target},id);
    store(db,local);
    return {status:'conflict' as const,local};
  }
  if(!sameSchedule(current,after)||details.action==='undo')writeSchedule(db,op.nodeId,after);
  if(details.target)setUndo(db,op,details.target,true);
  return {status:'applied' as const};
}

export function selectStudyChange(db:Repository,left:SyncOp,right:SyncOp,selected:SyncOp):void{
  const current=readSchedule(db,selected.nodeId);
  const a=parseSchedule(left.afterState),b=parseSchedule(right.afterState);
  // Legacy score replay may have already merged one side's progress with the other side's queue.
  const known=current&&[a,b].some(value=>value.leech===current.leech)&&
    [a,b].some(value=>sameTag(value.hold,current.hold)&&sameTag(value.buried,current.buried))&&
    [a,b].some(value=>value.review?.enabled===current.review?.enabled&&value.reading.enabled===current.reading.enabled)&&
    [a,b].some(value=>sameReviewProgress(value.review,current.review))&&
    [a,b].some(value=>sameReadingProgress(value.reading,current.reading));
  if(!known)throw Error(t('卡片的排程已变化，旧冲突不能覆盖。'));
  const target=change(left).target??change(right).target;
  writeSchedule(db,selected.nodeId,selected.id===left.id?a:b);
  if(target)setUndo(db,selected,target,!!change(selected).target);
}
