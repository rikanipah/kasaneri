import { t } from '../core/i18n';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeAnchor, titleFrom } from '../core/card';
import { studyReady } from '../core/image-occlusion';
import {migrateLibrary} from './migrations';
import {TrashStore} from './trash-store';
import type { Anchor, Asset, ChildrenPage, CreateInput, Material, NodeInput, SaveInput, TreeNode } from '../core/model';

// 1.6：metadata 列加入公共列清单。TreeNode 类型没有 metadata 字段，多出来的值会被忽略；
// Material（getNode）会解析它，见下方 material()。
export const metadataColumns = `n.id, n.parent_id AS parentId, n.folder_id AS folderId,n.priority,n.source_id AS sourceId, n.kind, n.title, n.position, n.metadata,
 EXISTS(SELECT 1 FROM nodes c WHERE c.parent_id=n.id AND c.deleted_at IS NULL) AS hasChildren`;

function material(row: any): Material | null {
  return row ? { ...row, hasChildren: Boolean(row.hasChildren), anchor: row.anchor ? JSON.parse(row.anchor) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : {} } : null;
}

function fingerprint(content: string, answer: string): string {
  return createHash('sha256').update(JSON.stringify([content, answer])).digest('hex');
}

const pushReadySql="CASE WHEN trim(?)!='' OR trim(?)!='' THEN 1 ELSE 0 END";

export class Repository {
  readonly db: DatabaseSync;
  private statements = new Map<string, StatementSync>();

  /** 1.23：垃圾桶文件夹（与数据库所在文件夹同级，默认 <dataDir>/../trash），删除的卡片正文快照落在这里。 */
  readonly trashDir: string;
  private readonly trash:TrashStore;
  constructor(readonly dataDir: string, trashDir?: string) {
    mkdirSync(dataDir, { recursive: true });
    this.trashDir = trashDir || join(dataDir, '..', 'trash');
    this.trash=new TrashStore(this);
    mkdirSync(this.trashDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'library.sqlite'));
    try{migrateLibrary(this);}
    catch(error){
      this.db.close();
      throw error;
    }
  }

  query(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  transaction<T>(fn: () => T): T {
    const nested=this.db.isTransaction;
    this.db.exec(nested?'SAVEPOINT nested_write':'BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec(nested?'RELEASE nested_write':'COMMIT'); return result; }
    catch (error) { this.db.exec(nested?'ROLLBACK TO nested_write; RELEASE nested_write':'ROLLBACK'); throw error; }
  }

  getSetting(key: string): unknown {
    const row = this.query('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.query('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  private insert(node: NodeInput): void {
    const now = new Date().toISOString();
    this.query(`INSERT INTO nodes(id,parent_id,source_id,kind,title,content,answer,anchor,position,metadata,created_at,updated_at,folder_id,priority,study_ready,push_ready)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(node.id,node.parentId,node.sourceId,node.kind,node.title,
      node.content,node.answer,node.anchor ? JSON.stringify(node.anchor) : null,node.position,
      JSON.stringify(node.metadata || {}),now,now,node.folderId||null,node.priority??null,
      studyReady(node.kind,node.content,node.answer),node.content.trim()||node.answer.trim()?1:0);
  }

  ensureDefaultFolder(exclude?:string):string {
    const id=exclude==='folder:unfiled'?'folder:recovered':'folder:unfiled';
    // 1.119：默认文件夹固定叫「默认」，并用极小 position 保证排在所有文件夹最上面；
    // 冲突时连 title/position 一起更新，旧库里的「未归类」会被改名并置顶。
    const stored=this.getSetting('studySettings') as {defaultFolderName?:string}|null;
    const title=id==='folder:unfiled'?(String(stored?.defaultFolderName||t('默认')).trim()||t('默认')):t('保留的卡片');
    const position=id==='folder:unfiled'?-999999:0;
    this.query(`INSERT INTO nodes(id,parent_id,source_id,kind,title,position,created_at,updated_at)
      VALUES(?,NULL,NULL,'folder',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET deleted_at=NULL,parent_id=NULL,position=excluded.position,
        title=CASE WHEN trim(nodes.title)='' OR nodes.title='未归类' THEN excluded.title ELSE nodes.title END`)
      .run(id,title,position,new Date().toISOString(),new Date().toISOString());
    return id;
  }

  /** 1.204：设置里改了默认文件夹名称时，立即重命名现有的默认文件夹。 */
  renameDefaultFolder(name:string):void{
    const title=String(name||'').trim()||t('默认');
    this.query("UPDATE nodes SET title=?,updated_at=? WHERE id='folder:unfiled'").run(title,new Date().toISOString());
  }

  importData(nodes: NodeInput[], origin: string): number {
    return this.transaction(() => {
      if (this.getSetting('importComplete')) return 0;
      const normalized=nodes.map(node=>({...node})),byId=new Map(normalized.map(node=>[node.id,node]));
      for(const node of normalized){
        if(node.kind==='folder'){
          if(node.parentId){const parent=byId.get(node.parentId)||this.getNode(node.parentId);if(parent?.kind!=='folder')throw Error(t('子文件夹缺少上级文件夹。'));}
          node.folderId=null;continue;
        }
        if(!node.parentId||(!byId.has(node.parentId)&&!this.getNode(node.parentId)))node.parentId=this.ensureDefaultFolder();
      }
      const folders=new Map<string,string>();
      for(const folder of normalized.filter(node=>node.kind==='folder')){
        const seen=new Set<string>();let cursor:NodeInput|Material|undefined|null=folder;
        while(cursor){if(seen.has(cursor.id))throw Error(t('导入目录包含循环关系。'));seen.add(cursor.id);cursor=cursor.parentId?(byId.get(cursor.parentId)||this.getNode(cursor.parentId)):null;}
      }
      for(const node of normalized){
        if(node.kind==='folder')continue;
        let cursor:NodeInput|Material|undefined|null=node;
        const chain:string[]=[],seen=new Set<string>();
        let folder:string|undefined;
        while(cursor){
          if(cursor.kind==='folder'){folder=cursor.id;break;}
          if(folders.has(cursor.id)){folder=folders.get(cursor.id);break;}
          if(seen.has(cursor.id))throw Error(t('导入目录包含循环关系。'));
          seen.add(cursor.id);chain.push(cursor.id);
          cursor=cursor.parentId?(byId.get(cursor.parentId)||this.getNode(cursor.parentId)):null;
        }
        if(!folder)throw Error(t('导入卡片缺少文件夹。'));
        for(const id of chain)folders.set(id,folder);
        node.folderId=folder;
      }
      const insertedFolders=new Set<string>();
      for(const node of normalized.filter(item=>item.kind==='folder')){
        const chain:NodeInput[]=[];let cursor:NodeInput|undefined=node;
        while(cursor&&!insertedFolders.has(cursor.id)){chain.push(cursor);cursor=cursor.parentId?byId.get(cursor.parentId):undefined;}
        for(const folder of chain.reverse()){this.insert(folder);insertedFolders.add(folder.id);}
      }
      for(const node of normalized)if(node.kind!=='folder')this.insert(node);
      this.setSetting('importComplete', { origin, count: nodes.length, at: new Date().toISOString() });
      this.setSetting('studySeededV3',false);
      return nodes.length;
    });
  }

  children(input: { parentId?: string | null; cursor?: {position:number;id:string} | null; limit?: number }): ChildrenPage {
    const parentId = input.parentId || null;
    const limit = Math.max(1,Math.min(250,input.limit || 150));
    const cursor = input.cursor;
    const predicate = cursor ? 'AND (n.position>? OR (n.position=? AND n.id>?))' : '';
    const args: any[] = [parentId];
    if (cursor) args.push(cursor.position,cursor.position,cursor.id);
    args.push(limit+1);
    const rows = this.query(`SELECT ${metadataColumns} FROM nodes n
      WHERE n.parent_id IS ? AND n.deleted_at IS NULL ${predicate} ORDER BY n.position,n.id LIMIT ?`).all(...args);
    const more = rows.length > limit;
    const items = rows.slice(0,limit).map(row => ({ ...row,hasChildren:Boolean(row.hasChildren) })) as unknown as TreeNode[];
    const last = items.at(-1);
    return {items,cursor:more && last ? {position:last.position,id:last.id} : null};
  }

  getNode(id: string, includeDeleted=false): Material | null {
    return material(this.query(`SELECT ${metadataColumns},n.content,n.answer,n.anchor,n.revision
      FROM nodes n WHERE n.id=?${includeDeleted?'':' AND n.deleted_at IS NULL'}`).get(id));
  }

  path(id: string): TreeNode[] {
    const rows: TreeNode[] = [];
    const seen = new Set<string>();
    const read=(key:string)=>this.query(`SELECT ${metadataColumns} FROM nodes n
      WHERE n.id=? AND n.deleted_at IS NULL`).get(key) as unknown as TreeNode|undefined;
    for(let node=read(id);node;node=node.parentId ? read(node.parentId) : undefined) {
      if (seen.has(node.id)) throw Error(t('目录包含循环关系。'));
      seen.add(node.id);
      rows.unshift({...node,hasChildren:Boolean(node.hasChildren)});
    }
    return rows;
  }

  anchors(id: string): {id:string;anchor:Anchor}[] {
    return this.query("SELECT id,anchor,kind FROM nodes WHERE source_id=? AND anchor IS NOT NULL AND deleted_at IS NULL")
      .all(id).map(row=>{const anchor=JSON.parse(String(row.anchor));
    // 1.60：把来源节点 id 一起给渲染层，供 Ctrl+点击高亮跳转
    return {id:String(row.id),anchor:{...anchor,nodeId:String(row.id),highlight:anchor.highlight||(row.kind==='cloze'?'cloze':'extract')}};});
  }

  save(input: SaveInput): {revision:number} {
    const {content,answer}=input;
    if(typeof content!=='string' || typeof answer!=='string') throw Error(t('无效正文。'));
    const result = this.query(`UPDATE nodes SET content=?,answer=?,revision=revision+1,updated_at=?,
      study_ready=CASE WHEN kind='cloze' THEN ? ELSE ? END,push_ready=${pushReadySql}
      WHERE id=? AND revision=? AND kind!='folder' AND deleted_at IS NULL`)
      .run(content,answer,new Date().toISOString(),studyReady('cloze',content,answer),studyReady('topic',content,answer),
        content,answer,input.id,input.revision);
    if(!result.changes) throw Error(t('这篇卡片已在其他位置修改。当前编辑仍在窗口里，请复制内容后重新打开。'));
    return {revision:input.revision+1};
  }

  // The caller validates placement and records the applied version in the same transaction.
  writeSyncedNode(node:NodeInput, current:Material|null, restore=false):void {
    if(!current){
      this.insert(node);
      if(node.kind!=='folder')this.setSetting('studySeededV3',false);
      return;
    }
    const {content,answer}=node;
    const changed=this.query(`UPDATE nodes SET kind=?,parent_id=?,source_id=?,title=?,content=?,answer=?,anchor=?,
      position=?,priority=?,revision=revision+1,updated_at=?,deleted_at=NULL,study_ready=?,push_ready=${pushReadySql}
      WHERE id=? AND kind=? AND revision=? AND deleted_at IS ${restore?'NOT ':''}NULL`).run(
      node.kind,node.parentId,node.sourceId,node.title,content,answer,node.anchor?JSON.stringify(node.anchor):null,
      node.position,node.priority??null,new Date().toISOString(),studyReady(node.kind,content,answer),content,answer,
      node.id,current.kind,current.revision);
    if(!changed.changes)throw Error(t('卡片已变更，请重新检查同步版本。'));
    const folderId=node.folderId??null;
    if(current.kind!=='folder'&&current.folderId!==folderId)this.updateBranchFolder(node.id,folderId);
    if(current.kind!==node.kind){
      this.resetStudyForKindChange(node.id);
      this.setSetting('studySeededV3',false);
    }
    if(restore)this.query('UPDATE trash SET restored_at=? WHERE node_id=? AND purged_at IS NULL').run(Date.now(),node.id);
  }

  resetStudyForKindChange(id:string):void {
    this.query('UPDATE review_cards SET enabled=0,revision=revision+1 WHERE node_id=?').run(id);
    this.query('UPDATE reading_state SET enabled=1,revision=revision+1 WHERE node_id=?').run(id);
  }

  // 1.6 ⑦：按卡片读写 metadata（浅合并）。
  // 目前唯一的用途是启动配置 metadata.launch={command,args?,cwd?}（见 renderer/app.ts 右键菜单）。
  // 校验放在 worker 调用方；这里只做 JSON 合并与更新，保证不误伤其他字段。
  setNodeMetadata(id:string, patch:Record<string,unknown>):Material|null {
    const node=this.getNode(id);if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    const merged={...(node.metadata||{}),...patch};
    this.query('UPDATE nodes SET metadata=?,updated_at=? WHERE id=? AND deleted_at IS NULL')
      .run(JSON.stringify(merged),new Date().toISOString(),id);
    return this.getNode(id);
  }

  create(input: CreateInput, onCreated?:(node:Material)=>void): {node:Material;undoable:boolean} {
    if(!['folder','topic','material','cloze'].includes(input.kind)) throw Error(t('类型无效。'));
    return this.transaction(()=>{
      const parent = input.parentId ? this.getNode(input.parentId) : null;
      if(input.parentId && !parent) throw Error(t('父级已删除。'));
      if(input.kind!=='folder'&&!parent)throw Error(t('请先在文件夹内新建主题或卡片。'));
      if(input.kind==='folder'&&parent&&parent.kind!=='folder')throw Error(t('子文件夹只能建立在文件夹内。'));
      let content='',answer='',anchor:Anchor|null=null,sourceId:string|null=null;
      const excerpt = input.kind==='material' || input.kind==='cloze';
      if(excerpt && input.from !== undefined && input.to !== undefined && input.to>input.from) {
        if(!parent || parent.kind==='folder' || parent.revision!==input.revision) throw Error(t('来源正文已改变，请重新选择。'));
        const section=input.section || 'question';
        const source=section==='answer'?parent.answer:parent.content;
        const from=input.from,to=input.to;
        if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to>source.length)throw Error(t('选区无效。'));
        const selected=source.slice(from,to);
        if(!selected.trim())throw Error(t('选区为空。'));
        anchor={...makeAnchor(source,from,to,parent.kind==='cloze'||section==='answer'?section:undefined),highlight:input.kind==='cloze'?'cloze':'extract'};
        sourceId=parent.id;
        if(input.kind==='cloze'){content=source.slice(0,from)+'[...]'+source.slice(to);answer=selected;}
        else content=selected;
      }
      // 1.133：独立「添加卡片」窗口直接给正文/答案（不经过摘录选区）
      if(input.content!==undefined)content=input.content;
      if(input.answer!==undefined)answer=input.answer;
      // 1.168：没有显式标题时——检测卡按答案命名；提取/主题按正文（选区）自动命名。
      // 选区里只有图片/音频这类附件标记时，退回到"未命名提取/未命名检测卡"。
      const plain=content.replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[[^\]]*asset:[^\]]*\]/g,' ');
      const fromText=titleFrom(plain);
      const fallback=input.kind==='material'?t('未命名提取'):input.kind==='cloze'?t('未命名检测卡'):t('未命名主题');
      const title=input.title?.trim() || (input.kind==='cloze'?(answer?t('检测 · {0}',titleFrom(answer)):fallback):(fromText===t('未命名')?fallback:fromText));
      const node=this.insertNew({parentId:parent?.id||null,sourceId,kind:input.kind,title,
        content,answer,anchor,folderId:input.kind==='folder'?null:parent!.kind==='folder'?parent!.id:parent!.folderId});
      onCreated?.(node);
      return {node,undoable:true};
    });
  }

  createImageOcclusionCard(source:Material,title:string,content:string,anchor:Anchor):Material {
    return this.insertNew({parentId:source.id,sourceId:source.id,kind:'cloze',title,content,answer:'',anchor,folderId:source.folderId});
  }

  private insertNew(input:Omit<NodeInput,'id'|'position'>):Material {
    const id=String(Date.now())+randomBytes(5).readUIntBE(0,5).toString().padStart(13,'0');
    const position=Number(this.query('SELECT COALESCE(MAX(position),0)+1 AS next FROM nodes').get()!.next);
    this.insert({...input,id,position});
    if(input.kind!=='folder')this.setSetting('studySeededV3',false);
    this.query('INSERT INTO creation_undo VALUES(?,?,?,?,NULL)')
      .run(id,input.parentId,fingerprint(input.content,input.answer),input.anchor?JSON.stringify(input.anchor):null);
    return this.getNode(id)!;
  }

  rename(id: string,title:string): void {
    if(!title?.trim())throw Error(t('名称不能为空。'));
    if(!this.query('UPDATE nodes SET title=?,updated_at=? WHERE id=? AND deleted_at IS NULL')
      .run(title.trim(),new Date().toISOString(),id).changes)throw Error(t('项目已删除。'));
  }

  move(id:string,parentId:string|null,restore?:{expectedParentId:string|null}):void {
    this.transaction(()=>{
      const node=this.getNode(id),target=parentId?this.getNode(parentId):null;
      // 1.72：任何卡片都可以移动（此前只允许 folder/topic，导致提取与检测卡"移至…"直接报错）
      if(!node||(!target&&parentId))throw Error(t('目标位置不存在。'));
      if(restore&&node.parentId!==restore.expectedParentId)throw Error(t('卡片位置已变化，无法撤销这次移动。'));
      if(target&&target.kind!=='folder'&&(!restore||node.kind==='folder'))throw Error(t('只能移动到文件夹里。'));
      if(id===parentId||parentId&&this.path(parentId).some(ancestor=>ancestor.id===id))throw Error(t('无法移动到自身或自己的下级。'));
      this.query('UPDATE nodes SET parent_id=?,updated_at=? WHERE id=?').run(parentId,new Date().toISOString(),id);
      if(node.kind!=='folder')this.updateBranchFolder(id,target?.kind==='folder'?target.id:target?.folderId??null);
    });
  }

  private updateBranchFolder(id:string,folderId:string|null):void {
    this.query(`WITH RECURSIVE branch(id) AS(SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN branch b ON n.parent_id=b.id)
      UPDATE nodes SET folder_id=? WHERE id IN(SELECT id FROM branch)`).run(id,folderId);
  }

  removeSyncedNode(node:Material):void{this.trash.removeSyncedNode(node);}
  remove(id:string){return this.trash.remove(id);}

  undoCreation(id:string): {parentId:string|null;anchor:Anchor|null} {
    return this.transaction(()=>{
      const node=this.getNode(id);
      const operation=this.query('SELECT * FROM creation_undo WHERE node_id=? AND undone_at IS NULL').get(id);
      if(!node||!operation)throw Error(t('这张卡片的创建操作已撤销。'));
      if(this.query('SELECT 1 FROM review_log WHERE node_id=? AND undone_at IS NULL LIMIT 1').get(id)
        ||this.query('SELECT 1 FROM reading_log WHERE node_id=? AND undone_at IS NULL LIMIT 1').get(id))throw Error(t('卡片已有复习记录，请使用删除卡片。'));
      if(fingerprint(node.content,node.answer)!==operation.fingerprint)throw Error(t('请先撤销正文编辑。'));
      if(node.hasChildren)throw Error(t('卡片已有下级，请先处理下级卡片。'));
      const now=new Date().toISOString();
      this.query('UPDATE nodes SET deleted_at=? WHERE id=?').run(now,id);
      this.query('UPDATE creation_undo SET undone_at=? WHERE node_id=?').run(now,id);
      this.query('UPDATE review_cards SET enabled=0 WHERE node_id=?').run(id);
      this.query('UPDATE reading_state SET enabled=0 WHERE node_id=?').run(id);
      return {parentId:operation.parent_id===null?null:String(operation.parent_id),anchor:operation.anchor?JSON.parse(String(operation.anchor)):null};
    });
  }

  trashGet(id:string){return this.trash.get(id);}
  trashList(limit?:number){return this.trash.list(limit);}
  trashRestore(id:string){return this.trash.restore(id);}
  trashPurge(id:string):void{this.trash.purge(id);}
  trashCleanup(now?:number,retentionDays?:number){return this.trash.cleanup(now,retentionDays);}

  search(query:string): TreeNode[] {    const terms=query.trim().split(/\s+/u).filter(term=>/[\p{L}\p{N}_]/u.test(term));
    if(!terms.length)return [];
    const expression=terms.map(term=>'"'+term.replace(/"/g,'""')+'"*').join(' AND ');
    return this.query(`SELECT ${metadataColumns} FROM nodes_fts f JOIN nodes n ON n.rowid=f.rowid
      WHERE nodes_fts MATCH ? AND n.deleted_at IS NULL AND n.kind!='folder' ORDER BY rank LIMIT 40`)
      .all(expression).map(row=>({...row,hasChildren:Boolean(row.hasChildren)})) as unknown as TreeNode[];
  }

  folders():Array<{id:string;title:string;parentId:string|null}> {
    return this.query("SELECT id,title,parent_id AS parentId FROM nodes WHERE kind='folder' AND deleted_at IS NULL ORDER BY position,id").all() as any;
  }

  registerAsset(asset:Asset):void {
    this.query('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?)')
      .run(asset.id,asset.filename,asset.mime,asset.size,asset.relativePath);
  }

  getAsset(id:string):Asset|null {
    return this.query('SELECT id,filename,mime,size,relative_path AS relativePath FROM assets WHERE id=?').get(id) as unknown as Asset|null;
  }

  // ===== 1.207：附件管理（未引用附件进回收站，可恢复/彻底删除） =====
  private assetTrashManifest(){return join(this.trashDir,'assets','manifest.json');}
  private readAssetTrash():Array<Asset&{trashedAt:number;trashName:string}>{
    try{const value=JSON.parse(readFileSync(this.assetTrashManifest(),'utf8'));return Array.isArray(value)?value:[];}catch{return [];}
  }
  private writeAssetTrash(entries:Array<Asset&{trashedAt:number;trashName:string}>){
    const folder=join(this.trashDir,'assets');mkdirSync(folder,{recursive:true});
    const temporary=this.assetTrashManifest()+'.tmp';
    writeFileSync(temporary,JSON.stringify(entries,null,2),'utf8');renameSync(temporary,this.assetTrashManifest());
  }
  private assetFile(relativePath:string){return join(this.dataDir,'assets',relativePath);}
  assetUsage(limit=200){
    const totals=this.query('SELECT count(*) n,COALESCE(SUM(size),0) bytes FROM assets').get()!;
    const unused=this.unusedAssets(limit);
    return {count:Number(totals.n),bytes:Number(totals.bytes),unused:unused.total,unusedBytes:unused.bytes,
      items:unused.items,trashed:this.readAssetTrash().length};
  }
  unusedAssets(limit=200){
    const rows=this.query(`SELECT a.id,a.filename,a.mime,a.size,a.relative_path AS relativePath FROM assets a
      WHERE NOT EXISTS(SELECT 1 FROM nodes n WHERE instr(n.content,'[[asset:'||a.id)>0 OR instr(n.answer,'[[asset:'||a.id)>0)
      ORDER BY a.size DESC,a.filename LIMIT ?`).all(limit) as unknown as Asset[];
    const totals=this.query(`SELECT count(*) n,COALESCE(SUM(size),0) bytes FROM assets a
      WHERE NOT EXISTS(SELECT 1 FROM nodes n WHERE instr(n.content,'[[asset:'||a.id)>0 OR instr(n.answer,'[[asset:'||a.id)>0)`).get()!;
    return {total:Number(totals.n),bytes:Number(totals.bytes),items:rows};
  }
  trashUnusedAssets(){
    const {items}=this.unusedAssets(10000),entries=this.readAssetTrash();let moved=0,bytes=0,missing=0;
    for(const asset of items){
      const source=this.assetFile(asset.relativePath);if(!existsSync(source)){missing++;continue;}
      const trashName=asset.id+'-'+basename(asset.relativePath),target=join(this.trashDir,'assets',trashName);
      mkdirSync(join(this.trashDir,'assets'),{recursive:true});
      try{renameSync(source,target);}catch{copyFileSync(source,target);unlinkSync(source);}
      entries.push({...asset,trashedAt:Date.now(),trashName});
      this.query('DELETE FROM assets WHERE id=?').run(asset.id);
      moved++;bytes+=asset.size;
    }
    if(moved)this.writeAssetTrash(entries);
    return {moved,bytes,missing};
  }
  trashedAssets(){return this.readAssetTrash().map(({id,filename,mime,size,trashedAt})=>({id,filename,mime,size,trashedAt}));}
  restoreAsset(id:string){
    const entries=this.readAssetTrash(),index=entries.findIndex(entry=>entry.id===id);
    if(index<0)throw Error(t('回收站里没有这个附件。'));
    const entry=entries[index]!,source=join(this.trashDir,'assets',entry.trashName),target=this.assetFile(entry.relativePath);
    if(!existsSync(source))throw Error(t('回收站里的附件文件已丢失。'));
    mkdirSync(join(this.dataDir,'assets'),{recursive:true});
    try{renameSync(source,target);}catch{copyFileSync(source,target);unlinkSync(source);}
    this.registerAsset({id:entry.id,filename:entry.filename,mime:entry.mime,size:entry.size,relativePath:entry.relativePath});
    entries.splice(index,1);this.writeAssetTrash(entries);
    return true;
  }
  purgeTrashedAsset(id:string){
    const entries=this.readAssetTrash(),index=entries.findIndex(entry=>entry.id===id);
    if(index<0)throw Error(t('回收站里没有这个附件。'));
    const file=join(this.trashDir,'assets',entries[index]!.trashName);
    if(existsSync(file))unlinkSync(file);
    entries.splice(index,1);this.writeAssetTrash(entries);
    return true;
  }
  info():Record<string,unknown> {
    return {count:this.query('SELECT count(*) AS n FROM nodes WHERE deleted_at IS NULL').get()!.n,
      import:this.getSetting('importComplete'),schemaVersion:Number(this.query('PRAGMA user_version').get()!.user_version)};
  }

  close():void { this.db.close(); }
}
