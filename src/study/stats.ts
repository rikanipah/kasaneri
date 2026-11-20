import {t} from '../core/i18n';
import type {FolderCounts,PrerequisiteState} from '../core/model';
import type {Repository} from '../data/database';
import type {DeckProfiles} from '../folders/decks';
import type {StudySettings,ReviewSettings} from '../core/settings';
import type {DailySlots} from './quota';
import {dayStartMs,deckChain} from './quota';
import {deckScope,inDeck,unlocked} from './queue';
import {validRecall} from './optimizer';
import {profileKey} from '../folders/decks';
import {DefaultScheduler,Rating} from 'ts-fsrs';
import {parseSchedule,studyChangeSession,type Schedule} from '../sync/study-changes';

type Row=Record<string,any>;
type Scheduler=Awaited<ReturnType<typeof DefaultScheduler>>;

/** 计数与统计要用的 service 依赖（不带会话，纯读）。 */
export interface StatsContext{
  repository:Repository;
  profiles:DeckProfiles;
  settings:StudySettings;
  now():number;
  /** 学习提前限制（毫秒），红色计数要用。 */
  learnAheadMs():number;
  /** 先修锁定的卡片 id json 数组。 */
  blockedJson():string;
  /** review_cards 一行 → 调度器卡片（卡片信息/遗忘曲线要用）。 */
  card(row:Row):any;
  schedulerForDeck(folderId:string|null):{chrono:{difference(a:Date,b:Date):number};model:{forgettingCurve(card:any,elapsed:number):number}};
  /** 先修关系（卡片信息面板）。 */
  prerequisites(id:string):PrerequisiteState;
  /** 累计重来次数。 */
  leechLapses(id:string):number;
  /** 按指定复习参数现造调度器（工作量模拟要按 0.85/0.9/0.95 各造一次）。 */
  schedulerFor(settings:ReviewSettings):Promise<Scheduler>;
}

export interface CountsSnapshot{
  value:Record<string,FolderCounts>;
  total:FolderCounts;
  direct:Map<string,DailySlots>;
}

/**
 * 各牌组的 red/green 计数（含父牌组汇总）＋全局总数＋每个牌组的直接计数。
 * 结果不缓存，缓存（15 秒）留在 service 里，因为它还要跟 invalidate() 联动。
 */
export function computeCounts(context:StatsContext):CountsSnapshot{
  const {repository,profiles}=context;
  const now=context.now();
  const result:Record<string,FolderCounts>={},direct=new Map<string,DailySlots>();
  const rows=repository.query(`SELECT n.folder_id,
    SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND COALESCE(r.buried_until,0)<=? AND r.stage=0 THEN 1 ELSE 0 END) AS fresh,
    SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND COALESCE(r.buried_until,0)<=? AND r.stage IN(1,3) AND r.due_at<=? THEN 1 ELSE 0 END)
    + SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND COALESCE(r.buried_until,0)<=? AND r.stage IN(1,3) AND r.due_at>=? AND r.due_at<=? THEN 1 ELSE 0 END) AS learning,
    SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND COALESCE(r.buried_until,0)<=? AND r.stage=2 AND r.due_at<=? THEN 1 ELSE 0 END) AS review,
    SUM(CASE WHEN n.push_ready=1 AND(n.kind!='cloze' OR r.enabled=0) AND s.enabled=1 AND COALESCE(s.buried_until,0)<=? AND s.due_at<=? THEN 1 ELSE 0 END) AS readingDue,
    SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND COALESCE(r.buried_until,0)<=? AND r.due_at<=? THEN 1 ELSE 0 END) AS fsrsDue
    FROM nodes n LEFT JOIN review_cards r ON r.node_id=n.id LEFT JOIN reading_state s ON s.node_id=n.id
    WHERE n.kind!='folder' AND n.deleted_at IS NULL AND(n.study_ready=1 OR n.push_ready=1) AND ${unlocked}
    GROUP BY n.folder_id`).all(now,now,now+context.learnAheadMs(),now,now+86400000,now+2*86400000,now,now,now,now,now,now,context.blockedJson());
  const zero=():FolderCounts=>({new:0,learning:0,review:0,readingDue:0,fsrsDue:0}),total=zero();
  for(const folder of profiles.folders.values())result[folder.id]=zero();
  for(const row of rows){const count={new:Number(row.fresh),learning:Number(row.learning),review:Number(row.review),readingDue:Number(row.readingDue),fsrsDue:Number(row.fsrsDue)};
    direct.set(String(row.folder_id),{new:count.new,review:count.review,reading:count.readingDue});
    result[String(row.folder_id)]=count;for(const key of Object.keys(total) as Array<keyof FolderCounts>)total[key]+=count[key];}
  const remaining=new Map([...profiles.folders.keys()].map(id=>[id,0]));
  for(const folder of profiles.folders.values())if(folder.parentId&&remaining.has(folder.parentId))remaining.set(folder.parentId,remaining.get(folder.parentId)!+1);
  const leaves=[...remaining].filter(([,count])=>count===0).map(([id])=>id);
  while(leaves.length){const id=leaves.pop()!,parent=profiles.folders.get(id)?.parentId;
    if(parent&&result[parent]){for(const key of Object.keys(total) as Array<keyof FolderCounts>)result[parent][key]+=result[id][key];remaining.set(parent,remaining.get(parent)!-1);if(remaining.get(parent)===0)leaves.push(parent);}}
  return {value:result,total,direct};
}

/**
 * 这个牌组今天还能出多少（把子牌组也算进来，再被额度与祖先牌组额度夹住）。
 * `direct` 来自 computeCounts()，所以调用前要先跑过 counts()。
 */
export function availableToday(context:StatsContext,slots:Map<string|null,DailySlots>,
  direct:Map<string,DailySlots>,folderId:string|null):DailySlots{
  const profiles=context.profiles,children=new Map<string|null,string[]>();
  if(!slots.has(folderId))return {new:0,review:0,reading:0};
  for(const folder of profiles.folders.values()){
    const parent=folder.parentId&&profiles.folders.has(folder.parentId)?folder.parentId:null;
    const siblings=children.get(parent)||[];
    siblings.push(folder.id);children.set(parent,siblings);
  }
  const collect=(id:string|null):DailySlots=>{
    const own=id?direct.get(id):undefined;
    let fresh=own?.new||0,review=own?.review||0,reading=own?.reading||0;
    for(const child of children.get(id)||[]){
      const count=collect(child);fresh+=count.new;review+=count.review;reading+=count.reading;
    }
    const remaining=slots.get(id)!;
    return {new:Math.min(fresh,remaining.new),review:Math.min(review,remaining.review),reading:Math.min(reading,remaining.reading)};
  };
  const total=collect(folderId);
  for(const ancestor of deckChain(profiles,folderId).slice(1)){
    const remaining=slots.get(ancestor)!;
    total.new=Math.min(total.new,remaining.new);total.review=Math.min(total.review,remaining.review);total.reading=Math.min(total.reading,remaining.reading);
  }
  return total;
}

export function scheduleEventLabel(before:Schedule,after:Schedule,details:{action?:string},everReviewed:boolean):string{
if(details?.action==='tags'){
  if(!!before.hold!==!!after.hold)return after.hold?t('留存判定'):t('取消留存判定');
  if(!!before.buried!==!!after.buried)return after.buried?t('搁置'):t('取消搁置');
  return t('状态变更');
}
const reviewBefore=Number(before.review?.enabled||0),reviewAfter=Number(after.review?.enabled||0);
const readBefore=Number(before.reading.enabled||0),readAfter=Number(after.reading.enabled||0);
if(reviewBefore&&!reviewAfter&&readAfter)return t('待办暂停');
// 卡片加入复习后会被重置成新卡（state 里 reps 归零），所以用「这张卡有没有复习记录」判断
if(!reviewBefore&&reviewAfter)return everReviewed?t('返回复习'):t('加入复习');
if(readBefore&&!readAfter)return t('暂停待办');
if(!readBefore&&readAfter)return t('恢复待办');
return t('排程变更');
}

export function cardInfo(context:StatsContext,input:{id:string;offset?:number;horizon?:number}){
  const node=context.repository.getNode(input.id);if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
  const r=context.repository.query('SELECT * FROM review_cards WHERE node_id=?').get(node.id) as Row|undefined;
  const push=context.repository.query('SELECT * FROM reading_state WHERE node_id=?').get(node.id),profile=context.profiles.resolve(node.folderId),now=context.now();
  const offset=Math.max(0,Math.floor(Number(input.offset)||0)),horizon=Math.max(1,Math.min(36500,Number(input.horizon)||180));
  // 复习记录里也带上排程事件（待办暂停 / 返回复习 / 搁置 / 留存判定这些），
  // 它们没有评价，评价列留空；真正的复习记录仍然来自 review_log。
  const eventFilter=`node_id=? AND session_id=? AND kind='schedule'
    AND json_extract(json_extract(after_state,'$.details'),'$.action') IN ('queue','tags')`;
  const total=Number(context.repository.query(`SELECT
    (SELECT count(*) FROM review_log WHERE node_id=?)+
    (SELECT count(*) FROM study_operations WHERE ${eventFilter}) AS n`)
    .get(node.id,node.id,studyChangeSession)!.n);
  const everReviewed=Number(context.repository.query('SELECT count(*) n FROM review_log WHERE node_id=?').get(node.id)!.n)>0;
  const history=(context.repository.query(`
    SELECT 'review' AS source,event_id AS id,reviewed_at AS at,rating,details,before_state,after_state,undone_at
      FROM review_log WHERE node_id=?
    UNION ALL
    SELECT 'event',event_id,reviewed_at,NULL,json_extract(after_state,'$.details'),
      before_state,json_extract(after_state,'$.schedule'),undone_at
      FROM study_operations WHERE ${eventFilter}
    ORDER BY at DESC,id DESC LIMIT 100 OFFSET ?`)
    .all(node.id,node.id,studyChangeSession,offset) as Row[]).map(row=>{
    if(String(row.source)==='event'){
      let label=t('排程变更');
      try{label=scheduleEventLabel(parseSchedule(String(row.before_state)),parseSchedule(String(row.after_state)),
        JSON.parse(String(row.details||'{}')),everReviewed);}catch{/* 老数据格式不对就退回默认文字 */}
      return {id:String(row.id),at:Number(row.at),kind:'event' as const,label,rating:null,intervalDays:null,type:null,
        stability:null,difficulty:null,elapsedDays:null,seconds:null,undone:!!row.undone_at};
    }
    const details=JSON.parse(String(row.details)),after=JSON.parse(String(row.after_state)),before=JSON.parse(String(row.before_state));
    const original=details.anki,ivl=original?.ivl;
    return {id:String(row.id),at:Number(row.reviewed_at),kind:'review' as const,label:null,rating:Number(row.rating),intervalDays:original?(ivl<0?-ivl/86400:ivl):(after?.scheduledDays??null),
      // 复习类型（0 新卡 / 1 学习 / 2 复习 / 3 重新学习），供 Anki 式历史表显示
type:typeof before?.state==='number'?before.state:(typeof original?.type==='number'?original.type:null),
stability:after?.stability??null,difficulty:after?.difficulty??null,elapsedDays:after?.lastReviewAt&&before?.lastReviewAt?(new Date(after.lastReviewAt).getTime()-new Date(before.lastReviewAt).getTime())/86400000:null,
      seconds:original?Number(original.time||0)/1000:details.durationMs===undefined?null:details.durationMs/1000,undone:!!row.undone_at};
  });
  const state=r?JSON.parse(r.state):null,curve:Array<{days:number;probability:number}>=[];let retrievability:number|null=null;
  if(r&&state?.lastReviewAt&&state.stability>0){
    const scheduler=context.schedulerForDeck(node.folderId),card=context.card(r);
    for(let i=0;i<=80;i++){const days=horizon*i/80,at=new Date(now+days*86400000),elapsed=Math.max(0,scheduler.chrono.difference(card.lastReviewAt!,at));
      const probability=Math.max(0,Math.min(1,scheduler.model.forgettingCurve(card,elapsed)));curve.push({days,probability});}
    retrievability=curve[0].probability;
  }
  // 参照 Anki「卡片信息」补齐字段——有效复习次数、首次/最近复习、当前间隔、
  // 总用时与平均用时（Anki 的 total/average time），供卡片信息面板复现。
  const aggregate=context.repository.query(`SELECT MIN(CASE WHEN undone_at IS NULL THEN reviewed_at END) AS firstReview,
      MAX(CASE WHEN undone_at IS NULL THEN reviewed_at END) AS lastReview,
      SUM(CASE WHEN undone_at IS NULL THEN 1 ELSE 0 END) AS live
    FROM review_log WHERE node_id=?`).get(node.id)!;
  let totalSeconds:number|null=null;
  try{
    const timeline=context.repository.query(`SELECT SUM(CAST(json_extract(details,'$.durationMs') AS REAL)) AS ms
      FROM review_log WHERE node_id=? AND undone_at IS NULL`).get(node.id);
    if(timeline?.ms!==null&&timeline?.ms!==undefined)totalSeconds=Number(timeline.ms)/1000;
  }catch{totalSeconds=null;}
  const liveCount=Number(aggregate.live||0);
  const intervalDays=r?.due_at&&state?.lastReviewAt?(Number(r.due_at)-new Date(state.lastReviewAt).getTime())/86400000:null;
  const elapsedDays=state?.lastReviewAt?(now-new Date(state.lastReviewAt).getTime())/86400000:null;
  return {id:node.id,title:node.title,kind:node.kind,path:context.repository.path(node.id).map(n=>n.title).join(' / '),
    prerequisites:node.kind==='cloze'?context.prerequisites(node.id):null,
    tags:context.repository.query('SELECT tag FROM node_tags WHERE node_id=? ORDER BY tag').all(node.id).map(row=>String(row.tag)),
    leechCount:context.leechLapses(node.id),
    settings:profile,reviewEnabled:node.kind==='cloze'&&!!r?.enabled,pushEnabled:!!push?.enabled,dueAt:r?.due_at??null,pushDueAt:push?.due_at??null,
    state,createdAt:context.repository.query('SELECT created_at FROM nodes WHERE id=?').get(node.id)?.created_at,
    updatedAt:context.repository.query('SELECT updated_at FROM nodes WHERE id=?').get(node.id)?.updated_at,
    reviewCount:liveCount,firstReviewAt:aggregate.firstReview?Number(aggregate.firstReview):null,
    latestReviewAt:aggregate.lastReview?Number(aggregate.lastReview):null,
    intervalDays,elapsedDays,totalSeconds,
    averageSeconds:liveCount&&totalSeconds!==null?totalSeconds/liveCount:null,
    retrievability,curve,horizon,history,total,offset};
}

export function statistics(context:StatsContext,input:{folderId?:string;days?:number}={}){
  const now=context.now(),days=Math.max(7,Math.min(366,Math.floor(Number(input.days)||30))),start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-days+1);
  const from=start.getTime(),args:any[]=[],where=["n.deleted_at IS NULL","n.kind!='folder'"];
  if(input.folderId){where.push(inDeck);args.push(input.folderId);}
  const scope=where.join(' AND '),summary=context.repository.query(`SELECT count(*) total,
    SUM(CASE WHEN n.kind='cloze' THEN 1 ELSE 0 END) tests,
    SUM(CASE WHEN n.kind='cloze' AND r.enabled=1 AND r.stage=0 AND n.study_ready=1 THEN 1 ELSE 0 END) newCards,
    SUM(CASE WHEN n.kind='cloze' AND r.enabled=1 AND r.stage>0 AND n.study_ready=1 THEN 1 ELSE 0 END) learned,
    SUM(CASE WHEN s.enabled=1 AND(n.kind!='cloze' OR r.enabled=0) THEN 1 ELSE 0 END) pushing,
    SUM(CASE WHEN n.kind='cloze' AND r.enabled=0 THEN 1 ELSE 0 END) suspended,
    SUM(CASE WHEN EXISTS(SELECT 1 FROM node_tags t WHERE t.node_id=n.id AND t.tag='leech') THEN 1 ELSE 0 END) leeches
    FROM nodes n LEFT JOIN review_cards r ON r.node_id=n.id LEFT JOIN reading_state s ON s.node_id=n.id WHERE ${scope}`).get(...args)!;
  const daily=context.repository.query(`SELECT date(l.reviewed_at/1000,'unixepoch','localtime') day,count(*) answers,SUM(CASE WHEN l.rating=1 THEN 1 ELSE 0 END) forgot
    FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=? GROUP BY day ORDER BY day`).all(...args,from);
  const ratings=context.repository.query(`SELECT l.rating,count(*) count FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=? GROUP BY rating`).all(...args,from);
  // 2026-11-19：到期预测只算复习卡（stage=2），与 Anki 的 Future Due 图口径一致；
  // 学习中的卡（含跨日学习）不在这张图里，它们属于「今日」的红色计数。
  const forecast=context.repository.query(`SELECT date(MAX(r.due_at,?)/1000,'unixepoch','localtime') day,count(*) count FROM review_cards r JOIN nodes n ON n.id=r.node_id
    WHERE ${scope} AND n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND r.stage=2 AND r.due_at<=? GROUP BY day ORDER BY day`).all(now,...args,now+3650*86400000);
  //   · 复习间隔分布 / 记忆稳定期分布 / 难度分布（来自卡片当前 FSRS 状态）
  //   · 回答按钮分布、逐小时分析（来自 review_log）
  //   · 每日新增卡片（nodes.created_at）
  // 日历热力图、日程表这类依赖 Anki 专有概念的图不做（用户确认它们在我们语义下没有意义）。
  const bucketsOf=(value:number,edges:number[])=>edges.findIndex(edge=>value<edge);
  const intervalEdges=[1,3,7,14,30,90,180,365,Infinity];
  const intervalLabels=[t('<1 天'),t('1–3 天'),t('3–7 天'),t('7–14 天'),t('14–30 天'),t('30–90 天'),t('90–180 天'),t('180–365 天'),t('>365 天')];
  const intervalBuckets=intervalLabels.map(label=>({label,count:0}));
  const stabilityBuckets=intervalLabels.map(label=>({label,count:0}));
  const difficultyBuckets=Array.from({length:10},(_,index)=>({label:String(index+1),count:0}));
  const cardRows=context.repository.query(`SELECT r.state AS state FROM review_cards r JOIN nodes n ON n.id=r.node_id
    WHERE ${scope} AND n.kind='cloze' AND r.enabled=1`).all(...args) as Array<{state:string}>;
  for(const row of cardRows){
    let state:any=null;try{state=JSON.parse(String(row.state));}catch{continue;}
    const scheduled=Number(state?.scheduledDays);
    if(Number.isFinite(scheduled))intervalBuckets[Math.max(0,bucketsOf(scheduled,intervalEdges))]!.count++;
    const stability=Number(state?.stability);
    if(Number.isFinite(stability)&&stability>0)stabilityBuckets[Math.max(0,bucketsOf(stability,intervalEdges))]!.count++;
    const difficulty=Number(state?.difficulty);
    if(Number.isFinite(difficulty)&&difficulty>0)difficultyBuckets[Math.min(9,Math.max(0,Math.round(difficulty)-1))]!.count++;
  }
  const buttonRow=context.repository.query(`SELECT
      SUM(CASE WHEN l.rating=1 THEN 1 ELSE 0 END) again,SUM(CASE WHEN l.rating=2 THEN 1 ELSE 0 END) hard,
      SUM(CASE WHEN l.rating=3 THEN 1 ELSE 0 END) good,SUM(CASE WHEN l.rating=4 THEN 1 ELSE 0 END) easy
    FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=?`).get(...args,from)!;
  const hourlyRows=context.repository.query(`SELECT CAST(strftime('%H',l.reviewed_at/1000,'unixepoch','localtime') AS INTEGER) hour,count(*) count
    FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=?
    GROUP BY hour`).all(...args,from) as Array<{hour:number;count:number}>;
  const hourly=Array.from({length:24},(_,hour)=>({label:String(hour).padStart(2,'0')+':00',count:hourlyRows.find(row=>Number(row.hour)===hour)?.count||0}));
  const addedRows=context.repository.query(`SELECT date(n.created_at/1000,'unixepoch','localtime') day,count(*) count
    FROM nodes n WHERE ${scope} AND n.created_at>=? GROUP BY day ORDER BY day`).all(...args,from) as Array<{day:string;count:number}>;
  const studiedDays=new Set((daily as Array<{day:string}>).map(row=>String(row.day))).size;
  // 2026-11-19：今日复习量按 Anki 的口径分开——复习卡（答题前 state=2）算「复习」，
  // 新卡/学习/重学（state=0/1/3）算「学习」，两者不混在一起。
  const todayStart=dayStartMs(now,context.settings.dayStartHour);
  const todayRows=context.repository.query(`SELECT json_extract(l.before_state,'$.state') stage,count(*) count
    FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=?
    GROUP BY stage`).all(...args,todayStart) as Array<{stage:number;count:number}>;
  const today={review:0,learning:0};
  for(const row of todayRows){if(Number(row.stage)===2)today.review+=Number(row.count);else today.learning+=Number(row.count);}
  return {title:input.folderId?context.profiles.configuration(input.folderId).path:t('全部牌组'),days,summary,daily,ratings,forecast,today,
    intervalBuckets,stabilityBuckets,difficultyBuckets,
    buttons:{again:Number(buttonRow.again||0),hard:Number(buttonRow.hard||0),good:Number(buttonRow.good||0),easy:Number(buttonRow.easy||0)},
    hourly,added:addedRows,studiedDays};
}

export function readingStatistics(context:StatsContext,input:{folderId?:string;days?:number}={}){
  const now=context.now(),days=Math.max(7,Math.min(366,Math.floor(Number(input.days)||30))),start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-days+1);
  const from=start.getTime(),args:any[]=[],where=["n.deleted_at IS NULL","n.kind!='folder'"];
  if(input.folderId){where.push(inDeck);args.push(input.folderId);}
  const scope=where.join(' AND ');
  const summary=context.repository.query(`SELECT SUM(CASE WHEN n.kind!='cloze' THEN 1 ELSE 0 END) total,
    SUM(CASE WHEN n.kind='topic' THEN 1 ELSE 0 END) topics,
    SUM(CASE WHEN n.kind='material' THEN 1 ELSE 0 END) materials,
    SUM(CASE WHEN n.kind!='cloze' AND s.enabled=1 THEN 1 ELSE 0 END) pushing,
    SUM(CASE WHEN n.kind!='cloze' AND COALESCE(s.enabled,0)=0 THEN 1 ELSE 0 END) stopped,
    SUM(CASE WHEN n.kind!='cloze' AND COALESCE(s.enabled,0)=0 AND (
      SELECT l.action FROM reading_log l WHERE l.node_id=n.id AND l.undone_at IS NULL ORDER BY l.reviewed_at DESC,l.event_id DESC LIMIT 1)='dismiss' THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN n.kind!='cloze' AND s.enabled=1 AND s.due_at<=? THEN 1 ELSE 0 END) dueToday
    FROM nodes n LEFT JOIN reading_state s ON s.node_id=n.id WHERE ${scope}`).get(now,...args)!;
  const actions=context.repository.query(`SELECT l.action,count(*) count FROM reading_log l JOIN nodes n ON n.id=l.node_id
    WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=? GROUP BY l.action`).all(...args,from) as Array<{action:string;count:number}>;
  const daily=context.repository.query(`SELECT date(l.reviewed_at/1000,'unixepoch','localtime') day,count(*) actions,
    SUM(CASE WHEN l.action='read' THEN 1 ELSE 0 END) reads,SUM(CASE WHEN l.action='dismiss' THEN 1 ELSE 0 END) done
    FROM reading_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=?
    GROUP BY day ORDER BY day`).all(...args,from) as Array<{day:string;actions:number;reads:number;done:number}>;
  const forecast=context.repository.query(`SELECT date(MAX(s.due_at,?)/1000,'unixepoch','localtime') day,count(*) count
    FROM reading_state s JOIN nodes n ON n.id=s.node_id WHERE ${scope} AND n.kind!='cloze' AND s.enabled=1 AND s.due_at<=?
    GROUP BY day ORDER BY day`).all(now,...args,now+3650*86400000) as Array<{day:string;count:number}>;
  const studiedDays=new Set(daily.map(row=>String(row.day))).size;
  const countOf=(action:string)=>Number(actions.find(row=>row.action===action)?.count||0);
  return {title:input.folderId?context.profiles.configuration(input.folderId).path:t('全部牌组'),days,summary,actions,
    daily,forecast,studiedDays,read:countOf('read'),later:countOf('later'),soon:countOf('soon'),done:countOf('dismiss')};
}

export async function simulateWorkload(context:StatsContext,folderId:string|null){
  const scope=deckScope(folderId),now=context.now(),day=86400000,days=30;
  const blocked=context.blockedJson();
  const rows=context.repository.query(`SELECT n.id,r.state,r.due_at,r.stage,r.algorithm_version,n.folder_id FROM review_cards r JOIN nodes n ON n.id=r.node_id
    WHERE r.enabled=1 AND n.kind='cloze' AND n.study_ready=1 AND n.deleted_at IS NULL AND ${unlocked} ${scope.filter}`).all(blocked,...scope.args);
  const profiles=context.profiles;
  const history=context.repository.query(`SELECT n.folder_id,l.rating,COUNT(*) AS count
    FROM review_log l JOIN nodes n ON n.id=l.node_id
    WHERE n.kind='cloze' AND n.deleted_at IS NULL AND l.undone_at IS NULL AND ${validRecall} ${scope.filter}
    GROUP BY n.folder_id,l.rating`).all(...scope.args);
  const countsByFolder=new Map<string,number[]>(),overall=[0,0,0,0];
  for(const row of history){
    const id=String(row.folder_id),index=Number(row.rating)-1,count=Number(row.count);
    const counts=countsByFolder.get(id)??[0,0,0,0];
    counts[index]+=count;overall[index]+=count;
    countsByFolder.set(id,counts);
  }
  const total=(counts:number[])=>counts.reduce((sum,count)=>sum+count,0);
  const historyCount=total(overall);
  const results=[];
  for(const retention of [.85,.9,.95]){
    const schedulers=new Map<string,Scheduler>(),counts=Array<number>(days).fill(0);
    let processed=0;
    for(const row of rows){
      if(++processed%256===0)await new Promise<void>(resolve=>setImmediate(resolve));
      const deckId=String(row.folder_id),profile=profiles.resolve(deckId),key=profileKey(profile);
      let scheduler=schedulers.get(key);
      if(!scheduler){
        scheduler=await context.schedulerFor({...profile,desiredRetention:retention,enableShortTerm:false});
        schedulers.set(key,scheduler);
      }
      let card=context.card(row),at=Math.max(now,Number(row.due_at));
      const local=countsByFolder.get(deckId);
      const ratings=local&&total(local)>=50?local:overall;
      const ratingCount=total(ratings);
      // Reuse each card's deterministic sequence in all retention scenarios.
      let seed=2166136261;
      for(const char of String(row.id))seed=Math.imul(seed^char.charCodeAt(0),16777619);
      while(at<now+days*day){
        counts[Math.floor((at-now)/day)]++;
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        const pick=seed/4294967296*ratingCount;
        const grade=!ratingCount?Rating.Good:pick<ratings[0]?Rating.Again:
          pick<ratings[0]+ratings[1]?Rating.Hard:pick<ratingCount-ratings[3]?Rating.Good:Rating.Easy;
        const next=scheduler.review({card,grade,now:new Date(at)}).card;
        card=context.card({...row,state:JSON.stringify(next),due_at:next.dueAt.getTime()});
        at=Math.max(at+day,card.dueAt.getTime());
      }
    }
    results.push({retention,total:counts.reduce((sum,count)=>sum+count,0),peak:Math.max(...counts)});
  }
  return {days,cards:rows.length,historyCount,results};
}
