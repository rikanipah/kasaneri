import { t } from '../core/i18n';
export type DailyLimit=number|null;
export const DAILY_LIMIT_KEYS=['newPerDay','reviewPerDay','readingPerDay'] as const;
export type DailyLimitKey=typeof DAILY_LIMIT_KEYS[number];
export interface StudySettings {
  desiredRetention:number;
  maximumInterval:number;
  enableShortTerm:boolean;
  showHardRating:boolean;
  showEasyRating:boolean;
  fsrsVersion:'FSRS-6'|'FSRS-7';
  fsrsWeights:number[];
  learningSteps:string[];
  relearningSteps:string[];
  leechThreshold:number;
  leechAction:'suspend'|'tag';
  readingInitialDays:number;
  readingLaterDays:number;
  // null 表示不限。短期学习与重学不占新卡和复习的每日额度。
  newPerDay:DailyLimit;
  reviewPerDay:DailyLimit;
  readingPerDay:DailyLimit;
  // 新卡与复习的先后顺序（对应 Anki 的 New/review order）
  newReviewOrder:'mixed'|'newFirst'|'reviewFirst';
  // 新卡插入位置与复习排列顺序（对应 Anki 牌组选项的「展示顺序」）
  newOrder:'position'|'random';
  reviewOrder:'forgetting'|'due'|'dueThenDeck'|'deckThenDue'|'intervals'|'intervalsDesc'|'ease'|'easeDesc'|'retrievability'|'retrievabilityDesc'|'relative'|'random'|'added'|'addedDesc';
  // 搁置关联卡片到次日（Anki 的 bury）。关联卡片＝记忆树里的父/子检测卡。
  buryNew:boolean;
  buryReview:boolean;
  buryLearning:boolean;
  // Anki 的「更改时将卡片重新排程」。默认开；改 FSRS 参数会重算复习卡的到期日。
  rescheduleOnChange:boolean;
  // 先修卡连续几次「良好/简单」才解锁依赖卡（默认 1，即最近一次达到良好）。
  masteryReps:number;
  // 新的一天从几点开始（本地时间，默认 4 点）。每日上限、搁置到次日的「次日」都按它算。
  dayStartHour:number;
  trashRetentionDays:number;   // 垃圾桶保留天数（阶段式清理：后半段按天抽样，超期永久删除）
  defaultPriority:number;
  priorityRatio:number;
  /** 学习提前限制（分钟）：学习中卡片提前多久可学；0 = 关闭 */
  learnAheadMinutes:number;
  /** 新卡不受复习上限影响（Anki 的 new_cards_ignore_review_limit，默认关） */
  newCardsIgnoreReviewLimit:boolean;
  /** 新卡收集顺序：position=按位置（默认）、deck=按目录、deckThenRandom=按目录再当天随机、lowest/highest=位置最前/最后、random=当天稳定随机。 */
  newCardGatherOrder:'position'|'deck'|'deckThenRandom'|'lowest'|'highest'|'random';
  /** 学习步随机抖动（0~+25%，上限 5 分钟）；测试里关掉 */
  learningStepFuzz:boolean;
  /** 是否按目录分散出卡（关闭后严格按排序结果） */
  directoryDispersion:boolean;
  /** 2026-11-19：Anki 的 load balancer（默认开）。在 fuzz 窗口内按到期量加权挑一天。 */
  loadBalance:boolean;
  /** 复习间隔 fuzz（Anki 恒开）。测试里关掉，才能断言精确到期日。 */
  reviewFuzz:boolean;
  /** 跨日学习与复习的混合方式：混合/复习后/复习前 */
  interdayLearningMix:'mixed'|'after'|'before';
  /** 仅今日追加的新卡额度（跨天自动失效） */
  todayExtraNew:number;
  /** 仅今日追加的复习额度（跨天自动失效） */
  todayExtraReview:number;
  /** 上面两个额度所属的日期（dayStart 时间戳，0 表示未设置） */
  todayExtraDay:number;
  fsrsPerCycle:number;
  readingPerCycle:number;
  studyMode:'mixed'|'reading'|'cards';
  fontSize:number;
  theme:'dark'|'light'|'system';
  audioAutoplay:boolean;   // 音频是否自动播放（全局开关，默认关）
  confirmDelete:boolean;   // 删除卡片/文件夹时是否弹确认框（默认关＝直接删，仍可撤销）
  customCss:string;        // 外观自定义 CSS（留空表示不用）
  // 没有文件夹时自动创建的默认文件夹名称（可用设置改；旧库的「未归类」会改成它）
  defaultFolderName:string;
}
export const DEFAULT_SETTINGS:StudySettings={desiredRetention:.9,maximumInterval:36500,enableShortTerm:true,showHardRating:false,showEasyRating:false,fsrsVersion:'FSRS-6',fsrsWeights:[],learningSteps:['1m','10m'],relearningSteps:['10m'],leechThreshold:4,leechAction:'suspend',
  readingInitialDays:1,readingLaterDays:0,newPerDay:null,reviewPerDay:null,readingPerDay:null,newReviewOrder:'mixed',newOrder:'position',reviewOrder:'forgetting',buryNew:false,buryReview:false,buryLearning:false,rescheduleOnChange:true,masteryReps:4,dayStartHour:4,trashRetentionDays:30,defaultPriority:5,priorityRatio:5,learnAheadMinutes:20,newCardsIgnoreReviewLimit:false,newCardGatherOrder:'position',learningStepFuzz:true,directoryDispersion:true,loadBalance:true,reviewFuzz:true,interdayLearningMix:'mixed',todayExtraNew:0,todayExtraReview:0,todayExtraDay:0,fsrsPerCycle:5,readingPerCycle:1,studyMode:'cards',fontSize:16,theme:'dark',audioAutoplay:false,confirmDelete:false,customCss:'',defaultFolderName:'默认'};
export const REVIEW_KEYS=['desiredRetention','maximumInterval','enableShortTerm','fsrsVersion','fsrsWeights','learningSteps','relearningSteps','leechThreshold','leechAction','buryNew','buryReview','buryLearning','masteryReps',...DAILY_LIMIT_KEYS] as const;
export type ReviewSettings=Pick<StudySettings,typeof REVIEW_KEYS[number]>;
export function reviewSettings(value:StudySettings):ReviewSettings{return Object.fromEntries(REVIEW_KEYS.map(key=>[key,value[key]])) as unknown as ReviewSettings;}
export function normalizeReviewOverrides(input:unknown):Partial<ReviewSettings>|null {
  if(input===null)return null;
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error(t('牌组复习设置无效。'));
  const source=input as Record<string,unknown>,chosen=Object.fromEntries(REVIEW_KEYS.filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
  const valid=reviewSettings(normalizeSettings({...DEFAULT_SETTINGS,...chosen}));
  const result:Partial<ReviewSettings>=Object.fromEntries(Object.keys(chosen).map(key=>[key,(valid as any)[key]]));
  if(source.fsrsVersion!==undefined){if(!['FSRS-6','FSRS-7'].includes(String(source.fsrsVersion)))throw Error(t('FSRS 模型版本无效。'));result.fsrsVersion=source.fsrsVersion as ReviewSettings['fsrsVersion'];}
  if(source.fsrsWeights!==undefined){if(!Array.isArray(source.fsrsWeights)||source.fsrsWeights.length>64||source.fsrsWeights.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw Error(t('FSRS 参数无效。'));result.fsrsWeights=source.fsrsWeights;}
  for(const key of ['learningSteps','relearningSteps'] as const)if(source[key]!==undefined){
    const value=source[key];if(!Array.isArray(value)||value.length>20||value.some(step=>typeof step!=='string'||!/^\d+(?:\.\d+)?[smhd]$/.test(step)))throw Error(t('学习步骤无效。'));result[key]=value;
  }
  return result;
}
export type CommandId='extract'|'cloze'|'blank'|'toggleReview'|'showAnswer'|'again'|'hard'|'good'|'easy'|
  'readDone'|'readLater'|'readSoon'|'readDismiss'|'enrollCard'|'stopCard'|'pauseReview'|'buryCard'|'navBack'|'navForward'|'editCard'|'stopCard'|'undoReview'|'search'|'save'|'rename'|'settings'|'shortcuts'|'toggleDirectory'|'browse'|'toggleReading'|
  'newTopic'|'newExtract'|'newCloze'|'newFolder'|'cardInfo'|'statistics'|'deleteCurrentCard'|'restoreDeleted'|
  'moveTo'|'undoMove'|'priorityUp'|'priorityDown'|'toggleHighlightExtract'|'toggleHighlightCloze'|
  'nextCard'|'previousCard'|'revealInTree'|'collapseAll'|'openInWindow'|'recordForgotten'|'addCard'|'bold'|'italic';
export const COMMANDS:Array<{id:CommandId;name:string;key:string;scope:'global'|'editor'|'card'|'reading'}>=[
  {id:'extract',name:'摘录',key:'Alt+A',scope:'editor'},
  {id:'cloze',name:'检测卡',key:'Alt+S',scope:'editor'},
  {id:'blank',name:'新建主题',key:'Alt+D',scope:'global'},
  {id:'toggleReview',name:'进入／退出复习',key:'Alt+R',scope:'global'},
  {id:'toggleReading',name:'进入／退出待办队列',key:'Alt+L',scope:'global'},
  {id:'toggleDirectory',name:'收起／展开目录树',key:'Ctrl+Shift+L',scope:'global'},
  {id:'browse',name:'浏览卡片',key:'Ctrl+Shift+B',scope:'global'},
  {id:'showAnswer',name:'显示答案',key:'Space',scope:'card'},
  // 界面导航——按打开过的顺序前后跳（不是猜测下一张）
  {id:'navBack',name:'返回上一个界面',key:'Ctrl+Alt+ArrowLeft',scope:'global'},
  {id:'navForward',name:'前进到下一个界面',key:'Ctrl+Alt+ArrowRight',scope:'global'},
  // 搁置卡片（等同 Anki 的 Suspend Card），复习中按 = 触发

  // 编辑用 Alt+E（原为单键 E）；Ctrl+B 加粗、Ctrl+I 斜体
  {id:'editCard',name:'编辑当前卡片',key:'Alt+E',scope:'card'},
  {id:'stopCard',name:'留存判定（暂存点，复习和待办都不出现）',key:'Shift+-',scope:'card'},
  {id:'buryCard',name:'搁置（记忆搁置 / 待办搁置，到下一个日切点）',key:'=',scope:'global'},
  {id:'pauseReview',name:'待办暂停（暂停复习，仍在待办）',key:'Shift+1',scope:'card'},
  {id:'bold',name:'加粗',key:'Ctrl+B',scope:'editor'},
  {id:'italic',name:'斜体',key:'Ctrl+I',scope:'editor'},
  {id:'again',name:'重来',key:'1',scope:'card'}, {id:'hard',name:'困难',key:'2',scope:'card'},
  {id:'good',name:'良好',key:'3',scope:'card'}, {id:'easy',name:'简单',key:'4',scope:'card'},
  // 待办动作（Foliole 语义）。读完=全增长；稍后=√增长；置于末尾=本轮末尾再排、不改状态；
  // 2026-11-19：按键统一成 1–5，与复习的 1–4 对应——1 读完、2 稍后、3 置于末尾、4 完成、5 加入复习。
  {id:'readDone',name:'材料：读完',key:'1',scope:'reading'},
  {id:'readLater',name:'材料：稍后',key:'2',scope:'reading'},
  {id:'readSoon',name:'材料：置于末尾',key:'3',scope:'reading'},
  {id:'readDismiss',name:'材料：完成',key:'4',scope:'reading'},
  {id:'enrollCard',name:'材料：加入复习',key:'5',scope:'reading'},
  {id:'undoReview',name:'撤销上次复习',key:'Ctrl+Z',scope:'global'},
  {id:'search',name:'快速查找',key:'Ctrl+P',scope:'global'}, {id:'save',name:'保存',key:'Ctrl+S',scope:'global'},
  {id:'rename',name:'修改显示名',key:'F2',scope:'global'},
  {id:'deleteCurrentCard',name:'删除当前卡片（进垃圾桶）',key:'Ctrl+Delete',scope:'global'},
  {id:'settings',name:'打开设置',key:'Ctrl+,',scope:'global'},
  {id:'shortcuts',name:'修改快捷键',key:'Ctrl+Shift+,',scope:'global'},
  // ===== 候选快捷键（先登记、不绑定；在「快捷键」页按需分配）=====
  {id:'newTopic',name:'新建主题',key:'',scope:'global'},
  {id:'newExtract',name:'新建提取',key:'',scope:'global'},
  {id:'newCloze',name:'新建检测卡',key:'',scope:'global'},
  {id:'newFolder',name:'新建文件夹',key:'',scope:'global'},
  {id:'cardInfo',name:'卡片信息',key:'',scope:'global'},
  {id:'statistics',name:'统计',key:'',scope:'global'},
  {id:'restoreDeleted',name:'恢复最近删除的卡片',key:'',scope:'global'},
  {id:'moveTo',name:'移至…（选择父级目录）',key:'',scope:'global'},
  {id:'undoMove',name:'撤销最近一次移动',key:'',scope:'global'},
  {id:'priorityUp',name:'优先度 +1（更容易抽到）',key:'',scope:'global'},
  {id:'priorityDown',name:'优先度 -1',key:'',scope:'global'},
  {id:'toggleHighlightExtract',name:'显示/隐藏摘录高亮',key:'',scope:'global'},
  {id:'toggleHighlightCloze',name:'显示/隐藏检测卡高亮',key:'',scope:'global'},
  {id:'nextCard',name:'浏览：下一张卡片',key:'',scope:'global'},
  {id:'previousCard',name:'浏览：上一张卡片',key:'',scope:'global'},
  {id:'revealInTree',name:'在目录树中定位当前卡片',key:'Ctrl+Shift+F',scope:'global'}, // 1.83 接线 / 1.95 给默认键
  {id:'collapseAll',name:'折叠全部目录',key:'',scope:'global'},
  {id:'openInWindow',name:'在新窗口打开当前卡片',key:'',scope:'global'},
  {id:'addCard',name:'添加卡片（独立窗口）',key:'Ctrl+Shift+N',scope:'global'},
  {id:'recordForgotten',name:'记录遗忘（未到期，依赖调度预留）',key:'',scope:'global'},
];
export type Shortcuts=Record<CommandId,string>;
export const DEFAULT_SHORTCUTS=Object.fromEntries(COMMANDS.map(command=>[command.id,command.key])) as Shortcuts;
// 旧版把「编辑」绑在单键 E 上。已保存的配置里若仍是旧默认值就升级到新默认值，
// 用户自己改过的其他键不动。
const LEGACY_SHORTCUTS:Partial<Record<CommandId,string>>={editCard:'E',stopCard:'Shift+1',pauseReview:'',
  // 2026-11-19：待办动作从 Space/1/2/0 改成 1–5，老配置按旧默认值迁移
  readDone:'Space',readSoon:'1',readLater:'2',readDismiss:'0'};
function migrateShortcuts(result:Shortcuts):void{
  for(const [id,legacy] of Object.entries(LEGACY_SHORTCUTS) as Array<[CommandId,string]>){
    if(result[id]===legacy&&DEFAULT_SHORTCUTS[id]!==legacy)result[id]=DEFAULT_SHORTCUTS[id];
  }
}
export function normalizeSettings(input:unknown):StudySettings {
  const defaults={...DEFAULT_SETTINGS,defaultFolderName:t(DEFAULT_SETTINGS.defaultFolderName)};
  if(!input||typeof input!=='object'||Array.isArray(input))return defaults;
  const value={...defaults,...input} as StudySettings;
  const number=(key:keyof StudySettings,min:number,max:number,integer=false)=>{
    const raw=Number(value[key]);if(!Number.isFinite(raw)||raw<min||raw>max)throw Error(t('设置数值超出范围：{0}',key));
    (value as any)[key]=integer?Math.round(raw):raw;
  };
  number('desiredRetention',.7,.99);number('maximumInterval',1,36500,true);
  number('readingInitialDays',1/1440,3650);number('readingLaterDays',0,36500,true);number('defaultPriority',1,9,true);number('priorityRatio',1,100);number('learnAheadMinutes',0,1440,true);
  number('trashRetentionDays',7,3650,true);
  number('fsrsPerCycle',1,20,true);number('readingPerCycle',1,20,true);number('fontSize',10,48,true);
  for(const key of DAILY_LIMIT_KEYS)if(value[key]!==null)number(key,0,10000,true);
  number('leechThreshold',0,1000000,true);if(!['suspend','tag'].includes(value.leechAction))throw Error(t('难记卡片处理方式无效。'));
  if(typeof value.enableShortTerm!=='boolean')throw Error(t('学习步骤设置无效。'));
  if(typeof value.confirmDelete!=='boolean')throw Error(t('删除确认设置无效。'));
  for(const key of ['buryNew','buryReview','buryLearning'] as const)if(typeof value[key]!=='boolean')throw Error(t('搁置设置无效。'));
  if(typeof value.rescheduleOnChange!=='boolean')throw Error(t('重新排程设置无效。'));
  number('masteryReps',1,9,true);
  number('dayStartHour',0,23,true);
  if(typeof value.showHardRating!=='boolean'||typeof value.showEasyRating!=='boolean')throw Error(t('回答按钮设置无效。'));
  if(typeof value.audioAutoplay!=='boolean')throw Error(t('音频自动播放设置无效。'));
 if(typeof value.newCardsIgnoreReviewLimit!=='boolean')throw Error(t('新卡不受复习上限影响设置无效。'));
 if(!['position','deck','deckThenRandom','lowest','highest','random'].includes(value.newCardGatherOrder))throw Error(t('新卡收集顺序设置无效。'));
 if(typeof value.learningStepFuzz!=='boolean')throw Error(t('学习步抖动设置无效。'));
 if(typeof value.directoryDispersion!=='boolean')throw Error(t('目录分散设置无效。'));
  if(typeof value.loadBalance!=='boolean')throw Error(t('负载均衡设置无效。'));
  if(typeof value.reviewFuzz!=='boolean')throw Error(t('复习间隔抖动设置无效。'));
 if(!['mixed','after','before'].includes(value.interdayLearningMix))throw Error(t('跨日学习混合方式无效。'));
 number('todayExtraNew',0,9999,true);number('todayExtraReview',0,9999,true);
  if(!['FSRS-6','FSRS-7'].includes(value.fsrsVersion))throw Error(t('FSRS 模型无效。'));
  if(!Array.isArray(value.fsrsWeights)||value.fsrsWeights.length>64||value.fsrsWeights.some(n=>typeof n!=='number'||!Number.isFinite(n)))throw Error(t('FSRS 参数无效。'));
  for(const key of ['learningSteps','relearningSteps'] as const)if(!Array.isArray(value[key])||value[key].length>20||value[key].some(step=>typeof step!=='string'||!/^\d+(?:\.\d+)?[smhd]$/.test(step)))throw Error(t('学习步骤无效。'));
  if(!['mixed','reading','cards'].includes(value.studyMode))throw Error(t('复习模式无效。'));
  if(!['mixed','newFirst','reviewFirst'].includes(value.newReviewOrder))throw Error(t('新卡与复习顺序无效。'));
  if(!['position','random'].includes(value.newOrder))throw Error(t('新卡插入位置无效。'));
  if(!['forgetting','due','dueThenDeck','deckThenDue','intervals','intervalsDesc','ease','easeDesc','retrievability','retrievabilityDesc','relative','random','added','addedDesc'].includes(value.reviewOrder))throw Error(t('复习排列顺序无效。'));
  if(value.theme!=='dark')value.theme='dark'; // 2026-11-20：浅色主题已归档到 archive/theme-light/，只留深色
  if(typeof value.customCss!=='string')throw Error(t('自定义样式无效。'));
  value.customCss=value.customCss.slice(0,20000);
  if(typeof value.defaultFolderName!=='string'||!value.defaultFolderName.trim()||value.defaultFolderName.trim().length>80)throw Error(t('默认文件夹名称需为 1–80 个字符。'));
  value.defaultFolderName=value.defaultFolderName.trim();
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key=>[key,(value as any)[key]])) as unknown as StudySettings;
}
export function canonicalShortcut(key:string):string {
  if(!key.trim())return '';
  const parts=key.split('+').map(p=>p.trim()),last=parts.pop()||'';
  const modifiers=new Set(parts.map(p=>p.toLowerCase()));
  if(parts.some(p=>!['ctrl','alt','shift','meta'].includes(p.toLowerCase())))throw Error(t('快捷键格式无效。'));
  const normalized=last===' '?'Space':last.length===1?last.toUpperCase():last;
  if(!/^(Space|Enter|Escape|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2])|[A-Z0-9])$/.test(normalized)
    && ![',','.',';','/','-','=','[',']','`',"'",'\\'].includes(normalized))throw Error(t('不支持这个快捷键。'));
  return [...['Ctrl','Alt','Shift','Meta'].filter(p=>modifiers.has(p.toLowerCase())),normalized].join('+');
}
export function normalizeShortcuts(input:unknown):Shortcuts {
  const source=input&&typeof input==='object'?input as Record<string,unknown>:{};
  const result={...DEFAULT_SHORTCUTS};
  // Previously deleteCard was an unbound placeholder. Keep any custom key that was saved.
  const deleteCardInput=source.deleteCurrentCard!==undefined?source.deleteCurrentCard:
    source.deleteCard===''?undefined:source.deleteCard;
  for(const command of COMMANDS){
    const raw=command.id==='deleteCurrentCard'?deleteCardInput:source[command.id];
    if(raw!==undefined){if(typeof raw!=='string')throw Error(t('快捷键无效。'));result[command.id]=canonicalShortcut(raw);}
    const key=result[command.id];
    if(key&&['global','editor'].includes(command.scope)&&!key.includes('+')&&!/^F\d+$/.test(key)&&command.id!=='buryCard')throw Error(t('{0}需要组合键或功能键。',t(command.name)));
    if(key==='Escape'||key==='Tab')throw Error(t('请保留 Escape 和 Tab 用于界面导航。'));
  }
  migrateShortcuts(result);
  if(deleteCardInput===undefined&&COMMANDS.some(command=>
    command.id!=='deleteCurrentCard'&&result[command.id]===result.deleteCurrentCard)){
    result.deleteCurrentCard='';
  }
  for(let i=0;i<COMMANDS.length;i++)for(let j=0;j<i;j++){
    const a=COMMANDS[i],b=COMMANDS[j];
    const disjoint=(a.scope==='card'&&b.scope==='reading')||(a.scope==='reading'&&b.scope==='card');
    if(result[a.id]&&result[a.id]===result[b.id]&&!disjoint)
      throw Error(t('快捷键重复：{0} 与 {1}',t(a.name),t(b.name)));
  }
  return result;
}
export function shortcutFromEvent(event:{key:string;code:string;ctrlKey:boolean;altKey:boolean;shiftKey:boolean;metaKey:boolean}):string {
  if(['Control','Alt','Shift','Meta','AltGraph'].includes(event.key))return '';
  const punctuation:Record<string,string>={Comma:',',Period:'.',Semicolon:';',Slash:'/',Minus:'-',Equal:'=',BracketLeft:'[',BracketRight:']',Backquote:'`',Quote:"'",Backslash:'\\'};
  const key=event.code==='Space'?'Space':/^Key[A-Z]$/.test(event.code)?event.code.slice(3):/^Digit[0-9]$/.test(event.code)?event.code.slice(5):punctuation[event.code]||event.key;
  return [...event.ctrlKey?['Ctrl']:[],...event.altKey?['Alt']:[],...event.shiftKey?['Shift']:[],...event.metaKey?['Meta']:[],key.length===1?key.toUpperCase():key].join('+');
}
