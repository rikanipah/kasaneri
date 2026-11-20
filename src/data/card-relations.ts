import { t } from '../core/i18n';
import type {CardRelation,CardRelationCandidate,CardRelationKey,MemoryTreeCard,MemoryTreeLink,MemoryTreeSnapshot} from '../core/model';
import type {Repository} from './database';

interface MemoryTreeRow extends MemoryTreeLink {
  role:'current'|'parent'|'child'|'related';
  manual:number;
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
      WITH current AS (
        SELECT id,parent_id FROM nodes WHERE id=? AND deleted_at IS NULL AND kind<>'folder'
      ), connections(role,id,manual) AS (
        SELECT 'current',id,0 FROM current
        UNION ALL SELECT 'parent',parent_id,0 FROM current
        UNION ALL SELECT 'child',child.id,0 FROM current JOIN nodes child ON child.parent_id=current.id
        UNION ALL
        SELECT CASE WHEN r.child_id=current.id THEN 'parent' ELSE 'child' END,
          CASE WHEN r.child_id=current.id THEN r.parent_id ELSE r.child_id END,1
        FROM current JOIN card_relations r ON r.parent_id=current.id OR r.child_id=current.id
        WHERE r.kind='memory'
        UNION ALL
        SELECT 'related',CASE WHEN r.child_id=current.id THEN r.parent_id ELSE r.child_id END,0
        FROM current JOIN card_relations r ON r.parent_id=current.id OR r.child_id=current.id
        WHERE r.kind='related'
      )
      SELECT link.role,n.id,n.title,n.kind,MAX(link.manual) AS manual
      FROM current CROSS JOIN connections link JOIN nodes n ON n.id=link.id
      WHERE n.deleted_at IS NULL AND n.kind<>'folder'
        -- 目录关系与手动关系方向冲突时，按目录中的层级显示。
        AND (link.role<>'parent' OR n.parent_id IS NOT current.id)
        AND (link.role<>'child' OR current.parent_id IS NOT n.id)
      GROUP BY link.role,n.id ORDER BY n.title COLLATE NOCASE,n.id
    `).all(id) as unknown as MemoryTreeRow[];
    const current=rows.find(row=>row.role==='current');
    if(!current)return {roots:[],cards:[]};

    const parents=rows.filter(row=>row.role==='parent');
    const parentIds=new Set(parents.map(row=>row.id));
    const children=rows.filter(row=>row.role==='child'&&!parentIds.has(row.id));
    const card=(row:MemoryTreeRow,onPath:boolean):MemoryTreeCard=>({
      id:row.id,title:row.title,kind:row.kind,onPath,children:[],memoryChildren:[],related:[],
    });
    const focus=card(current,true);
    focus.children=children.map(child=>child.id);
    focus.memoryChildren=children.filter(child=>child.manual).map(child=>child.id);
    focus.related=rows.filter(row=>row.role==='related').map(({id,title,kind})=>({id,title,kind}));
    const siblingCards=new Map<string,MemoryTreeCard>();
    const focusChildren=new Set(focus.children);
    const parentConnections=parents.length?this.repository.query(`
      WITH parents AS (SELECT value AS id FROM json_each(?)), edges AS (
        SELECT p.id AS owner,n.id,0 AS manual FROM parents p JOIN nodes n ON n.parent_id=p.id
        UNION ALL SELECT p.id,r.child_id,1 FROM parents p JOIN card_relations r ON r.parent_id=p.id AND r.kind='memory'
      )
      SELECT e.owner,n.id,n.title,n.kind,MAX(e.manual) AS manual
      FROM edges e JOIN nodes n ON n.id=e.id AND n.deleted_at IS NULL AND n.kind<>'folder'
      GROUP BY e.owner,n.id ORDER BY n.title COLLATE NOCASE,n.id
    `).all(JSON.stringify([...parentIds])) as unknown as Array<MemoryTreeRow&{owner:string}>:[];
    const parentCards=parents.map(parent=>{
      const siblings=parentConnections.filter(row=>row.owner===parent.id&&row.id!==id&&!parentIds.has(row.id)&&!focusChildren.has(row.id));
      for(const sibling of siblings)siblingCards.set(sibling.id,card(sibling,false));
      return {...card(parent,true),children:[id,...siblings.map(row=>row.id)],
        memoryChildren:[...(parent.manual?[id]:[]),...siblings.filter(row=>row.manual).map(row=>row.id)]};
    });
    return {roots:parents.length?[...parentIds]:[id],cards:[...parentCards,focus,...children.map(child=>card(child,false)),...siblingCards.values()]};
  }

  createChild(id:string,title:string,kind?:MemoryTreeLink['kind']){
    const parent=this.repository.getNode(id);
    if(!parent||parent.kind==='folder'||!parent.folderId)throw Error(t('卡片或所属文件夹不存在。'));
    if(typeof title!=='string'||!title.trim())throw Error(t('名称不能为空。'));
    // 记忆子卡直接挂在父卡下面（目录树里像记忆树那样体现归属）；主题/提取也支持，子卡沿用父卡类型。
    return this.repository.create({parentId:id,kind:kind??parent.kind,title},node=>{
      this.insert({parentId:id,childId:node.id,kind:'memory'});
    });
  }

  addMemoryChild(id:string,targetId:string):boolean{
    if(typeof id!=='string'||typeof targetId!=='string'||id===targetId)throw Error(t('请选择另一张检测卡片。'));
    return this.repository.transaction(()=>{
      const parent=this.repository.getNode(id),child=this.repository.getNode(targetId);
      if(!parent||parent.kind==='folder'||!child||child.kind==='folder')throw Error(t('卡片不存在。'));
      if(this.repository.query("SELECT 1 FROM card_relations WHERE parent_id=? AND child_id=? AND kind='memory'").get(id,targetId))return false;
      const cycle=this.repository.query(`WITH RECURSIVE edges(parentId,childId) AS (
        SELECT parent_id,id FROM nodes WHERE deleted_at IS NULL AND kind<>'folder'
        UNION SELECT parent_id,child_id FROM card_relations WHERE kind='memory'
        UNION SELECT dependent_id,prerequisite_id FROM card_dependency_overrides WHERE mode='require'
      ), descendants(id) AS (
        VALUES (?) UNION SELECT edges.childId FROM edges JOIN descendants ON edges.parentId=descendants.id
      ) SELECT 1 FROM descendants WHERE id=?`).get(targetId,id);
      if(cycle)throw Error(t('这条先修关系会形成循环。'));
      return this.insert({parentId:id,childId:targetId,kind:'memory'});
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

  removeAll(id:string):number{
    return this.repository.transaction(()=>{
      const edges=this.repository.query('SELECT parent_id AS parentId,child_id AS childId,kind FROM card_relations WHERE parent_id=? OR child_id=?')
        .all(id,id) as unknown as CardRelationKey[];
      return edges.filter(edge=>this.remove(id,edge)).length;
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
