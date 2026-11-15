import { t } from '../core/i18n';
import {existsSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {Material} from '../core/model';
import type {Repository} from './database';

type TrashRepository=Pick<Repository,'trashDir'|'query'|'transaction'|'getNode'|'ensureDefaultFolder'>;

export class TrashStore {
  constructor(private readonly repository:TrashRepository){}

  /** 1.121：软删除单个节点：目录里立刻不可见，复习/待办一并挂起（复习记录保留）。 */
  private softDelete(id:string):void{
    this.repository.query('UPDATE nodes SET deleted_at=? WHERE id=?').run(new Date().toISOString(),id);
    this.repository.query('UPDATE review_cards SET enabled=0 WHERE node_id=?').run(id);
    this.repository.query('UPDATE reading_state SET enabled=0 WHERE node_id=?').run(id);
  }
  /** 恢复单个节点：回到目录，复习/待办状态重新打开（内容、复习记录本来就没动）。 */
  private reenable(id:string,kind:string):void{
    if(kind==='cloze')this.repository.query('UPDATE review_cards SET enabled=1,revision=revision+1 WHERE node_id=?').run(id);
    else if(kind!=='folder')this.repository.query('UPDATE reading_state SET enabled=1,revision=revision+1 WHERE node_id=?').run(id);
  }
  private recordTrash(id:string,parentId:string|null,stamp:number):void{
    const row=this.repository.query('SELECT * FROM nodes WHERE id=?').get(id);
    if(!row)return;
    this.repository.query(`INSERT INTO trash(node_id,deleted_at,parent_id,kind,title,restored_at,purged_at)
      VALUES(?,?,?,?,?,NULL,NULL)
      ON CONFLICT(node_id) DO UPDATE SET deleted_at=excluded.deleted_at,parent_id=excluded.parent_id,
        kind=excluded.kind,title=excluded.title,restored_at=NULL,purged_at=NULL`)
      .run(id,stamp,parentId,row.kind,row.title);
    this.writeTrashFile(row,stamp);
  }
  removeSyncedNode(node:Material):void{
    if(node.id==='folder:unfiled'||node.hasChildren)throw Error(t('此卡片暂时不能应用对端删除。'));
    this.softDelete(node.id);
    this.recordTrash(node.id,node.parentId,Date.now());
  }
  remove(id:string): {parentId:string|null;destinationId:string|null;children:number} {
    return this.repository.transaction(()=>{
      const node=this.repository.getNode(id);
      if(!node)throw Error(t('项目已删除。'));
      const children=Number(this.repository.query('SELECT count(*) AS n FROM nodes WHERE parent_id=? AND deleted_at IS NULL').get(id)!.n);
      const stamp=Date.now();
      // 1.121：删除＝软删除 + trash 记录 + 磁盘快照。
      // 一次操作共用同一个 stamp，trash.parent_id 记「这次删除的根节点」作为批次标记，
      // 恢复时按这个标记把整棵子树一起取回（节点之间的 parent_id 删除时不动，树形原样保留）。

      // 1.121：删文件夹（或删掉带下级的主题/卡片）＝它和里面所有内容一起进垃圾桶，
      // 不再是「子项上移到上级」；恢复时整棵子树一起回来。
      const descendants=this.repository.query(`WITH RECURSIVE tree(id) AS (
          SELECT id FROM nodes WHERE parent_id=? AND deleted_at IS NULL
          UNION ALL SELECT n.id FROM nodes n JOIN tree t ON n.parent_id=t.id WHERE n.deleted_at IS NULL)
        SELECT id FROM tree`).all(id) as Array<{id:string}>;
      for(const item of descendants){const childId=String(item.id);this.softDelete(childId);this.recordTrash(childId,id,stamp);}
      this.softDelete(id);this.recordTrash(id,node.parentId,stamp);
      // 「默认」文件夹本身删不掉：内容进了垃圾桶，这里立刻重建一个空的默认文件夹（可整批恢复）。
      if(id==='folder:unfiled')this.repository.ensureDefaultFolder('');
      return {parentId:node.parentId,destinationId:node.kind==='folder'?null:node.parentId,children};
    });
  }

  // ===== 1.23：垃圾桶文件夹（磁盘快照，与数据库文件夹同级）=====
  // data/library 放 SQLite；data/trash 放被删卡片的 Markdown 快照，
  // 文件名 <删除时间>-<卡片编号>.md，可直接用文本编辑器打开人工抢救。
  private writeTrashFile(row:Record<string,unknown>,deletedAt:number):void{
    try{
      const stamp=new Date(deletedAt).toISOString().replace(/[:.]/g,'-');
      const body=['<!-- kasaneri trash -->','# '+String(row.title),'',
        t('- 卡片编号：{0}',String(row.id)),t('- 类型：{0}',String(row.kind)),
        t('- 删除时间：{0}',new Date(deletedAt).toISOString()),
        t('- 原父级：{0}',(row.parent_id?String(row.parent_id):'（无）')),'',
        t('## 正文'),'',String(row.content||''),'',t('## 答案'),'',String(row.answer||''),''].join('\n');
      writeFileSync(join(this.repository.trashDir,stamp+'-'+encodeURIComponent(String(row.id))+'.md'),body,'utf8');
    }catch{/* 写磁盘失败不影响删除主流程 */}
  }
  private removeTrashFiles(ids:string[]):void{
    if(!ids.length)return;
    const directory=this.repository.trashDir;
    let names:string[];
    try{names=readdirSync(directory);}catch{return;}
    for(const id of ids){
      const encoded='-'+encodeURIComponent(id)+'.md',legacy='-'+id+'.md';
      const index=names.findIndex(file=>file.endsWith(encoded)||file.endsWith(legacy));
      if(index<0)continue;
      try{rmSync(join(directory,names[index]),{force:true});names.splice(index,1);}catch{}
    }
  }
  private pruneTrashFiles(cutoff:number):number{
    let removed=0;
    try{for(const name of readdirSync(this.repository.trashDir)){
      if(!name.endsWith('.md'))continue;
      const file=join(this.repository.trashDir,name);
      try{if(statSync(file).mtimeMs<=cutoff){rmSync(file,{force:true});removed++;}}catch{}
    }}catch{}
    return removed;
  }

  // ===== 1.13：垃圾桶 =====
  // 删除 = 软删除 + trash 里记一条 + 磁盘快照写进 data/trash；
  // 垃圾桶支持「恢复」「彻底删除」，超过保留天数自动永久删除（连同快照）。
  get(id:string){
    return this.repository.query(`SELECT node_id AS nodeId,deleted_at AS deletedAt,parent_id AS parentId,kind,title
      FROM trash WHERE node_id=? AND restored_at IS NULL AND purged_at IS NULL`).get(id);
  }
  list(limit=200){
    return this.repository.query(`SELECT t.node_id AS nodeId,t.deleted_at AS deletedAt,t.parent_id AS parentId,t.kind,t.title,
        n.content,n.answer,COALESCE(p.title,?) AS parentTitle,
        (SELECT count(*) FROM trash WHERE parent_id=t.node_id AND restored_at IS NULL AND purged_at IS NULL) AS childCount
      FROM trash t JOIN nodes n ON n.id=t.node_id LEFT JOIN nodes p ON p.id=t.parent_id
      WHERE t.restored_at IS NULL AND t.purged_at IS NULL AND n.deleted_at IS NOT NULL
      ORDER BY t.deleted_at DESC LIMIT ?`).all(t('未归类'),limit) as Array<Record<string,any>>;
  }
  /** 1.121：按 trash 里的批次标记找回「同一次删除」的整棵子树；父级关系保持删除前的样子。 */
  private restoreBatch(rootId:string,now:string,at:number):string[]{
    const pending=this.repository.query(`SELECT node_id AS id FROM trash
      WHERE parent_id=? AND restored_at IS NULL AND purged_at IS NULL AND node_id<>?`).all(rootId,rootId) as Array<{id:string}>;
    const restored:string[]=[];
    for(const item of pending){
      const target=String(item.id);
      const row=this.repository.query('SELECT kind FROM nodes WHERE id=?').get(target) as {kind:string}|undefined;
      if(!row)continue;
      this.repository.query('UPDATE nodes SET deleted_at=NULL,updated_at=? WHERE id=?').run(now,target);
      this.reenable(target,String(row.kind));
      this.repository.query('UPDATE trash SET restored_at=? WHERE node_id=?').run(at,target);
      restored.push(target);
    }
    return restored;
  }
  restore(id:string):{parentId:string|null;title:string}{
    const {parentId,title,snapshots}=this.repository.transaction(()=>{
      const row=this.repository.query('SELECT * FROM nodes WHERE id=?').get(id);
      const entry=this.get(id);
      const now=new Date().toISOString(),at=Date.now();
      // 1.118/1.121：默认文件夹（folder:unfiled）本身删不掉，恢复它时不应再建一个同名文件夹，
      // 而是把当时被一起删掉的整棵子树放回现有的默认文件夹里。
      if(id==='folder:unfiled'){
        const defaultId=this.repository.ensureDefaultFolder('');
        const snapshots=this.restoreBatch(id,now,at);
        this.repository.query('UPDATE trash SET restored_at=? WHERE node_id=?').run(at,id);
        const folder=this.repository.query('SELECT title FROM nodes WHERE id=?').get(defaultId) as {title?:string}|undefined;
        return {parentId:defaultId,title:String(folder?.title||t('默认')),snapshots};
      }
      if(!row||!row.deleted_at||!entry)throw Error(t('垃圾桶里没有这张卡片。'));
      // 1.121：恢复文件夹/带下级的卡片时，整棵子树一起回来。
      const snapshots=this.restoreBatch(id,now,at);
      // 原父级也被删/不存在时，放回「默认」，避免恢复到看不见的地方；
      // 顶级文件夹原本就在根上，恢复时放回根，而不是塞进「默认」。
      const parent=row.parent_id?this.repository.query('SELECT id,deleted_at FROM nodes WHERE id=?').get(String(row.parent_id)):null;
      const parentId=row.parent_id
        ?(parent&&!parent.deleted_at?String(row.parent_id):this.repository.ensureDefaultFolder())
        :(String(row.kind)==='folder'?null:this.repository.ensureDefaultFolder());
      this.repository.query('UPDATE nodes SET deleted_at=NULL,parent_id=?,updated_at=? WHERE id=?').run(parentId,now,id);
      this.reenable(id,String(row.kind));
      this.repository.query('UPDATE trash SET restored_at=? WHERE node_id=?').run(at,id);
      return {parentId,title:String(row.title),snapshots:[...snapshots,id]};
    });
    this.removeTrashFiles(snapshots);
    return {parentId,title};
  }
  purge(id:string):void{
    const purged=this.repository.transaction(()=>{
      const row=this.repository.query('SELECT deleted_at FROM nodes WHERE id=?').get(id);
      if(!row?.deleted_at||!this.get(id))throw Error(t('垃圾桶里没有这张卡片。'));
      // 1.121：彻底删除文件夹时，一起删掉的整棵子树也一并清掉，否则子项会留下悬空的 parent_id。
      // 深度倒序（叶子先删）以满足节点之间的外键约束。
      const targets=(this.repository.query(`WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?
           UNION ALL SELECT n.id,depth+1 FROM nodes n JOIN tree t ON n.parent_id=t.id WHERE n.deleted_at IS NOT NULL)
         SELECT id FROM tree ORDER BY depth DESC`).all(id) as Array<{id:string}>).map(item=>String(item.id));
      const ids=JSON.stringify(targets),targetIds='SELECT value FROM json_each(?)';
      // Shared assets and the import source itself may still be used by other cards.
      for(const table of ['review_log','reading_log','study_operations','review_cards','reading_state',
        'anki_review_log','creation_undo','node_tags','external_links']){
        this.repository.query(`DELETE FROM ${table} WHERE node_id IN (${targetIds})`).run(ids);
      }
      this.repository.query(`DELETE FROM deck_settings WHERE folder_id IN (${targetIds})`).run(ids);
      // An extract moved to a different branch keeps its content when its old source is removed.
      this.repository.query(`UPDATE nodes SET source_id=NULL WHERE source_id IN (${targetIds})`).run(ids);
      // 1.184：记录这些卡片引用的附件，节点删完后回收没人再用的附件（文件+记录）
      const hashes=new Set<string>();
      for(const target of targets){
        const row=this.repository.query('SELECT content,answer FROM nodes WHERE id=?').get(target) as {content?:string;answer?:string}|undefined;
        for(const text of [row?.content||'',row?.answer||'']){
          for(const match of text.matchAll(/asset:([a-f0-9]{64})/g))hashes.add(match[1]!);
        }
      }
      for(const target of targets)this.repository.query('DELETE FROM nodes WHERE id=?').run(target);
      this.purgeOrphanAssets(hashes);
      this.repository.query(`UPDATE trash SET purged_at=? WHERE node_id IN (${targetIds})`).run(Date.now(),ids);
      return targets;
    });
    this.removeTrashFiles(purged);
  }
  /** 1.184：删除卡片后，如果没有任何卡片（含垃圾桶里的）再引用该附件，就把附件文件和记录一起删掉。 */
  private purgeOrphanAssets(hashes:Set<string>):void{
    if(!hashes.size)return;
    const assets=join(dirname(this.repository.trashDir),'assets');
    for(const hash of hashes){
      const used=this.repository.query('SELECT 1 FROM nodes WHERE content LIKE ? OR answer LIKE ? LIMIT 1').get('%'+hash+'%','%'+hash+'%');
      if(used)continue;
      const row=this.repository.query('SELECT relative_path AS path FROM assets WHERE id=?').get(hash) as {path?:string}|undefined;
      if(row?.path){try{const file=join(assets,row.path);if(existsSync(file))rmSync(file,{force:true});}catch{}}
      try{this.repository.query('DELETE FROM assets WHERE id=?').run(hash);}catch{}
    }
  }  /** 阶段式清理：返回 {purged, thinned}
   *  1.18：按用户要求取消阶梯式清理——只按保留天数判断：超过天数就永久删除。 */
  cleanup(now=Date.now(),retentionDays=30):{purged:number}{
    const day=86400000,cutoff=now-Math.max(1,retentionDays)*day;
    const expired=this.repository.query(`SELECT t.node_id AS nodeId FROM trash t JOIN nodes n ON n.id=t.node_id
      WHERE n.deleted_at IS NOT NULL AND t.restored_at IS NULL AND t.purged_at IS NULL AND t.deleted_at<=?`).all(cutoff) as Array<{nodeId:string}>;
    let purged=0;
    for(const item of expired){try{this.purge(item.nodeId);purged++;}catch{/* 已不存在则跳过 */}}
    // 磁盘快照按同一保留期清理（防止手工放进来的旧文件长期堆积）
    this.pruneTrashFiles(cutoff);
    return {purged};
  }
}
