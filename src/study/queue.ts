import {t} from '../core/i18n';
import {assembleFsrsPushQueue,assembleReadingPushQueue} from '../vendor/foliole/unifiedPushQueueAssembler';
import {resolveInheritedPushQueuePriority} from '../vendor/foliole/unifiedPushQueueRules';
import {dayStartMs,dailySlots,quotaChain,hasDailyQuota,type QuotaContext} from './quota';

type Row=Record<string,any>;

/** 队列构建要用的 service 依赖。额度部分复用 QuotaContext，其余是候选查询与排序专用的。 */
export interface QueueContext extends QuotaContext{
  /** 先修锁定的卡片 id 列表（json 数组字符串，直接拼进 SQL 的 json_each）。 */
  blockedJson():string;
  /** review_cards 的一行 → 调度器卡片（会校验算法版本）。 */
  card(row:Row):any;
  /** 按牌组取调度器，用来算可提取度。 */
  deckScheduler(folderId:string):{chrono:{difference(a:Date,b:Date):number};model:{forgettingCurve(card:any,elapsed:number):number}};
}

export const inDeck=`n.folder_id IN(WITH RECURSIVE decks(id) AS(
  SELECT id FROM nodes WHERE id=? AND kind='folder' AND deleted_at IS NULL
  UNION ALL SELECT c.id FROM nodes c JOIN decks p ON c.parent_id=p.id WHERE c.kind='folder' AND c.deleted_at IS NULL
) SELECT id FROM decks)`;
export const unlocked='n.id NOT IN(SELECT value FROM json_each(?))';
export const deckScope=(folderId:string|null)=>folderId?{filter:`AND ${inDeck}`,args:[folderId]}:{filter:'',args:[]};

/** 学新与复习混合：照 Anki 的 Intersperser —— ratio=(复习+1)/(新卡+1)，双向均匀摊，等长时复习先出。 */
export function interleave<T>(review:T[],fresh:T[]):T[]{
  const result:T[]=[];
  if(!fresh.length)return [...review];
  if(!review.length)return [...fresh];
  const ratio=(review.length+1)/(fresh.length+1);
  let i=0,j=0;
  while(i<review.length||j<fresh.length){
    if(j>=fresh.length){result.push(review[i++]);continue;}
    if(i>=review.length){result.push(fresh[j++]);continue;}
    if((j+1)*ratio<(i+1))result.push(fresh[j++]); else result.push(review[i++]);
  }
  return result;
}

/**
 * 候选队列：先按额度取舍，再按 Anki 的收集/排列顺序分组（学习 / 复习+跨日学习 / 新卡），
 * 最后按「展示顺序」合并。返回卡片 id 列表。
 */
export function buildQueue(context:QueueContext):string[]{
  const {repository,settings,profiles}=context;
  const session=context.active(),now=context.now(),at=new Date(now),blocked=context.blockedJson();
  const scope=deckScope(session.folderId),slots=dailySlots(context);
  const readingRows=session.mode==='cards'?[]:repository.query(`WITH RECURSIVE absolute_priority(id) AS (
    SELECT id FROM nodes WHERE priority=0 AND deleted_at IS NULL
    UNION ALL
    SELECT child.id FROM nodes child JOIN absolute_priority parent ON parent.id=child.parent_id
    WHERE child.priority IS NULL AND child.deleted_at IS NULL
  )
    SELECT n.id,n.parent_id,n.folder_id,n.priority,s.due_at,s.interval_ms FROM reading_state s JOIN nodes n ON n.id=s.node_id
    LEFT JOIN review_cards review ON review.node_id=n.id
    WHERE n.kind!='folder' AND(n.kind!='cloze' OR review.enabled=0) AND n.deleted_at IS NULL AND n.push_ready=1 AND s.enabled=1 AND s.due_at<=? AND COALESCE(s.buried_until,0)<=? AND ${unlocked} ${scope.filter}
    ORDER BY n.id IN(SELECT id FROM absolute_priority) DESC,s.due_at,n.position,n.id`).iterate(now,now,blocked,...scope.args);
  const reads:Row[]=[];
  for(const row of readingRows){
    if(!hasDailyQuota(context,String(row.folder_id),1,slots))continue;
    reads.push(row);
    if(reads.length===500)break;
  }
  const cards=session.mode==='reading'?[]:repository.query(`SELECT n.id,n.parent_id,n.folder_id,n.created_at,r.stage,r.state,r.algorithm_version,r.day_learning FROM review_cards r JOIN nodes n ON n.id=r.node_id
    WHERE n.kind='cloze' AND n.deleted_at IS NULL AND n.study_ready=1 AND r.enabled=1
      AND r.due_at<=? AND COALESCE(r.buried_until,0)<=? AND ${unlocked} ${scope.filter}
    ORDER BY CASE WHEN r.stage IN(1,3) THEN 0 WHEN r.stage=2 THEN 1 ELSE 2 END,r.due_at,n.position,n.rowid`).iterate(now,now,blocked,...scope.args) as Iterable<Row>;
  const limited:Row[]=[];
  if(session.mode==='cards'){
    for(const row of cards){
      if(row.stage===0||row.stage===2){
        const kind=row.stage===0?'new':'review';
        const chain=quotaChain(context,String(row.folder_id),slots);
        if(chain.some(remaining=>remaining[kind]<=0))continue;
        for(const remaining of chain)remaining[kind]--;
      }
      limited.push(row);
      if(limited.length===500)break;
    }
  }
  const metadata=new Map<string,Row>([...reads,...limited].map(row=>[String(row.id),row]));
  const pathFrom=(id:string)=>{
    const chain:Row[]=[],seen=new Set<string>();let current:string|null=id;
    while(current){
      if(seen.has(current))throw Error(t('目录包含循环关系。'));seen.add(current);
      let node=metadata.get(current);
      if(!node){node=repository.query('SELECT id,parent_id,priority FROM nodes WHERE id=? AND deleted_at IS NULL').get(current) as Row|undefined;if(node)metadata.set(current,node);}
      if(!node)break;chain.push(node);current=node.parent_id?String(node.parent_id):null;
    }
    return chain;
  };
  if(session.mode==='reading'){
    const reading=reads.map(row=>{
      const id=String(row.id),path=pathFrom(id),dueAt=new Date(Number(row.due_at)).toISOString();
      const priority=resolveInheritedPushQueuePriority(path.map(node=>node.priority),settings.defaultPriority as any);
      return {id,priority,pathNodeIds:path.reverse().map(node=>String(node.id)),nextAt:dueAt,dueAt,
        intervalDurationMs:Number(row.interval_ms)};
    });
    return assembleReadingPushQueue(reading,{priorityRatio:settings.priorityRatio,
      materialDispersion:settings.directoryDispersion===false?undefined:{now:at.toISOString(),readingInitialIntervalMs:settings.readingInitialDays*86400000}}).map(row=>row.id);
  }
  const ordered=assembleFsrsPushQueue(limited.map(row=>{
    const id=String(row.id),pathNodeIds=pathFrom(id).reverse().map(node=>String(node.id));
    if(row.stage===0)return {id,pathNodeIds,priority:5 as const,retrievability:1};
    if(row.stage===1||row.stage===3)return {id,pathNodeIds,priority:5 as const,retrievability:-1};
    const scheduler=context.deckScheduler(String(row.folder_id)),card=context.card(row);
    const elapsed=card.lastReviewAt?scheduler.chrono.difference(card.lastReviewAt,at):0;
    return {id,pathNodeIds,priority:5 as const,retrievability:scheduler.model.forgettingCurve(card,elapsed)};
  }),{priorityRatio:1,materialDispersion:settings.directoryDispersion===false?undefined:{}}).map(row=>row.id);
  // 展示顺序（对应 Anki 牌组选项的「展示顺序」）。
  //   新学/复习的先后：mixed=学新与复习混合（默认）、newFirst=新卡先出、reviewFirst=复习先出；
  //   新卡插入位置：position=顺序插入（旧卡片在前，默认）、random=随机；
  //   复习排列顺序：forgetting=最容易忘的先（默认）、due=按到期日期、random=随机。
  // 学习/重学永远排最前，组内顺序沿用上面的遗忘程度/位置排序。
  const stages=new Map(limited.map(row=>[String(row.id),Number(row.stage)]));
  const dueAt=new Map(limited.map(row=>[String(row.id),Number(row.due_at)]));
  const groups:{learning:string[];review:string[];fresh:string[]}={learning:[],review:[],fresh:[]};
  // 2026-11-19：照 Anki，跨日学习（due 在明天及以后）按「跨日学习与复习的混合」处理：
  // 混合=并入复习组；复习之后=排在复习组末尾；复习之前=排在复习组开头。
  const tomorrowStart=dayStartMs(context.now(),settings.dayStartHour)+86400000;
  const interdayIds:string[]=[];
  for(const id of ordered){const stage=stages.get(id),due=dueAt.get(id)||0;
    const interday=(stage===1||stage===3)&&due>=tomorrowStart;
    if(interday)interdayIds.push(id);
    (stage===0?groups.fresh:stage===2||interday?groups.review:groups.learning).push(id);}
  if(interdayIds.length){
    const mix=settings.interdayLearningMix||'mixed';
    if(mix!=='mixed'){
      const interdaySet=new Set(interdayIds);
      const reviews=groups.review.filter(id=>!interdaySet.has(id));
      groups.review=mix==='before'?[...interdayIds,...reviews]:[...reviews,...interdayIds];
    }
  }
  // 2026-11-19：新卡收集（Anki 的 NewCardGatherPriority）与复习排序（ReviewCardOrder）。
  // 随机一律用「卡片 id + 今天是第几天」的哈希，同一天内重建队列顺序不变（Anki 的 fnvhash）。
  const folders=new Map(limited.map(row=>[String(row.id),String(row.folder_id??'')]));
  const dayIndex=Math.floor((Date.now()-Date.UTC(2020,0,1))/86400000);
  const stableHash=(value:string)=>{
    let hash=2166136261^dayIndex;
    for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)>>>0;}
    return hash;
  };
  const folderPath=(folderId:string)=>{const parts:string[]=[];let cursor: string|null|undefined=folderId;
    for(let guard=0;cursor&&guard<32;guard++){const folder=profiles.folders.get(cursor);if(!folder)break;parts.unshift(folder.title);cursor=folder.parentId;}
    return parts.join('/');};
  const pathOf=(id:string)=>folderPath(folders.get(id)||'');
  const createdAt=new Map(limited.map(row=>[String(row.id),Number(row.created_at||0)]));
  // 新卡收集顺序：位置（默认）/按目录/按目录再随机/最高位置/最低位置/随机
  const gather=settings.newCardGatherOrder||'position';
  if(gather==='deck'||gather==='deckThenRandom'){
    const base=(a:string,b:string)=>pathOf(a).localeCompare(pathOf(b));
    groups.fresh.sort(gather==='deck'?(a,b)=>base(a,b)||(a<b?-1:1):(a,b)=>base(a,b)||stableHash(a)-stableHash(b));
  }else if(gather==='lowest')groups.fresh.sort((a,b)=>(Number(createdAt.get(a))||0)-(Number(createdAt.get(b))||0)||(a<b?-1:1));
  else if(gather==='highest')groups.fresh.sort((a,b)=>-(Number(createdAt.get(a))||0)+(Number(createdAt.get(b))||0)||(a<b?-1:1));
  else if(gather==='random'||settings.newOrder==='random')groups.fresh.sort((a,b)=>stableHash(a)-stableHash(b));
  // 复习排列顺序：Anki ReviewCardOrder 的可用子集，末尾统一用当天稳定哈希兜底。
  const intervalDays=new Map(limited.map(row=>{
    try{const state=JSON.parse(String(row.state??'{}'));return [String(row.id),Number(state.scheduledDays??0)];}
    catch{return [String(row.id),0];}
  }));
  const relativeOverdue=(id:string)=>{
    const days=intervalDays.get(id)||0,last=dueAt.get(id)||0;
    if(days<=0)return Number.POSITIVE_INFINITY;
    return (Date.now()-last)/Math.max(1,days*86400000);
  };
  const easeOf=new Map(limited.map(row=>{
    try{const state=JSON.parse(String(row.state??'{}'));return [String(row.id),Number(state.difficulty??state.ease??0)];}
    catch{return [String(row.id),0];}
  }));
  const retrievabilityOf=new Map(limited.map(row=>{
    try{const state=JSON.parse(String(row.state??'{}')),s=Number(state.stability??0),last=Number(dueAt.get(String(row.id))||0);
      if(!s||!last)return [String(row.id),0];
      const days=Math.max(0,(Date.now()-last)/86400000);
      return [String(row.id),Math.pow(1+days/s,state.decay?Number(state.decay):-0.5)];
    }catch{return [String(row.id),0];}
  }));
  const tie=(a:string,b:string)=>stableHash(a)-stableHash(b);
  switch(settings.reviewOrder){
    case 'relative':groups.review.sort((a,b)=>relativeOverdue(b)-relativeOverdue(a)||tie(a,b));break;
    case 'intervals':groups.review.sort((a,b)=>(intervalDays.get(a)||0)-(intervalDays.get(b)||0)||tie(a,b));break;
    case 'intervalsDesc':groups.review.sort((a,b)=>(intervalDays.get(b)||0)-(intervalDays.get(a)||0)||tie(a,b));break;
    case 'ease':groups.review.sort((a,b)=>(easeOf.get(b)||0)-(easeOf.get(a)||0)||tie(a,b));break;
    case 'easeDesc':groups.review.sort((a,b)=>(easeOf.get(a)||0)-(easeOf.get(b)||0)||tie(a,b));break;
    case 'retrievability':groups.review.sort((a,b)=>(retrievabilityOf.get(a)||0)-(retrievabilityOf.get(b)||0)||tie(a,b));break;
    case 'retrievabilityDesc':groups.review.sort((a,b)=>(retrievabilityOf.get(b)||0)-(retrievabilityOf.get(a)||0)||tie(a,b));break;
    case 'due':groups.review.sort((a,b)=>(dueAt.get(a)||0)-(dueAt.get(b)||0)||tie(a,b));break;
    case 'dueThenDeck':groups.review.sort((a,b)=>(dueAt.get(a)||0)-(dueAt.get(b)||0)||pathOf(a).localeCompare(pathOf(b))||tie(a,b));break;
    case 'deckThenDue':groups.review.sort((a,b)=>pathOf(a).localeCompare(pathOf(b))||(dueAt.get(a)||0)-(dueAt.get(b)||0)||tie(a,b));break;
    case 'added':groups.review.sort((a,b)=>(createdAt.get(a)||0)-(createdAt.get(b)||0)||tie(a,b));break;
    case 'addedDesc':groups.review.sort((a,b)=>(createdAt.get(b)||0)-(createdAt.get(a)||0)||tie(a,b));break;
    case 'random':groups.review.sort(tie);break;
    default:break; // forgetting=默认：沿用 assembleFsrsPushQueue 的可提取度排序
  }
  const order=settings.newReviewOrder||'mixed';
  if(order==='newFirst')return [...groups.learning,...groups.fresh,...groups.review];
  if(order==='reviewFirst')return [...groups.learning,...groups.review,...groups.fresh];
  return [...groups.learning,...interleave(groups.review,groups.fresh)];
}
