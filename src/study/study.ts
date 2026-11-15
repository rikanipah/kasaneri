import { t } from '../core/i18n';
import {DefaultScheduler,type DefaultSchedulerCard,Rating} from 'ts-fsrs';
import {migrateFSRS6Parameters} from 'ts-fsrs/models/fsrs-6';
import {randomUUID} from 'node:crypto';
import {studyReady} from '../core/image-occlusion';
import {Repository} from '../data/database';
import {CardDependencies} from './card-dependencies';
import {DEFAULT_SETTINGS,normalizeSettings,normalizeShortcuts,normalizeReviewOverrides,type StudySettings,type ReviewSettings} from '../core/settings';
import {DeckProfiles,profileKey} from '../folders/decks';
import {assembleReadingPushQueue,assembleFsrsPushQueue} from '../vendor/foliole/unifiedPushQueueAssembler';
import {resolveInheritedPushQueuePriority} from '../vendor/foliole/unifiedPushQueueRules';
import {validRecall} from './optimizer';
import {readSchedule,recordStudyChange,recordTagChange,sameSchedule,studyChangeSession,parseSchedule,writeSchedule,type Schedule} from '../sync/study-changes';
import type {AgainChildCandidate,AgainChildSelection,FolderCounts,Material,PrerequisiteChange,PrerequisiteState,StudyItem,StudySnapshot} from '../core/model';

type Scheduler=Awaited<ReturnType<typeof DefaultScheduler>>;
type Row=Record<string,any>;
type Submission={sessionId:string;token:string;revision:number};
type Session={id:string;mode:'cards'|'reading';folderId:string|null;queue:string[];current:string|null;token:string;
  completed:number;history:string[];submitted:Set<string>;shownAt:number;postponed:number};
const unlocked='n.id NOT IN(SELECT value FROM json_each(?))';
const inDeck=`n.folder_id IN(WITH RECURSIVE decks(id) AS(
  SELECT id FROM nodes WHERE id=? AND kind='folder' AND deleted_at IS NULL
  UNION ALL SELECT c.id FROM nodes c JOIN decks p ON c.parent_id=p.id WHERE c.kind='folder' AND c.deleted_at IS NULL
) SELECT id FROM decks)`;
const deckScope=(folderId:string|null)=>folderId?{filter:`AND ${inDeck}`,args:[folderId]}:{filter:'',args:[]};
const againChildBatch='again-children:';
/** 1.210：把一条排程变更翻译成复习记录里的一行文字（这些事件没有评分）。 */
function scheduleEventLabel(before:Schedule,after:Schedule,details:{action?:string},everReviewed:boolean):string{
  if(details?.action==='tags'){
    if(!!before.hold!==!!after.hold)return after.hold?t('留存判定'):t('取消留存判定');
    if(!!before.buried!==!!after.buried)return after.buried?t('搁置'):t('取消搁置');
    return t('状态变更');
  }
  const reviewBefore=Number(before.review?.enabled||0),reviewAfter=Number(after.review?.enabled||0);
  const readBefore=Number(before.reading.enabled||0),readAfter=Number(after.reading.enabled||0);
  if(reviewBefore&&!reviewAfter&&readAfter)return t('待办暂停');
  // 1.210：卡片加入复习后会被重置成新卡（state 里 reps 归零），所以用「这张卡有没有复习记录」判断
  if(!reviewBefore&&reviewAfter)return everReviewed?t('返回复习'):t('加入复习');
  if(readBefore&&!readAfter)return t('暂停待办');
  if(!readBefore&&readAfter)return t('恢复待办');
  return t('排程变更');
}

export class StudyService {
  private session:Session|null=null;
  private statsCache:{at:number;value:Record<string,FolderCounts>;total:FolderCounts}|null=null;
  private profiles!:DeckProfiles;
  private schedulers=new Map<string,Scheduler>();
  private readonly dependencies:CardDependencies;
  private dependencyCache:{ids:Set<string>;json:string}|null=null;
  private constructor(readonly repository:Repository,private settings:StudySettings,private now:()=>number){
    // 1.198：解锁条件按先修卡所属牌组的 masteryReps 判定，没设置时回落到全局值。
    this.dependencies=new CardDependencies(repository,id=>{
      const folder=repository.query('SELECT folder_id FROM nodes WHERE id=?').get(id)?.folder_id;
      return this.profiles?this.profiles.resolve(folder?String(folder):null).masteryReps:this.settings.masteryReps;
    });
  }
  static async create(repository:Repository,now:()=>number=Date.now):Promise<StudyService>{
    const stored=repository.getSetting('studySettings') as Record<string,unknown>|null;
    const settings=normalizeSettings({...DEFAULT_SETTINGS,...stored as object,
      fontSize:repository.getSetting('fontSize')||DEFAULT_SETTINGS.fontSize,theme:repository.getSetting('theme')||DEFAULT_SETTINGS.theme});
    // 1.133：1.132 及以前保存的 studySettings 没有「每日上限」字段，也没有真正用过学习步骤
    // （enableShortTerm 恒为 false）。这类老配置一次性升级成三态：默认打开学习步骤，之后用户在设置里关掉就保持关。
    if(stored&&!('newPerDay' in stored)&&settings.enableShortTerm===false){
      settings.enableShortTerm=true;
      repository.setSetting('studySettings',settings);
    }
    // 1.136：用户要求 leech 阈值「本次和以后默认都是 4」——把老库里仍是旧默认 8 的一次性改成 4
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
  private static schedulerFor(settings:ReviewSettings){return DefaultScheduler({version:settings.fsrsVersion||'FSRS-7',desiredRetention:settings.desiredRetention,
    ...(settings.fsrsWeights?.length?{weights:settings.fsrsVersion==='FSRS-6'?migrateFSRS6Parameters(settings.fsrsWeights):settings.fsrsWeights}:{}),
    maximumInterval:settings.maximumInterval,enableShortTerm:settings.enableShortTerm,enableFuzz:false,
    learningSteps:settings.enableShortTerm?(settings.learningSteps||['1m','10m']) as any:[],relearningSteps:settings.enableShortTerm?(settings.relearningSteps||['10m']) as any:[],allowModelOverride:false});}
  config(){return {settings:this.settings,shortcuts:normalizeShortcuts(this.repository.getSetting('shortcuts')),algorithm:'ts-fsrs/6.0.0:'+this.settings.fsrsVersion};}
  private async prepareProfiles(profiles:DeckProfiles){
    for(const value of profiles.all()){const key=profileKey(value);if(!this.schedulers.has(key))this.schedulers.set(key,await StudyService.schedulerFor(value));}
  }
  // ===== 1.135：Anki 的「更改时将卡片重新排程」=====
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
        const due=Math.round(last+interval*86400000);
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
  async saveDeckConfig(input:{folderId:string;overrides:unknown}){
    this.profiles.configuration(input.folderId);const overrides=normalizeReviewOverrides(input.overrides);
    const profiles=new DeckProfiles(this.repository,this.settings,{folderId:input.folderId,overrides});await this.prepareProfiles(profiles);
    if(overrides)this.repository.query('INSERT INTO deck_settings(folder_id,overrides,updated_at) VALUES(?,?,?) ON CONFLICT(folder_id) DO UPDATE SET overrides=excluded.overrides,updated_at=excluded.updated_at')
      .run(input.folderId,JSON.stringify(overrides),this.now());
    else this.repository.query('DELETE FROM deck_settings WHERE folder_id=?').run(input.folderId);
    this.profiles=profiles;if(this.session)this.session.queue=[];
    if(this.settings.rescheduleOnChange)this.rescheduleCards(input.folderId);
    return this.deckConfig(input.folderId);
  }
  async saveConfig(input:{settings:unknown;shortcuts:unknown}){
    const settings=normalizeSettings(input.settings),shortcuts=normalizeShortcuts(input.shortcuts);
    const profiles=new DeckProfiles(this.repository,settings);await this.prepareProfiles(profiles);
    this.repository.transaction(()=>{
      this.repository.setSetting('studySettings',settings);this.repository.setSetting('shortcuts',shortcuts);
      this.repository.setSetting('fontSize',settings.fontSize);this.repository.setSetting('theme',settings.theme);
    });
    this.settings=settings;this.profiles=profiles;this.invalidate();if(this.session)this.session.queue=[];
    if(settings.rescheduleOnChange)this.rescheduleCards(null);
    return this.config();
  }
  invalidate(){this.statsCache=null;this.dependencyCache=null;}
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
        VALUES(?,'fsrs',?,?,?,?,0,0)`).run(id,'ts-fsrs/6.0.0:'+(this.profiles.resolve(node.folder_id?String(node.folder_id):null).fsrsVersion||'FSRS-7'),JSON.stringify(card),now,now);
    }
    const active=node.kind==='cloze'&&!!this.repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(id)?.enabled;
    this.repository.query('INSERT OR IGNORE INTO reading_state(node_id,due_at,enabled) VALUES(?,?,?)').run(id,now,active?0:1);
    this.invalidate();
  }
  setPriority(id:string,priority:number|null){
    if(priority!==null&&(!Number.isInteger(priority)||priority<0||priority>9))throw Error(t('优先级需要 0 到 9，或选择继承。'));
    if(!this.repository.query('UPDATE nodes SET priority=? WHERE id=? AND deleted_at IS NULL').run(priority,id).changes)throw Error(t('项目已删除。'));
    if(this.session)this.session.queue=[];
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
      // 1.210：从待办暂停回到复习＝当新卡重新计分——记忆状态（稳定性/难度/次数/到期/阶段）清零，
      // 复习记录和 leech 标签都保留，所以历史里还能看到之前学过什么。
      if(node.kind==='cloze'&&enabled&&before.review?.enabled===0){
        const profile=this.profiles.resolve(node.folderId);
        const card={...this.schedulerForDeck(node.folderId).newCard({now:new Date(now)}),cardId:id};
        this.repository.query(`UPDATE review_cards SET state=?,due_at=?,stage=0,algorithm_version=?,revision=revision+1
          WHERE node_id=?`).run(JSON.stringify(card),now,'ts-fsrs/6.0.0:'+(profile.fsrsVersion||'FSRS-7'),id);
      }
      const after=readSchedule(this.repository,id)!;
      recordStudyChange(this.repository,id,now,before,after);
      return {id,before,after};
    });
    if(this.session)this.session.queue=[];this.invalidate();
    return change;
  }
  /** 1.181：留存判定——手动把卡片放进"暂存点"：不确定要不要留在 IR 时先收起来，
   *  移出复习与待办队列，打 hold 标签；之后可在浏览卡片里取消或直接删除。 */
  setHold(id:string,hold:boolean){
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    this.register(id);
    this.repository.transaction(()=>{
      // 1.194：hold 也随排程同步——记下前后状态，对端收到后标签和队列开关一起变。
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
  }  /** 1.180：手动搁置到下一个日切点（和 Anki 的 Bury 一样），并打 buried 标签让状态/筛选能看出来。 */
  bury(id:string){
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    this.register(id);
    const change=this.repository.transaction(()=>{
      const before=readSchedule(this.repository,id)!;
      const now=this.now();
      const until=StudyService.dayStartMs(now,this.settings.dayStartHour)+86400000;
      this.repository.query('UPDATE review_cards SET due_at=?,revision=revision+1 WHERE node_id=?').run(until,id);
      this.repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'buried')").run(id);
      recordStudyChange(this.repository,id,now,before,readSchedule(this.repository,id)!);
      return {id,before,after:readSchedule(this.repository,id)!};
    });
    if(this.session)this.session.queue=[];this.invalidate();
    return change;
  }
  /** 1.210：取消搁置——删掉 buried 标签，并把到期时间拉回现在，等下一次推送。 */
  unbury(id:string){
    const node=this.repository.getNode(id);
    if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    this.register(id);
    const change=this.repository.transaction(()=>{
      if(!this.repository.query("SELECT 1 FROM node_tags WHERE node_id=? AND tag='buried'").get(id))return null;
      const before=readSchedule(this.repository,id)!,now=this.now();
      this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='buried'").run(id);
      this.repository.query('UPDATE review_cards SET due_at=MIN(due_at,?),revision=revision+1 WHERE node_id=?').run(now,id);
      recordStudyChange(this.repository,id,now,before,readSchedule(this.repository,id)!);
      return {id,before,after:readSchedule(this.repository,id)!};
    });
    if(this.session)this.session.queue=[];this.invalidate();
    return change;
  }
  /** 1.210：卡片属性面板里改标签。hold / buried / leech 是内部状态，删标签必须连带改队列，
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
    const buried=node.kind==='cloze'&&Boolean(this.repository.query("SELECT 1 FROM node_tags WHERE node_id=? AND tag='buried'").get(id))&&Number(review?.due_at||0)>this.now();
    const hold=Boolean(this.repository.query("SELECT 1 FROM node_tags WHERE node_id=? AND tag='hold'").get(id));
    const lastRead=this.repository.query('SELECT action FROM reading_log WHERE node_id=? AND undone_at IS NULL ORDER BY reviewed_at DESC LIMIT 1').get(id);
    const dismissed=!push?.enabled&&lastRead?.action==='dismiss';
    const reviewed=Boolean(review&&Number(review.stage||0)>0);
    return {enabled:node.kind==='cloze'?!!review?.enabled:!!push?.enabled,reviewEnabled:active,pushEnabled:!!push?.enabled,buried:!!buried,hold,dismissed,reviewed,
      priority:node.priority,effectivePriority:this.priority(id),kind:active?'fsrs':'reading',dueAt:(active?review:push)?.due_at||null,
      readingPosition:Number(push?.reading_position||0)};
  }
  /** 1.211：累计重来次数（撤销掉的不算）。leech 属性后面用它显示 leech(n)，让人看得出循环了几轮。 */
  leechLapses(id:string):number{
    return Number(this.repository.query('SELECT count(*) n FROM review_log WHERE node_id=? AND rating=1 AND undone_at IS NULL').get(id)?.n||0);
  }
  counts():Record<string,FolderCounts>{
    const now=this.now();if(this.statsCache&&now-this.statsCache.at<15000)return this.statsCache.value;
    const result:Record<string,FolderCounts>={};
    const rows=this.repository.query(`SELECT n.folder_id,
      SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND r.stage=0 THEN 1 ELSE 0 END) AS fresh,
      SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND r.stage IN(1,3) THEN 1 ELSE 0 END) AS learning,
      SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND r.stage=2 AND r.due_at<=? THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN n.push_ready=1 AND(n.kind!='cloze' OR r.enabled=0) AND s.enabled=1 AND s.due_at<=? THEN 1 ELSE 0 END) AS readingDue,
      SUM(CASE WHEN n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND r.due_at<=? THEN 1 ELSE 0 END) AS fsrsDue
      FROM nodes n LEFT JOIN review_cards r ON r.node_id=n.id LEFT JOIN reading_state s ON s.node_id=n.id
      WHERE n.kind!='folder' AND n.deleted_at IS NULL AND(n.study_ready=1 OR n.push_ready=1) AND ${unlocked}
      GROUP BY n.folder_id`).all(now,now,now,this.blockedCards().json);
    const zero=():FolderCounts=>({new:0,learning:0,review:0,readingDue:0,fsrsDue:0}),total=zero();
    for(const folder of this.profiles.folders.values())result[folder.id]=zero();
    for(const row of rows){const count={new:Number(row.fresh),learning:Number(row.learning),review:Number(row.review),readingDue:Number(row.readingDue),fsrsDue:Number(row.fsrsDue)};
      result[String(row.folder_id)]=count;for(const key of Object.keys(total) as Array<keyof FolderCounts>)total[key]+=count[key];}
    const remaining=new Map([...this.profiles.folders.keys()].map(id=>[id,0]));
    for(const folder of this.profiles.folders.values())if(folder.parentId&&remaining.has(folder.parentId))remaining.set(folder.parentId,remaining.get(folder.parentId)!+1);
    const leaves=[...remaining].filter(([,count])=>count===0).map(([id])=>id);
    while(leaves.length){const id=leaves.pop()!,parent=this.profiles.folders.get(id)?.parentId;
      if(parent&&result[parent]){for(const key of Object.keys(total) as Array<keyof FolderCounts>)result[parent][key]+=result[id][key];remaining.set(parent,remaining.get(parent)!-1);if(remaining.get(parent)===0)leaves.push(parent);}}
    this.statsCache={at:now,value:result,total};return result;
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
    const postponed=0; // 1.32：取消 auto-postpone，允许积压，队列只按优先级/到期处理
    this.session={id:randomUUID(),mode,folderId,queue:[],current:null,token:'',completed:0,history:[],submitted:new Set(),shownAt:this.now(),postponed};
    this.next();return this.snapshot();
  }
  stop(){this.session=null;return true;}
  refresh():StudySnapshot {
    const session=this.active();
    if(session.current){const node=this.repository.getNode(session.current),row=node?this.stateRow(node):null;
      const ready=node?this.ready(node.id):0;
      if(!node||!this.matchesMode(node)||!ready||!row?.enabled||this.blockedCards().ids.has(node.id))session.current=null;}
    if(!session.current)this.next();return this.snapshot();
  }
  private active(){if(!this.session)throw Error(t('当前没有进入复习。'));return this.session;}
  private matchesMode(node:Material){
    const session=this.active();
    if(session.mode==='reading')return node.kind!=='folder'&&(node.kind!=='cloze'||!this.repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(node.id)?.enabled);
    if(node.kind!=='cloze')return false;
    if(!session.folderId)return true;
    for(let id=node.folderId;id;id=this.profiles.folders.get(id)?.parentId??null){
      if(id===session.folderId)return this.profiles.folders.has(id);
    }
    return false;
  }
  private ready(id:string,mode=this.active().mode){return this.repository.query(`SELECT ${mode==='cards'?'study_ready':'push_ready'} ready FROM nodes WHERE id=?`).get(id)?.ready;}
  private stateRow(node:Material,mode=this.active().mode):Row|undefined {return this.repository.query(`SELECT * FROM ${mode==='cards'?'review_cards':'reading_state'} WHERE node_id=?`).get(node.id) as Row|undefined;}
  private priority(id:string):number{return resolveInheritedPushQueuePriority(this.repository.path(id).reverse().map(node=>node.priority),this.settings.defaultPriority as any);}
  // ===== 1.7 ①：采用 Foliole 阅读推送算法（用户要求），四动作：读完/稍后/本轮再出/搁置 =====
  // 公式对照 foliole/src/features/review/model/unifiedPushQueueRules.ts：
  //   growth = 1.1 + (priority-1) * (1.5-1.1) / 8    ← 优先级 1 → 1.1，优先级 9 → 1.5，线性映射
  //   nextInterval = max(初始间隔, prevInterval * growth^exponent)
  //   读完 exponent=1（全增长）；稍后 exponent=0.5（只乘平方根，稍拉长）；首读固定初始间隔（1 天）。
  // 「本轮再出」不动间隔与次数（见 grade() 的 soon 分支）。
  private static readonly GROWTH_MIN=1.1;
  private static readonly GROWTH_MAX=1.5;
  private readingGrowth(id:string):number{
    const priority=this.priority(id)||this.settings.defaultPriority;
    return Math.round((StudyService.GROWTH_MIN+(priority-1)*(StudyService.GROWTH_MAX-StudyService.GROWTH_MIN)/8)*100)/100;
  }
  private pushSchedule(id:string,row:Row,action:'read'|'later',now:number){
    if(action==='later'&&this.settings.readingLaterDays>0){
      return {dueAt:now+this.settings.readingLaterDays*86400000,interval:Number(row.interval_ms),reps:Number(row.reps)};
    }
    const initial=this.settings.readingInitialDays*86400000;
    const reps=Number(row.reps);
    const interval=Math.round(reps<=0?initial:Math.max(initial,Number(row.interval_ms)*Math.pow(this.readingGrowth(id),action==='later'?0.5:1)));
    return {dueAt:now+interval,interval,reps:reps+1};
  }
  // ===== 1.7 ②：auto-postpone（SM「自动延后」策略层）=====
  // 1.32：auto-postpone 已按用户要求取消——允许积压，队列完全按优先级与到期时间处理。
  setReadingPosition(id:string,position:number):void{
    if(!Number.isFinite(position)||position<0)throw Error(t('阅读位置无效。'));
    if(!this.repository.query('UPDATE reading_state SET reading_position=?,revision=revision+1 WHERE node_id=?')
      .run(Math.min(100000000,Math.floor(position)),id).changes)throw Error(t('卡片不存在。'));
  }
  cardInfo(input:{id:string;offset?:number;horizon?:number}){
    const node=this.repository.getNode(input.id);if(!node||node.kind==='folder')throw Error(t('卡片不存在。'));
    const r=this.repository.query('SELECT * FROM review_cards WHERE node_id=?').get(node.id) as Row|undefined;
    const push=this.repository.query('SELECT * FROM reading_state WHERE node_id=?').get(node.id),profile=this.profiles.resolve(node.folderId),now=this.now();
    const offset=Math.max(0,Math.floor(Number(input.offset)||0)),horizon=Math.max(1,Math.min(36500,Number(input.horizon)||180));
    // 1.210：复习记录里也带上排程事件（待办暂停 / 返回复习 / 搁置 / 留存判定这些），
    // 它们没有评分，评分列留空；真正的复习记录仍然来自 review_log。
    const eventFilter=`node_id=? AND session_id=? AND kind='schedule'
      AND json_extract(json_extract(after_state,'$.details'),'$.action') IN ('queue','tags')`;
    const total=Number(this.repository.query(`SELECT
      (SELECT count(*) FROM review_log WHERE node_id=?)+
      (SELECT count(*) FROM study_operations WHERE ${eventFilter}) AS n`)
      .get(node.id,node.id,studyChangeSession)!.n);
    const everReviewed=Number(this.repository.query('SELECT count(*) n FROM review_log WHERE node_id=?').get(node.id)!.n)>0;
    const history=(this.repository.query(`
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
        // 1.107：复习类型（0 新卡 / 1 学习 / 2 复习 / 3 重新学习），供 Anki 式历史表显示
  type:typeof before?.state==='number'?before.state:(typeof original?.type==='number'?original.type:null),
  stability:after?.stability??null,difficulty:after?.difficulty??null,elapsedDays:after?.lastReviewAt&&before?.lastReviewAt?(new Date(after.lastReviewAt).getTime()-new Date(before.lastReviewAt).getTime())/86400000:null,
        seconds:original?Number(original.time||0)/1000:details.durationMs===undefined?null:details.durationMs/1000,undone:!!row.undone_at};
    });
    const state=r?JSON.parse(r.state):null,curve:Array<{days:number;probability:number}>=[];let retrievability:number|null=null;
    if(r&&state?.lastReviewAt&&state.stability>0){
      const scheduler=this.schedulerForDeck(node.folderId),card=this.card(r);
      for(let i=0;i<=80;i++){const days=horizon*i/80,at=new Date(now+days*86400000),elapsed=Math.max(0,scheduler.chrono.difference(card.lastReviewAt!,at));
        const probability=Math.max(0,Math.min(1,scheduler.model.forgettingCurve(card,elapsed)));curve.push({days,probability});}
      retrievability=curve[0].probability;
    }
    // 1.14：参照 Anki「卡片信息」补齐字段——有效复习次数、首次/最近复习、当前间隔、
    // 总用时与平均用时（Anki 的 total/average time），供卡片信息面板复现。
    const aggregate=this.repository.query(`SELECT MIN(CASE WHEN undone_at IS NULL THEN reviewed_at END) AS firstReview,
        MAX(CASE WHEN undone_at IS NULL THEN reviewed_at END) AS lastReview,
        SUM(CASE WHEN undone_at IS NULL THEN 1 ELSE 0 END) AS live
      FROM review_log WHERE node_id=?`).get(node.id)!;
    let totalSeconds:number|null=null;
    try{
      const timeline=this.repository.query(`SELECT SUM(CAST(json_extract(details,'$.durationMs') AS REAL)) AS ms
        FROM review_log WHERE node_id=? AND undone_at IS NULL`).get(node.id);
      if(timeline?.ms!==null&&timeline?.ms!==undefined)totalSeconds=Number(timeline.ms)/1000;
    }catch{totalSeconds=null;}
    const liveCount=Number(aggregate.live||0);
    const intervalDays=r?.due_at&&state?.lastReviewAt?(Number(r.due_at)-new Date(state.lastReviewAt).getTime())/86400000:null;
    const elapsedDays=state?.lastReviewAt?(now-new Date(state.lastReviewAt).getTime())/86400000:null;
    return {id:node.id,title:node.title,kind:node.kind,path:this.repository.path(node.id).map(n=>n.title).join(' / '),
      prerequisites:node.kind==='cloze'?this.prerequisites(node.id):null,
      tags:this.repository.query('SELECT tag FROM node_tags WHERE node_id=? ORDER BY tag').all(node.id).map(row=>String(row.tag)),
      leechCount:this.leechLapses(node.id),
      settings:profile,reviewEnabled:node.kind==='cloze'&&!!r?.enabled,pushEnabled:!!push?.enabled,dueAt:r?.due_at??null,pushDueAt:push?.due_at??null,
      state,createdAt:this.repository.query('SELECT created_at FROM nodes WHERE id=?').get(node.id)?.created_at,
      updatedAt:this.repository.query('SELECT updated_at FROM nodes WHERE id=?').get(node.id)?.updated_at,
      reviewCount:liveCount,firstReviewAt:aggregate.firstReview?Number(aggregate.firstReview):null,
      latestReviewAt:aggregate.lastReview?Number(aggregate.lastReview):null,
      intervalDays,elapsedDays,totalSeconds,
      averageSeconds:liveCount&&totalSeconds!==null?totalSeconds/liveCount:null,
      retrievability,curve,horizon,history,total,offset};
  }
  statistics(input:{folderId?:string;days?:number}={}){
    const now=this.now(),days=Math.max(7,Math.min(366,Math.floor(Number(input.days)||30))),start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-days+1);
    const from=start.getTime(),args:any[]=[],where=["n.deleted_at IS NULL","n.kind!='folder'"];
    if(input.folderId){where.push(inDeck);args.push(input.folderId);}
    const scope=where.join(' AND '),summary=this.repository.query(`SELECT count(*) total,
      SUM(CASE WHEN n.kind='cloze' THEN 1 ELSE 0 END) tests,
      SUM(CASE WHEN n.kind='cloze' AND r.enabled=1 AND r.stage=0 AND n.study_ready=1 THEN 1 ELSE 0 END) newCards,
      SUM(CASE WHEN n.kind='cloze' AND r.enabled=1 AND r.stage>0 AND n.study_ready=1 THEN 1 ELSE 0 END) learned,
      SUM(CASE WHEN s.enabled=1 AND(n.kind!='cloze' OR r.enabled=0) THEN 1 ELSE 0 END) pushing,
      SUM(CASE WHEN n.kind='cloze' AND r.enabled=0 THEN 1 ELSE 0 END) suspended,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM node_tags t WHERE t.node_id=n.id AND t.tag='leech') THEN 1 ELSE 0 END) leeches
      FROM nodes n LEFT JOIN review_cards r ON r.node_id=n.id LEFT JOIN reading_state s ON s.node_id=n.id WHERE ${scope}`).get(...args)!;
    const daily=this.repository.query(`SELECT date(l.reviewed_at/1000,'unixepoch','localtime') day,count(*) answers,SUM(CASE WHEN l.rating=1 THEN 1 ELSE 0 END) forgot
      FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=? GROUP BY day ORDER BY day`).all(...args,from);
    const ratings=this.repository.query(`SELECT l.rating,count(*) count FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=? GROUP BY rating`).all(...args,from);
    // 1.34：到期预测——覆盖未来 3650 天（供「全部」视图），逾期归到"今天"那一格（对齐 Anki forecast 口径）。
    const forecast=this.repository.query(`SELECT date(MAX(r.due_at,?)/1000,'unixepoch','localtime') day,count(*) count FROM review_cards r JOIN nodes n ON n.id=r.node_id
      WHERE ${scope} AND n.kind='cloze' AND n.study_ready=1 AND r.enabled=1 AND r.due_at<=? GROUP BY day ORDER BY day`).all(now,...args,now+3650*86400000);
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
    const cardRows=this.repository.query(`SELECT r.state AS state FROM review_cards r JOIN nodes n ON n.id=r.node_id
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
    const buttonRow=this.repository.query(`SELECT
        SUM(CASE WHEN l.rating=1 THEN 1 ELSE 0 END) again,SUM(CASE WHEN l.rating=2 THEN 1 ELSE 0 END) hard,
        SUM(CASE WHEN l.rating=3 THEN 1 ELSE 0 END) good,SUM(CASE WHEN l.rating=4 THEN 1 ELSE 0 END) easy
      FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=?`).get(...args,from)!;
    const hourlyRows=this.repository.query(`SELECT CAST(strftime('%H',l.reviewed_at/1000,'unixepoch','localtime') AS INTEGER) hour,count(*) count
      FROM review_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=?
      GROUP BY hour`).all(...args,from) as Array<{hour:number;count:number}>;
    const hourly=Array.from({length:24},(_,hour)=>({label:String(hour).padStart(2,'0')+':00',count:hourlyRows.find(row=>Number(row.hour)===hour)?.count||0}));
    const addedRows=this.repository.query(`SELECT date(n.created_at/1000,'unixepoch','localtime') day,count(*) count
      FROM nodes n WHERE ${scope} AND n.created_at>=? GROUP BY day ORDER BY day`).all(...args,from) as Array<{day:string;count:number}>;
    const studiedDays=new Set((daily as Array<{day:string}>).map(row=>String(row.day))).size;
    return {title:input.folderId?this.profiles.configuration(input.folderId).path:t('全部牌组'),days,summary,daily,ratings,forecast,
      intervalBuckets,stabilityBuckets,difficultyBuckets,
      buttons:{again:Number(buttonRow.again||0),hard:Number(buttonRow.hard||0),good:Number(buttonRow.good||0),easy:Number(buttonRow.easy||0)},
      hourly,added:addedRows,studiedDays};
  }
  /** 1.206：待办统计（轻量）：主题/提取数量、待办状态、今日到期、阅读动作与未来到期。 */
  readingStatistics(input:{folderId?:string;days?:number}={}){
    const now=this.now(),days=Math.max(7,Math.min(366,Math.floor(Number(input.days)||30))),start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-days+1);
    const from=start.getTime(),args:any[]=[],where=["n.deleted_at IS NULL","n.kind!='folder'"];
    if(input.folderId){where.push(inDeck);args.push(input.folderId);}
    const scope=where.join(' AND ');
    const summary=this.repository.query(`SELECT SUM(CASE WHEN n.kind!='cloze' THEN 1 ELSE 0 END) total,
      SUM(CASE WHEN n.kind='topic' THEN 1 ELSE 0 END) topics,
      SUM(CASE WHEN n.kind='material' THEN 1 ELSE 0 END) materials,
      SUM(CASE WHEN n.kind!='cloze' AND s.enabled=1 THEN 1 ELSE 0 END) pushing,
      SUM(CASE WHEN n.kind!='cloze' AND COALESCE(s.enabled,0)=0 THEN 1 ELSE 0 END) stopped,
      SUM(CASE WHEN n.kind!='cloze' AND COALESCE(s.enabled,0)=0 AND (
        SELECT l.action FROM reading_log l WHERE l.node_id=n.id AND l.undone_at IS NULL ORDER BY l.reviewed_at DESC,l.event_id DESC LIMIT 1)='dismiss' THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN n.kind!='cloze' AND s.enabled=1 AND s.due_at<=? THEN 1 ELSE 0 END) dueToday
      FROM nodes n LEFT JOIN reading_state s ON s.node_id=n.id WHERE ${scope}`).get(now,...args)!;
    const actions=this.repository.query(`SELECT l.action,count(*) count FROM reading_log l JOIN nodes n ON n.id=l.node_id
      WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=? GROUP BY l.action`).all(...args,from) as Array<{action:string;count:number}>;
    const daily=this.repository.query(`SELECT date(l.reviewed_at/1000,'unixepoch','localtime') day,count(*) actions,
      SUM(CASE WHEN l.action='read' THEN 1 ELSE 0 END) reads,SUM(CASE WHEN l.action='dismiss' THEN 1 ELSE 0 END) done
      FROM reading_log l JOIN nodes n ON n.id=l.node_id WHERE ${scope} AND l.undone_at IS NULL AND l.reviewed_at>=?
      GROUP BY day ORDER BY day`).all(...args,from) as Array<{day:string;actions:number;reads:number;done:number}>;
    const forecast=this.repository.query(`SELECT date(MAX(s.due_at,?)/1000,'unixepoch','localtime') day,count(*) count
      FROM reading_state s JOIN nodes n ON n.id=s.node_id WHERE ${scope} AND n.kind!='cloze' AND s.enabled=1 AND s.due_at<=?
      GROUP BY day ORDER BY day`).all(now,...args,now+3650*86400000) as Array<{day:string;count:number}>;
    const studiedDays=new Set(daily.map(row=>String(row.day))).size;
    const countOf=(action:string)=>Number(actions.find(row=>row.action===action)?.count||0);
    return {title:input.folderId?this.profiles.configuration(input.folderId).path:t('全部牌组'),days,summary,actions,
      daily,forecast,studiedDays,read:countOf('read'),later:countOf('later'),soon:countOf('soon'),done:countOf('dismiss')};
  }
  async simulateWorkload(folderId:string|null){
    const scope=deckScope(folderId),now=this.now(),day=86400000,days=30;
    const blocked=this.blockedCards().json;
    const rows=this.repository.query(`SELECT n.id,r.state,r.due_at,r.stage,r.algorithm_version,n.folder_id FROM review_cards r JOIN nodes n ON n.id=r.node_id
      WHERE r.enabled=1 AND n.kind='cloze' AND n.study_ready=1 AND n.deleted_at IS NULL AND ${unlocked} ${scope.filter}`).all(blocked,...scope.args);
    const profiles=this.profiles;
    const history=this.repository.query(`SELECT n.folder_id,l.rating,COUNT(*) AS count
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
          scheduler=await StudyService.schedulerFor({...profile,desiredRetention:retention,enableShortTerm:false});
          schedulers.set(key,scheduler);
        }
        let card=this.card(row),at=Math.max(now,Number(row.due_at));
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
          card=this.card({...row,state:JSON.stringify(next),due_at:next.dueAt.getTime()});
          at=Math.max(at+day,card.dueAt.getTime());
        }
      }
      results.push({retention,total:counts.reduce((sum,count)=>sum+count,0),peak:Math.max(...counts)});
    }
    return {days,cards:rows.length,historyCount,results};
  }
  private card(row:Row):DefaultSchedulerCard<'FSRS-7'>{
    if(!/^ts-fsrs\/6\.0\.0:FSRS-[67]$/.test(row.algorithm_version))throw Error(t('这张卡片的复习数据来自其他算法版本，需要迁移后使用。'));
    const state=JSON.parse(row.state);
    const card={...state,stabilityFast:state.stabilityFast??state.stability,dueAt:new Date(state.dueAt),lastReviewAt:state.lastReviewAt?new Date(state.lastReviewAt):null};
    if(!Number.isFinite(card.dueAt.getTime())||(card.lastReviewAt&&!Number.isFinite(card.lastReviewAt.getTime())))throw Error(t('复习日期无效。'));
    return card as DefaultSchedulerCard<'FSRS-7'>;
  }
  // ===== 1.133：Anki 式每日上限（新卡 / 复习）=====
  // 当天已做数取自 review_log：before.state 0=新卡、2=复习；撤销过的记录（undone_at）不算。
  // 「学习/重学」（state 1/3）不占额度，与 Anki 一致。设置值 0 表示不限。
  // 1.136：一天从 settings.dayStartHour 点开始（默认 4 点），review_log 统计与搁置的「次日」都按它算。
  private static dayStartMs(now:number,hour:number):number{
    const date=new Date(now);date.setHours(hour,0,0,0);
    if(date.getTime()>now)date.setDate(date.getDate()-1);
    return date.getTime();
  }
  private dailyUsage(folderId:string|null):{new:number;review:number}{
    const start=StudyService.dayStartMs(this.now(),this.settings.dayStartHour);
    // 1.199：每日上限可以按牌组设置，所以已做数也只统计这个牌组（含子牌组）的卡片。
    const scope=folderId?deckScope(folderId):{filter:'',args:[] as any[]};
    const row=this.repository.query(`SELECT
      SUM(CASE WHEN json_extract(l.before_state,'$.state')=0 THEN 1 ELSE 0 END) AS newCount,
      SUM(CASE WHEN json_extract(l.before_state,'$.state')=2 THEN 1 ELSE 0 END) AS reviewCount
      FROM review_log l JOIN nodes n ON n.id=l.node_id
      WHERE l.reviewed_at>=? AND l.undone_at IS NULL ${scope.filter}`).get(start,...scope.args) as {newCount:number|null;reviewCount:number|null}|undefined;
    return {new:Number(row?.newCount||0),review:Number(row?.reviewCount||0)};
  }
  private remainingToday(folderId:string|null):{new:number;review:number}{
    const usage=this.dailyUsage(folderId),profile=this.profiles.resolve(folderId);
    return {
      new:profile.newPerDay>0?Math.max(0,profile.newPerDay-usage.new):Number.POSITIVE_INFINITY,
      review:profile.reviewPerDay>0?Math.max(0,profile.reviewPerDay-usage.review):Number.POSITIVE_INFINITY,
    };
  }
  private candidates():string[]{
    const session=this.active(),now=this.now(),at=new Date(now),blocked=this.blockedCards().json;
    const scope=deckScope(session.folderId);
    const remaining=this.remainingToday(session.folderId);
    const reads=session.mode==='cards'?[]:this.repository.query(`WITH RECURSIVE absolute_priority(id) AS (
      SELECT id FROM nodes WHERE priority=0 AND deleted_at IS NULL
      UNION ALL
      SELECT child.id FROM nodes child JOIN absolute_priority parent ON parent.id=child.parent_id
      WHERE child.priority IS NULL AND child.deleted_at IS NULL
    )
      SELECT n.id,n.parent_id,n.priority,s.due_at,s.interval_ms FROM reading_state s JOIN nodes n ON n.id=s.node_id
      LEFT JOIN review_cards review ON review.node_id=n.id
      WHERE n.kind!='folder' AND(n.kind!='cloze' OR review.enabled=0) AND n.deleted_at IS NULL AND n.push_ready=1 AND s.enabled=1 AND s.due_at<=? AND ${unlocked}
      ORDER BY n.id IN(SELECT id FROM absolute_priority) DESC,s.due_at,n.position,n.id LIMIT 500`).all(now,blocked);
    const cards=session.mode==='reading'?[]:this.repository.query(`SELECT n.id,n.parent_id,n.folder_id,r.stage,r.state,r.algorithm_version FROM review_cards r JOIN nodes n ON n.id=r.node_id
      WHERE n.kind='cloze' AND n.deleted_at IS NULL AND n.study_ready=1 AND r.enabled=1 AND r.due_at<=? AND ${unlocked} ${scope.filter}
      ORDER BY CASE WHEN r.stage IN(1,3) THEN 0 WHEN r.stage=2 THEN 1 ELSE 2 END,r.due_at,n.position,n.id LIMIT 500`).all(now,blocked,...scope.args) as Row[];
    // 1.133：按今天剩余额度裁剪新卡与复习卡；学习/重学（stage 1/3）始终保留在最前面
    const limited=cards.filter(row=>{
      if(Number(row.stage)===0){if(remaining.new<=0)return false;remaining.new-=1;return true;}
      if(Number(row.stage)===2){if(remaining.review<=0)return false;remaining.review-=1;return true;}
      return true;
    });
    const metadata=new Map<string,Row>([...reads,...cards].map(row=>[String(row.id),row]));
    const pathFrom=(id:string)=>{
      const chain:Row[]=[],seen=new Set<string>();let current:string|null=id;
      while(current){
        if(seen.has(current))throw Error(t('目录包含循环关系。'));seen.add(current);
        let node=metadata.get(current);
        if(!node){node=this.repository.query('SELECT id,parent_id,priority FROM nodes WHERE id=? AND deleted_at IS NULL').get(current) as Row|undefined;if(node)metadata.set(current,node);}
        if(!node)break;chain.push(node);current=node.parent_id?String(node.parent_id):null;
      }
      return chain;
    };
    if(session.mode==='reading'){
      const reading=reads.map(row=>{
        const id=String(row.id),path=pathFrom(id),dueAt=new Date(Number(row.due_at)).toISOString();
        const priority=resolveInheritedPushQueuePriority(path.map(node=>node.priority),this.settings.defaultPriority as any);
        return {id,priority,pathNodeIds:path.reverse().map(node=>String(node.id)),nextAt:dueAt,dueAt,
          intervalDurationMs:Number(row.interval_ms)};
      });
      return assembleReadingPushQueue(reading,{priorityRatio:this.settings.priorityRatio,
        materialDispersion:{now:at.toISOString(),readingInitialIntervalMs:this.settings.readingInitialDays*86400000}}).map(row=>row.id);
    }
    const ordered=assembleFsrsPushQueue(limited.map(row=>{
      const id=String(row.id),pathNodeIds=pathFrom(id).reverse().map(node=>String(node.id));
      if(row.stage===0)return {id,pathNodeIds,priority:5 as const,retrievability:1};
      if(row.stage===1||row.stage===3)return {id,pathNodeIds,priority:5 as const,retrievability:-1};
      const scheduler=this.schedulerForDeck(String(row.folder_id)),card=this.card(row);
      const elapsed=card.lastReviewAt?scheduler.chrono.difference(card.lastReviewAt,at):0;
      return {id,pathNodeIds,priority:5 as const,retrievability:scheduler.model.forgettingCurve(card,elapsed)};
    }),{priorityRatio:1,materialDispersion:{}}).map(row=>row.id);
    // 1.133：展示顺序（对应 Anki 牌组选项的「展示顺序」）。
    //   新学/复习的先后：mixed=学新与复习混合（默认）、newFirst=新卡先出、reviewFirst=复习先出；
    //   新卡插入位置：position=顺序插入（旧卡片在前，默认）、random=随机；
    //   复习排列顺序：forgetting=最容易忘的先（默认）、due=按到期日期、random=随机。
    // 学习/重学永远排最前，组内顺序沿用上面的遗忘程度/位置排序。
    const stages=new Map(limited.map(row=>[String(row.id),Number(row.stage)]));
    const dueAt=new Map(limited.map(row=>[String(row.id),Number(row.due_at)]));
    const groups:{learning:string[];review:string[];fresh:string[]}={learning:[],review:[],fresh:[]};
    for(const id of ordered){const stage=stages.get(id);(stage===0?groups.fresh:stage===2?groups.review:groups.learning).push(id);}
    if(this.settings.newOrder==='random')groups.fresh=StudyService.shuffle(groups.fresh);
    if(this.settings.reviewOrder==='due')groups.review.sort((a,b)=>(dueAt.get(a)||0)-(dueAt.get(b)||0));
    else if(this.settings.reviewOrder==='random')groups.review=StudyService.shuffle(groups.review);
    const order=this.settings.newReviewOrder||'mixed';
    if(order==='newFirst')return [...groups.learning,...groups.fresh,...groups.review];
    if(order==='reviewFirst')return [...groups.learning,...groups.review,...groups.fresh];
    return [...groups.learning,...StudyService.interleave(groups.review,groups.fresh)];
  }
  private static shuffle<T>(items:T[]):T[]{
    const copy=[...items];
    for(let i=copy.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}
    return copy;
  }
  /** 学新与复习混合：把新卡均匀插进复习队列（Anki 的 New/review order = 混合）。 */
  private static interleave<T>(review:T[],fresh:T[]):T[]{
    const result:T[]=[],pending=[...fresh];
    if(!pending.length)return [...review];
    if(!review.length)return pending;
    const step=review.length/pending.length;
    let next=step;
    for(let index=0;index<review.length;index++){
      while(next<=index+1&&pending.length){result.push(pending.shift()!);next+=step;}
      result.push(review[index]);
    }
    while(pending.length)result.push(pending.shift()!);
    return result;
  }
  private next(){
    const session=this.active(),blocked=this.blockedCards();session.current=null;
    if(session.mode!=='reading'){
      const scope=deckScope(session.folderId);
      const urgent=this.repository.query(`SELECT r.node_id FROM review_cards r JOIN nodes n ON n.id=r.node_id
        WHERE n.kind='cloze' AND n.deleted_at IS NULL AND n.study_ready=1 AND r.enabled=1 AND r.stage IN(1,3)
          AND r.due_at<=? AND ${unlocked} ${scope.filter} ORDER BY r.due_at LIMIT 1`).get(this.now(),blocked.json,...scope.args);
      if(urgent){session.current=String(urgent.node_id);session.token=randomUUID();session.shownAt=this.now();return;}
    }
    for(let pass=0;pass<2;pass++){
      if(!session.queue.length){
        session.queue=this.candidates();
        if(!session.queue.length)return;
      }
      while(session.queue.length){
        const id=session.queue.shift()!,node=this.repository.getNode(id),row=node?this.stateRow(node):null;
        const ready=node?this.ready(id):0;
        if(node&&this.matchesMode(node)&&ready&&row?.enabled&&!blocked.ids.has(id)&&Number(row.due_at)<=this.now()){
          session.current=id;session.token=randomUUID();session.shownAt=this.now();return;
        }
      }
    }
  }
  snapshot():StudySnapshot {
    const session=this.active(),blocked=this.blockedCards();
    const scope=deckScope(session.folderId);
    let item:StudyItem|null=null;
    if(session.current&&!blocked.ids.has(session.current)){
      const node=this.repository.getNode(session.current),row=node?this.stateRow(node):null;
      if(node&&row&&(!session.folderId||this.matchesMode(node))){
        const isReview=session.mode==='cards',now=this.now();const preview=isReview?[...this.schedulerForDeck(node.folderId).preview({card:this.card(row),now:new Date(now)})]
          .map(result=>({rating:result.grade as 1|2|3|4,dueAt:result.card.dueAt.getTime()})):[];
        item={id:node.id,token:session.token,kind:isReview?'fsrs':'reading',isTest:node.kind==='cloze',title:node.title,
          state:isReview?(row.stage===0?'new':row.stage===2?'review':'learning'):row.reps===0?'new':'review',
          priority:this.priority(node.id),revision:row.revision,preview,...(!isReview?{pushPreview:{read:this.pushSchedule(node.id,row,'read',now).dueAt,later:this.pushSchedule(node.id,row,'later',now).dueAt}}:{})};
      }
    }
    const next=this.repository.query(`SELECT MIN(r.due_at) due_at FROM ${session.mode==='cards'?'review_cards':'reading_state'} r JOIN nodes n ON n.id=r.node_id
      WHERE n.deleted_at IS NULL AND n.${session.mode==='cards'?'study_ready':'push_ready'}=1 AND r.enabled=1
      AND ${unlocked}
      AND ${session.mode==='cards'?"n.kind='cloze'":"(n.kind!='cloze' OR NOT EXISTS(SELECT 1 FROM review_cards active WHERE active.node_id=n.id AND active.enabled=1))"} ${scope.filter}`).get(blocked.json,...scope.args);
    const byFolder=this.counts();
    const counts=session.folderId?byFolder[session.folderId]??{new:0,learning:0,review:0,readingDue:0}:this.statsCache!.total;
    // 1.133：复习条上的新卡/复习数字按「今天还剩多少额度」显示，与队列实际会出的卡一致；
    // 侧栏的 folderCounts 仍然是积压总数，不受上限影响。
    const remaining=session.mode==='cards'?this.remainingToday(session.folderId):null;
    const shown=remaining?{...counts,new:Math.min(counts.new,remaining.new),review:Math.min(counts.review,remaining.review)}:counts;
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
  // ===== 1.135：搁置关联卡片到次日（Anki 的 bury）=====
  // 关联卡片＝记忆树里和这张卡直接相连的父/子检测卡（card_relations.kind='memory'）。
  // 复习一张卡时，按「新的 / 待复习的 / 跨日学习中的」三个开关把今天到期的关联卡片挪到明天零点：
  // 子卡被搁置时父卡也一起搁置，但不会反过来波及没被搁置的其它子卡。
  private buryRelated(node:Material,now:number):Array<{id:string;revision:number;dueAt:number;buriedAt:number}>{
    const profile=this.profiles.resolve(node.folderId);
    if(!profile.buryNew&&!profile.buryReview&&!profile.buryLearning)return [];
    const tomorrow=StudyService.dayStartMs(now,this.settings.dayStartHour)+24*3600000;const limit=tomorrow;
    // 1.156：单向——子卡片被搁置会影响父卡片，父卡片被搁置不影响子卡片；
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
  private applyFsrsGrade(node:Material,before:Row,rating:1|2|3|4,now:number,eventId:string,details:Record<string,unknown>){
    const profile=this.profiles.resolve(node.folderId);
    const card=this.card(before),lapsesBefore=card.lapses;
    const result=this.schedulerForDeck(node.folderId).review({card,grade:rating,now:new Date(now)});
    const version='ts-fsrs/6.0.0:'+(profile.fsrsVersion||'FSRS-7'),state=JSON.stringify(result.card);
    this.repository.query('UPDATE review_cards SET state=?,due_at=?,stage=?,revision=revision+1,algorithm_version=?,updated_at=? WHERE node_id=?')
      .run(state,result.card.dueAt.getTime(),result.card.state,version,now,node.id);
    const lapses=result.card.lapses,threshold=profile.leechThreshold;
    let leechEffect;
    if(rating===Rating.Again&&lapses>lapsesBefore&&threshold>0&&lapses>=threshold&&(lapses-threshold)%Math.ceil(threshold/2)===0){
      const previous=readSchedule(this.repository,node.id)!;
      this.repository.query("INSERT OR IGNORE INTO node_tags(node_id,tag) VALUES(?,'leech')").run(node.id);
      if(profile.leechAction==='suspend'){
        this.repository.query('UPDATE review_cards SET enabled=0 WHERE node_id=?').run(node.id);
        this.repository.query('UPDATE reading_state SET enabled=1,due_at=MIN(due_at,?),revision=revision+1 WHERE node_id=?').run(now,node.id);
      }
      const after=readSchedule(this.repository,node.id)!;
      leechEffect={previous:{tag:previous.leech,reviewEnabled:previous.review!.enabled,pushEnabled:previous.reading.enabled,pushDueAt:previous.reading.due_at},
        after:{tag:after.leech,reviewEnabled:after.review!.enabled,pushEnabled:after.reading.enabled,pushDueAt:after.reading.due_at}};
    }
    this.repository.query('INSERT INTO review_log(event_id,node_id,reviewed_at,rating,algorithm_version,before_state,after_state,details) VALUES(?,?,?,?,?,?,?,?)')
      .run(eventId,node.id,now,rating,version,before.state,state,JSON.stringify({revlog:result.revlog,settings:profile,deckId:node.folderId,...details,leechEffect}));
  }
  grade(input:Submission&{rating?:1|2|3|4;action?:'read'|'later'|'soon'|'dismiss';position?:number;againChildren?:AgainChildSelection[]}):StudySnapshot {
    const session=this.active();if(session.id!==input.sessionId)throw Error(t('复习会话已改变。'));
    if(session.submitted.has(input.token))return this.snapshot();
    const {node,before}=this.currentSubmission(session,input);
    const now=this.now(),kind=session.mode==='cards'?'fsrs':'reading',eventId=input.token;
    if(input.againChildren!==undefined&&(kind!=='fsrs'||input.rating!==Rating.Again||!Array.isArray(input.againChildren)))
      throw Error(t('请在父卡的重来操作中选择子卡。'));
    this.repository.transaction(()=>{
      const children=this.checkedAgainChildren(node.id,input.againChildren??[]);
      // 阅读点随评分一起写入，避免额外递增 reading_state.revision。
      if(Number.isFinite(Number(input.position)))
        this.repository.query('UPDATE reading_state SET reading_position=? WHERE node_id=?')
          .run(Math.min(1e8,Math.max(0,Math.floor(Number(input.position)))),node.id);
      const beforeOperation=this.operationState(node.id,before);
      if(kind==='fsrs'){
        if(![1,2,3,4].includes(Number(input.rating)))throw Error(t('评分无效。'));
        this.applyFsrsGrade(node,before,input.rating!,now,eventId,{durationMs:Math.max(0,Math.min(600000,now-session.shownAt))});
        for(const child of children){
          const childEvent=randomUUID(),previous=this.operationState(child.node.id,child.before);
          this.applyFsrsGrade(child.node,child.before,Rating.Again,now,childEvent,{source:'selected_child_again',parentEventId:eventId});
          this.logOperation(child.node.id,childEvent,againChildBatch+eventId,'fsrs',now,previous,this.stateRow(child.node)!);
        }
        // 1.180：复习了就不再是搁置状态，清掉 buried 标记（1.194：标签变化单独记一条，随同步过去）
        const tagsBefore=readSchedule(this.repository,node.id)!;
        this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='buried'").run(node.id);
        recordTagChange(this.repository,node.id,now,tagsBefore,readSchedule(this.repository,node.id)!);
        // 1.135：按设置把记忆树里的父/子检测卡搁置到次日，撤销时一起回滚
        const buried=this.buryRelated(node,now);
        if(buried.length)(beforeOperation as any)._buried=buried;
      }else{
        // 1.7 ①：Foliole 四动作。soon（本轮再出）不写任何状态：间隔/次数/due 都不动，
        // 只在本轮队列末尾再排一次（foliole 的 soon cohort 语义）；不记日志、不进撤销栈。
        if(!['read','later','soon','dismiss'].includes(input.action||''))throw Error(t('阅读操作无效。'));
        const action=input.action as 'read'|'later'|'soon'|'dismiss';
        if(action!=='soon'){
          const schedule=action==='dismiss'
            ?{dueAt:before.due_at,interval:before.interval_ms,reps:before.reps}
            :this.pushSchedule(node.id,before,action,now);
          this.repository.query('UPDATE reading_state SET due_at=?,interval_ms=?,reps=?,last_read_at=?,enabled=?,revision=revision+1 WHERE node_id=?')
            .run(schedule.dueAt,schedule.interval,schedule.reps,now,action==='dismiss'?0:1,node.id);
          const after=this.stateRow(node)!;
          this.repository.query('INSERT INTO reading_log(event_id,node_id,reviewed_at,action,before_state,after_state) VALUES(?,?,?,?,?,?)')
            .run(eventId,node.id,now,input.action!,JSON.stringify(before),JSON.stringify(after));
          const tagsBefore=readSchedule(this.repository,node.id)!;
          this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='buried'").run(node.id);
          recordTagChange(this.repository,node.id,now,tagsBefore,readSchedule(this.repository,node.id)!);
        }
      }
      if(input.action!=='soon')this.logOperation(node.id,eventId,session.id,kind,now,beforeOperation,this.stateRow(node)!);
    });
    session.submitted.add(eventId);
    if(input.action==='soon')session.queue.push(node.id);
    else{session.history.push(eventId);session.completed++;}
    this.invalidate();this.next();return this.snapshot();
  }
  private restoreOperation(event:Row,now:number):void{
    const node=this.repository.getNode(String(event.node_id));
    if(!node)throw Error(t('这张卡片已删除。'));
    const fsrs=event.kind==='fsrs';
    const table=fsrs?'review_cards':'reading_state';
    const before=JSON.parse(event.before_state),after=JSON.parse(event.after_state);
    const current=this.repository.query(`SELECT * FROM ${table} WHERE node_id=?`).get(node.id);
    if(!current||node.kind==='folder'||(fsrs&&node.kind!=='cloze')||
      (!fsrs&&node.kind==='cloze'&&this.repository.query('SELECT enabled FROM review_cards WHERE node_id=?').get(node.id)?.enabled))
      throw Error(t('卡片类型或推送方式已改变，无法撤销此次复习。'));
    if(event.kind==='fsrs'&&after._push){
      const push=this.repository.query('SELECT * FROM reading_state WHERE node_id=?').get(node.id);
      // 另一次撤销可能恢复了相同的推送内容，但版本号仍须递增。
      if(!push||Object.keys(after._push).some(key=>key!=='revision'&&push[key]!==after._push[key]))
        throw Error(t('推送状态之后已改变，无法撤销此次复习。'));
    }
    const keys=event.kind==='fsrs'?['state','due_at','enabled','stage']:['due_at','interval_ms','reps','last_read_at','enabled'];
    if(keys.some(key=>current[key]!==after[key]))throw Error(t('这张卡片之后又修改了排程，无法撤销。'));
    const previousSchedule=readSchedule(this.repository,node.id)!;
    if(event.kind==='fsrs'&&before._leech!==undefined){
      if(!before._leech)this.repository.query("DELETE FROM node_tags WHERE node_id=? AND tag='leech'").run(node.id);
      if(before._push)this.repository.query('UPDATE reading_state SET enabled=?,due_at=?,revision=revision+1 WHERE node_id=? AND (enabled!=? OR due_at!=?)')
        .run(before._push.enabled,before._push.due_at,node.id,before._push.enabled,before._push.due_at);
    }
    if(fsrs)this.repository.query('UPDATE review_cards SET state=?,due_at=?,stage=?,enabled=?,algorithm_version=?,revision=revision+1,updated_at=? WHERE node_id=?')
      .run(before.state,before.due_at,before.stage,before.enabled,before.algorithm_version,now,node.id);
    else this.repository.query('UPDATE reading_state SET due_at=?,interval_ms=?,reps=?,last_read_at=?,enabled=?,revision=revision+1 WHERE node_id=?')
      .run(before.due_at,before.interval_ms,before.reps,before.last_read_at,before.enabled,node.id);
    // 1.135：这次复习一并搁置的关联卡片，撤销时放回原来的到期日（期间被人改过就跳过）
    const buried=(before as any)._buried as Array<{id:string;dueAt:number;buriedAt:number}>|undefined;
    if(fsrs&&buried?.length)for(const entry of buried){
      const row=this.repository.query('SELECT due_at FROM review_cards WHERE node_id=?').get(entry.id);
      if(!row||Number(row.due_at)!==entry.buriedAt)continue;
      const previousSchedule=readSchedule(this.repository,entry.id);
      this.repository.query('UPDATE review_cards SET due_at=?,revision=revision+1,updated_at=? WHERE node_id=?').run(entry.dueAt,now,entry.id);
      const restored=readSchedule(this.repository,entry.id);
      if(previousSchedule&&restored)recordStudyChange(this.repository,entry.id,now,previousSchedule,restored,
        {id:'unbury-'+String(event.event_id)+'-'+entry.id,kind:'fsrs',at:now});
    }
    this.repository.query('UPDATE study_operations SET undone_at=? WHERE event_id=?').run(now,event.event_id);
    this.repository.query(`UPDATE ${fsrs?'review_log':'reading_log'} SET undone_at=? WHERE event_id=?`).run(now,event.event_id);
    recordStudyChange(this.repository,node.id,now,previousSchedule,readSchedule(this.repository,node.id)!,
      {id:String(event.event_id),kind:fsrs?'fsrs':'reading',at:now});
  }
  undo():StudySnapshot;
  undo(eventId:string):StudySnapshot|null;
  undo(requestedId?:string):StudySnapshot|null {
    const session=this.session,requested=requestedId??this.active().history.at(-1);
    if(!requested)throw Error(t('没有可撤销的复习。'));
    const find=this.repository.query("SELECT * FROM study_operations WHERE event_id=? AND undone_at IS NULL AND kind IN ('fsrs','reading')");
    let event=find.get(requested) as Row|undefined;
    if(event&&String(event.session_id).startsWith(againChildBatch))event=find.get(String(event.session_id).slice(againChildBatch.length)) as Row|undefined;
    if(!event)throw Error(t('没有可撤销的复习。'));
    const operation=event,eventId=String(event.event_id),nodeId=String(event.node_id),now=this.now();
    this.repository.transaction(()=>{
      const children=this.repository.query('SELECT * FROM study_operations WHERE session_id=?').all(againChildBatch+eventId) as Row[];
      if(children.some(child=>child.undone_at!==null))throw Error(t('这批重来已被部分撤销。'));
      this.restoreOperation(operation,now);
      for(const child of children)this.restoreOperation(child,now);
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
