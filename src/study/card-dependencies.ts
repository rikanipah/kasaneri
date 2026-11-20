import { t } from '../core/i18n';
import type {Repository} from '../data/database';
import type {DependencyOverride} from '../core/model';

interface Rule {prerequisiteId:string;dependentId:string;inherited:number;mode:DependencyOverride}

const rulesSql=`
  SELECT r.child_id AS prerequisiteId,r.parent_id AS dependentId,1 AS inherited,o.mode
  FROM card_relations r LEFT JOIN card_dependency_overrides o
    ON o.prerequisite_id=r.child_id AND o.dependent_id=r.parent_id
  WHERE r.kind='memory'
  UNION ALL
  SELECT o.prerequisite_id,o.dependent_id,0,o.mode FROM card_dependency_overrides o
  WHERE o.mode='require' AND NOT EXISTS(
    SELECT 1 FROM card_relations r WHERE r.child_id=o.prerequisite_id AND r.parent_id=o.dependent_id AND r.kind='memory'
  )`;
const activeCards=`
  FROM rules
  JOIN nodes prerequisite ON prerequisite.id=rules.prerequisiteId AND prerequisite.kind='cloze' AND prerequisite.deleted_at IS NULL
  JOIN nodes dependent ON dependent.id=rules.dependentId AND dependent.kind='cloze' AND dependent.deleted_at IS NULL`;

export class CardDependencies {
  private readonly masteryReps:(id:string)=>number;
  constructor(private readonly repository:Repository,masteryReps?:(id:string)=>number){
    // 没传就按全局设置（测试/独立使用）；StudyService 会按卡片所属牌组解析。
    this.masteryReps=masteryReps??(()=>{
      const settings=repository.getSetting('studySettings') as {masteryReps?:unknown}|null;
      const value=Number(settings?.masteryReps);
      return Number.isInteger(value)&&value>=1?Math.min(9,value):1;
    });
  }

  memoryPrerequisites(id:string):string[]{
    return this.repository.query(`
      WITH rules AS (${rulesSql})
      SELECT prerequisiteId ${activeCards} WHERE dependent.id=? AND inherited=1 AND mode IS NOT 'ignore'
    `).all(id).map(row=>String(row.prerequisiteId));
  }

  list(id:string){
    const rows=this.repository.query(`
      WITH rules AS (${rulesSql})
      SELECT rules.*,prerequisite.title ${activeCards}
      WHERE dependent.id=? ORDER BY prerequisite.title COLLATE NOCASE,prerequisite.id
    `).all(id) as unknown as Array<Rule&{title:string}>;
    return rows.map(({prerequisiteId,title,inherited,mode})=>{
      const rating=this.effectiveRating(prerequisiteId);
      return {id:prerequisiteId,title,inherited:!!inherited,mode,mastered:this.mastered(prerequisiteId),rating};
    });
  }

  setOverride(dependentId:string,prerequisiteId:string,mode:DependencyOverride,expected?:DependencyOverride):void{
    if(typeof dependentId!=='string'||typeof prerequisiteId!=='string'||dependentId===prerequisiteId)
      throw Error(t('请选择另一张检测卡片。'));
    if(mode!==null&&mode!=='require'&&mode!=='ignore')throw Error(t('先修设置无效。'));
    this.repository.transaction(()=>{
      const endpoints=this.repository.query("SELECT count(*) AS n FROM nodes WHERE id IN (?,?) AND kind='cloze' AND deleted_at IS NULL")
        .get(dependentId,prerequisiteId);
      if(endpoints?.n!==2)throw Error(t('先修关系只适用于检测卡片。'));
      if(expected!==undefined||mode==='ignore'){
        const rule=this.repository.query(`
          WITH rules AS (${rulesSql})
          SELECT mode,inherited FROM rules WHERE prerequisiteId=? AND dependentId=?
        `).get(prerequisiteId,dependentId);
        if((mode==='ignore'&&!rule?.inherited)||(expected!==undefined&&(rule?.mode??null)!==expected))
          throw Error(t('先修设置已变化，请重新打开卡片信息。'));
      }
      if(mode===null){
        this.repository.query('DELETE FROM card_dependency_overrides WHERE prerequisite_id=? AND dependent_id=?')
          .run(prerequisiteId,dependentId);
      }else{
        this.repository.query(`
          INSERT INTO card_dependency_overrides VALUES(?,?,?)
          ON CONFLICT(prerequisite_id,dependent_id) DO UPDATE SET mode=excluded.mode
        `).run(prerequisiteId,dependentId,mode);
      }
      if(mode!=='ignore'&&this.formsCycle(prerequisiteId,dependentId))throw Error(t('这条先修关系会形成循环。'));
    });
  }

  private formsCycle(prerequisiteId:string,dependentId:string):boolean{
    return !!this.repository.query(`
      WITH RECURSIVE rules AS (${rulesSql}), descendants(id) AS (
        SELECT dependentId FROM rules WHERE prerequisiteId=? AND dependentId=? AND mode IS NOT 'ignore'
        UNION
        SELECT r.dependentId FROM rules r JOIN descendants d ON d.id=r.prerequisiteId
        WHERE r.mode IS NOT 'ignore'
      )
      SELECT 1 FROM descendants WHERE id=? LIMIT 1
    `).get(prerequisiteId,dependentId,prerequisiteId);
  }

  blocked():Set<string>{
    const edges=this.repository.query(`
      WITH rules AS (${rulesSql})
      SELECT prerequisiteId,dependentId ${activeCards} WHERE mode IS NOT 'ignore'
    `).all() as unknown as Array<Pick<Rule,'prerequisiteId'|'dependentId'>>;
    const downstream=new Map<string,string[]>();
    for(const edge of edges){
      const children=downstream.get(edge.prerequisiteId)??[];
      children.push(edge.dependentId);downstream.set(edge.prerequisiteId,children);
    }
    const blocked=new Set<string>();
    for(const [id,children] of downstream){
      if(!this.mastered(id))for(const child of children)blocked.add(child);
    }
    // 已锁的先修仍会阻塞它的后续卡，即使它自己最近评价为良好。
    for(const id of blocked)for(const child of downstream.get(id)??[])blocked.add(child);
    return blocked;
  }

  // 先修卡要连续 N 次（N=masteryReps）有效评价都达到「良好/简单」才算掌握。
  private mastered(id:string):boolean{
    const need=Math.max(1,Math.min(9,Math.round(this.masteryReps(id))));
    const latest=this.effective(id);
    if(!latest||latest.rating<3)return false;
    if(need===1)return true;
    const rows=this.repository.query(`
      SELECT rating FROM review_log
      WHERE node_id=? AND undone_at IS NULL AND rating BETWEEN 1 AND 4 AND reviewed_at<=?
        AND COALESCE(json_extract(details,'$.anki.type'),-1) NOT IN (4,5)
      ORDER BY reviewed_at DESC,event_id DESC LIMIT ?
    `).all(id,latest.at,need) as Array<{rating:number}>;
    return rows.length>=need&&rows.every(row=>Number(row.rating)>=3);
  }

  private effective(id:string):{rating:number;at:number}|null{
    const card=this.repository.query('SELECT state FROM review_cards WHERE node_id=?').get(id);
    if(typeof card?.state!=='string')return null;
    const active=this.repository.query(`
      SELECT rating,reviewed_at FROM review_log WHERE node_id=? AND undone_at IS NULL AND after_state=?
      ORDER BY reviewed_at DESC,event_id DESC LIMIT 1
    `).get(id,card.state) as {rating:number;reviewed_at:number}|undefined;
    if(active)return {rating:Number(active.rating),at:Number(active.reviewed_at)};

    // Anki 导入只保留历史评价，历史行没有排程快照；匹配导入排程的最近复习秒。
    const last=Date.parse(JSON.parse(card.state)?.lastReviewAt??'');
    if(!Number.isFinite(last))return null;
    const second=Math.floor(last/1000)*1000;
    const imported=this.repository.query(`
      SELECT rating,reviewed_at FROM review_log WHERE node_id=? AND undone_at IS NULL AND algorithm_version='anki:historical'
        AND reviewed_at>=? AND reviewed_at<? AND json_extract(details,'$.anki.type') IS NOT 4
      ORDER BY reviewed_at DESC,event_id DESC LIMIT 1
    `).get(id,second,second+1000) as {rating:number;reviewed_at:number}|undefined;
    return imported?{rating:Number(imported.rating),at:Number(imported.reviewed_at)}:null;
  }

  private effectiveRating(id:string):number|null{return this.effective(id)?.rating??null;}
}
