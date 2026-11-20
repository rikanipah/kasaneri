import {DefaultScheduler,Rating} from 'ts-fsrs';
import type {Material} from '../core/model';
import type {Repository} from '../data/database';
import type {DeckProfiles} from '../folders/decks';
import {profileKey} from '../folders/decks';
import type {StudySettings} from '../core/settings';
import {readSchedule} from '../sync/study-changes';
import {minimumReviewFuzzInterval} from './fuzz';
import {dayStartMs} from './quota';

type Row=Record<string,any>;
type Scheduler=Awaited<ReturnType<typeof DefaultScheduler>>;

/** 评价写库要用的 service 依赖：写库、调度器、fuzz/负载均衡这几个能力。 */
export interface GradeContext{
  repository:Repository;
  settings:StudySettings;
  profiles:DeckProfiles;
  card(row:Row):any;
  schedulerForDeck(folderId:string|null):Scheduler;
  /** study.ts 的 reviewIntervalDays：负载均衡优先、否则 fuzz。 */
  reviewIntervalDays(node:Material,dueAt:number,raw:number,minimum:number,maximum:number,now:number,reps:number):number;
  /** study.ts 的 loadBalanceAdjust：让额度缓存跟着同一次事务里的写入走。 */
  loadBalanceAdjust(presetKey:string,stage:unknown,enabled:unknown,dueAt:unknown,delta:number):void;
}

export interface FsrsGradeInput{
  node:Material;
  before:Row;
  rating:1|2|3|4;
  now:number;
  eventId:string;
  details:Record<string,unknown>;
}

/** 2026-11-19：把 '1m'/'10m'/'1h' 这类步骤文本转成毫秒。 */
export function stepTextToMs(step:string|undefined):number{
  const match=String(step??'').match(/^([\d.]+)\s*([smhd])$/i);
  if(!match)return 0;
  const value=Number(match[1]);
  if(!Number.isFinite(value))return 0;
  const unit=match[2].toLowerCase() as 's'|'m'|'h'|'d';
  return value*({s:1000,m:60000,h:3600000,d:86400000}[unit]??0);
}

/**
 * FSRS 评价落库：算下一步状态 → 按 Anki 修正 Hard 步长/学习步抖动/复习 fuzz/负载均衡 →
 * 统一到日切点 → 写 review_cards → leech 处理 → 写 review_log。
 * 调用方负责事务、会话与撤销记录。
 */
export function applyFsrsGrade(context:GradeContext,input:FsrsGradeInput):void{
  const {node,before,rating,now,eventId,details}=input;
  const {repository,settings,profiles}=context;
  const profile=profiles.resolve(node.folderId);
  const card=context.card(before),lapsesBefore=card.lapses;
  const result=context.schedulerForDeck(node.folderId).review({card,grade:rating,now:new Date(now)});
  // 2026-11-19：照 Anki 修正两处——
  // ① Hard 在非首步应停留「当前步」，ts-fsrs 恒用 (步1+步2)/2；
  // ② 学习步到期时间要加随机抖动（最多 +25%，上限 5 分钟），Again 也加。
  let dueAt=result.card.dueAt.getTime();
  const stateBefore=Number(card.state),stepBefore=Number((card as any).learningStep??before.learning_step??0);
  const learningResult=result.card.state===1||result.card.state===3;
  if(learningResult){
    if(rating===2&&(stateBefore===1||stateBefore===3)&&stepBefore>0){
      const steps=(stateBefore===3?profile.relearningSteps:profile.learningSteps)||[];
      const current=steps[Math.min(stepBefore,steps.length-1)];
      const ms=stepTextToMs(current);
      if(ms>0)dueAt=now+ms;
    }
  }
  // 2026-11-19：学习步到期加确定性的随机抖动（0~+25%，上限 5 分钟），种子 = 卡片 id + 已答次数，
  // 与 Anki 的 fuzz seed 一致；测试里可关掉。
  if((result.card.state===1||result.card.state===3)&&settings.learningStepFuzz!==false){
    const base=dueAt-now;
    if(base>0){
      const seed=String(node.id)+String((result.card as any).reps??0);
      let hash=2166136261;
      for(let i=0;i<seed.length;i++){hash^=seed.charCodeAt(i);hash=Math.imul(hash,16777619)>>>0;}
      dueAt=now+base+Math.floor((hash/4294967296)*Math.min(base*0.25,300000));
    }
  }
  // 2026-11-19：复习卡的下次间隔按 Anki 的 with_review_fuzz——先算 fuzz 窗口，
  // 有负载均衡就按窗口加权挑天，否则用卡片确定的随机因子在窗口内取一天。
  if(result.card.state===2){
    const scheduled=Number((result.card as any).scheduled_days);
    const raw=Number.isFinite(scheduled)&&scheduled>0?scheduled:Math.round((dueAt-now)/86400000);
    const maximum=Math.max(1,Math.round(Number(settings.maximumInterval)||36500));
    const previous=Math.max(1,Math.round(Number((card as any).scheduledDays??raw)));
    const minimum=Math.max(1,Math.min(maximum,minimumReviewFuzzInterval(raw,previous,maximum)));
    const ideal=Math.min(maximum,Math.max(minimum,Math.round(raw)));
    const days=context.reviewIntervalDays(node,dueAt,raw,minimum,maximum,now,Number((result.card as any).reps??0));
    if(days!==ideal)dueAt=dueAt+(days-ideal)*86400000;
  }
  // 2026-11-19：把「跨日学习」写成独立标记，替代按 due 推断（用对齐前的 dueAt 判定）。
  const dayLearning=((result.card.state===1||result.card.state===3)&&dueAt>=dayStartMs(now,settings.dayStartHour)+86400000)?1:0;
  // 2026-11-19（D3）：复习卡与跨日学习的到期日按「天」对齐到日切点——Anki 的 due 是天序号，
  // 到那天 4 点就算到期，而不是等到当时那个钟点。
  if(result.card.state===2||dayLearning===1)dueAt=dayStartMs(dueAt,settings.dayStartHour);
  // 状态 JSON 里的 dueAt 必须和库里一致（放在对齐之后），否则同步重放与卡片信息会拿到旧日期。
  if(result.card.dueAt.getTime()!==dueAt)(result.card as any).dueAt=new Date(dueAt);
  const version='ts-fsrs/6.0.0:'+(profile.fsrsVersion||'FSRS-6'),state=JSON.stringify(result.card);
  const learningStep=Math.max(0,Math.floor(Number((result.card as any).learningStep??0)))||0;
  context.loadBalanceAdjust(profileKey(profile),before.stage,before.enabled,before.due_at,-1);
  repository.query('UPDATE review_cards SET state=?,due_at=?,stage=?,day_learning=?,learning_step=?,revision=revision+1,algorithm_version=?,updated_at=? WHERE node_id=?')
    .run(state,dueAt,result.card.state,dayLearning,learningStep,version,now,node.id);
  const lapses=result.card.lapses,threshold=profile.leechThreshold;
  let leechEffect,reviewEnabled=1;
  if(rating===Rating.Again&&lapses>lapsesBefore&&threshold>0&&lapses>=threshold&&(lapses-threshold)%Math.ceil(threshold/2)===0){
    const previous=readSchedule(repository,node.id)!;
    repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'leech')").run(node.id);
    if(profile.leechAction==='suspend'){
      reviewEnabled=0;
      repository.query('UPDATE review_cards SET enabled=0 WHERE node_id=?').run(node.id);
      repository.query('UPDATE reading_state SET enabled=1,due_at=MIN(due_at,?),revision=revision+1 WHERE node_id=?').run(now,node.id);
    }
    const after=readSchedule(repository,node.id)!;
    leechEffect={previous:{tag:previous.leech,reviewEnabled:previous.review!.enabled,pushEnabled:previous.reading.enabled,pushDueAt:previous.reading.due_at},
      after:{tag:after.leech,reviewEnabled:after.review!.enabled,pushEnabled:after.reading.enabled,pushDueAt:after.reading.due_at}};
  }
  context.loadBalanceAdjust(profileKey(profile),result.card.state,reviewEnabled,dueAt,1);
  repository.query('INSERT INTO review_log(event_id,node_id,reviewed_at,rating,algorithm_version,before_state,after_state,details) VALUES(?,?,?,?,?,?,?,?)')
    .run(eventId,node.id,now,rating,version,before.state,state,JSON.stringify({revlog:result.revlog,settings:profile,deckId:node.folderId,...details,leechEffect}));
}
