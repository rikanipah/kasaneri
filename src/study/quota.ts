import type {Repository} from '../data/database';
import type {DeckProfiles} from '../folders/decks';
import type {StudySettings} from '../core/settings';

/** 每日额度：还剩多少张新卡 / 复习卡 / 待办卡。Infinity＝不限。 */
export type DailySlots={new:number;review:number;reading:number};

/** 额度计算要用到的 service 依赖，显式传进来，不回头读 StudyService 的私有状态。 */
export interface QuotaContext{
  repository:Repository;
  settings:StudySettings;
  profiles:DeckProfiles;
  now():number;
  active():{mode:'cards'|'reading';folderId:string|null};
}

// 每日额度来自未撤销的记录。短期学习或重学不占新卡和复习额度。
// 一天从 settings.dayStartHour 点开始（默认 4 点），review_log 统计与搁置的「次日」都按它算。
export function dayStartMs(now:number,hour:number):number{
  const date=new Date(now);date.setHours(hour,0,0,0);
  if(date.getTime()>now)date.setDate(date.getDate()-1);
  return date.getTime();
}

/** 牌组链：从当前牌组往上到顶层，不包含「全部」（null）。 */
export function deckChain(profiles:DeckProfiles,folderId:string|null):string[]{
  const ids:string[]=[];
  for(let id=folderId;id&&profiles.folders.has(id);id=profiles.folders.get(id)!.parentId)ids.push(id);
  return ids;
}

/**
 * 计算每个牌组（含 null＝全部）今天还剩多少额度。
 * 顺序：配置上限 → 扣掉今天已用 → 新卡再受复习额度约束（Anki 默认口径）。
 */
export function dailySlots(context:QuotaContext):Map<string|null,DailySlots>{
  const {repository,settings,profiles}=context;
  const start=dayStartMs(context.now(),settings.dayStartHour);
  // 2026-11-19：仅今日追加额度——只在当天（dayStart 相同）生效，跨天自动归零。
  const extraToday=Number(settings.todayExtraDay||0)===start;
  const extraNew=extraToday?Number(settings.todayExtraNew||0):0;
  const extraReview=extraToday?Number(settings.todayExtraReview||0):0;
  const slots=new Map<string|null,DailySlots>();
  for(const id of [null,...profiles.folders.keys()]){
    const profile=profiles.resolve(id);
    const baseNew=profile.newPerDay??Infinity,baseReview=profile.reviewPerDay??Infinity;
    slots.set(id,{new:baseNew===Infinity?baseNew:baseNew+extraNew,review:baseReview===Infinity?baseReview:baseReview+extraReview,reading:profile.readingPerDay??Infinity});
  }
  // The default unlimited queues need no daily log scan.
  const reading=context.active().mode==='reading';
  if([...slots.values()].every(slot=>reading?slot.reading===Infinity:slot.new===Infinity&&slot.review===Infinity))return slots;
  const usage=repository.query(`SELECT n.folder_id,
    SUM(CASE WHEN json_extract(l.before_state,'$.state')=0 THEN 1 ELSE 0 END) AS newCount,
    SUM(CASE WHEN json_extract(l.before_state,'$.state')=2 THEN 1 ELSE 0 END) AS reviewCount,
    0 AS readingCount
    FROM review_log l JOIN nodes n ON n.id=l.node_id
    WHERE l.reviewed_at>=? AND l.undone_at IS NULL GROUP BY n.folder_id
    UNION ALL
    SELECT n.folder_id,0,0,COUNT(*)
    FROM reading_log l JOIN nodes n ON n.id=l.node_id
    WHERE l.reviewed_at>=? AND l.undone_at IS NULL GROUP BY n.folder_id`).all(start,start);
  for(const row of usage){
    for(const id of [null,...deckChain(profiles,row.folder_id?String(row.folder_id):null)]){
      const remaining=slots.get(id)!;
      remaining.new=Math.max(0,remaining.new-Number(row.newCount));
      remaining.review=Math.max(0,remaining.review-Number(row.reviewCount));
      remaining.reading=Math.max(0,remaining.reading-Number(row.readingCount));
    }
  }
  // 2026-11-19：照 Anki 默认——新卡额度受复习额度约束：
  //   review -= 今日已学新卡数；new = min(new, review)。可在设置里关掉（等价 Anki 的
  //   「新卡不受复习上限影响」开关）。学习中的卡不占这两种额度。
  if(!settings.newCardsIgnoreReviewLimit){
    const learned=repository.query(`SELECT n.folder_id,
      SUM(CASE WHEN json_extract(l.before_state,'$.state')=0 THEN 1 ELSE 0 END) AS newCount
      FROM review_log l JOIN nodes n ON n.id=l.node_id
      WHERE l.reviewed_at>=? AND l.undone_at IS NULL GROUP BY n.folder_id`).all(start);
    for(const row of learned){
      for(const id of [null,...deckChain(profiles,row.folder_id?String(row.folder_id):null)]){
        const remaining=slots.get(id)!;
        if(remaining.review!==Infinity)remaining.review=Math.max(0,remaining.review-Number(row.newCount));
        if(remaining.new!==Infinity)remaining.new=Math.min(remaining.new,remaining.review);
      }
    }
  }
  return slots;
}

/** 这张卡要过的所有额度关：自己的牌组链，全部模式再加一个「全部」。 */
export function quotaChain(context:QuotaContext,folderId:string|null,slots:Map<string|null,DailySlots>):DailySlots[]{
  const chain:Array<string|null>=deckChain(context.profiles,folderId);
  if(!context.active().folderId)chain.push(null);
  return chain.map(id=>slots.get(id)!);
}

/**
 * 这张卡现在还有没有额度。学习卡分两种：当天内的学习步不占额度；
 * 跨日学习（day_learning=1，或旧数据按 due 推断）按「复习」占额度。
 */
export function hasDailyQuota(context:QuotaContext,folderId:string|null,stage:number,
  slots?:Map<string|null,DailySlots>,dueAt=0,dayLearning=0):boolean{
  const interday=(stage===1||stage===3)&&(dayLearning===1||
    (dueAt>0&&dueAt>=dayStartMs(context.now(),context.settings.dayStartHour)+86400000));
  const kind=context.active().mode==='reading'?'reading':stage===0?'new':stage===2||interday?'review':null;
  return !kind||quotaChain(context,folderId,slots??dailySlots(context)).every(remaining=>remaining[kind]>0);
}
