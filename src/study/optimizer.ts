import { t } from '../core/i18n';
// ===== 1.6 ⑥：FSRS 一键优化 + 留存度实验性测算 =====
// 使用官方原生组件 @open-spaced-repetition/binding（napi-rs 绑定，支持 FSRS-6/7）。
// 数据来源：统一 review_log（Anki 导入的历史也已按卡片写入这里），只读，不修改任何排程。
// 为什么用 createRequire 延迟加载而不是静态 import：
//   1) 原生 .node 不能被 esbuild 打包，静态 import 会让 worker 启动时就 require 组件，
//      组件缺失会拖垮整个 worker（数据库线程直接 fatal）；
//   2) 延迟加载把"缺组件"变成一条可读错误，只影响优化这一个动作。
// 打包：scripts/native-dependencies.mjs 会把该包（含 win32-x64-msvc 等平台包）复制进 resources/app。
import type {Repository} from '../data/database';

export const MIN_OPTIMIZATION_REVIEWS=50;

export interface OptimizeResult {
  weights:number[];
  reviewCount:number;   // 送入样本转换的评分条数
  trainingItemCount:number;
  cardCount:number;     // 涉及的卡片数
  durationMs:number;
  evaluation:{logLoss:number;rmseBins:number}|null;      // 训练出的参数在时间序列切分上的评测（evaluate 开关）
  currentEvaluation:{logLoss:number;rmseBins:number}|null;  // 当前参数在同一数据集上的评测
}

// Anki filtered-deck previews have type 3 and factor 0. Manual/reset and
// rescheduled records do not describe a recall attempt.
export const validRecall=`l.rating BETWEEN 1 AND 4 AND
  COALESCE(json_extract(l.details,'$.anki.type'),-1) NOT IN (4,5) AND NOT (
    COALESCE(json_extract(l.details,'$.anki.type'),-1)=3 AND
    COALESCE(json_extract(l.details,'$.anki.factor'),-1)=0
  )`;

export async function optimizeParameters(repository:Repository,input:{
  folderId:string|null;
  includeDescendants?:boolean;
  modelVersion:'FSRS-6'|'FSRS-7';
  enableShortTerm:boolean;
  currentWeights:number[]|null;
  evaluate?:boolean;        // true 时额外跑时间序列切分评测（留存度测算），耗时约为训练的一倍
  timezone?:string|number;   // 缺省 Asia/Shanghai（Anki 的"次日开始于 4 点"固定 4）
  nextDayStartsAt?:number;
  maxRows?:number;
}):Promise<OptimizeResult>{
  const begin=Date.now();
  if(!['FSRS-6','FSRS-7'].includes(input.modelVersion))throw Error(t('FSRS 模型无效。'));
  // 延迟加载并给出可读错误：组件缺失只影响优化动作，不让 worker 线程崩溃。
  let binding:any;
  try{binding=require('node:module').createRequire(__filename)('@open-spaced-repetition/binding');}
  catch{throw Error(t('未找到 FSRS 优化组件（@open-spaced-repetition/binding），请重新安装程序后再试。'));}
  const tz=input.timezone??'Asia/Shanghai',startAt=input.nextDayStartsAt??4;
  // 默认保留完整历史；调用方可显式指定采样上限。
  const limit=input.maxRows===undefined?-1:Math.max(8,Math.floor(Number(input.maxRows)||8));
  // 1) 收集牌组（含子牌组，folderId=null 表示全部牌组）的复习历史
  const conditions=["l.undone_at IS NULL","n.deleted_at IS NULL",validRecall],args:any[]=[];
  if(input.folderId){
    conditions.push(input.includeDescendants===false?'n.folder_id=?':
      `n.folder_id IN(WITH RECURSIVE decks(id) AS(SELECT id FROM nodes WHERE id=? AND kind='folder' AND deleted_at IS NULL
      UNION ALL SELECT c.id FROM nodes c JOIN decks p ON c.parent_id=p.id WHERE c.kind='folder' AND c.deleted_at IS NULL) SELECT id FROM decks)`);
    args.push(String(input.folderId));
  }
  const rows=repository.query(`SELECT l.node_id,l.reviewed_at,l.rating,l.before_state,l.details
    FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${conditions.join(' AND ')}
    ORDER BY l.reviewed_at DESC,l.event_id DESC LIMIT ?`).all(...args,limit) as Record<string,any>[];
  // 2) 生成标准优化器 CSV：card_id,review_time(ms),review_rating(1-4),review_state(0新/1学/2复习/3重学),review_duration(ms)
  //    Anki 的日志类型与训练 CSV 的卡片状态使用不同的编号。
  //    review_duration 取 details.anki.time 或 details.durationMs，没有则 0（只是可选统计量）。
  const stateOf=(row:Record<string,any>,type:unknown):number=>{
    if(type===0)return 1; // Anki learning → Learning
    if(type===1||type===3)return 2; // Review or rescheduled filtered review
    if(type===2)return 3; // Anki relearning → Relearning
    try{const state=JSON.parse(String(row.before_state||'null'))?.state;
      if(typeof state==='number'&&state>=0&&state<=3)return state;
      if(typeof state==='string'){const at=['New','Learning','Review','Relearning'].indexOf(state);if(at>=0)return at;}}catch{}
    return 2;
  };
  const lines=['card_id,review_time,review_rating,review_state,review_duration'];
  const cards=new Set<string>();
  for(const row of rows){
    const id=String(row.node_id),rating=Number(row.rating),time=Number(row.reviewed_at);
    if(!/^[0-9]+$/.test(id)||![1,2,3,4].includes(rating)||!Number.isFinite(time)||time<=0)continue;
    let details:any;
    try{details=JSON.parse(String(row.details||'{}'));}catch{}
    const ankiTime=details?.anki?.time;
    const duration=typeof ankiTime==='number'&&ankiTime>0?ankiTime:details?.durationMs;
    const durationMs=typeof duration==='number'&&duration>0?Math.round(duration):0;
    lines.push(`${id},${time},${rating},${stateOf(row,details?.anki?.type)},${durationMs}`);
    cards.add(id);
  }
  if(lines.length-1<MIN_OPTIMIZATION_REVIEWS)throw Error(t('可用复习记录太少（至少 {0} 条），暂不优化。',MIN_OPTIMIZATION_REVIEWS));
  // 3) CSV → 训练项（带窗口化卡片 ID；FSRS-7 用分数学习日归一化，FSRS-6 用整天数）
  const converted=binding.convertCsvToFsrsItemsWithCardIds(new TextEncoder().encode(lines.join('\n')),startAt,tz,input.modelVersion) as {items:any[];cardIds:number[]};
  if(!converted.items.length)throw Error(t('没有可用的训练记录。'));
  const options={modelVersion:input.modelVersion,cardIds:converted.cardIds,enableShortTerm:!!input.enableShortTerm,
    // The native binding uses this value as its progress polling interval.
    numRelearningSteps:input.enableShortTerm?1:0,timeout:100};
  const weights=(await binding.computeParameters(converted.items,options)) as number[];
  // 4) 留存度实验性测算：时间序列切分评测（对标 Anki「帮我决定（实验性）」的指标来源）。
  //    与训练同样昂贵（44k 条约 3 分钟），因此由 evaluate 开关单独触发。
  let evaluation:OptimizeResult['evaluation']|null=null,currentEvaluation:OptimizeResult['currentEvaluation']=null;
  if(input.evaluate){
    evaluation=await binding.evaluateWithTimeSeriesSplits(converted.items,options);
    if(input.currentWeights&&input.currentWeights.length){
      try{currentEvaluation=new binding.FSRSBinding(input.currentWeights).evaluate(converted.items,converted.cardIds);}
      catch{/* 当前参数与模型维度不符时留空，不阻断优化结果 */}
    }
  }
  return {weights,evaluation,currentEvaluation,reviewCount:lines.length-1,trainingItemCount:converted.items.length,
    cardCount:cards.size,durationMs:Date.now()-begin};
}

// ===== 1.15：留存度快速统计（替代原先"训练+时间序列评测"的慢路径）=====
// 口径对齐 Anki「记忆保留率」：只统计间隔 ≥ 1 天的复习（排除学习步骤内的短间隔），
// 通过 = 评分 > 重来。按今天/昨天/上周/上个月/近一年/全部分组，并按难度拆欠熟练/已熟练。
export interface RetentionRow{key:string;label:string;pass:number;total:number;rate:number|null;}
export interface RetentionReport{
  overall:RetentionRow;
  periods:RetentionRow[];
  byDifficulty:{hard:RetentionRow;easy:RetentionRow};
  durationMs:number;
}
export function retentionReport(repository:Repository,input:{folderId?:string|null;now?:number}={}):RetentionReport{
  const begin=Date.now(),now=Number(input.now)||Date.now(),day=86400000;
  const conditions=["l.undone_at IS NULL","n.deleted_at IS NULL",validRecall],args:any[]=[];
  if(input.folderId){
    conditions.push(`n.folder_id IN(WITH RECURSIVE decks(id) AS(SELECT id FROM nodes WHERE id=? AND kind='folder' AND deleted_at IS NULL
      UNION ALL SELECT c.id FROM nodes c JOIN decks p ON c.parent_id=p.id WHERE c.kind='folder' AND c.deleted_at IS NULL) SELECT id FROM decks)`);
    args.push(String(input.folderId));
  }
  // elapsed：本次复习距上次复习的天数。原生日志看 before_state.lastReviewAt，
  // Anki 导入的历史看 details.anki.lastIvl（天；学习步骤为负数或 0），两者都缺则跳过。
  const rows=repository.query(`SELECT l.reviewed_at AS at,l.rating AS rating,
      json_extract(l.before_state,'$.lastReviewAt') AS lastReview,
      CAST(json_extract(l.details,'$.anki.lastIvl') AS REAL) AS ankiLastIvl,
      json_extract(l.details,'$.anki.type') AS ankiType,
      CAST(json_extract(l.after_state,'$.difficulty') AS REAL) AS difficulty
    FROM review_log l JOIN nodes n ON n.id=l.node_id
    WHERE ${conditions.join(' AND ')}`).all(...args) as Array<Record<string,any>>;
  // 周期窗口：今天 / 昨天 / 上周（7–14 天前）/ 上个月（近 30 天）/ 近一年（近 365 天）。
  // 每个窗口有 [min,max)，避免"今天"把以前的复习也算进去。
  const startOfDay=(daysAgo:number)=>{
    const date=new Date(now);
    date.setHours(0,0,0,0);
    date.setDate(date.getDate()-daysAgo);
    return date.getTime();
  };
  const todayStart=startOfDay(0);
  const buckets:{[key:string]:{min:number;max:number;label:string}}={
    today:{min:todayStart,max:startOfDay(-1),label:t('今天')},
    yesterday:{min:startOfDay(1),max:todayStart,label:t('昨天')},
    lastWeek:{min:startOfDay(14),max:startOfDay(7),label:t('上周')},
    lastMonth:{min:now-30*day,max:now,label:t('上个月')},
    lastYear:{min:now-365*day,max:now,label:t('近一年')},
    all:{min:0,max:Number.MAX_SAFE_INTEGER,label:t('全部')},
  };
  const acc:Record<string,{pass:number;total:number}>={};
  const hard={pass:0,total:0},easy={pass:0,total:0};
  const overall={pass:0,total:0};
  for(const row of rows){
    const at=Number(row.at),last=row.lastReview?new Date(String(row.lastReview)).getTime():0;
    const interval=Number(row.ankiLastIvl);
    const eligible=last?at-last>=day:row.ankiType===1||interval>=1||interval<=-86400;
    if(!eligible)continue;
    const pass=Number(row.rating)>1;
    overall.total++;if(pass)overall.pass++;
    for(const [key,bucket] of Object.entries(buckets)){
      if(at>=bucket.min&&at<bucket.max){const cell=acc[key]||{pass:0,total:0};cell.total++;if(pass)cell.pass++;acc[key]=cell;}
    }
    const d=Number(row.difficulty);
    if(Number.isFinite(d)&&d>0){(d>5?hard:easy).total++;if(pass)(d>5?hard:easy).pass++;}
  }
  const toRow=(key:string,label:string,cell:{pass:number;total:number}|undefined):RetentionRow=>({
    key,label,pass:cell?.pass||0,total:cell?.total||0,rate:cell&&cell.total?cell.pass/cell.total:null});
  const periods=['today','yesterday','lastWeek','lastMonth','lastYear'].map(key=>toRow(key,buckets[key].label,acc[key]));
  return {
    overall:toRow('all',t('全部'),overall),
    periods,
    byDifficulty:{hard:toRow('hard',t('欠熟练（难度>5）'),hard),easy:toRow('easy',t('已熟练（难度≤5）'),easy)},
    durationMs:Date.now()-begin,
  };
}
// 1.125：原先这里有一个 optimizeDecks()「一次性把全部牌组训练完」的批量实现，
// 但设置页的「一键全局优化」实际是在渲染层循环调用 optimizeDeckList + optimizeDeck（能显示逐牌组进度、
// 可中途停止），批量版本从来没有调用方，已删除，避免两套语义漂移。
