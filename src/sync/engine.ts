import { t } from '../core/i18n';
// 评分与阅读沿用原日志格式。新版对端另交换队列状态和撤销操作。
// 重放按事件编号去重，缺卡时先暂存，有分歧时保留双方排程供选择。
import type {Repository} from '../data/database';
import {applyStudyChange,readSchedule,studyChangeFromRow,studyChangePrefix,studyChangeRows,studyChangeSession} from './study-changes';

export interface SyncOp {
  id:string;kind:'fsrs'|'reading'|'schedule';nodeId:string;reviewedAt:number;
  rating:number|null;action:string|null;algorithmVersion:string|null;
  beforeState:string;afterState:string;details:string;undoneAt:number|null;
}
export interface SyncConflict {
  nodeId:string;opId:string;opAt:number;localAt:number;
  reason:'older'|'diverged';
  incoming:SyncOp;local:SyncOp|null;localState:unknown;
}
export interface SyncApplyResult {applied:number;skipped:number;deferred?:number;conflicts?:SyncConflict[]}
const pendingKey=(id:string)=>'syncPendingOp:'+id;

function opRow(table:'review_log'|'reading_log',row:any):SyncOp{
  return {id:String(row.event_id),kind:table==='review_log'?'fsrs':'reading',nodeId:String(row.node_id),
    reviewedAt:Number(row.reviewed_at),rating:row.rating===null||row.rating===undefined?null:Number(row.rating),
    action:row.action?String(row.action):null,algorithmVersion:row.algorithm_version?String(row.algorithm_version):null,
    beforeState:String(row.before_state||'null'),afterState:String(row.after_state||'null'),
    details:String(row.details||'{}'),undoneAt:row.undone_at?Number(row.undone_at):null};
}

export function collectSyncOps(repository:Repository,ids:string[]):SyncOp[]{
  const result:SyncOp[]=[];
  if(!ids.length)return result;
  const unique=[...new Set(ids.map(String))].slice(0,5000);
  const placeholders=unique.map(()=>'?').join(',');
  for(const row of repository.query(`SELECT * FROM review_log WHERE event_id IN(${placeholders})`).all(...unique) as any[])
    result.push(opRow('review_log',row));
  for(const row of repository.query(`SELECT * FROM reading_log WHERE event_id IN(${placeholders})`).all(...unique) as any[])
    result.push(opRow('reading_log',row));
  const scheduleIds=unique.filter(id=>id.startsWith(studyChangePrefix));
  if(scheduleIds.length)result.push(...studyChangeRows(repository,scheduleIds).map(studyChangeFromRow));
  const order=new Map(unique.map((id,index)=>[id,index]));
  return result.sort((a,b)=>order.get(a.id)!-order.get(b.id)!);
}
export function collectSyncIds(repository:Repository,includeStudyChanges=false):string[]{
  if(includeStudyChanges)return repository.query(`
    WITH events AS (
      SELECT event_id,reviewed_at FROM review_log UNION ALL
      SELECT event_id,reviewed_at FROM reading_log
    )
    SELECT event_id FROM (
      SELECT e.event_id,e.reviewed_at,COALESCE(s.rowid,0) AS sequence
        FROM events e LEFT JOIN study_operations s ON s.event_id=e.event_id
      UNION ALL
      SELECT event_id,reviewed_at,rowid FROM study_operations WHERE session_id=?
    ) ORDER BY reviewed_at,sequence,event_id`).all(studyChangeSession)
    .map(row=>String(row.event_id));
  const ids=new Set<string>();
  for(const row of repository.query('SELECT event_id FROM review_log').all() as any[])ids.add(String(row.event_id));
  for(const row of repository.query('SELECT event_id FROM reading_log').all() as any[])ids.add(String(row.event_id));
  return [...ids];
}

const stageOf=(state:any)=>Number(state?.state??0);
export function applyLeechEffect(repository:Repository,op:SyncOp,side:'previous'|'after'='after'):void{
  let effect;
  try{effect=JSON.parse(op.details)?.leechEffect;}catch{return;}
  const value=effect?.[side];
  if(typeof value?.tag!=='boolean'||![0,1].includes(value.reviewEnabled)||![0,1].includes(value.pushEnabled)||
    !Number.isSafeInteger(value.pushDueAt))return;
  if(value.tag)repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'leech')").run(op.nodeId);
  else repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='leech'").run(op.nodeId);
  if(effect.previous?.reviewEnabled!==effect.after?.reviewEnabled){
    repository.query('UPDATE review_cards SET enabled=?,revision=revision+1 WHERE node_id=?').run(value.reviewEnabled,op.nodeId);
    repository.query('UPDATE reading_state SET enabled=?,due_at=?,revision=revision+1 WHERE node_id=?')
      .run(value.pushEnabled,value.pushDueAt,op.nodeId);
  }
}
function previousOperationAt(op:SyncOp):number|null{
  try{
    const state=JSON.parse(op.beforeState);
    if(!state||typeof state!=='object')return null;
    const at=op.kind==='fsrs'
      ?(state.lastReviewAt?new Date(state.lastReviewAt).getTime():0)
      :Number(state.last_read_at||0);
    return Number.isFinite(at)?at:null;
  }catch{return null;}
}

export function applySyncOps(repository:Repository,ops:SyncOp[],options:{clockToleranceMs?:number}={}):SyncApplyResult{
  if(!Array.isArray(ops)||ops.length>5000)throw Error(t('同步数据无效。'));
  // 1.30：时钟保护（双保险）——明显来自未来的 op 不重放，避免打乱顺序。
  // 容忍度可配置：默认 2 分钟；测试或时间旅行场景可放宽。
  const clockLimit=Date.now()+Math.max(0,Number(options.clockToleranceMs??2*60*1000));
  let applied=0,skipped=0,deferred=0;
  // 1.114：记录「收到的操作比本地旧、被丢弃」的情况（= 冲突），供界面保留查看
  const conflicts:SyncConflict[]=[];
  const recordConflict=(op:SyncOp,localAt:number,localState:unknown,reason:SyncConflict['reason'])=>{
    const table=op.kind==='fsrs'?'review_log':'reading_log';
    const row=repository.query(`SELECT * FROM ${table}
      WHERE node_id=? AND reviewed_at=? AND undone_at IS NULL AND event_id<>?
      ORDER BY event_id DESC LIMIT 1`).get(op.nodeId,localAt,op.id);
    conflicts.push({nodeId:op.nodeId,opId:op.id,opAt:op.reviewedAt,localAt,reason,
      incoming:op,local:row?opRow(table,row):null,localState});
  };
  // 只重放"新收到"的 op；已存在的 op 幂等跳过
  const fresh:SyncOp[]=[];
  repository.transaction(()=>{
    for(const incoming of ops){
      if(typeof incoming?.id!=='string'||!/^[\w:-]{8,80}$/.test(incoming.id)||
        typeof incoming.nodeId!=='string'||!incoming.nodeId||!Number.isFinite(incoming.reviewedAt)||
        !['fsrs','reading','schedule'].includes(incoming.kind)||
        (incoming.kind==='schedule'&&!incoming.id.startsWith(studyChangePrefix))){skipped++;continue;}
      const key=pendingKey(incoming.id);
      const op=(repository.getSetting(key) as SyncOp|null)??incoming;
      const table=op.kind==='fsrs'?'review_cards':'reading_state';
      const ready=repository.query(`SELECT 1 FROM nodes n JOIN ${table} s ON s.node_id=n.id
        WHERE n.id=? AND n.deleted_at IS NULL`).get(op.nodeId);
      if(!ready){
        repository.query('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(op));
        deferred++;
        continue;
      }
      if(op.kind==='fsrs'){
        const changes=repository.query(`INSERT OR IGNORE INTO review_log(event_id,node_id,reviewed_at,rating,algorithm_version,before_state,after_state,details,undone_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(op.id,op.nodeId,op.reviewedAt,op.rating??1,op.algorithmVersion||'unknown',op.beforeState,op.afterState,op.details,op.undoneAt).changes;
        if(changes)fresh.push(op);else skipped++;
      }else if(op.kind==='reading'){
        const changes=repository.query(`INSERT OR IGNORE INTO reading_log(event_id,node_id,reviewed_at,action,before_state,after_state,undone_at)
          VALUES(?,?,?,?,?,?,?)`).run(op.id,op.nodeId,op.reviewedAt,op.action||'read',op.beforeState,op.afterState,op.undoneAt).changes;
        if(changes)fresh.push(op);else skipped++;
      }else fresh.push(op);
      repository.query('DELETE FROM settings WHERE key=?').run(key);
    }
    // 按 (reviewed_at, event_id) 全序重放（两端规则一致 → 收敛）
    fresh.sort((a,b)=>a.reviewedAt-b.reviewedAt);
    const byNode=new Map<string,SyncOp[]>();
    for(const op of fresh){const list=byNode.get(op.nodeId)||[];list.push(op);byNode.set(op.nodeId,list);}
    for(const [nodeId,nodeOps] of byNode){
      for(const op of nodeOps){
        if(op.undoneAt)continue;
      if(op.reviewedAt>clockLimit){skipped++;continue;} // 未来时间戳不重放
        if(op.kind==='schedule'){
          const current=readSchedule(repository,nodeId);
          if(!current){skipped++;continue;}
          let result;
          try{result=repository.transaction(()=>applyStudyChange(repository,op,current));}
          catch{skipped++;continue;}
          if(result.status==='applied')applied++;
          else if(result.status==='conflict'){
            conflicts.push({nodeId,opId:op.id,opAt:op.reviewedAt,localAt:result.local.reviewedAt,
              reason:'diverged',incoming:op,local:result.local,localState:current});
          }else skipped++;
          continue;
        }
        let after:any;
        try{after=JSON.parse(op.afterState);}catch{}
        if(!after||typeof after!=='object'||Array.isArray(after)){skipped++;continue;}
        const base=previousOperationAt(op);
        if(op.kind==='fsrs'){
          const card=repository.query('SELECT * FROM review_cards WHERE node_id=?').get(nodeId);
          if(!card)continue; // 卡片不在本地：保留日志，阶段 2 后补算
          const current=JSON.parse(String(card.state));
          const last=current?.lastReviewAt?new Date(current.lastReviewAt).getTime():0;
          if(op.reviewedAt<=last){
            recordConflict(op,last,current,'older');
            continue;}
          if(base!==null&&base<last)recordConflict(op,last,current,'diverged');
          
          // ts-fsrs 的卡状态 JSON 用 dueAt/lastReviewAt（驼峰），不是 SQL 行的 due_at
          const dueAt=after.dueAt?new Date(after.dueAt).getTime():after.due?new Date(after.due).getTime():op.reviewedAt;
          repository.query(`UPDATE review_cards SET state=?,stage=?,due_at=?,algorithm_version=?,revision=revision+1,updated_at=? WHERE node_id=?`)
            .run(op.afterState,stageOf(after),dueAt,op.algorithmVersion||'ts-fsrs/6.0.0:FSRS-7',new Date().toISOString(),nodeId);
          applyLeechEffect(repository,op);
          applied++;
        }else{
          const reading=repository.query('SELECT * FROM reading_state WHERE node_id=?').get(nodeId);
          if(!reading)continue;
          const last=Number(reading.last_read_at||0);
          if(op.reviewedAt<=last){
            recordConflict(op,last,reading,'older');
            continue;}
          if(base!==null&&base<last)recordConflict(op,last,reading,'diverged');
          repository.query(`UPDATE reading_state SET due_at=?,interval_ms=?,reps=?,last_read_at=?,enabled=?,reading_position=COALESCE(?,reading_position),revision=revision+1 WHERE node_id=?`)
            .run(after.due_at??op.reviewedAt,after.interval_ms??0,after.reps??0,after.last_read_at??op.reviewedAt,after.enabled??1,after.reading_position??null,nodeId);
          applied++;
        }
      }
    }
  });
  return {applied,skipped,deferred,conflicts};
}

export function replayPendingSyncOps(repository:Repository,options?:{clockToleranceMs?:number}):SyncApplyResult{
  const rows=repository.query(`SELECT pending.value FROM settings pending
    JOIN nodes n ON n.id=json_extract(pending.value,'$.nodeId') AND n.deleted_at IS NULL
    WHERE pending.key GLOB 'syncPendingOp:*' AND CASE json_extract(pending.value,'$.kind')
      WHEN 'fsrs' THEN EXISTS(SELECT 1 FROM review_cards WHERE node_id=n.id)
      ELSE EXISTS(SELECT 1 FROM reading_state WHERE node_id=n.id) END
    ORDER BY json_extract(pending.value,'$.reviewedAt'),pending.rowid LIMIT 5000`).all();
  return applySyncOps(repository,rows.map(row=>JSON.parse(String(row.value))),options);
}
