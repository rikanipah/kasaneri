import { t } from '../core/i18n';
import type {CardRelation,CardRelationCandidate,CardRelationKey,MemoryTreeCard,MemoryTreeLink,MemoryTreeSnapshot} from '../core/model';
import type {Repository} from './database';

interface MemoryTreeRow extends MemoryTreeLink {
  type:'card'|'child'|'related';
  ownerId:string|null;
  isRoot:number;
  onPath:number;
}

export class CardRelations {
  constructor(private readonly repository:Repository){}

  list(id:string):CardRelation[]{
    return this.repository.query(`
      SELECT r.parent_id AS parentId,r.child_id AS childId,r.kind,other.title
      FROM card_relations r
      JOIN nodes current ON current.id=? AND current.deleted_at IS NULL AND current.kind<>'folder'
      JOIN nodes other ON other.id=CASE WHEN r.parent_id=current.id THEN r.child_id ELSE r.parent_id END
      WHERE (r.parent_id=current.id OR r.child_id=current.id) AND other.deleted_at IS NULL
      ORDER BY other.title COLLATE NOCASE,other.id
    `).all(id) as unknown as CardRelation[];
  }

  tree(id:string):MemoryTreeSnapshot{
    const rows=this.repository.query(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT id FROM nodes WHERE id=? AND kind<>'folder' AND deleted_at IS NULL
        UNION
        SELECT parent.id FROM ancestors a
        JOIN card_relations r ON r.child_id=a.id AND r.kind='memory'
        JOIN nodes parent ON parent.id=r.parent_id AND parent.deleted_at IS NULL AND parent.kind<>'folder'
      ), roots(id) AS (
        SELECT a.id FROM ancestors a WHERE NOT EXISTS (
          SELECT 1 FROM card_relations r JOIN ancestors parent ON parent.id=r.parent_id
          WHERE r.child_id=a.id AND r.kind='memory'
        )
      ), members(id) AS (
        SELECT id FROM roots
        UNION
        SELECT child.id FROM members parent
        JOIN card_relations r ON r.parent_id=parent.id AND r.kind='memory'
        JOIN nodes child ON child.id=r.child_id AND child.deleted_at IS NULL AND child.kind<>'folder'
      )
      SELECT 'card' AS type,NULL AS ownerId,n.id AS id,n.title AS title,n.kind AS kind,
        roots.id IS NOT NULL AS isRoot,ancestors.id IS NOT NULL AS onPath
      FROM members m JOIN nodes n ON n.id=m.id
      LEFT JOIN roots ON roots.id=m.id LEFT JOIN ancestors ON ancestors.id=m.id
      UNION ALL
      SELECT 'child',parent.id,child.id,child.title,child.kind,0,0 FROM members parent
      JOIN card_relations r ON r.parent_id=parent.id AND r.kind='memory'
      JOIN members included ON included.id=r.child_id JOIN nodes child ON child.id=included.id
      UNION ALL
      SELECT 'related',m.id,other.id,other.title,other.kind,0,0 FROM members m
      JOIN card_relations r ON r.kind='related' AND (r.parent_id=m.id OR r.child_id=m.id)
      JOIN nodes other ON other.id=CASE WHEN r.parent_id=m.id THEN r.child_id ELSE r.parent_id END
        AND other.deleted_at IS NULL AND other.kind<>'folder'
      ORDER BY title COLLATE NOCASE,id
    `).all(id) as unknown as MemoryTreeRow[];
    const cards=new Map<string,MemoryTreeCard>(),roots:string[]=[];
    for(const row of rows){
      if(row.type!=='card')continue;
      cards.set(row.id,{id:row.id,title:row.title,kind:row.kind,onPath:!!row.onPath,children:[],related:[]});
      if(row.isRoot)roots.push(row.id);
    }
    for(const row of rows){
      if(!row.ownerId)continue;
      const owner=cards.get(row.ownerId)!;
      if(row.type==='child')owner.children.push(row.id);
      else owner.related.push({id:row.id,title:row.title,kind:row.kind});
    }
    return {roots,cards:[...cards.values()]};
  }

  createChild(id:string,title:string,kind?:MemoryTreeLink['kind']){
    const parent=this.repository.getNode(id);
    if(!parent||parent.kind==='folder'||!parent.folderId)throw Error(t('卡片或所属文件夹不存在。'));
    if(typeof title!=='string'||!title.trim())throw Error(t('名称不能为空。'));
    // 1.165：记忆子卡直接挂在父卡下面（目录树里像记忆树那样体现归属）；1.205 起主题/提取也支持，子卡沿用父卡类型。
    return this.repository.create({parentId:id,kind:kind??parent.kind,title},node=>{
      this.insert({parentId:id,childId:node.id,kind:'memory'});
    });
  }

  addRelated(id:string,targetId:string):boolean{
    if(typeof id!=='string'||typeof targetId!=='string'||id===targetId)throw Error(t('请选择另一张卡片。'));
    return this.repository.transaction(()=>{
      const card=this.repository.getNode(id),target=this.repository.getNode(targetId);
      if(!card||card.kind==='folder'||!target||target.kind==='folder')throw Error(t('卡片不存在。'));
      const [parentId,childId]=[id,targetId].sort();
      return this.insert({parentId,childId,kind:'related'});
    });
  }

  remove(id:string,{parentId,childId,kind}:CardRelationKey):boolean{
    if((id!==parentId&&id!==childId)||!['memory','related'].includes(kind))throw Error(t('无效的卡片关系。'));
    if(kind==='related'&&parentId>childId)[parentId,childId]=[childId,parentId];
    return this.repository.transaction(()=>{
      const removed=Number(this.repository.query('DELETE FROM card_relations WHERE parent_id=? AND child_id=? AND kind=?')
        .run(parentId,childId,kind).changes)>0;
      if(removed&&kind==='memory')this.repository.query(`
        DELETE FROM card_dependency_overrides WHERE prerequisite_id=? AND dependent_id=? AND mode='ignore'
      `).run(childId,parentId);
      return removed;
    });
  }

  private insert({parentId,childId,kind}:CardRelationKey):boolean{
    return Number(this.repository.query('INSERT INTO card_relations VALUES (?,?,?) ON CONFLICT DO NOTHING')
      .run(parentId,childId,kind).changes)>0;
  }

  search(id:string,query:string,onlyTests=false):CardRelationCandidate[]{
    const keyword=query.slice(0,240).trim().toLowerCase();
    const segments=keyword.split('/').map(segment=>segment.trim()).filter(Boolean);
    if(keyword.includes('/')&&segments.length){
      const pathPattern='%'+segments.map(segment=>segment.replace(/[\\%_]/gu,'\\$&')).join('% / %')
        +(keyword.endsWith('/')?'% / %':'%');
      // 由父路径拼出子路径，共用祖先前缀。
      return this.repository.query(`
        WITH RECURSIVE paths(id,kind,position,path) AS (
          SELECT id,kind,position,title FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL
          UNION ALL
          SELECT n.id,n.kind,n.position,paths.path||' / '||n.title
          FROM paths JOIN nodes n ON n.parent_id=paths.id AND n.deleted_at IS NULL
        )
        SELECT id,path FROM paths
        WHERE id<>? AND kind<>'folder' AND (NOT ? OR kind='cloze') AND lower(path) LIKE ? ESCAPE '\\'
        ORDER BY position DESC,id DESC LIMIT 40
      `).all(id,onlyTests?1:0,pathPattern) as unknown as CardRelationCandidate[];
    }
    return this.repository.query(`
      WITH RECURSIVE candidates AS MATERIALIZED (
        SELECT id,parent_id,title,position FROM nodes
        WHERE deleted_at IS NULL AND kind<>'folder' AND id<>? AND (NOT ? OR kind='cloze') AND instr(lower(title),?)>0
        ORDER BY position DESC,id DESC LIMIT 40
      ), paths(id,parent_id,path) AS (
        SELECT id,parent_id,title FROM candidates
        UNION ALL
        SELECT paths.id,n.parent_id,n.title||' / '||paths.path
        FROM paths JOIN nodes n ON n.id=paths.parent_id AND n.deleted_at IS NULL
      )
      SELECT paths.id,paths.path FROM paths JOIN candidates USING(id)
      WHERE paths.parent_id IS NULL
      ORDER BY candidates.position DESC,candidates.id DESC
    `).all(id,onlyTests?1:0,segments[0]??'') as unknown as CardRelationCandidate[];
  }
}
