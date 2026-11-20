import {t} from '../core/i18n';
import type {CatalogStatus,NodeKind} from '../core/model';
import {parseSearch} from './search-syntax';

export const enabled=`CASE WHEN n.kind='cloze' THEN COALESCE(r.enabled,1) ELSE COALESCE(s.enabled,1) END`;
export const stage=`CASE WHEN n.kind='cloze' THEN COALESCE(r.stage,0) WHEN COALESCE(s.reps,0)=0 THEN 0 ELSE 2 END`;
export const due=`CASE WHEN n.kind='cloze' THEN r.due_at ELSE s.due_at END`;
// 状态表达式单独提出来，浏览列表的"状态"列取值和表头按状态排序共用同一段 SQL，避免两处漂移。
// 状态判定顺序不能乱：
//   1. 内容未补全 → empty
//   2. 推送开启（检测卡要求复习关闭才算"推送中"）→ push
//   4. 复习关闭但推送开着 → 这种情况上面已归入 push，因此 suspended 只对旧数据兜底
//   5. FSRS 阶段：new / learning / review
export const stateExpr=`CASE WHEN n.study_ready=0 THEN 'empty'
  WHEN EXISTS(SELECT 1 FROM node_tags ht WHERE ht.node_id=n.id AND ht.tag='hold') THEN 'hold'
  WHEN s.enabled=1 AND(n.kind!='cloze' OR COALESCE(r.enabled,0)=0) THEN 'push'
  WHEN ${enabled}=1 AND EXISTS(SELECT 1 FROM node_tags bt WHERE bt.node_id=n.id AND bt.tag='buried') AND COALESCE(r.due_at,0)>CAST(strftime('%s','now') AS INTEGER)*1000 THEN 'buried'
  WHEN (${enabled})=0 THEN 'suspended'
  WHEN (${stage})=0 THEN 'new' WHEN (${stage}) IN(1,3) THEN 'learning' ELSE 'review' END`;
export const from=`FROM nodes n LEFT JOIN nodes f ON f.id=n.folder_id
 LEFT JOIN review_cards r ON r.node_id=n.id LEFT JOIN reading_state s ON s.node_id=n.id`;

export const STATUS_VALUES:CatalogStatus[]=['new','learning','review','hold','buried','due','suspended','empty','push','leech','conflict'];
export const SORT_KEYS=['created','updated','title','due','kind','folder','state','reps'];

/** 把筛选条件与搜索词翻成 WHERE 子句 + 绑定参数。 */
export interface WhereContext{
  now():number;
  /** 搜索里的 rated:/added:/edited: 按「日切小时」算 N 天前。 */
  dayStartNow():number;
}
export interface WhereInput{
  query:string;
  kinds:NodeKind[];
  statuses:CatalogStatus[];
  folderId?:string|null;
  conflictIds:string[];
}
export function buildWhere(context:WhereContext,input:WhereInput):{where:string;args:any[]}{
  const conditions:string[]=[],args:any[]=[];
  const escapeLike=(value:string)=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
  // 状态组：每个状态各自带「未删除 + 非文件夹」的前提，冲突文件例外（它可能指向垃圾桶里的卡片或目录）。
  const statusCondition=(status:CatalogStatus):string=>{
    if(status==='conflict'){
      args.push(JSON.stringify(input.conflictIds));
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
      if(status==='due'){parts.push(`(${due})<=?`);args.push(context.now());}
      else parts.push(`(${stage}) ${status==='new'?'=0':status==='learning'?'IN(1,3)':'=2'}`);
    }
    return '('+parts.join(' AND ')+')';
  };
  if(input.statuses.length)conditions.push('('+input.statuses.map(statusCondition).join(' OR ')+')');
  else conditions.push('n.deleted_at IS NULL',"n.kind!='folder'");
  if(input.kinds.length){conditions.push(`n.kind IN (${input.kinds.map(()=>'?').join(',')})`);args.push(...input.kinds);}
  if(input.folderId){conditions.push(`n.folder_id IN(WITH RECURSIVE decks(id) AS(SELECT id FROM nodes WHERE id=? AND kind='folder' AND deleted_at IS NULL
    UNION ALL SELECT c.id FROM nodes c JOIN decks p ON c.parent_id=p.id WHERE c.kind='folder' AND c.deleted_at IS NULL) SELECT id FROM decks)`);args.push(String(input.folderId));}
  // 2026-11-19：Anki 风格的字段搜索（deck:/tag:/is:/prop:）先解析出来，
  // 剩下的自由文本再走原来的全文/子串匹配。
  const parsed=parseSearch(input.query);
  const freeText:string[]=[];
  for(const term of parsed.terms){
    if(term.value==='__OR__')continue;
    if(term.field===''){freeText.push(term.value);continue;}
    const not=term.negated?'NOT ':'';
    if(term.field==='deck'){
      conditions.push(`${not}n.folder_id IN(WITH RECURSIVE d(id) AS(SELECT id FROM nodes WHERE kind='folder' AND deleted_at IS NULL AND title LIKE ? ESCAPE '\\'
        UNION ALL SELECT c.id FROM nodes c JOIN d p ON c.parent_id=p.id WHERE c.kind='folder' AND c.deleted_at IS NULL) SELECT id FROM d)`);
      args.push(escapeLike(term.value));
    }else if(term.field==='tag'){
      conditions.push(`${not}EXISTS(SELECT 1 FROM node_tags t WHERE t.node_id=n.id AND t.tag LIKE ? ESCAPE '\\')`);
      args.push(escapeLike(term.value));
    }else if(term.field==='is'){
      const map:Record<string,string>={
        new:"n.kind='cloze' AND r.stage=0",
        learning:"n.kind='cloze' AND r.stage IN(1,3)",
        review:"n.kind='cloze' AND r.stage=2",
        suspended:"n.kind='cloze' AND r.enabled=0",
        buried:'COALESCE(r.buried_until,0)>'+String(context.now()),
        due:"n.kind='cloze' AND r.due_at<="+String(context.now()),
      };
      conditions.push(`${not}(${map[term.value]??'1=0'})`);
    }else if(term.field==='prop'&&term.key){
      // 2026-11-19：ivl/lapses 改成读真实字段（以前是占位）；ease 用 FSRS 难度顶上（我们没有 Anki 的 ease 因子），
      // due 仍是毫秒时间戳，比较时按同一个单位传值。
      const column:Record<string,string>={ivl:"COALESCE(json_extract(r.state,'$.scheduledDays'),0)",reps:"COALESCE(json_extract(r.state,'$.reps'),0)",lapses:"COALESCE(json_extract(r.state,'$.lapses'),0)",ease:"COALESCE(json_extract(r.state,'$.difficulty'),0)",due:'r.due_at'};
      const expr=column[term.key];
      if(expr){conditions.push(`${not}(${expr} ${term.op??'='} ?)`);args.push(Number(term.value));}
    }else if(term.field==='rated'){
      // Anki 的 rated:N = 最近 N 天答过（含今天）；rated:N:评价 只看某个评价
      const [daysText,ratingText]=term.value.split(':');
      const days=Math.max(1,Math.floor(Number(daysText)||1));
      const rating=ratingText?Number(ratingText):null;
      conditions.push(`${not}EXISTS(SELECT 1 FROM review_log rl WHERE rl.node_id=n.id AND rl.undone_at IS NULL AND rl.reviewed_at>=?${rating?' AND rl.rating=?':''})`);
      args.push(context.dayStartNow()-(days-1)*86400000);
      if(rating)args.push(rating);
    }else if(term.field==='added'||term.field==='edited'){
      // Anki 的 added:N / edited:N = 最近 N 天新增 / 修改
      const days=Math.max(1,Math.floor(Number(term.value)||1));
      const column=term.field==='added'?'n.created_at':'n.updated_at';
      conditions.push(`${not}${column}>=?`);
      args.push(context.dayStartNow()-(days-1)*86400000);
    }
  }
  // Bind literal substrings so Chinese word fragments and punctuation work.
  for(const term of freeText){
    const characters=Array.from(term);
    if(characters.length>=3){
      const grams=new Set(Array.from({length:characters.length-2},(_,index)=>characters.slice(index,index+3).join('')));
      conditions.push('n.rowid IN(SELECT rowid FROM nodes_substrings WHERE nodes_substrings MATCH ?)');
      args.push([...grams].map(gram=>'"'+gram.replaceAll('"','""')+'"').join(' AND '));
    }
    // 卡片标签（标签）也参与检索
    conditions.push("(n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\' OR n.answer LIKE ? ESCAPE '\\' OR n.id LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM node_tags t WHERE t.node_id=n.id AND t.tag LIKE ? ESCAPE '\\'))");
    const value=escapeLike(term);args.push(value,value,value,value,value);
  }
  if(!conditions.length)throw Error(t('筛选条件无效。'));
  return {where:'WHERE '+conditions.join(' AND '),args};
}
