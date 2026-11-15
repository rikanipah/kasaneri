import { t } from '../core/i18n';
import type {ChildrenPage,TreeNode} from '../core/model';
import {Repository,metadataColumns} from '../data/database';
export type DirectoryType='topic'|'material'|'cloze';
export class DirectoryProjection {
  private key='';
  constructor(private repository:Repository){}
  invalidate(){this.key='';}
  private prepare(input:unknown):boolean {
    if(!Array.isArray(input)||input.length===0)return false;
    const types=[...new Set(input)];if(types.some(type=>!['topic','material','cloze'].includes(type)))throw Error(t('目录筛选无效。'));
    if(types.length===3)return false;
    const key=types.sort().join(',');if(this.key===key)return true;
    const db=this.repository;db.db.exec(`CREATE TEMP TABLE IF NOT EXISTS directory_projection(id TEXT PRIMARY KEY,parent_id TEXT,position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS directory_projection_parent ON directory_projection(parent_id,position,id);`);
    db.transaction(()=>{
      db.db.exec('DELETE FROM directory_projection');
      db.query("INSERT INTO directory_projection SELECT id,parent_id,position FROM nodes WHERE kind='folder' AND deleted_at IS NULL").run();
      const placeholders=types.map(()=>'?').join(',');
      db.query(`INSERT OR IGNORE INTO directory_projection SELECT id,parent_id,position FROM nodes WHERE kind IN(${placeholders}) AND deleted_at IS NULL`).run(...types);
      const context=types.filter(type=>type==='material'||type==='cloze');
      if(context.length)db.query(`INSERT OR IGNORE INTO directory_projection SELECT p.id,p.parent_id,p.position FROM nodes p JOIN nodes c ON c.parent_id=p.id
        WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND c.kind IN(${context.map(()=>'?').join(',')})`).run(...context);
      db.db.exec(`UPDATE directory_projection AS v SET parent_id=CASE WHEN n.kind='folder' THEN n.parent_id
        WHEN EXISTS(SELECT 1 FROM directory_projection p WHERE p.id=n.parent_id) THEN n.parent_id ELSE n.folder_id END
        FROM nodes n WHERE n.id=v.id;`);
    });
    this.key=key;return true;
  }
  children(input:{parentId?:string|null;cursor?:ChildrenPage['cursor'];limit?:number;types?:DirectoryType[]}={}):ChildrenPage {
    if(!this.prepare(input.types))return this.repository.children(input);
    const limit=Math.max(1,Math.min(250,input.limit||150)),cursor=input.cursor,args:any[]=[input.parentId||null];
    const predicate=cursor?'AND(v.position>? OR(v.position=? AND v.id>?))':'';
    if(cursor)args.push(cursor.position,cursor.position,cursor.id);args.push(limit+1);
    const rows=this.repository.query(`SELECT ${metadataColumns},EXISTS(SELECT 1 FROM directory_projection child WHERE child.parent_id=n.id) AS projectedChildren
      FROM directory_projection v JOIN nodes n ON n.id=v.id WHERE v.parent_id IS ? ${predicate} ORDER BY v.position,v.id LIMIT ?`).all(...args);
    const items=rows.slice(0,limit).map(row=>{const {projectedChildren,...node}=row;return {...node,hasChildren:!!projectedChildren};}) as unknown as TreeNode[];
    const last=items.at(-1);return {items,cursor:rows.length>limit&&last?{position:last.position,id:last.id}:null};
  }
  path(id:string,types?:DirectoryType[]):TreeNode[] {
    if(!this.prepare(types))return this.repository.path(id);
    const node=this.repository.query('SELECT folder_id FROM nodes WHERE id=? AND deleted_at IS NULL').get(id);if(!node)return [];
    let cursor:string|null=this.repository.query('SELECT 1 FROM directory_projection WHERE id=?').get(id)?id:String(node.folder_id||'')||null;
    const result:TreeNode[]=[],seen=new Set<string>();
    while(cursor){
      if(seen.has(cursor))throw Error(t('目录包含循环。'));seen.add(cursor);
      const row=this.repository.query(`SELECT ${metadataColumns},v.parent_id AS projectedParent,
        EXISTS(SELECT 1 FROM directory_projection child WHERE child.parent_id=n.id) AS projectedChildren
        FROM directory_projection v JOIN nodes n ON n.id=v.id WHERE v.id=?`).get(cursor);
      if(!row)break;const {projectedParent,projectedChildren,...value}=row;result.unshift({...value,hasChildren:!!projectedChildren} as unknown as TreeNode);
      cursor=projectedParent?String(projectedParent):null;
    }
    return result;
  }
}
