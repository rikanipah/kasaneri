import type {Material} from '../core/model';
import {t} from '../core/i18n';
import {readSchedule,recordTagChange} from '../sync/study-changes';
import {pushSchedule,type PushContext} from './push';

type Row=Record<string,any>;
export type ReadingAction='read'|'later'|'soon'|'dismiss';

export interface ReadingActionInput{
  node:Material;
  /** 评分前的 reading_state 行（撤销快照也用它）。 */
  before:Row;
  action:ReadingAction;
  eventId:string;
  now:number;
}

/**
 * 待办四动作的写库：读完 / 稍后 / 搁置（dismiss）改 reading_state 并记 reading_log；
 * 「本轮再出」（soon）**不写任何状态**——间隔/次数/due 都不动，只由调用方把卡塞回队尾，
 * 不记日志、不进撤销栈（Foliole 的 soon cohort 语义）。
 *
 * 读完 / 稍后在写库后顺带清掉 buried 标签并记一条同步用的标签变更。
 */
export function applyReadingAction(context:PushContext,input:ReadingActionInput):void{
  const {node,before,action,eventId,now}=input;
  if(!['read','later','soon','dismiss'].includes(action))throw Error(t('阅读操作无效。'));
  if(action==='soon')return;
  const repository=context.repository;
  const schedule=action==='dismiss'
    ?{dueAt:before.due_at,interval:before.interval_ms,reps:before.reps}
    :pushSchedule(context,node.id,before,action,now);
  repository.query('UPDATE reading_state SET due_at=?,interval_ms=?,reps=?,last_read_at=?,enabled=?,revision=revision+1 WHERE node_id=?')
    .run(schedule.dueAt,schedule.interval,schedule.reps,now,action==='dismiss'?0:1,node.id);
  const after=repository.query('SELECT * FROM reading_state WHERE node_id=?').get(node.id) as Row|undefined;
  repository.query('INSERT INTO reading_log(event_id,node_id,reviewed_at,action,before_state,after_state) VALUES(?,?,?,?,?,?)')
    .run(eventId,node.id,now,action,JSON.stringify(before),JSON.stringify(after));
  const tagsBefore=readSchedule(repository,node.id)!;
  repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='buried'").run(node.id);
  recordTagChange(repository,node.id,now,tagsBefore,readSchedule(repository,node.id)!);
}

/** 记录阅读点（滚到哪了）。随评价一起写时由调用方直接 UPDATE，不递增 revision。 */
export function setReadingPosition(repository:PushContext['repository'],id:string,position:number):void{
  if(!Number.isFinite(position)||position<0)throw Error(t('阅读位置无效。'));
  if(!repository.query('UPDATE reading_state SET reading_position=?,revision=revision+1 WHERE node_id=?')
    .run(Math.min(100000000,Math.floor(position)),id).changes)throw Error(t('卡片不存在。'));
}
