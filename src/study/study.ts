import { t } from '../core/i18n';
import { constrainedFuzzBounds, stableRandom } from './fuzz';
import {DefaultScheduler,type DefaultSchedulerCard,Rating} from 'ts-fsrs';
import {migrateFSRS6Parameters} from 'ts-fsrs/models/fsrs-6';
import {randomUUID} from 'node:crypto';
import {studyReady} from '../core/image-occlusion';
import {Repository} from '../data/database';
import {CardDependencies} from './card-dependencies';
import {DEFAULT_SETTINGS,normalizeSettings,normalizeShortcuts,normalizeReviewOverrides,type StudySettings,type ReviewSettings} from '../core/settings';
import {DeckProfiles,profileKey} from '../folders/decks';
import {dayStartMs,dailySlots,hasDailyQuota,type DailySlots,type QuotaContext} from './quota';
import {buildQueue,unlocked,deckScope,type QueueContext} from './queue';
import {applyFsrsGrade,type GradeContext} from './grade';
import {againChildBatch,childOperations,findUndoableOperation,restoreOperation} from './undo';
import {computeCounts,availableToday,cardInfo,statistics,readingStatistics,simulateWorkload,type StatsContext} from './stats';
import {pushPriority,pushSchedule,type PushContext} from '../reading/push';
import {applyReadingAction,setReadingPosition,type ReadingAction} from '../reading/actions';
import {readSchedule,recordStudyChange,recordTagChange,sameSchedule,writeSchedule,type Schedule} from '../sync/study-changes';
import type {AgainChildCandidate,AgainChildSelection,FolderCounts,Material,PrerequisiteChange,PrerequisiteState,StudyItem,StudySnapshot} from '../core/model';

type Scheduler=Awaited<ReturnType<typeof DefaultScheduler>>;
type Row=Record<string,any>;
type BuryChange={id:string;before:Schedule;after:Schedule};
type Submission={sessionId:string;token:string;revision:number};
type Session={id:string;mode:'cards'|'reading';folderId:string|null;queue:string[];current:string|null;token:string;
  completed:number;history:string[];submitted:Set<string>;shownAt:number;postponed:number};
// 撤销/「重来」批次的前缀在 ./undo.ts（againChildBatch）
/** 把一条排程变更翻译成复习记录里的一行文字（这些事件没有评价）。 */

export class StudyService {
  private session:Session|null=null;
  private statsCache:{at:number;value:Record<string,FolderCounts>;total:FolderCounts;direct:Map<string,DailySlots>}|null=null;
  private profiles!:DeckProfiles;
  private schedulers=new Map<string,Scheduler>();
  private readonly dependencies:CardDependencies;
  private dependencyCache:{ids:Set<string>;json:string}|null=null;
  // 2026-11-19：负载均衡用的「未来每天到期量」。按牌组缓存，invalidate() 时清空。
  private loadBalanceCache:{dayStart:number;counts:Map<string,Map<number,number>>}|null=null;
  private constructor(readonly repository:Repository,private settings:StudySettings,private now:()=>number){
    // 解锁条件按先修卡所属牌组的 masteryReps 判定，没设置时回落到全局值。
    this.dependencies=new CardDependencies(repository,id=>{
      const folder=repository.query('SELECT folder_id FROM nodes WHERE id=?').get(id)?.folder_id;
      return this.profiles?this.profiles.resolve(folder?String(folder):null).masteryReps:this.settings.masteryReps;
    });
  }
  static async create(repository:Repository,now:()=>number=Date.now):Promise<StudyService>{
    // Existing settings used zero for unlimited. Convert those values only once per library.
    if(!repository.getSetting('dailyLimitValuesV1'))repository.transaction(()=>{
      for(const path of ['$.newPerDay','$.reviewPerDay']){
        repository.query("UPDATE settings SET value=json_set(value,?,NULL) WHERE key='studySettings' AND json_extract(value,?)=0").run(path,path);
        repository.query('UPDATE deck_settings SET overrides=json_set(overrides,?,NULL) WHERE json_extract(overrides,?)=0').run(path,path);
      }
      repository.setSetting('dailyLimitValuesV1',true);
    });
    const stored=repository.getSetting('studySettings') as Record<string,unknown>|null;
    const settings=normalizeSettings({...DEFAULT_SETTINGS,...stored as object,
      fontSize:repository.getSetting('fontSize')||DEFAULT_SETTINGS.fontSize,theme:repository.getSetting('theme')||DEFAULT_SETTINGS.theme});
    // 旧版 及以前保存的 studySettings 没有「每日上限」字段，也没有真正用过学习步骤
    // （enableShortTerm 恒为 false）。这类老配置一次性升级成三态：默认打开学习步骤，之后用户在设置里关掉就保持关。
    if(stored&&!('newPerDay' in stored)&&settings.enableShortTerm===false){
      settings.enableShortTerm=true;
      repository.setSetting('studySettings',settings);
    }
    // leech 阈值「本次和以后默认都是 4」——把老库里仍是旧默认 8 的一次性改成 4
    if(stored&&!repository.getSetting('leechDefault4')&&Number(settings.leechThreshold)===8){
      settings.leechThreshold=4;
      repository.setSetting('studySettings',settings);
      repository.setSetting('leechDefault4',true);
    }
    const service=new StudyService(repository,settings,now);
    await service.hierarchyChanged();
    if(!repository.getSetting('studySeededV3')){
      const missing=repository.db.prepare(`SELECT n.id FROM nodes n
        LEFT JOIN reading_state s ON s.node_id=n.id LEFT JOIN review_cards r ON r.node_id=n.id
        WHERE n.kind!='folder' AND n.deleted_at IS NULL AND((n.kind='cloze' AND r.node_id IS NULL)OR(n.kind!='cloze' AND s.node_id IS NULL))`).all();
      repository.transaction(()=>{for(const row of missing)service.register(String(row.id));repository.setSetting('studySeededV3',true);});
    }
    return service;
  }
  private static schedulerFor(settings:ReviewSettings){return DefaultScheduler({version:settings.fsrsVersion||'FSRS-6',desiredRetention:settings.desiredRetention,
    ...(settings.fsrsWeights?.length?{weights:settings.fsrsVersion==='FSRS-6'?migrateFSRS6Parameters(settings.fsrsWeights):settings.fsrsWeights}:{}),
    maximumInterval:settings.maximumInterval,enableShortTerm:settings.enableShortTerm,enableFuzz:false,
    learningSteps:settings.enableShortTerm?(settings.learningSteps||['1m','10m']) as any:[],relearningSteps:settings.enableShortTerm?(settings.relearningSteps||['10m']) as any:[],allowModelOverride:false});}
  config(){return {settings:this.settings,shortcuts:normalizeShortcuts(this.repository.getSetting('shortcuts')),algorithm:'ts-fsrs/6.0.0:'+this.settings.fsrsVersion};}
  private async prepareProfiles(profiles:DeckProfiles){
    for(const value of profiles.all()){const key=profileKey(value);if(!this.schedulers.has(key))this.schedulers.set(key,await StudyService.schedulerFor(value));}
  }
  // ===== Anki 的「更改时将卡片重新排程」=====
  // 只在设置里打开时生效：用新参数按每张复习卡当前的记忆状态（stability）重算下次间隔，
  // 到期日 = 上次复习时间 + 新间隔；学习/重学卡不重排，记忆状态不重置。
  private rescheduleCards(folderId:string|null):number{
    const scope=folderId?deckScope(folderId):{filter:'',args:[] as any[]};
    const rows=this.repository.query(`SELECT r.node_id AS id,r.state,n.folder_id AS folderId FROM review_cards r JOIN nodes n ON n.id=r.node_id
      WHERE n.kind='cloze' AND n.deleted_at IS NULL AND r.enabled=1 AND r.stage=2 ${scope.filter}`).all(...scope.args) as Row[];
    const now=this.now();let changed=0;
    this.repository.transaction(()=>{
      for(const row of rows){
        let state:any;try{state=JSON.parse(String(row.state));}catch{continue;}
        const stability=Number(state?.stability);
        if(!Number.isFinite(stability)||stability<=0)continue;
        const profile=this.profiles.resolve((row.folderId as string|null)||null);
        const interval=StudyService.nextInterval(this.schedulerForDeck((row.folderId as string|null)||null),state,profile.desiredRetention);
        if(!Number.isFinite(interval)||interval<=0)continue;
        const last=state.lastReviewAt?new Date(state.lastReviewAt).getTime():now;
        // 2026-11-19（D3）：重算的到期日同样对齐到那天的日切点。
        const due=dayStartMs(Math.round(last+interval*86400000),this.settings.dayStartHour);
        if(Number(row.due_at)===due)continue;
        const id=String(row.id),before=readSchedule(this.repository,id);
        this.repository.query('UPDATE review_cards SET due_at=?,revision=revision+1,updated_at=? WHERE node_id=?').run(due,now,id);
        const after=readSchedule(this.repository,id);
        if(before&&after)recordStudyChange(this.repository,id,now,before,after,{id:'reschedule-'+id+'-'+now,kind:'fsrs',at:now});
        changed++;
      }
    });
    return changed;
  }
  /** 用当前 FSRS 模型按「目标记忆率」反算下次间隔（天）。FSRS-6 收 stability，FSRS-7 收 state。 */
  private static nextInterval(scheduler:any,state:any,retention:number):number{
    const model=scheduler?.model;
    if(!model)return 0;
    for(const input of [Number(state?.stability),state]){
      try{const value=model.next_interval(input,retention);if(Number.isFinite(value)&&value>0)return value;}catch{/* 换一种入参再试 */}
    }
    return 0;
  }
  private schedulerForDeck(folderId:string|null){return this.schedulers.get(profileKey(this.profiles.resolve(folderId)))!;}
  async hierarchyChanged(){this.invalidate();const profiles=new DeckProfiles(this.repository,this.settings);await this.prepareProfiles(profiles);this.profiles=profiles;this.invalidate();if(this.session)this.session.queue=[];}
  deckConfig(folderId:string){return this.profiles.configuration(folderId);}
  private schedulerSettingsChanged(profiles:DeckProfiles):boolean{
    return [null,...profiles.folders.keys()].some(id=>profileKey(this.profiles.resolve(id))!==profileKey(profiles.resolve(id)));
  }
  async saveDeckConfig(input:{folderId:string;overrides:unknown}){
    this.profiles.configuration(input.folderId);const overrides=normalizeReviewOverrides(input.overrides);
    const profiles=new DeckProfiles(this.repository,this.settings,{folderId:input.folderId,overrides});await this.prepareProfiles(profiles);
    if(overrides)this.repository.query('INSERT INTO deck_settings(folder_id,overrides,updated_at) VALUES(?,?,?) ON CONFLICT(folder_id) DO UPDATE SET overrides=excluded.overrides,updated_at=excluded.updated_at')
      .run(input.folderId,JSON.stringify(overrides),this.now());
    else this.repository.query('DELETE FROM deck_settings WHERE folder_id=?').run(input.folderId);
    const reschedule=this.settings.rescheduleOnChange&&this.schedulerSettingsChanged(profiles);
    this.profiles=profiles;if(this.session)this.session.queue=[];
    if(reschedule)this.rescheduleCards(input.folderId);
    return this.deckConfig(input.folderId);
  }
  async saveConfig(input:{settings:unknown;shortcuts:unknown}){
    const previous=this.settings;
    const settings=normalizeSettings(input.settings),shortcuts=normalizeShortcuts(input.shortcuts);
    const profiles=new DeckProfiles(this.repository,settings);await this.prepareProfiles(profiles);
    const now=this.now();
    this.repository.transaction(()=>{
      this.repository.setSetting('studySettings',settings);this.repository.setSetting('shortcuts',shortcuts);
      this.repository.setSetting('fontSize',settings.fontSize);this.repository.setSetting('theme',settings.theme);
      this.repository.recordSyncedSettingChanges(previous,settings,now);
    });
    const reschedule=settings.rescheduleOnChange&&this.schedulerSettingsChanged(profiles);
    this.settings=settings;this.profiles=profiles;this.invalidate();if(this.session)this.session.queue=[];
    if(reschedule)this.rescheduleCards(null);
    return this.config();
  }
  /** 同步写入全局设置或解决设置冲突后刷新内存配置、牌组调度器与必要的重排。 */
  async reloadSettings(rescheduleIfEnabled=true){
    const stored=this.repository.getSetting('studySettings') as Record<string,unknown>|null;
    const settings=normalizeSettings({...DEFAULT_SETTINGS,...(stored&&typeof stored==='object'&&!Array.isArray(stored)?stored:{}),
      fontSize:this.repository.getSetting('fontSize')||DEFAULT_SETTINGS.fontSize,
      theme:this.repository.getSetting('theme')||DEFAULT_SETTINGS.theme});
    const profiles=new DeckProfiles(this.repository,settings);await this.prepareProfiles(profiles);
    const reschedule=rescheduleIfEnabled&&settings.rescheduleOnChange&&this.schedulerSettingsChanged(profiles);
    this.settings=settings;this.profiles=profiles;this.invalidate();if(this.session)this.session.queue=[];
    if(reschedule)this.rescheduleCards(null);
    return this.config();
  }
  invalidate(){this.statsCache=null;this.dependencyCache=null;this.loadBalanceCache=null;}
  /** 2026-11-19（D6）：搁置到期后连 `buried` 标签一起清掉，和 Anki 日切解封一致；每天最多跑一次。
   *  清理本身记一条 tags 变更，随同步过去，对端的标签也一起消失。 */
  private buriedCleanupAt=0;
  private cleanupBuriedTags(now:number){
    const start=dayStartMs(now,this.settings.dayStartHour);
    if(start<=this.buriedCleanupAt)return;
    this.buriedCleanupAt=start;
    const rows=this.repository.query(`SELECT node_id FROM review_cards WHERE COALESCE(buried_until,0)<=?
        AND node_id IN(SELECT node_id FROM node_tags WHERE tag='buried')
      UNION SELECT node_id FROM reading_state WHERE COALESCE(buried_until,0)<=?
        AND node_id IN(SELECT node_id FROM node_tags WHERE tag='buried')`).all(now,now) as Row[];
    if(!rows.length)return;
    this.repository.transaction(()=>{
      for(const row of rows){
        const id=String(row.node_id),before=readSchedule(this.repository,id);
        this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='buried'").run(id);
        const after=readSchedule(this.repository,id);
        if(before&&after)recordStudyChange(this.repository,id,now,before,after,
          {id:'unbury-rollover-'+id+'-'+now,kind:'fsrs',at:now});
      }
    });
  }
  private blockedCards(){
    if(!this.dependencyCache){
      const ids=this.dependencies.blocked();
      this.dependencyCache={ids,json:JSON.stringify([...ids])};
    }
    return this.dependencyCache;
  }
  private prerequisites(id:string):PrerequisiteState{
    const blocked=this.blockedCards().ids;
    return {blocked:blocked.has(id),cards:this.dependencies.list(id).map(card=>({...card,blocked:blocked.has(card.id)}))};
  }
  setPrerequisite(input:PrerequisiteChange):PrerequisiteState{
    this.dependencies.setOverride(input.id,input.prerequisiteId,input.mode,input.expected);
    this.invalidate();
    if(this.session)this.session.queue=[];
    return this.prerequisites(input.id);
  }
  register(id:string){
    const node=this.repository.query('SELECT kind,folder_id FROM nodes WHERE id=? AND deleted_at IS NULL').get(id);if(!node||node.kind==='folder')return;
    const now=this.now();
    if(node.kind==='cloze'){
      const card={...this.schedulerForDeck(node.folder_id?String(node.folder_id):null).newCard({now:new Date(now)}),cardId:id};
      this.repository.query(`INSERT OR IGNORE INTO review_cards(node_id,algorithm,algorithm_version,state,due_at,updated_at,stage,enabled)
        VALUES(?,'fsrs',?,?,?,?,0,0)`).run(id,'ts-fsrs/6.0.0:'+(this.profiles.resolve(node.folder_id?String(node.folder_id):null).fsrsVersion||'FSRS-6'),JSON.stringify(card),now,now);
    }
    const active=node.kind==='cloze'&&!!this.repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(id)?.enabled;
    this.repository.query('INSERT OR IGNORE INTO reading_state(node_id,due_at,enabled) VALUES(?,?,?)').run(id,now,active?0:1);
    this.invalidate();
  }
  setPriority(id:string,priority:number|null,reading?:Submission&{position:number}){
    if(priority!==null&&(!Number.isInteger(priority)||priority<0||priority>9))throw Error(t('优先级需要 0 到 9，或选择继承。'));
    const session=this.session;
    if(reading){
      if(session?.mode!=='reading'||session.current!==id)throw Error(t('复习会话已改变。'));
      const {node}=this.currentSubmission(session,reading);
      if(node.priority===priority)return this.snapshot();
    }
    this.repository.transaction(()=>{
      if(!this.repository.query('UPDATE nodes SET priority=? WHERE id=? AND deleted_at IS NULL').run(priority,id).changes)throw Error(t('项目已删除。'));
      if(reading)this.setReadingPosition(id,reading.position);
    });
    if(session?.mode!=='reading')return;
    session.queue=reading?this.candidates():[];
    if(!reading)return;
    // Keep the updated order, but give the next due card one turn if this card still ranks first.
    if(session.queue[0]===id&&session.queue.length>1)[session.queue[0],session.queue[1]]=[session.queue[1],session.queue[0]];
    this.next();
    return this.snapshot();
  }
  setEnabled(id:string,enabled:boolean){
    const node=this.repository.getNode(id);if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    this.register(id);const table=node.kind==='cloze'?'review_cards':'reading_state';
    if(node.kind==='cloze'&&enabled&&!this.repository.query('SELECT study_ready FROM nodes WHERE id=?').get(id)?.study_ready)throw Error(t('请先补全检测内容和答案，再加入复习。'));
    const change=this.repository.transaction(()=>{
      const before=readSchedule(this.repository,id)!;
      if((node.kind==='cloze'?before.review?.enabled:before.reading.enabled)===Number(enabled))return null;
      const now=this.now();
      this.repository.query(`UPDATE ${table} SET enabled=?,revision=revision+1 WHERE node_id=?`).run(enabled?1:0,id);
      if(node.kind==='cloze')this.repository.query('UPDATE reading_state SET enabled=?,due_at=MIN(due_at,?),revision=revision+1 WHERE node_id=?').run(enabled?0:1,now,id);
      // 从待办暂停回到复习＝当新卡重新计分——记忆状态（稳定性/难度/次数/到期/阶段）清零，
      // 复习记录和 leech 标签都保留，所以历史里还能看到之前学过什么。
      if(node.kind==='cloze'&&enabled&&before.review?.enabled===0){
        const profile=this.profiles.resolve(node.folderId);
        const card={...this.schedulerForDeck(node.folderId).newCard({now:new Date(now)}),cardId:id};
        this.repository.query(`UPDATE review_cards SET state=?,due_at=?,stage=0,day_learning=0,learning_step=0,algorithm_version=?,revision=revision+1
          WHERE node_id=?`).run(JSON.stringify(card),now,'ts-fsrs/6.0.0:'+(profile.fsrsVersion||'FSRS-6'),id);
      }
      const after=readSchedule(this.repository,id)!;
      recordStudyChange(this.repository,id,now,before,after);
      return {id,before,after};
    });
    if(this.session)this.session.queue=[];this.invalidate();
    return change;
  }
  /** 留存判定——手动把卡片放进"暂存点"：不确定要不要留在 IR 时先收起来，
   *  移出复习与待办队列，打 hold 标签；之后可在浏览卡片里取消或直接删除。 */
  setHold(id:string,hold:boolean){
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    this.register(id);
    this.repository.transaction(()=>{
      // hold 也随排程同步——记下前后状态，对端收到后标签和队列开关一起变。
      const before=readSchedule(this.repository,id)!;
      if(hold){
        this.repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'hold')").run(id);
        this.repository.query('UPDATE review_cards SET enabled=0,revision=revision+1 WHERE node_id=?').run(id);
        this.repository.query('UPDATE reading_state SET enabled=0,revision=revision+1 WHERE node_id=?').run(id);
      }else{
        this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='hold'").run(id);
        this.repository.query('UPDATE reading_state SET enabled=1,revision=revision+1 WHERE node_id=?').run(id);
      }
      recordStudyChange(this.repository,id,this.now(),before,readSchedule(this.repository,id)!);
    });
    if(this.session)this.session.queue=[];this.invalidate();
  }  /** 手动搁置到下一个日切点（和 Anki 的 Bury 一样），并打 buried 标签让状态/筛选能看出来。 */
  bury(id:string,mode?:Session['mode']):BuryChange{
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    this.register(id);
    const change=this.repository.transaction(()=>{
      const before=readSchedule(this.repository,id)!;
      const now=this.now();
      const until=dayStartMs(now,this.settings.dayStartHour)+86400000;
      const table=mode==='reading'||!before.review?'reading_state':'review_cards';
      const previous=table==='reading_state'?before.reading:before.review!;
      // 2026-11-19：搁置 = 隐藏到日切之后，到期日保持不变，次日自动恢复。
      void table; void previous;
      this.repository.query('UPDATE review_cards SET buried_until=?,revision=revision+1 WHERE node_id=?').run(until,id);
      this.repository.query('UPDATE reading_state SET buried_until=?,revision=revision+1 WHERE node_id=?').run(until,id);
      this.repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'buried')").run(id);
      recordStudyChange(this.repository,id,now,before,readSchedule(this.repository,id)!);
      return {id,before,after:readSchedule(this.repository,id)!};
    });
    if(this.session&&!mode)this.session.queue=[];
    this.invalidate();
    return change;
  }
  buryActive(input:Submission){
    const session=this.active();
    const {node}=this.currentSubmission(session,input);
    const change=this.bury(node.id,session.mode);
    this.next();
    return {change,study:this.snapshot()};
  }
  /** 2026-11-17：待办暂停——保留暂停前的排程快照，方便 Ctrl+Z 原样恢复（不重置 FSRS）。 */
  pauseActive(input:Submission){
    const session=this.active();
    const {node}=this.currentSubmission(session,input);
    const change=this.setEnabled(node.id,false);
    this.next();
    return {change,study:this.snapshot()};
  }
  /** 原样恢复待办暂停前的排程：把 reading_state / review_cards 写回快照，并把会话切回该卡。 */
  undoPause(change:{id:string;before:Schedule;after:Schedule}|null,sessionId:string):StudySnapshot|null{
    if(!change)return this.session?this.snapshot():null;
    let stale=false;
    this.repository.transaction(()=>{
      const current=readSchedule(this.repository,change.id);
      if(!current)return;
      if(sameSchedule(current,change.after)){
        writeSchedule(this.repository,change.id,change.before);
        recordStudyChange(this.repository,change.id,this.now(),current,change.before);
        return;
      }
      // 其它端或本机后续操作已经改过排程时，不覆盖较新的状态；按当前状态重新暂停，
      // 避免撤销按钮只显示错误代码，同时保证卡片不会意外回到复习队列。
      stale=true;
      const now=this.now();
      this.repository.query('UPDATE review_cards SET enabled=0,revision=revision+1 WHERE node_id=?').run(change.id);
      this.repository.query('UPDATE reading_state SET enabled=1,revision=revision+1 WHERE node_id=?').run(change.id);
      const after=readSchedule(this.repository,change.id);
      if(current&&after)recordStudyChange(this.repository,change.id,now,current,after);
    });
    this.invalidate();
    if(!this.session)return null;
    const result=this.focus(change.id);
    if(stale)(result as StudySnapshot&{pauseUndoStale?:boolean}).pauseUndoStale=true;
    return result;
  }  /** 2026-11-17：把当前会话切到指定卡片（撤销删除后回到被删的那张）。 */
  focus(id:string):StudySnapshot{
    const session=this.session;
    if(!session)return this.snapshot();
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')return this.snapshot();
    this.register(id);
    session.queue=session.queue.filter(queued=>queued!==id);
    session.current=id;
    session.token=randomUUID();
    session.shownAt=this.now();
    return this.snapshot();
  }
  undoBury({id,before,after}:BuryChange,sessionId:string):StudySnapshot|null{
    this.repository.transaction(()=>{
      const current=readSchedule(this.repository,id);
      if(!this.repository.getNode(id)||!current||!sameSchedule(current,after)||
        current.reading.due_at!==after.reading.due_at||current.review?.due_at!==after.review?.due_at)
        throw Error(t('卡片的排程已变化，无法撤销。'));
      writeSchedule(this.repository,id,before);
      this.repository.query('UPDATE review_cards SET buried_until=0 WHERE node_id=?').run(id);
      this.repository.query('UPDATE reading_state SET buried_until=0 WHERE node_id=?').run(id);
      recordStudyChange(this.repository,id,this.now(),current,before);
    });
    this.invalidate();
    const session=this.session;
    if(!session)return null;
    if(session.id===sessionId){
      const next=session.current===id?null:session.current;
      session.queue=session.queue.filter(queued=>queued!==id&&queued!==next);
      if(next)session.queue.unshift(next);
      session.current=id;
      session.token=randomUUID();session.shownAt=this.now();
    }
    return this.refresh();
  }
  /** 取消搁置——删掉 buried 标签，并把到期时间拉回现在，等下一次推送。 */
  unbury(id:string){
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    this.register(id);
    const change=this.repository.transaction(()=>{
      if(!this.repository.query("SELECT 1 FROM node_tags WHERE node_id=? AND tag='buried'").get(id))return null;
      const before=readSchedule(this.repository,id)!,now=this.now();
      this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='buried'").run(id);
      const table=!before.review||(!before.review.enabled&&before.reading.due_at>now&&
        before.reading.due_at===dayStartMs(before.reading.due_at,this.settings.dayStartHour))?'reading_state':'review_cards';
      this.repository.query('UPDATE '+table+' SET due_at=MIN(due_at,?),revision=revision+1 WHERE node_id=?').run(now,id);
      recordStudyChange(this.repository,id,now,before,readSchedule(this.repository,id)!);
      return {id,before,after:readSchedule(this.repository,id)!};
    });
    if(this.session)this.session.queue=[];this.invalidate();
    return change;
  }
  /** 卡片标签面板里改标签。hold / buried / leech 是内部状态，删标签必须连带改队列，
   *  否则会出现「标签没了但卡片还在暂存点/还搁置着」。 */
  setCardTag(id:string,tag:string,on:boolean){
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    if(tag==='hold'){this.setHold(id,on);return;}
    if(tag==='buried'){if(on)this.bury(id);else this.unbury(id);return;}
    if(tag==='leech'){
      if(on)this.repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'leech')").run(id);
      else this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='leech'").run(id);
      this.invalidate();return;
    }
    if(on)this.repository.query('INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,?)').run(id,tag);
    else this.repository.query('DELETE FROM node_tags WHERE node_id=? AND tag=?').run(id,tag);
    this.invalidate();
  }
  setPushEnabled(id:string,enabled:boolean){
    const node=this.repository.getNode(id);if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));this.register(id);
    if(node.kind==='cloze'&&this.repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(id)?.enabled)throw Error(t('请先暂停复习，再调整推送。'));
    this.repository.transaction(()=>{
      const before=readSchedule(this.repository,id)!;
      if(before.reading.enabled===Number(enabled))return;
      this.repository.query('UPDATE reading_state SET enabled=?,revision=revision+1 WHERE node_id=?').run(enabled?1:0,id);
      recordStudyChange(this.repository,id,this.now(),before,readSchedule(this.repository,id)!);
    });
    if(this.session)this.session.queue=[];this.invalidate();
  }
  setEnabledBatch(ids:string[],enabled:boolean){
    return this.repository.transaction(()=>ids.flatMap(id=>{
      const change=this.setEnabled(id,enabled);
      return change?[change]:[];
    }));
  }
  restoreEnabledBatch(changes:{id:string;before:Schedule;after:Schedule}[]){
    this.repository.transaction(()=>{
      for(const {id,before,after} of changes){
        const current=readSchedule(this.repository,id);
        if(!this.repository.getNode(id)||!current||!sameSchedule(current,after))
          throw Error(t('卡片的排程已变化，无法撤销。'));
        writeSchedule(this.repository,id,before);
      this.repository.query('UPDATE review_cards SET buried_until=0 WHERE node_id=?').run(id);
      this.repository.query('UPDATE reading_state SET buried_until=0 WHERE node_id=?').run(id);
        recordStudyChange(this.repository,id,this.now(),current,before);
      }
    });
    if(this.session)this.session.queue=[];this.invalidate();
  }
  changeKind(id:string,kind:'topic'|'material'|'cloze'){
    if(!['topic','material','cloze'].includes(kind))throw Error(t('卡片类型无效。'));const node=this.repository.getNode(id);if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    if(node.kind===kind)return node;
    this.repository.transaction(()=>{
      if(node.anchor&&!node.anchor.highlight)this.repository.query("UPDATE nodes SET anchor=json_set(anchor,'$.highlight',?) WHERE id=?").run(node.kind==='cloze'?'cloze':'extract',id);
      this.repository.query('UPDATE nodes SET kind=?,study_ready=?,updated_at=? WHERE id=?')
        .run(kind,studyReady(kind,node.content,node.answer),new Date(this.now()).toISOString(),id);
      this.register(id);this.repository.resetStudyForKindChange(id);
    });if(this.session)this.session.queue=[];this.invalidate();return this.repository.getNode(id);
  }
  nodeState(id:string){
    const node=this.repository.getNode(id);if(!node||node.kind==='folder')return null;
    const review=this.repository.query('SELECT * FROM review_cards WHERE node_id=?').get(id),push=this.repository.query('SELECT * FROM reading_state WHERE node_id=?').get(id),active=node.kind==='cloze'&&!!review?.enabled;
    // 2026-11-19：记忆搁置与待办搁置分开判断（两张表本来就分开存）
    const nowMs=this.now();
    const buriedReview=Number(review?.buried_until||0)>nowMs;
    const buriedTodo=Number(push?.buried_until||0)>nowMs;
    const buried=buriedReview||buriedTodo;
    const hold=Boolean(this.repository.query("SELECT 1 FROM node_tags WHERE node_id=? AND tag='hold'").get(id));
    const lastRead=this.repository.query('SELECT action FROM reading_log WHERE node_id=? AND undone_at IS NULL ORDER BY reviewed_at DESC LIMIT 1').get(id);
    const dismissed=!push?.enabled&&lastRead?.action==='dismiss';
    const reviewed=Boolean(review&&Number(review.stage||0)>0);
    return {enabled:node.kind==='cloze'?!!review?.enabled:!!push?.enabled,reviewEnabled:active,pushEnabled:!!push?.enabled,buried:!!buried,buriedReview,buriedTodo,hold,dismissed,reviewed,
      priority:node.priority,effectivePriority:this.priority(id),kind:active?'fsrs':'reading',dueAt:(active?review:push)?.due_at||null,
      readingPosition:Number(push?.reading_position||0)};
  }
  /** 累计重来次数（撤销掉的不算）。leech 属性后面用它显示 leech(n)，让人看得出循环了几轮。 */
  leechLapses(id:string):number{
    return Number(this.repository.query('SELECT count(*) n FROM review_log WHERE node_id=? AND rating=1 AND undone_at IS NULL').get(id)?.n||0);
  }
  counts():Record<string,FolderCounts>{
    const now=this.now();this.cleanupBuriedTags(now);
    if(this.statsCache&&now-this.statsCache.at<15000)return this.statsCache.value;
    this.statsCache={at:now,...computeCounts(this.statsContext())};
    return this.statsCache.value;
  }
  start(_legacyFolderId?:string|null,mode?:StudySettings['studyMode']):StudySnapshot {
    if(mode&&!['mixed','reading','cards'].includes(mode))throw Error(t('复习模式无效。'));
    return this.startSession(mode==='reading'?'reading':'cards',null);
  }
  startDeck(folderId:string,mode:'cards'|'reading'='cards'):StudySnapshot {
    if(typeof folderId!=='string'||!this.profiles.folders.has(folderId))throw Error(t('牌组不存在。'));
    return this.startSession(mode,folderId);
  }
  private startSession(mode:Session['mode'],folderId:string|null):StudySnapshot {
    const postponed=0; // 取消 auto-postpone，允许积压，队列只按优先级/到期处理
    this.session={id:randomUUID(),mode,folderId,queue:[],current:null,token:'',completed:0,history:[],submitted:new Set(),shownAt:this.now(),postponed};
    this.next();return this.snapshot();
  }
  stop(){this.session=null;return true;}
  refresh():StudySnapshot {
    const session=this.active();
    if(session.current){const node=this.repository.getNode(session.current),row=node?this.stateRow(node):null;
      const ready=node?this.ready(node.id):0;
      if(!node||!this.matchesMode(node)||!ready||!row?.enabled||this.blockedCards().ids.has(node.id)||!hasDailyQuota(this.quotaContext(),node.folderId,row.stage,undefined,Number(row.due_at),Number(row.day_learning||0))){
        session.current=null;session.queue=[];
      }}
    if(!session.current)this.next();return this.snapshot();
  }
  private active(){if(!this.session)throw Error(t('当前没有进入复习。'));return this.session;}
  private matchesMode(node:Material){
    const session=this.active();
    if(session.mode==='reading'){
      if(node.kind==='folder'||(node.kind==='cloze'&&this.repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(node.id)?.enabled))return false;
    }else if(node.kind!=='cloze')return false;
    if(!session.folderId)return true;
    for(let id=node.folderId;id;id=this.profiles.folders.get(id)?.parentId??null){
      if(id===session.folderId)return this.profiles.folders.has(id);
    }
    return false;
  }
  private ready(id:string,mode=this.active().mode){return this.repository.query(`SELECT ${mode==='cards'?'study_ready':'push_ready'} ready FROM nodes WHERE id=?`).get(id)?.ready;}
  private stateRow(node:Material,mode=this.active().mode):Row|undefined {return this.repository.query(`SELECT * FROM ${mode==='cards'?'review_cards':'reading_state'} WHERE node_id=?`).get(node.id) as Row|undefined;}
  private priority(id:string):number{return pushPriority(this.pushContext(),id);}
  // 阅读推送的间隔增长与四动作见 ./reading/push.ts 与 ./reading/actions.ts
  private pushContext():PushContext{return {repository:this.repository,settings:this.settings};}
  setReadingPosition(id:string,position:number):void{setReadingPosition(this.repository,id,position);}
  cardInfo(input:{id:string;offset?:number;horizon?:number}){return cardInfo(this.statsContext(),input);}
  statistics(input:{folderId?:string;days?:number}={}){return statistics(this.statsContext(),input);}
  /** 待办统计（轻量）：主题/提取数量、待办状态、今日到期、阅读动作与未来到期。 */
  readingStatistics(input:{folderId?:string;days?:number}={}){return readingStatistics(this.statsContext(),input);}
  async simulateWorkload(folderId:string|null){return simulateWorkload(this.statsContext(),folderId);}
  private card(row:Row):DefaultSchedulerCard<'FSRS-7'>{
    if(!/^ts-fsrs\/6\.0\.0:FSRS-[67]$/.test(row.algorithm_version))throw Error(t('这张卡片的复习数据来自其他算法版本，需要迁移后使用。'));
    const state=JSON.parse(row.state);
    // 2026-11-19：给 FSRS-7 需要的 stabilityFast 一个兜底（FSRS-6 卡片没有这个字段）
    const card={...state,stabilityFast:state.stabilityFast??state.stability,dueAt:new Date(state.dueAt),lastReviewAt:state.lastReviewAt?new Date(state.lastReviewAt):null};
    if(!Number.isFinite(card.dueAt.getTime())||(card.lastReviewAt&&!Number.isFinite(card.lastReviewAt.getTime())))throw Error(t('复习日期无效。'));
    return card as DefaultSchedulerCard<'FSRS-7'>;
  }
  // 每日额度相关逻辑见 ./quota.ts；这里只把 service 的依赖显式交出去（settings/profiles 是私有字段，不能直接传 this）
  private quotaContext():QuotaContext{
    return {repository:this.repository,settings:this.settings,profiles:this.profiles,now:()=>this.now(),active:()=>this.active()};
  }
  // 计数与「今天还能出多少」见 ./stats.ts；缓存（15 秒）留在 service，因为要跟 invalidate() 联动。
  private statsContext():StatsContext{
    return {repository:this.repository,profiles:this.profiles,settings:this.settings,now:()=>this.now(),
      learnAheadMs:()=>this.learnAheadMs(),blockedJson:()=>this.blockedCards().json,
      card:row=>this.card(row),schedulerForDeck:id=>this.schedulerForDeck(id),
      prerequisites:id=>this.prerequisites(id),leechLapses:id=>this.leechLapses(id),
      schedulerFor:settings=>StudyService.schedulerFor(settings)};
  }
  private availableToday(folderId:string|null):DailySlots{
    return availableToday(this.statsContext(),dailySlots(this.quotaContext()),this.statsCache!.direct,folderId);
  }
  // 候选与排序见 ./queue.ts（buildQueue）；这里只把 service 依赖显式交出去。
  private queueContext():QueueContext{
    return {...this.quotaContext(),blockedJson:()=>this.blockedCards().json,card:row=>this.card(row),deckScheduler:id=>this.schedulerForDeck(id)};
  }
  private candidates():string[]{return buildQueue(this.queueContext());}
  /** 2026-11-18：学习提前限制（分钟，0 = 关闭）。 */
  /** 2026-11-19：最近一张答过的卡，用于「提前卡不要立刻重复同一张」。 */
  private lastGraded:{id:string;at:number}|null=null;
  private learnAheadMs(){
    const minutes=Number(this.settings.learnAheadMinutes??20);
    return Number.isFinite(minutes)&&minutes>0?minutes*60000:0;
  }  private next(){
    const session=this.active(),blocked=this.blockedCards();session.current=null;
    if(session.mode!=='reading'){
      const scope=deckScope(session.folderId);
      const urgent=this.repository.query(`SELECT r.node_id,r.day_learning FROM review_cards r JOIN nodes n ON n.id=r.node_id
        WHERE n.kind='cloze' AND n.deleted_at IS NULL AND n.study_ready=1 AND r.enabled=1 AND r.stage IN(1,3)
          AND r.due_at<=? AND ${unlocked} ${scope.filter}
          ORDER BY (COALESCE(json_extract(r.state,'$.reps'),0)=0), r.due_at, r.learning_step, r.node_id LIMIT 1`).get(this.now(),blocked.json,...scope.args);
      if(urgent){session.current=String(urgent.node_id);session.token=randomUUID();session.shownAt=this.now();return;}
    }
    const slots=dailySlots(this.quotaContext());
    queuePasses:for(let pass=0;pass<2;pass++){
      if(!session.queue.length){
        session.queue=this.candidates();
        if(!session.queue.length)break queuePasses;
      }
      while(session.queue.length){
        const id=session.queue.shift()!,node=this.repository.getNode(id),row=node?this.stateRow(node):null;
        const ready=node?this.ready(id):0;
        if(node&&this.matchesMode(node)&&ready&&row?.enabled&&!blocked.ids.has(id)&&
          Number(row.due_at)<=this.now()&&hasDailyQuota(this.quotaContext(),node.folderId,row.stage,slots,Number(row.due_at),Number(row.day_learning||0))){
          session.current=id;session.token=randomUUID();session.shownAt=this.now();return;
        }
      }
    }
    // 2026-11-18：照 Anki 的三段顺序——到点的学习卡 → 主队列（复习/跨日学习/新卡）→ 提前量内的学习卡。
    // 提前的卡排最后，不会插队打断正在进行的复习。
    if(session.mode!=='reading'&&this.learnAheadMs()>0){
      const scope=deckScope(session.folderId);
      const aheadRows=this.repository.query(`SELECT r.node_id FROM review_cards r JOIN nodes n ON n.id=r.node_id
        WHERE n.kind='cloze' AND n.deleted_at IS NULL AND n.study_ready=1 AND r.enabled=1 AND r.stage IN(1,3)
          AND r.due_at<=? AND COALESCE(r.buried_until,0)<=? AND ${unlocked} ${scope.filter} ORDER BY r.due_at LIMIT 2`).all(this.now()+this.learnAheadMs(),this.now(),blocked.json,...scope.args) as Row[];
      // 优先给不是「刚答过」的那张，实在只有它就照给（此时队列已经空了）
      const ahead=aheadRows.find(row=>String(row.node_id)!==this.lastGraded?.id)??aheadRows[0];
      if(ahead){session.current=String(ahead.node_id);session.token=randomUUID();session.shownAt=this.now();return;}
    }
  }
  snapshot():StudySnapshot {
    this.cleanupBuriedTags(this.now());
    const session=this.active(),blocked=this.blockedCards();
    const scope=deckScope(session.folderId);
    let item:StudyItem|null=null;
    if(session.current&&!blocked.ids.has(session.current)){
      const node=this.repository.getNode(session.current),row=node?this.stateRow(node):null;
      if(node&&row&&(!session.folderId||this.matchesMode(node))){
        const isReview=session.mode==='cards',now=this.now();const preview=isReview?[...this.schedulerForDeck(node.folderId).preview({card:this.card(row),now:new Date(now)})]
          .map(result=>({rating:result.grade as 1|2|3|4,
            // 2026-11-19（D3）：复习的预览也要按天对齐，否则和写库后的到期日差几个小时。
            dueAt:result.card.state===2?dayStartMs(result.card.dueAt.getTime(),this.settings.dayStartHour):result.card.dueAt.getTime(),
            // 2026-11-19：复习卡按 Anki 的口径显示「整数天」，不再显示「距现在 1.8 天」这种经过时间。
            ...(result.card.state===2?{days:Math.max(1,Math.round(Number(result.card.scheduledDays)||0))}:{})})):[];
        item={id:node.id,token:session.token,kind:isReview?'fsrs':'reading',isTest:node.kind==='cloze',title:node.title,
          state:isReview?(row.stage===0?'new':row.stage===2?'review':'learning'):row.reps===0?'new':'review',
          priority:this.priority(node.id),revision:row.revision,preview,...(!isReview?{pushPreview:{read:pushSchedule(this.pushContext(),node.id,row,'read',now).dueAt,later:pushSchedule(this.pushContext(),node.id,row,'later',now).dueAt}}:{})};
      }
    }
    const next=this.repository.query(`SELECT MIN(r.due_at) due_at FROM ${session.mode==='cards'?'review_cards':'reading_state'} r JOIN nodes n ON n.id=r.node_id
      WHERE n.deleted_at IS NULL AND n.${session.mode==='cards'?'study_ready':'push_ready'}=1 AND r.enabled=1
      AND ${unlocked}
      AND ${session.mode==='cards'?"n.kind='cloze'":"(n.kind!='cloze' OR NOT EXISTS(SELECT 1 FROM review_cards active WHERE active.node_id=n.id AND active.enabled=1))"} ${scope.filter}`).get(blocked.json,...scope.args);
    const byFolder=this.counts();
    const counts=session.folderId?byFolder[session.folderId]??{new:0,learning:0,review:0,readingDue:0}:this.statsCache!.total;
    // 复习条上的新卡/复习数字按「今天还剩多少额度」显示，与队列实际会出的卡一致；
    // 侧栏的 folderCounts 仍然是积压总数，不受上限影响。
    const available=this.availableToday(session.folderId);
    const shown=session.mode==='cards'?{...counts,new:available.new,review:available.review}:{...counts,readingDue:available.reading};
    const folderTitle=session.folderId?this.profiles.folders.get(session.folderId)?.title??t('牌组'):session.mode==='cards'?t('全部牌组'):t('全部待办');
    return {sessionId:session.id,folderId:session.folderId,folderTitle,mode:session.mode,item,completed:session.completed,
      canUndo:session.history.length>0,nextDueAt:next?.due_at?Number(next.due_at):null,postponed:session.postponed,
      counts:{new:shown.new,learning:shown.learning,review:shown.review,readingDue:shown.readingDue}};
  }
  private currentSubmission(session:Session,input:Submission){
    if(session.id!==input.sessionId)throw Error(t('复习会话已改变。'));
    if(!session.current||input.token!==session.token)throw Error(t('这张卡片已经提交。'));
    const node=this.repository.getNode(session.current);if(!node||!this.matchesMode(node))throw Error(t('卡片已删除、类型已改变或移出了当前牌组。'));
    if(this.blockedCards().ids.has(node.id))throw Error(t('先修卡尚未掌握，请刷新队列。'));
    if(!this.ready(node.id))throw Error(t('请先补全卡片内容，再继续。'));
    const before=this.stateRow(node);if(!before||before.revision!==input.revision||!before.enabled)throw Error(t('复习状态已改变，请刷新。'));
    return {node,before};
  }
  againDependents(input:Submission):AgainChildCandidate[]{
    const session=this.active();
    if(session.mode!=='cards')throw Error(t('请在检测卡复习中操作。'));
    const {node}=this.currentSubmission(session,input);
    return this.againCandidates(node.id);
  }
  recordForgotten(id:string):string{
    const node=this.repository.getNode(id);
    if(!node||node.kind!=='cloze')throw Error(t('请选择检测卡。'));
    const eventId=randomUUID(),now=this.now();
    this.repository.transaction(()=>{
      const before=this.stateRow(node,'cards');
      if(!before?.enabled||!this.ready(id,'cards')||!this.card(before).lastReviewAt)
        throw Error(t('只有已复习且未暂停的检测卡可以记录遗忘。'));
      const previous=this.operationState(id,before);
      this.applyFsrsGrade(node,before,Rating.Again,now,eventId,{source:'directory_forgotten'});
      this.logOperation(id,eventId,'directory-forgotten','fsrs',now,previous,this.stateRow(node,'cards')!);
    });
    if(this.session)this.session.queue=[];
    this.invalidate();
    return eventId;
  }
  resetMemory(id:string){
    const node=this.repository.getNode(id);
    if(!node||node.kind!=='cloze'||!this.ready(id,'cards'))throw Error(t('请选择已填写题目和答案的检测卡。'));
    const result=this.repository.transaction(()=>{
      this.register(id);
      const before=readSchedule(this.repository,id)!;
      const now=this.now(),profile=this.profiles.resolve(node.folderId);
      const card={...this.schedulerForDeck(node.folderId).newCard({now:new Date(now)}),cardId:id};
      const after:Schedule={...before,leech:false,reading:{...before.reading,enabled:0},
        review:{enabled:1,stage:0,due_at:now,state:JSON.stringify(card),algorithm_version:'ts-fsrs/6.0.0:'+profile.fsrsVersion}};
      writeSchedule(this.repository,id,after);
      recordStudyChange(this.repository,id,now,before,after);
      return {id,before,after};
    });
    if(this.session)this.session.queue=[];
    this.invalidate();
    return result;
  }
  private againCandidates(id:string):AgainChildCandidate[]{
    const ids=this.dependencies.memoryPrerequisites(id);
    if(!ids.length)return [];
    return this.repository.query(`
      SELECT n.id,n.title,r.revision,r.due_at AS dueAt FROM nodes n JOIN review_cards r ON r.node_id=n.id
      WHERE n.id IN(SELECT value FROM json_each(?)) AND n.study_ready=1 AND r.enabled=1
        AND json_extract(r.state,'$.lastReviewAt') IS NOT NULL
      ORDER BY n.position,n.id
    `).all(JSON.stringify(ids)) as unknown as AgainChildCandidate[];
  }
  private checkedAgainChildren(id:string,selection:AgainChildSelection[]){
    if(!selection.length)return [];
    const candidates=new Map(this.againCandidates(id).map(card=>[card.id,card]));
    return selection.map(entry=>{
      const candidate=entry&&candidates.get(entry.id);
      if(!candidate||candidate.revision!==entry.revision)throw Error(t('所选子卡的关系或复习状态已变化，请重新选择。'));
      candidates.delete(candidate.id);
      const node=this.repository.getNode(candidate.id)!;
      return {node,before:this.stateRow(node)!};
    });
  }
  private operationState(id:string,row:Row){
    return {...row,_leech:!!this.repository.query("SELECT 1 FROM node_tags WHERE node_id=? AND tag='leech'").get(id),
      _push:this.repository.query('SELECT * FROM reading_state WHERE node_id=?').get(id)};
  }
  private logOperation(id:string,eventId:string,sessionId:string,kind:'fsrs'|'reading',now:number,before:Row,after:Row){
    this.repository.query('INSERT INTO study_operations(event_id,session_id,node_id,kind,reviewed_at,before_state,after_state) VALUES(?,?,?,?,?,?,?)')
      .run(eventId,sessionId,id,kind,now,JSON.stringify(before),JSON.stringify(this.operationState(id,after)));
  }
  // ===== 搁置关联卡片到次日（Anki 的 bury）=====
  // 关联卡片＝记忆树里和这张卡直接相连的父/子检测卡（card_relations.kind='memory'）。
  // 复习一张卡时，按「新的 / 待复习的 / 跨日学习中的」三个开关把今天到期的关联卡片挪到明天零点：
  // 子卡被搁置时父卡也一起搁置，但不会反过来波及没被搁置的其它子卡。
  private buryRelated(node:Material,now:number):Array<{id:string;revision:number;dueAt:number;buriedAt:number}>{
    const profile=this.profiles.resolve(node.folderId);
    if(!profile.buryNew&&!profile.buryReview&&!profile.buryLearning)return [];
    const tomorrow=dayStartMs(now,this.settings.dayStartHour)+24*3600000;const limit=tomorrow;
    // 单向——子卡片被搁置会影响父卡片，父卡片被搁置不影响子卡片；
    // 所以复习一张卡时只把它的记忆树「父卡」按开关搁置到次日，不再往下波及子卡。
    const rows=this.repository.query(`SELECT r.node_id AS id,r.stage,r.due_at AS dueAt,r.revision
      FROM review_cards r JOIN nodes n ON n.id=r.node_id
      WHERE n.deleted_at IS NULL AND n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND r.due_at<?
        AND n.id IN(SELECT parent_id FROM card_relations WHERE child_id=? AND kind='memory')`).all(limit,node.id) as Row[];
    const buried:Array<{id:string;revision:number;dueAt:number;buriedAt:number}>=[];
    for(const row of rows){
      const stage=Number(row.stage);
      const enabled=stage===0?profile.buryNew:stage===2?profile.buryReview:profile.buryLearning;
      if(!enabled)continue;
      const id=String(row.id),before=readSchedule(this.repository,id);
      this.repository.query('UPDATE review_cards SET due_at=?,revision=revision+1,updated_at=? WHERE node_id=?').run(limit,now,id);
      this.repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'buried')").run(id);
      const after=readSchedule(this.repository,id);
      if(before&&after)recordStudyChange(this.repository,id,now,before,after,{id:randomUUID(),kind:'fsrs',at:now});
      buried.push({id,revision:Number(row.revision),dueAt:Number(row.dueAt),buriedAt:limit});
    }
    return buried;
  }
  // ===== 2026-11-19：复习间隔 fuzz + 负载均衡（对齐 anki main：states/fuzz.rs、states/load_balancer.rs）=====
  // fuzz 区间：间隔 <2.5 天不 fuzz；否则 delta = 1 + 0.15·(min(i,7)−2.5)⁺ + 0.10·(min(i,20)−7)⁺ + 0.05·(i−20)⁺。
  /** fuzz.rs::constrained_fuzz_bounds——夹到 [minimum,maximum]，并保证上下界不等（除非 maximum 不允许）。 */
  private static constrainedFuzzBounds(interval:number,minimum:number,maximum:number):[number,number]{return constrainedFuzzBounds(interval,minimum,maximum);}
  /** 未来每天到期数，按「预设」（deck config）分组——对齐 Anki 的 days_by_preset。 */
  private loadBalanceCounts(now:number):{dayStart:number;counts:Map<string,Map<number,number>>}{
    if(this.loadBalanceCache)return this.loadBalanceCache;
    const dayStart=dayStartMs(now,this.settings.dayStartHour);
    const counts=new Map<string,Map<number,number>>();
    const rows=this.repository.query(`SELECT n.folder_id AS folderId,CAST((r.due_at-?)/86400000 AS INTEGER) AS day,count(*) AS count
      FROM review_cards r JOIN nodes n ON n.id=r.node_id
      WHERE r.stage=2 AND r.enabled=1 AND n.deleted_at IS NULL AND r.due_at>=? AND r.due_at<?
      GROUP BY n.folder_id,day`).all(dayStart,dayStart,dayStart+100*86400000) as Row[];
    for(const row of rows){
      const key=this.presetKeyFor(row.folderId?String(row.folderId):null),day=Number(row.day);
      let bucket=counts.get(key);if(!bucket)counts.set(key,bucket=new Map());
      bucket.set(day,(bucket.get(day)||0)+Number(row.count));
    }
    this.loadBalanceCache={dayStart,counts};
    return this.loadBalanceCache;
  }
  private presetKeyFor(folderId:string|null):string{return profileKey(this.profiles.resolve(folderId));}
  /** 让缓存跟着同一次事务里的写入走（撤销/改期由 invalidate() 统一清空）。 */
  private loadBalanceAdjust(presetKey:string,stage:unknown,enabled:unknown,dueAt:unknown,delta:number){
    const cache=this.loadBalanceCache;if(!cache)return;
    if(Number(stage)!==2||!Number(enabled))return;
    const at=Number(dueAt);if(!Number.isFinite(at))return;
    const day=Math.floor((at-cache.dayStart)/86400000);
    if(day<0||day>=100)return;
    let bucket=cache.counts.get(presetKey);if(!bucket)cache.counts.set(presetKey,bucket=new Map());
    const next=(bucket.get(day)||0)+delta;
    if(next>0)bucket.set(day,next);else bucket.delete(day);
  }
  /** 与学习步抖动一致的确定性随机（FNV-1a + mulberry32 一步），同样输入得到同样结果，测试可复现。 */
  private static stableRandom(seed:string):number{return stableRandom(seed);}
  /**
   * 复习卡的下次间隔（天）：fuzz.rs::with_review_fuzz 的等价实现。
   * 有负载均衡上下文时优先用它挑天，否则在 fuzz 区间里按卡片确定的随机因子取一天。
   * 关闭 `reviewFuzz`（只在测试里）时直接返回四舍五入后的间隔。
   */
  private reviewIntervalDays(node:Material,dueAt:number,raw:number,minimum:number,maximum:number,now:number,reps:number):number{
    const ideal=Math.min(maximum,Math.max(minimum,Math.round(raw)));
    const [lower,upper]=StudyService.constrainedFuzzBounds(raw,minimum,maximum);
    // Anki 里负载均衡优先于 fuzz：有负载均衡上下文就挑天，否则才用 fuzz 因子。
    const balanced=this.balancedInterval(node,dueAt,lower,upper,now,reps,Math.round(raw));
    if(balanced!==null)return balanced;
    if(this.settings.reviewFuzz===false)return ideal;
    const factor=StudyService.stableRandom(String(node.id)+'|'+String(reps));
    return lower+Math.floor(factor*(1+upper-lower));
  }
  /**
   * load_balancer.rs::find_interval——在 fuzz 窗口内按 w = (1/n)^2.15 · (1/target_interval)^3 加权随机；
   * 0 张到期时权重 1；间隔 >90 天或窗口下界 >90 天不参与。
   */
  private balancedInterval(node:Material,dueAt:number,lower:number,upper:number,now:number,reps:number,ideal:number):number|null{
    if(this.settings.loadBalance!==true)return null;
    if(ideal>90||lower>90)return null;
    if(upper<=lower)return null;
    const {dayStart,counts}=this.loadBalanceCounts(now);
    const perDay=counts.get(this.presetKeyFor(node.folderId));
    const baseDay=Math.floor((dueAt-dayStart)/86400000);
    const candidates:{offset:number;weight:number}[]=[];let total=0;
    for(let offset=lower;offset<=upper;offset++){
      const due=perDay?.get(baseDay+offset-ideal)||0;
      const weight=due===0?1:Math.pow(1/due,2.15)*Math.pow(1/Math.max(1,offset),3);
      candidates.push({offset,weight});total+=weight;
    }
    let pick=StudyService.stableRandom(String(node.id)+'|'+String(reps)+'|'+String(baseDay))*total;
    for(const candidate of candidates){pick-=candidate.weight;if(pick<=0)return candidate.offset;}
    return candidates[candidates.length-1]!.offset;
  }
  // 评价写库见 ./grade.ts（applyFsrsGrade）；这里只把 service 依赖显式交出去。
  private gradeContext():GradeContext{
    return {repository:this.repository,settings:this.settings,profiles:this.profiles,
      card:row=>this.card(row),schedulerForDeck:id=>this.schedulerForDeck(id),
      reviewIntervalDays:(node,dueAt,raw,minimum,maximum,now,reps)=>this.reviewIntervalDays(node,dueAt,raw,minimum,maximum,now,reps),
      loadBalanceAdjust:(presetKey,stage,enabled,dueAt,delta)=>this.loadBalanceAdjust(presetKey,stage,enabled,dueAt,delta)};
  }
  private applyFsrsGrade(node:Material,before:Row,rating:1|2|3|4,now:number,eventId:string,details:Record<string,unknown>){
    applyFsrsGrade(this.gradeContext(),{node,before,rating,now,eventId,details});
  }
  grade(input:Submission&{rating?:1|2|3|4;action?:'read'|'later'|'soon'|'dismiss';position?:number;againChildren?:AgainChildSelection[]}):StudySnapshot {
    const session=this.active();if(session.id!==input.sessionId)throw Error(t('复习会话已改变。'));
    if(session.submitted.has(input.token))return this.snapshot();
    const {node,before}=this.currentSubmission(session,input);
    if(!hasDailyQuota(this.quotaContext(),node.folderId,before.stage))throw Error(t('已达到此牌组的每日上限，请刷新队列。'));
    const now=this.now(),kind=session.mode==='cards'?'fsrs':'reading',eventId=input.token;
    if(input.againChildren!==undefined&&(kind!=='fsrs'||input.rating!==Rating.Again||!Array.isArray(input.againChildren)))
      throw Error(t('请在父卡的重来操作中选择子卡。'));
    this.repository.transaction(()=>{
      const children=this.checkedAgainChildren(node.id,input.againChildren??[]);
      // 阅读点随评价一起写入，避免额外递增 reading_state.revision。
      if(Number.isFinite(Number(input.position)))
        this.repository.query('UPDATE reading_state SET reading_position=? WHERE node_id=?')
          .run(Math.min(1e8,Math.max(0,Math.floor(Number(input.position)))),node.id);
      const beforeOperation=this.operationState(node.id,before);
      if(kind==='fsrs'){
        if(![1,2,3,4].includes(Number(input.rating)))throw Error(t('评价无效。'));
        this.applyFsrsGrade(node,before,input.rating!,now,eventId,{durationMs:Math.max(0,Math.min(600000,now-session.shownAt))});
      this.lastGraded={id:node.id,at:now};
        for(const child of children){
          const childEvent=randomUUID(),previous=this.operationState(child.node.id,child.before);
          this.applyFsrsGrade(child.node,child.before,Rating.Again,now,childEvent,{source:'selected_child_again',parentEventId:eventId});
          this.logOperation(child.node.id,childEvent,againChildBatch+eventId,'fsrs',now,previous,this.stateRow(child.node)!);
        }
        // 复习了就不再是搁置状态，清掉 buried 标记（标签变化单独记一条，随同步过去）
        const tagsBefore=readSchedule(this.repository,node.id)!;
        this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='buried'").run(node.id);
        recordTagChange(this.repository,node.id,now,tagsBefore,readSchedule(this.repository,node.id)!);
        // 按设置把记忆树里的父/子检测卡搁置到次日，撤销时一起回滚
        const buried=this.buryRelated(node,now);
        if(buried.length)(beforeOperation as any)._buried=buried;
      }else{
        // Foliole 四动作的写库见 ./reading/actions.ts（soon 不写状态，由下面的队列逻辑处理）。
        applyReadingAction(this.pushContext(),{node,before,action:input.action as ReadingAction,eventId,now});
      }
      if(input.action!=='soon')this.logOperation(node.id,eventId,session.id,kind,now,beforeOperation,this.stateRow(node)!);
    });
    session.submitted.add(eventId);
    if(input.action==='soon')session.queue.push(node.id);
    else{session.history.push(eventId);session.completed++;}
    this.invalidate();this.next();return this.snapshot();
  }
  /** 2026-11-19：撤销「置于末尾」——把卡片从队尾拿回来，重新作为当前卡片。
   *  「置于末尾」只改本轮队列顺序、不写日志，所以在会话里就地回滚。 */
  unqueue(id:string):StudySnapshot {
    const session=this.active();
    if(session.mode!=='reading')throw Error(t('当前不是待办。'));
    const displaced=session.current;
    session.queue=session.queue.filter(queued=>queued!==id);
    // 被顶掉的那张放回队首，否则撤销后队列就空了
    if(displaced&&displaced!==id)session.queue.unshift(displaced);
    session.current=id;
    session.submitted.delete(session.token);
    this.invalidate();return this.snapshot();
  }
  undo():StudySnapshot;
  undo(eventId:string):StudySnapshot|null;
  undo(requestedId?:string):StudySnapshot|null {
    const session=this.session,requested=requestedId??this.active().history.at(-1);
    if(!requested)throw Error(t('没有可撤销的复习。'));
    const event=findUndoableOperation(this.repository,requested);
    if(!event)throw Error(t('没有可撤销的复习。'));
    const eventId=String(event.event_id),nodeId=String(event.node_id),now=this.now();
    this.repository.transaction(()=>{
      const children=childOperations(this.repository,eventId);
      if(children.some(child=>child.undone_at!==null))throw Error(t('这批重来已被部分撤销。'));
      restoreOperation(this.repository,event,now);
      for(const child of children)restoreOperation(this.repository,child,now);
    });
    this.invalidate();
    if(!session)return null;
    if(session.id!==event.session_id)session.queue=[];
    const index=session.history.indexOf(eventId);
    if(index>=0){session.history.splice(index,1);session.completed--;}
    const node=this.repository.getNode(nodeId);
    if(node&&session.mode===(event.kind==='fsrs'?'cards':'reading')&&this.matchesMode(node)&&!this.blockedCards().ids.has(nodeId)){
      session.current=nodeId;session.token=randomUUID();return this.snapshot();
    }
    return this.refresh();
  }
}
