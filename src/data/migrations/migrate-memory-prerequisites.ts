import type {Repository} from '../database';

interface Dependency {
  prerequisiteId:string;
  dependentId:string;
}

function reaches(dependents:Map<string,string[]>,from:string,to:string):boolean{
  const pending=[from],visited=new Set<string>();
  while(pending.length){
    const id=pending.pop()!;
    if(id===to)return true;
    if(visited.has(id))continue;
    visited.add(id);
    for(const dependent of dependents.get(id)??[])pending.push(dependent);
  }
  return false;
}

export function migrateMemoryPrerequisites(repository:Repository):void{
  const ignored=repository.query(`
    SELECT r.child_id AS prerequisiteId,r.parent_id AS dependentId
    FROM card_relations r JOIN card_dependency_overrides o
      ON o.prerequisite_id=r.parent_id AND o.dependent_id=r.child_id
    WHERE r.kind='memory' AND o.mode='ignore'
  `).all() as unknown as Dependency[];
  const remove=repository.query("DELETE FROM card_dependency_overrides WHERE prerequisite_id=? AND dependent_id=? AND mode='ignore'");
  const ignore=repository.query("INSERT OR IGNORE INTO card_dependency_overrides VALUES(?,?,'ignore')");
  // 原先忽略的是这对父子卡的自动先修，随关系方向一起迁移。
  for(const {prerequisiteId,dependentId} of ignored)remove.run(dependentId,prerequisiteId);
  for(const {prerequisiteId,dependentId} of ignored)ignore.run(prerequisiteId,dependentId);

  const manual=repository.query(`
    SELECT prerequisite_id AS prerequisiteId,dependent_id AS dependentId
    FROM card_dependency_overrides WHERE mode='require'
  `).all() as unknown as Dependency[];
  if(manual.length){
    const dependents=new Map<string,string[]>();
    const add=({prerequisiteId,dependentId}:Dependency)=>{
      const existing=dependents.get(prerequisiteId);
      if(existing)existing.push(dependentId);
      else dependents.set(prerequisiteId,[dependentId]);
    };
    manual.forEach(add);
    const inherited=repository.query(`
      SELECT r.child_id AS prerequisiteId,r.parent_id AS dependentId
      FROM card_relations r
      WHERE r.kind='memory' AND NOT EXISTS(
        SELECT 1 FROM card_dependency_overrides o
        WHERE o.prerequisite_id=r.child_id AND o.dependent_id=r.parent_id
      )
      ORDER BY r.parent_id,r.child_id
    `).all() as unknown as Dependency[];
    // 手动指定的先修保留原方向。会形成循环的自动关系标为忽略，仍可在卡片信息中查看。
    for(const edge of inherited){
      if(reaches(dependents,edge.dependentId,edge.prerequisiteId))ignore.run(edge.prerequisiteId,edge.dependentId);
      else add(edge);
    }
  }
  repository.db.exec('PRAGMA user_version=13;');
}
