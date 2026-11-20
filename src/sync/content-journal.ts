import { t } from '../core/i18n';
import type { Anchor, NodeKind } from '../core/model';
import type { Repository } from '../data/database';
import { projectStoredDocuments,type StoredDocuments } from '../content/document';
import { localContentAsset } from './content-assets';
import { chooseContentVersion, CONTENT_BATCH_SIZE, inspectContentVersions, isVersionId, makeContentVersion,
  mergeContentVersions, validateContentVersion, type CardContent, type ContentVersion } from './content-versions';

type StoredVersion={version_id:string;node_id:string;parents:string;value:string;created_at:number};
type ContentRow=StoredDocuments&{
  kind:NodeKind;parent_id:string|null;source_id:string|null;title:string;
  anchor:string|null;position:number;priority:number|null;deleted_at:string|null;
};
type ApplyContentResult=
  |{status:'empty'}
  |{status:'applied'|'current';versionId:string;merged?:boolean}
  |{status:'conflict';versionIds:string[]}
  |{status:'pending';reason:'history'|'attachment'|'parent'|'source'|'children'|'cycle';ids:string[]}
  |{status:'pending';reason:'structure'|'deletion'|'restore'|'invalid-text'|'editing'};

function fromRow(row:StoredVersion):ContentVersion{
  return {id:row.version_id,nodeId:row.node_id,parents:JSON.parse(row.parents),value:JSON.parse(row.value),
    createdAt:Number(row.created_at)||undefined};
}

const watchedColumns=['kind','parent_id','source_id','title','content','answer','content_objects','answer_objects','anchor','position','priority','deleted_at'];
function versionIdBatch(ids:readonly string[]):string{
  if(!Array.isArray(ids)||ids.length>CONTENT_BATCH_SIZE||!ids.every(isVersionId)){
    throw Error(t('卡片版本编号批次无效。'));
  }
  return JSON.stringify([...new Set(ids)]);
}

// 同步表已搬进 schema 12 迁移（src/data/migrations/migrate-content-sync.ts），这里只做读写。
export class ContentJournal {
  constructor(private repository:Repository){}

  private insert(version:ContentVersion){
    return Boolean(this.repository.query('INSERT OR IGNORE INTO sync_content_versions(version_id,node_id,parents,value,created_at) VALUES(?,?,?,?,?)')
      .run(version.id,version.nodeId,JSON.stringify(version.parents),JSON.stringify(version.value),
        version.createdAt??Date.now()).changes);
  }

  private queue(nodeId:string){
    this.repository.query('INSERT OR IGNORE INTO sync_content_pending VALUES(?)').run(nodeId);
  }

  private localVersion(nodeId:string):ContentVersion|null{
    const row=this.repository.query(`SELECT v.* FROM sync_content_local l
      JOIN sync_content_versions v ON v.version_id=l.version_id WHERE l.node_id=?`).get(nodeId) as StoredVersion|undefined;
    return row?fromRow(row):null;
  }

  // Anki 的 usn=-1：本机内容版本和对端已确认的版本不一致，就是「有未同步的本地改动」。
  // applied_version_id 只有在对端版本写回、用户选定版本、或本轮把本机版本推给对端后才更新，所以重试时仍然成立。
  private isDirty(nodeId:string):boolean{
    const row=this.repository.query('SELECT version_id,applied_version_id FROM sync_content_local WHERE node_id=?')
      .get(nodeId) as {version_id:string;applied_version_id:string|null}|undefined;
    return Boolean(row&&row.applied_version_id!==row.version_id);
  }

  private setLocalVersion(version:ContentVersion,applied:boolean){
    this.repository.query(`INSERT INTO sync_content_local(node_id,version_id,applied_version_id) VALUES(?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET version_id=excluded.version_id,applied_version_id=excluded.applied_version_id`)
      .run(version.nodeId,version.id,applied?version.id:null);
    this.repository.query('DELETE FROM sync_content_dirty WHERE node_id=?').run(version.nodeId);
  }

  private captureIfDirty(nodeId:string):ContentVersion|null{
    return this.repository.query('SELECT 1 FROM sync_content_dirty WHERE node_id=?').get(nodeId)?this.capture(nodeId,false):null;
  }

  private capture(nodeId:string,published:boolean):ContentVersion|null{
    const db=this.repository;
    const row=db.query('SELECT '+watchedColumns.join(',')+' FROM nodes WHERE id=?').get(nodeId) as ContentRow|undefined;
    const value:CardContent|null=row&&!row.deleted_at?{
      kind:row.kind,parentId:row.parent_id,sourceId:row.source_id,title:row.title,...projectStoredDocuments(row),
      anchor:row.anchor?JSON.parse(row.anchor) as Anchor:null,position:row.position,priority:row.priority,
    }:null;
    const before=this.localVersion(nodeId);
    if(before&&makeContentVersion(nodeId,before.parents,value).id===before.id){
      db.query('DELETE FROM sync_content_dirty WHERE node_id=?').run(nodeId);
      // 推送路径：内容已经和本机版本一致，等于对端确认过了。
      if(published)db.query('UPDATE sync_content_local SET applied_version_id=? WHERE node_id=?').run(before.id,nodeId);
      return null;
    }
    const version=makeContentVersion(nodeId,before?[before.id]:[],value,Date.now());
    this.insert(version);
    // 第一次记录到的版本是两边共同的基线，视为已确认；之后要等推送/写回确认。
    this.setLocalVersion(version,published||!before);
    return version;
  }

  /** 补齐所有尚未写入内容版本表的存活卡片（用于首次全量内容同步或手动触发全量检查）。 */
  enqueueUntracked():number{
    return this.repository.transaction(()=>{
      return Number(this.repository.query(`
        INSERT OR IGNORE INTO sync_content_dirty(node_id)
        SELECT n.id FROM nodes n
        LEFT JOIN sync_content_local l ON l.node_id=n.id
        WHERE n.deleted_at IS NULL AND l.node_id IS NULL
      `).run().changes)||0;
    });
  }

  /** 将所有存活卡片重新入队核对并立即捕获成内容版本（已有相同内容版本的节点会幂等跳过）。 */
  prepareFullSync():{queued:number;captured:number}{
    const queued=this.repository.transaction(()=>Number(this.repository.query(`
      INSERT OR IGNORE INTO sync_content_dirty(node_id)
      SELECT id FROM nodes WHERE deleted_at IS NULL
    `).run().changes)||0);
    let captured=0;
    while(this.repository.query('SELECT 1 FROM sync_content_dirty LIMIT 1').get()){
      captured+=this.captureDirty().length;
    }
    return {queued,captured};
  }

  captureDirty(limit=500):ContentVersion[]{
    return this.repository.transaction(()=>{
      const changed:ContentVersion[]=[];
      for(const row of this.repository.query('SELECT node_id FROM sync_content_dirty ORDER BY node_id LIMIT ?').all(limit)){
        const version=this.capture(String(row.node_id),true);
        if(version)changed.push(version);
      }
      return changed;
    });
  }

  receive(versions:readonly ContentVersion[]){
    this.repository.transaction(()=>{
      for(const version of versions){
        validateContentVersion(version);
        const expected=makeContentVersion(version.nodeId,version.parents,version.value,version.createdAt);
        if(expected.id!==version.id)throw Error(t('卡片版本与校验值不一致。'));
        if(this.insert(expected))this.queue(expected.nodeId);
      }
    });
  }

  listVersionIds(after:string|null=null,limit=CONTENT_BATCH_SIZE):{ids:string[];nextAfter:string|null}{
    if((after!==null&&!isVersionId(after))||
        !Number.isInteger(limit)||limit<1||limit>CONTENT_BATCH_SIZE)throw Error(t('卡片版本分页参数无效。'));
    const rows=this.repository.query('SELECT version_id FROM sync_content_versions WHERE version_id>? ORDER BY version_id LIMIT ?')
      .all(after??'',limit+1);
    const ids=rows.slice(0,limit).map(row=>String(row.version_id));
    return {ids,nextAfter:rows.length>limit?ids[ids.length-1]:null};
  }

  missingVersionIds(ids:readonly string[]):string[]{
    return this.repository.query(`SELECT requested.value AS id FROM json_each(?) requested
      LEFT JOIN sync_content_versions v ON v.version_id=requested.value
      WHERE v.version_id IS NULL ORDER BY requested.key`).all(versionIdBatch(ids)).map(row=>String(row.id));
  }

  readVersions(ids:readonly string[]):ContentVersion[]{
    return (this.repository.query(`SELECT v.* FROM json_each(?) requested
      JOIN sync_content_versions v ON v.version_id=requested.value ORDER BY requested.key`)
      .all(versionIdBatch(ids)) as StoredVersion[]).map(fromRow);
  }

  private versions(nodeId:string):ContentVersion[]{
    return (this.repository.query('SELECT * FROM sync_content_versions WHERE node_id=?').all(nodeId) as StoredVersion[]).map(fromRow);
  }

  inspect(nodeId:string){
    return inspectContentVersions(nodeId,this.versions(nodeId));
  }

  listConflicts(){
    const rows=this.repository.query('SELECT node_id FROM sync_content_pending ORDER BY node_id').all();
    return rows.flatMap(row=>{
      const nodeId=String(row.node_id);
      const {heads,missing}=this.inspect(nodeId);
      if(missing.length||heads.length<2)return [];
      return [{kind:'content' as const,nodeId,localVersionId:this.localVersion(nodeId)?.id??null,versions:heads}];
    });
  }

  choose(nodeId:string,expectedHeads:readonly string[],choice:string){
    return this.repository.transaction(()=>{
      this.captureIfDirty(nodeId);
      const version=chooseContentVersion(nodeId,this.versions(nodeId),expectedHeads,choice);
      this.insert(version);
      this.queue(nodeId);
      return version;
    });
  }

  /** 冲突处理时「删除卡片」——生成一个删除版本，父版本取当前所有分叉头。
   *  这样两边都会收敛到删除，冲突记录也能清掉；卡片本身按正常删除进垃圾桶（可恢复）。 */
  discard(nodeId:string):ApplyContentResult{
    return this.repository.transaction(()=>{
      this.captureIfDirty(nodeId);
      const {heads,missing}=this.inspect(nodeId);
      if(missing.length)return {status:'pending',reason:'history',ids:missing};
      if(!heads.length)return {status:'empty'};
      const current=this.repository.getNode(nodeId);
      // 默认文件夹和还有子卡片的节点不能这样删（交给正常删除流程/先处理子卡片）。
      if(nodeId==='folder:unfiled'||current?.hasChildren)return {status:'pending',reason:'children',ids:[]};
      this.insert(makeContentVersion(nodeId,heads.map(head=>head.id),null,Date.now()));
      return this.apply(nodeId);
    });
  }

  private missingAttachments(content:string,answer:string):string[]{
    const ids=new Set([...content.matchAll(/\[\[asset:([a-f0-9]{64})(?=\||\]\])/gu),
      ...answer.matchAll(/\[\[asset:([a-f0-9]{64})(?=\||\]\])/gu)].map(match=>match[1]));
    return [...ids].filter(id=>!localContentAsset(this.repository,id)).sort();
  }

  apply(nodeId:string,editing=false):ApplyContentResult{
    return this.repository.transaction(()=>{
      const result=this.applyVersion(nodeId,editing);
      if(result.status==='applied'||result.status==='current'||result.status==='empty'){
        this.repository.query('DELETE FROM sync_content_pending WHERE node_id=?').run(nodeId);
      }
      return result;
    });
  }

  applyPending(protectedIds:ReadonlySet<string>=new Set()):Array<{nodeId:string;result:ApplyContentResult}>{
    const queue=this.repository.query('SELECT node_id FROM sync_content_pending ORDER BY node_id').all()
      .map(row=>String(row.node_id));
    const results=new Map<string,ApplyContentResult>();
    const waiting=new Map<string,Set<string>>();
    const queued=new Set(queue);
    for(let index=0;index<queue.length;index++){
      const nodeId=queue[index];
      queued.delete(nodeId);
      const result=this.apply(nodeId,protectedIds.has(nodeId));
      results.set(nodeId,result);
      if(result.status==='pending'&&(result.reason==='parent'||result.reason==='source'||result.reason==='children')){
        for(const id of result.ids){
          const dependents=waiting.get(id)??new Set<string>();
          dependents.add(nodeId);
          waiting.set(id,dependents);
        }
      }else if(result.status==='applied'){
        for(const dependent of waiting.get(nodeId)??[]){
          if(queued.has(dependent))continue;
          queued.add(dependent);queue.push(dependent);
        }
        waiting.delete(nodeId);
      }
    }
    return [...results].map(([nodeId,result])=>({nodeId,result}));
  }

  private applyVersion(nodeId:string,editing:boolean):ApplyContentResult{
    this.captureIfDirty(nodeId);
    // Anki 的 usn=-1：本机内容版本和对端已确认的版本不一致（再点一次同步仍然成立，不会被清掉）。
    const localDirty=this.isDirty(nodeId);
    const {heads,missing}=this.inspect(nodeId);
    if(missing.length)return {status:'pending',reason:'history',ids:missing};
    if(!heads.length)return {status:'empty'};

    let head=heads[0];
    let merged=false;
    if(heads.length>1){
      // 只有本机也有未同步改动才算冲突；本机干净时自动合并（两边按同一规则取较新的版本）。
      if(localDirty)return {status:'conflict',versionIds:heads.map(version=>version.id)};
      head=mergeContentVersions(nodeId,heads);
      merged=true;
    }
    const previous=this.localVersion(nodeId);
    if(head.id===previous?.id){
      this.setLocalVersion(head,true);
      return {status:'current',versionId:head.id};
    }
    if(editing)return {status:'pending',reason:'editing'};
    const value=head.value;
    const current=this.repository.getNode(nodeId);
    if(!value){
      if(nodeId==='folder:unfiled')return {status:'pending',reason:'deletion'};
      if(current?.hasChildren){
        const ids=this.repository.query('SELECT id FROM nodes WHERE parent_id=? AND deleted_at IS NULL ORDER BY id')
          .all(nodeId).map(row=>String(row.id));
        return {status:'pending',reason:'children',ids};
      }
      if(current)this.repository.removeSyncedNode(current);
      if(merged)this.insert(head);
      this.setLocalVersion(head,true);
      return {status:'applied',versionId:head.id,...(merged?{merged:true}:{})};
    }
    const stored=current??this.repository.getNode(nodeId,true);
    const restoring=!current&&!!stored;
    if(!stored&&this.repository.query('SELECT 1 FROM trash WHERE node_id=? AND purged_at IS NOT NULL').get(nodeId)){
      return {status:'pending',reason:'restore'};
    }
    if(previous&&makeContentVersion(nodeId,head.parents,previous.value).id===head.id){
      if(merged)this.insert(head);
      this.setLocalVersion(head,true);
      return {status:'applied',versionId:head.id,...(merged?{merged:true}:{})};
    }
    const {kind,parentId,sourceId,title,content,answer,position,priority}=value;
    if(typeof title!=='string'||typeof content!=='string'||typeof answer!=='string'||
        (title!==current?.title&&!title.trim()))return {status:'pending',reason:'invalid-text'};
    if(!['folder','topic','material','cloze'].includes(kind)||(stored&&(stored.kind==='folder')!==(kind==='folder'))||
        !Number.isSafeInteger(position)||(priority!==null&&(!Number.isInteger(priority)||priority<0||priority>9))||
        (parentId!==null&&(typeof parentId!=='string'||!parentId))||
        (sourceId!==null&&(typeof sourceId!=='string'||!sourceId||sourceId===nodeId))){
      return {status:'pending',reason:'structure'};
    }
    let folderId:string|null=null;
    if(parentId!==null){
      const path=this.repository.path(parentId);
      if(path.some(node=>node.id===nodeId))return {status:'pending',reason:'cycle',ids:[parentId]};
      if(!path.length)return {status:'pending',reason:'parent',ids:[parentId]};
      const missingParent=path[0].parentId;
      if(missingParent!==null)return {status:'pending',reason:'parent',ids:[missingParent]};
      if(kind==='folder'&&path.at(-1)?.kind!=='folder')return {status:'pending',reason:'structure'};
      if(kind!=='folder')folderId=path.reverse().find(node=>node.kind==='folder')?.id??null;
    }
    if(kind!=='folder'&&!folderId)return {status:'pending',reason:'structure'};
    if(sourceId!==null&&!this.repository.query('SELECT 1 FROM nodes WHERE id=?').get(sourceId)){
      return {status:'pending',reason:'source',ids:[sourceId]};
    }
    const attachments=this.missingAttachments(content,answer);
    if(attachments.length)return {status:'pending',reason:'attachment',ids:attachments};

    const schedule=restoring&&stored.kind===kind?
      this.repository.query('SELECT review,reading FROM sync_content_deleted_schedule WHERE node_id=?').get(nodeId):null;
    if(merged)this.insert(head);
    this.repository.writeSyncedNode({id:nodeId,...value,folderId},stored,restoring);
    if(typeof schedule?.review==='number'){
      this.repository.query('UPDATE review_cards SET enabled=?,revision=revision+1 WHERE node_id=?').run(schedule.review,nodeId);
    }
    if(typeof schedule?.reading==='number'){
      this.repository.query('UPDATE reading_state SET enabled=?,revision=revision+1 WHERE node_id=?').run(schedule.reading,nodeId);
    }
    this.setLocalVersion(head,true);
    return {status:'applied',versionId:head.id,...(merged?{merged:true}:{})};
  }
}
