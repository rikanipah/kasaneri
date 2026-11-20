import type {CatalogRow} from '../core/model';
import type {Repository} from '../data/database';
import {from,due,stateExpr} from './where';

export type CatalogSort='created'|'updated'|'title'|'due'|'kind'|'folder'|'state'|'reps';

export interface ListQuery{
  where:string;
  args:any[];
  sort:CatalogSort;
  direction:'asc'|'desc';
  limit:number;
  offset:number;
}

// 排序键扩展。kind/folder/state/reps 都是纯表达式排序，不需要建索引，100 张分页足够快；
// 表头点击排序由 renderer/browser.ts 发起，键名必须与这里的白名单一致。
const orderOf=(sort:CatalogSort):string=>({
  created:'n.position',updated:'n.updated_at',title:'n.title COLLATE NOCASE',due:`(${due})`,
  kind:`CASE n.kind WHEN 'topic' THEN 0 WHEN 'material' THEN 1 ELSE 2 END`,folder:'f.title COLLATE NOCASE',
  state:`${stateExpr}`,
  reps:`CASE WHEN n.kind='cloze' THEN COALESCE(json_extract(r.state,'$.reps'),0) ELSE COALESCE(s.reps,0) END`,
}[sort]);

/** 总数：countTotal=false 时不重算（续页滚到底用），total 返回 -1 表示「没算」。 */
export function countRows(repository:Repository,query:Pick<ListQuery,'where'|'args'>):number{
  return Number(repository.query(`SELECT count(*) n ${from} ${query.where}`).get(...query.args)!.n);
}

export function listRows(repository:Repository,query:ListQuery):CatalogRow[]{
  const direction=query.direction.toUpperCase();
  return repository.query(`SELECT n.id,n.title,n.kind,n.folder_id AS folderId,f.title AS folderTitle,n.deleted_at AS deletedAt,
    n.study_ready AS reviewReady,COALESCE(r.enabled,0) AS reviewEnabled,COALESCE(s.enabled,0) AS pushEnabled,
    ${stateExpr} AS state,
    CASE WHEN n.study_ready=1 THEN (${due}) ELSE NULL END AS dueAt,
    CASE WHEN n.kind='cloze' THEN COALESCE(json_extract(r.state,'$.reps'),0) ELSE COALESCE(s.reps,0) END AS reps,
    n.created_at AS createdAt,n.updated_at AS updatedAt ${from} ${query.where}
    ORDER BY ${query.sort==='due'?`(${due}) IS NULL,`:''}${orderOf(query.sort)} ${direction},n.id ${direction} LIMIT ? OFFSET ?`)
    .all(...query.args,query.limit,query.offset) as unknown as CatalogRow[];
}
