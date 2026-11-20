import { t } from '../core/i18n';
import type {CatalogPage,CatalogQuery,CatalogStatus,NodeKind} from '../core/model';
import {Repository} from '../data/database';
import {countRows,listRows,type CatalogSort} from './query';
import {buildWhere,SORT_KEYS,STATUS_VALUES} from './where';

/**
 * 浏览卡片的查询入口：校验参数 → 拼 WHERE（where.ts）→ 取总数与行（query.ts）。
 * 界面只跟这个类打交道，不直接拼 SQL。
 */
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
  /** 2026-11-19：搜索里的 rated:/added:/edited: 按「日切小时」算 N 天前（默认 4 点，和每日上限同一口径）。 */
  private dayStartNow():number{
    let hour=4;
    try{
      const stored=this.repository.getSetting('studySettings') as Record<string,unknown>|null;
      const value=Number(stored?.dayStartHour);
      if(Number.isFinite(value)&&value>=0&&value<=23)hour=Math.round(value);
    }catch{/* 设置读不出来就用默认 4 点 */}
    const at=this.now(),date=new Date(at);
    date.setHours(hour,0,0,0);
    if(date.getTime()>at)date.setDate(date.getDate()-1);
    return date.getTime();
  }
  list(input:CatalogQuery={}):CatalogPage {
    const query=String(input.query||'').trim();if(query.length>200)throw Error(t('搜索内容请控制在 200 字以内。'));
    const sort=(input.sort||'created') as CatalogSort,direction=input.direction||'desc';
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
        statuses.some(status=>!STATUS_VALUES.includes(status)))throw Error(t('筛选条件无效。'));
    if(!SORT_KEYS.includes(sort)||!['asc','desc'].includes(direction))throw Error(t('排序方式无效。'));
    // 浏览卡片不再翻页（和 Anki 一样一次给全部命中），所以上限放开到 1 万；
    // 真超过 1 万时界面会提示用搜索/筛选缩小范围。
    const limit=Math.max(1,Math.min(10000,Math.floor(Number(input.limit)||100))),offset=Math.max(0,Math.floor(Number(input.offset)||0));
    if(!Number.isSafeInteger(offset))throw Error(t('页码无效。'));
    const conflictIds=Array.isArray(input.conflictIds)?input.conflictIds.filter(id=>typeof id==='string'):[];
    const {where,args}=buildWhere({now:()=>this.now(),dayStartNow:()=>this.dayStartNow()},
      {query,kinds,statuses,folderId:input.folderId,conflictIds});
    // countTotal=false 时不重算总数（续页滚到底用），省掉一次整表扫描；total 返回 -1 表示「没算」。
    const total=input.countTotal===false?-1:countRows(this.repository,{where,args});
    const items=listRows(this.repository,{where,args,sort,direction:direction as 'asc'|'desc',limit,offset});
    return {items,total,offset,limit};
  }
}
