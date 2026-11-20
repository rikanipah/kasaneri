import {t} from '../core/i18n';
import type {Repository} from '../data/database';
import {readSchedule,recordStudyChange} from '../sync/study-changes';

type Row=Record<string,any>;

/** 「重来」连带勾选的子卡批次：子卡的 study_operations 用这个前缀挂在父卡事件后面。 */
export const againChildBatch='again-children:';

/** 找可撤销的排程操作；父卡被「重来批次」包着时继续往下找真正的父事件。 */
export function findUndoableOperation(repository:Repository,requestedId:string):Row|undefined{
  const find=repository.query("SELECT * FROM study_operations WHERE event_id=? AND undone_at IS NULL AND kind IN ('fsrs','reading')");
  let event=find.get(requestedId) as Row|undefined;
  if(event&&String(event.session_id).startsWith(againChildBatch))event=find.get(String(event.session_id).slice(againChildBatch.length)) as Row|undefined;
  return event;
}

/** 同一次「重来」里被一起评分的子卡操作。 */
export function childOperations(repository:Repository,eventId:string):Row[]{
  return repository.query('SELECT * FROM study_operations WHERE session_id=?').all(againChildBatch+eventId) as Row[];
}

/**
 * 撤销一次排程操作：校验「之后没被改过」→ 把 state/due/stage 等写回 before → 处理 leech/推送 →
 * 把连带的搁置卡放回原到期日 → 标记 study_operations 与 review_log/reading_log 为已撤销 →
 * 记一条同步用的排程变更。调用方负责事务。
 */
export function restoreOperation(repository:Repository,event:Row,now:number):void{
  const node=repository.getNode(String(event.node_id));
  if(!node)throw Error(t('这张卡片已删除。'));
  const fsrs=event.kind==='fsrs';
  const table=fsrs?'review_cards':'reading_state';
  const before=JSON.parse(event.before_state),after=JSON.parse(event.after_state);
  const current=repository.query(`SELECT * FROM ${table} WHERE node_id=?`).get(node.id);
  if(!current||node.kind==='folder'||(fsrs&&node.kind!=='cloze')||
    (!fsrs&&node.kind==='cloze'&&repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(node.id)?.enabled))
    throw Error(t('卡片类型或推送方式已改变，无法撤销此次复习。'));
  if(event.kind==='fsrs'&&after._push){
    const push=repository.query('SELECT * FROM reading_state WHERE node_id=?').get(node.id);
    // 另一次撤销可能恢复了相同的推送内容，但版本号仍须递增。
    if(!push||Object.keys(after._push).some(key=>key!=='revision'&&push[key]!==after._push[key]))
      throw Error(t('推送状态之后已改变，无法撤销此次复习。'));
  }
  const keys=event.kind==='fsrs'?['state','due_at','enabled','stage']:['due_at','interval_ms','reps','last_read_at','enabled'];
  if(keys.some(key=>current[key]!==after[key]))throw Error(t('这张卡片之后又修改了排程，无法撤销。'));
  const previousSchedule=readSchedule(repository,node.id)!;
  if(event.kind==='fsrs'&&before._leech!==undefined){
    if(!before._leech)repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='leech'").run(node.id);
    if(before._push)repository.query('UPDATE reading_state SET enabled=?,due_at=?,revision=revision+1 WHERE node_id=? AND (enabled!=? OR due_at!=?)')
      .run(before._push.enabled,before._push.due_at,node.id,before._push.enabled,before._push.due_at);
  }
  if(fsrs)repository.query('UPDATE review_cards SET state=?,due_at=?,stage=?,enabled=?,day_learning=?,learning_step=?,algorithm_version=?,revision=revision+1,updated_at=? WHERE node_id=?')
    .run(before.state,before.due_at,before.stage,before.enabled,Number(before.day_learning??0),Number(before.learning_step??0),before.algorithm_version,now,node.id);
  else repository.query('UPDATE reading_state SET due_at=?,interval_ms=?,reps=?,last_read_at=?,enabled=?,revision=revision+1 WHERE node_id=?')
    .run(before.due_at,before.interval_ms,before.reps,before.last_read_at,before.enabled,node.id);
  // 这次复习一并搁置的关联卡片，撤销时放回原来的到期日（期间被人改过就跳过）
  const buried=(before as any)._buried as Array<{id:string;dueAt:number;buriedAt:number}>|undefined;
  if(fsrs&&buried?.length)for(const entry of buried){
    const row=repository.query('SELECT due_at FROM review_cards WHERE node_id=?').get(entry.id);
    if(!row||Number(row.due_at)!==entry.buriedAt)continue;
    const previousSchedule=readSchedule(repository,entry.id);
    repository.query('UPDATE review_cards SET due_at=?,revision=revision+1,updated_at=? WHERE node_id=?').run(entry.dueAt,now,entry.id);
    const restored=readSchedule(repository,entry.id);
    if(previousSchedule&&restored)recordStudyChange(repository,entry.id,now,previousSchedule,restored,
      {id:'unbury-'+String(event.event_id)+'-'+entry.id,kind:'fsrs',at:now});
  }
  repository.query('UPDATE study_operations SET undone_at=? WHERE event_id=?').run(now,event.event_id);
  repository.query(`UPDATE ${fsrs?'review_log':'reading_log'} SET undone_at=? WHERE event_id=?`).run(now,event.event_id);
  recordStudyChange(repository,node.id,now,previousSchedule,readSchedule(repository,node.id)!,
    {id:String(event.event_id),kind:fsrs?'fsrs':'reading',at:now});
}
