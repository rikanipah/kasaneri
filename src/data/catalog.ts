import { t } from '../core/i18n';
import type {CatalogPage,CatalogQuery,CatalogRow,CatalogStatus,NodeKind} from '../core/model';
import {Repository} from './database';

const enabled=`CASE WHEN n.kind='cloze' THEN COALESCE(r.enabled,1) ELSE COALESCE(s.enabled,1) END`;
const stage=`CASE WHEN n.kind='cloze' THEN COALESCE(r.stage,0) WHEN COALESCE(s.reps,0)=0 THEN 0 ELSE 2 END`;
const due=`CASE WHEN n.kind='cloze' THEN r.due_at ELSE s.due_at END`;
// 状态表达式单独提出来，浏览列表的"状态"列取值和表头按状态排序共用同一段 SQL，避免两处漂移。
// 状态判定顺序不能乱：
//   1. 内容未补全 → empty
//   2. 推送开启（检测卡要求复习关闭才算"推送中"）→ push
//   4. 复习关闭但推送开着 → 这种情况上面已归入 push，因此 suspended 只对旧数据兜底
//   5. FSRS 阶段：new / learning / review
const stateExpr=`CASE WHEN n.study_ready=0 THEN 'empty'
  WHEN EXISTS(SELECT 1 FROM node_tags ht WHERE ht.node_id=n.id AND ht.tag='hold') THEN 'hold'
  WHEN s.enabled=1 AND(n.kind!='cloze' OR COALESCE(r.enabled,0)=0) THEN 'push'
  WHEN ${enabled}=1 AND EXISTS(SELECT 1 FROM node_tags bt WHERE bt.node_id=n.id AND bt.tag='buried') AND COALESCE(r.due_at,0)>CAST(strftime('%s','now') AS INTEGER)*1000 THEN 'buried'
  WHEN (${enabled})=0 THEN 'suspended'
  WHEN (${stage})=0 THEN 'new' WHEN (${stage}) IN(1,3) THEN 'learning' ELSE 'review' END`;
const from=`FROM nodes n LEFT JOIN nodes f ON f.id=n.folder_id
 LEFT JOIN review_cards r ON r.node_id=n.id LEFT JOIN reading_state s ON s.node_id=n.id`;

export class CardCatalog {
  constructor(private repository:Repository,private now:()=>number=Date.now){
    if(!repository.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_substrings'").get())repository.transaction(()=>{
      repository.db.exec(`CREATE VIRTUAL TABLE nodes_substrings USING fts5(title,content,answer,id,content='nodes',content_rowid='rowid',tokenize='trigram',detail=none);
        CREATE TRIGGER nodes_substrings_insert AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_substrings(rowid,title,content,answer,id) VALUES(new.rowid,new.title,new.content,new.answer,new.id);END;
        CREATE TRIGGER nodes_substrings_update AFTER UPDATE OF title,content,answer ON nodes BEGIN
          INSERT INTO nodes_substrings(nodes_substrings,rowid,title,content,answer,id) VALUES('delete',old.rowid,old.title,old.content,old.answer,old.id);
          INSERT INTO nodes_substrings(rowid,title,content,answer,id) VALUES(new.rowid,new.title,new.content,new.answer,new.id);END;
        CREATE TRIGGER nodes_substrings_delete AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_substrings(nodes_substrings,rowid,title,content,answer,id) VALUES('delete',old.rowid,old.title,old.content,old.answer,old.id);END;
        INSERT INTO nodes_substrings(nodes_substrings) VALUES('rebuild');`);
    });
  }
  list(input:CatalogQuery={}):CatalogPage {
    const query=String(input.query||'').trim();if(query.length>200)throw Error(t('搜索内容请控制在 200 字以内。'));
    const sort=input.sort||'created',direction=input.direction||'desc';
    const statusValues:CatalogStatus[]=['new','learning','review','hold','buried','due','suspended','empty','push','leech','conflict'];
    // 浏览卡片改成多选筛选——同一组内 OR，组与组之间 AND；空集合 = 不筛选。
    // 旧的单选 kind/status 继续兼容（其他调用方/测试还在用）。
    const kinds=[...new Set<NodeKind>([
      ...(Array.isArray(input.kinds)?input.kinds:[]),
      ...(input.kind&&input.kind!=='all'?[input.kind]:[]),
    ])];
    const statuses=[...new Set<CatalogStatus>([
      ...(Array.isArray(input.statuses)?input.statuses:[]),
      ...(input.status&&input.status!=='all'?[input.status]:[]),
    ])];
    if(kinds.some(kind=>!['topic','material','cloze'].includes(kind))||
        statuses.some(status=>!statusValues.includes(status)))throw Error(t('筛选条件无效。'));
    if(!['created','updated','title','due','kind','folder','state','reps'].includes(sort)||!['asc','desc'].includes(direction))throw Error(t('排序方式无效。'));
    // 浏览卡片不再翻页（和 Anki 一样一次给全部命中），所以上限放开到 1 万；
    // 真超过 1 万时界面会提示用搜索/筛选缩小范围。
    const limit=Math.max(1,Math.min(10000,Math.floor(Number(input.limit)||100))),offset=Math.max(0,Math.floor(Number(input.offset)||0));
    if(!Number.isSafeInteger(offset))throw Error(t('页码无效。'));
    const conditions:string[]=[],args:any[]=[];
    const conflictIds=Array.isArray(input.conflictIds)?input.conflictIds.filter(id=>typeof id==='string'):[];
    // 状态组：每个状态各自带「未删除 + 非文件夹」的前提，冲突文件例外（它可能指向垃圾桶里的卡片或目录）。
    const statusCondition=(status:CatalogStatus):string=>{
      if(status==='conflict'){
        args.push(JSON.stringify(conflictIds));
        return 'n.id IN (SELECT value FROM json_each(?))';
      }
      const parts=["n.deleted_at IS NULL","n.kind!='folder'"];
      if(status==='suspended')parts.push(`(${enabled})=0`);
        else if(status==='push')parts.push("s.enabled=1 AND(n.kind!='cloze' OR r.enabled=0)");
      else if(status==='hold')parts.push("n.id IN(SELECT node_id FROM node_tags WHERE tag='hold')");
      else if(status==='buried')parts.push("EXISTS(SELECT 1 FROM node_tags t WHERE t.node_id=n.id AND t.tag='buried')");
      else if(status==='leech')parts.push("EXISTS(SELECT 1 FROM node_tags t WHERE t.node_id=n.id AND t.tag='leech')");
      else if(status==='empty')parts.push('n.study_ready=0');
      else{
        parts.push(`n.kind='cloze' AND n.study_ready=1 AND r.enabled=1`);
        if(status==='due'){parts.push(`(${due})<=?`);args.push(this.now());}
        else parts.push(`(${stage}) ${status==='new'?'=0':status==='learning'?'IN(1,3)':'=2'}`);
      }
      return '('+parts.join(' AND ')+')';
    };
    if(statuses.length)conditions.push('('+statuses.map(statusCondition).join(' OR ')+')');
    else conditions.push('n.deleted_at IS NULL',"n.kind!='folder'");
    if(kinds.length){conditions.push(`n.kind IN (${kinds.map(()=>'?').join(',')})`);args.push(...kinds);}
    if(input.folderId){conditions.push(`n.folder_id IN(WITH RECURSIVE decks(id) AS(SELECT id FROM nodes WHERE id=? AND kind='folder' AND deleted_at IS NULL
      UNION ALL SELECT c.id FROM nodes c JOIN decks p ON c.parent_id=p.id WHERE c.kind='folder' AND c.deleted_at IS NULL) SELECT id FROM decks)`);args.push(String(input.folderId));}
    // Bind literal substrings so Chinese word fragments and punctuation work.
    for(const term of query.split(/\s+/u).filter(Boolean)){
      const characters=Array.from(term);
      if(characters.length>=3){
        const grams=new Set(Array.from({length:characters.length-2},(_,index)=>characters.slice(index,index+3).join('')));
        conditions.push('n.rowid IN(SELECT rowid FROM nodes_substrings WHERE nodes_substrings MATCH ?)');
        args.push([...grams].map(gram=>'"'+gram.replaceAll('"','""')+'"').join(' AND '));
      }
      // 卡片属性（标签）也参与检索
      conditions.push("(n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\' OR n.answer LIKE ? ESCAPE '\\' OR n.id LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM node_tags t WHERE t.node_id=n.id AND t.tag LIKE ? ESCAPE '\\'))");
      const value='%'+term.replace(/[\\%_]/g,'\\$&')+'%';args.push(value,value,value,value,value);
    }
    const where='WHERE '+conditions.join(' AND '),db=this.repository;
    // countTotal=false 时不重算总数（续页滚到底用），省掉一次整表扫描；total 返回 -1 表示「没算」。
    const total=input.countTotal===false?-1:Number(db.query(`SELECT count(*) n ${from} ${where}`).get(...args)!.n);
    // 排序键扩展。kind/folder/state/reps 都是纯表达式排序，不需要建索引，100 张分页足够快；
    // 表头点击排序由 renderer/browser.ts 发起，键名必须与这里的白名单一致。
    const order={created:'n.position',updated:'n.updated_at',title:'n.title COLLATE NOCASE',due:`(${due})`,
      kind:`CASE n.kind WHEN 'topic' THEN 0 WHEN 'material' THEN 1 ELSE 2 END`,folder:'f.title COLLATE NOCASE',
      state:`${stateExpr}`,
      reps:`CASE WHEN n.kind='cloze' THEN COALESCE(json_extract(r.state,'$.reps'),0) ELSE COALESCE(s.reps,0) END`}[sort];
    const rows=db.query(`SELECT n.id,n.title,n.kind,n.folder_id AS folderId,f.title AS folderTitle,n.deleted_at AS deletedAt,
      n.study_ready AS reviewReady,COALESCE(r.enabled,0) AS reviewEnabled,COALESCE(s.enabled,0) AS pushEnabled,
      ${stateExpr} AS state,
      CASE WHEN n.study_ready=1 THEN (${due}) ELSE NULL END AS dueAt,
      CASE WHEN n.kind='cloze' THEN COALESCE(json_extract(r.state,'$.reps'),0) ELSE COALESCE(s.reps,0) END AS reps,
      n.created_at AS createdAt,n.updated_at AS updatedAt ${from} ${where}
      ORDER BY ${sort==='due'?`(${due}) IS NULL,`:''}${order} ${direction.toUpperCase()},n.id ${direction.toUpperCase()} LIMIT ? OFFSET ?`)
      .all(...args,limit,offset) as unknown as CatalogRow[];
    return {items:rows,total,offset,limit};
  }
}
