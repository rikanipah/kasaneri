import {contextMenuPreferences} from './context-menu-settings';
import { getLocale, parseLocale, t } from '../core/i18n';
import {COMMANDS,REVIEW_KEYS,shortcutFromEvent,type Shortcuts,type StudySettings,type ReviewSettings} from '../core/settings';
import type {TreeNode,DeckConfiguration,OptimizeResult} from '../core/model';
import {icon,type IconName} from './icons';
const formatBytes=(value:number)=>value>=1024*1024?(Math.round(value/1024/1024*10)/10)+' MB':value>=1024?Math.round(value/1024)+' KB':value+' B';
async function openAttachmentManager():Promise<void>{
 const existing=document.querySelector<HTMLDialogElement>('#attachment-manager');if(existing){existing.remove();return;}
 const dialog=document.createElement('dialog');dialog.id='attachment-manager';document.body.append(dialog);
 const body=document.createElement('div');body.className='attachment-manager';dialog.append(body);
 const close=()=>dialog.close();
 const render=async()=>{
  body.replaceChildren();
  const title=document.createElement('h3');title.textContent=t('附件管理');body.append(title);
  const usage=await window.reading.request<any>('assetUsage',{limit:200});
  const trashed=await window.reading.request<any[]>('assetTrashList');
  const note=document.createElement('p');note.className='preference-hint';
  note.textContent=t('附件 {0} 个 · 占用 {1}；未被正文引用 {2} 个（{3}）；回收站 {4} 个',usage.count,formatBytes(usage.bytes),usage.unused,formatBytes(usage.unusedBytes),trashed.length);
  body.append(note);
  const unusedTitle=document.createElement('h4');unusedTitle.textContent=t('未引用附件');body.append(unusedTitle);
  if(!usage.items.length){const empty=document.createElement('p');empty.className='preference-hint';empty.textContent=t('没有未引用附件。');body.append(empty);}
  else{
   const list=document.createElement('div');list.className='attachment-list';
   for(const item of usage.items){
    const row=document.createElement('div');row.className='attachment-row';
    const name=document.createElement('span');name.textContent=item.filename;name.title=item.filename;
    const size=document.createElement('small');size.textContent=formatBytes(item.size);
    row.append(name,size);list.append(row);
   }
   body.append(list);
   const actions=document.createElement('div');actions.className='dialog-actions';
   const clean=document.createElement('button');clean.type='button';clean.textContent=t('全部移入附件回收站');
   clean.onclick=async()=>{
    if(!confirm(t('把未引用附件移到回收站？可从回收站恢复。')))return;
    clean.disabled=true;const result=await window.reading.request<any>('assetTrashUnused');
    note.textContent=t('已移入回收站 {0} 个（{1}）{2}',result.moved,formatBytes(result.bytes),result.missing?t('，{0} 个文件缺失已跳过',result.missing):'');
    await render();
   };
   actions.append(clean);body.append(actions);
  }
  const trashTitle=document.createElement('h4');trashTitle.textContent=t('附件回收站');body.append(trashTitle);
  if(!trashed.length){const empty=document.createElement('p');empty.className='preference-hint';empty.textContent=t('回收站是空的。');body.append(empty);}
  else{
   const list=document.createElement('div');list.className='attachment-list';
   for(const item of trashed){
    const row=document.createElement('div');row.className='attachment-row';
    const name=document.createElement('span');name.textContent=item.filename;name.title=item.filename;
    const size=document.createElement('small');size.textContent=formatBytes(item.size);
    const restore=document.createElement('button');restore.type='button';restore.textContent=t('恢复');
    restore.onclick=()=>void window.reading.request('assetRestore',{id:item.id}).then(render);
    const purge=document.createElement('button');purge.type='button';purge.textContent=t('彻底删除');
    purge.onclick=()=>{if(confirm(t('彻底删除这个附件？不可恢复。')))void window.reading.request('assetPurge',{id:item.id}).then(render);};
    row.append(name,size,restore,purge);list.append(row);
   }
   body.append(list);
  }
  const footer=document.createElement('div');footer.className='dialog-actions';
  const done=document.createElement('button');done.type='button';done.textContent=t('关闭');done.onclick=close;footer.append(done);body.append(footer);
 };
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 dialog.showModal();
 await render();
}

export interface Configuration {settings:StudySettings;shortcuts:Shortcuts;algorithm:string}
export type PreferenceTab='appearance'|'general'|'review'|'reading'|'files'|'sync'|'backup'|'trash'|'shortcuts'|'contextMenu'|'help';
function preferenceHint(text:string):HTMLParagraphElement{
  const paragraph=document.createElement('p');
  paragraph.className='preference-hint';paragraph.textContent=text;
  return paragraph;
}
function outlineSection(title:string,style:'preference-folder'|'preference-sub',open=false):HTMLDetailsElement{
  const details=document.createElement('details');details.className=style;details.open=open;
  const summary=document.createElement('summary');summary.textContent=title;
  details.append(summary);
  return details;
}
function markdownReference():HTMLElement{
  const guide=outlineSection(t('Markdown 语法速查'),'preference-folder');
  guide.classList.add('markdown-help');
  const samples=[
    {name:t('标题与行内格式'),lines:['# '+t('标题'),'## '+t('标题'),'','**'+t('加粗')+'**','*'+t('斜体')+'*','`print()`']},
    {name:t('引用与列表'),lines:['> '+t('引用'),'','- A','- B','','1. A','2. B']},
    {name:t('代码块'),lines:['```python','print("Hello")','```'],note:t('语言名可省略。光标离开后可用代码块右上角的按钮复制代码。')},
    {name:t('表格'),lines:['| A | B |','| --- | --- |','| 1 | 2 |']},
    {name:t('网页和本地文件链接'),lines:['['+t('链接')+'](https://example.com)','[report.pdf](file:///C:/Docs/report.pdf)'],
      note:t('在正文或答案右键选择「插入外部文件链接…」可选取文件。点击带箭头的链接可打开目标。')},
    {name:t('行内公式'),lines:['$E=mc^2$','\\(E=mc^2\\)']},
    {name:t('独立公式'),lines:['$$','\\frac{1}{2} + \\frac{1}{2} = 1','$$']},
    {name:t('检测卡挖空'),lines:['A + [...] = C'],note:t('在检测内容中填 [...]，把被挖去的内容写到答案区。')},
    {name:t('图片和附件'),note:t('在编辑处拖入文件，或右键选择「插入附件…」。文件复制到资料库，图片拖动右下角可调整大小。')},
  ];
  for(const {name,lines,note} of samples){
    const item=document.createElement('section');item.className='markdown-help-example';
    const heading=document.createElement('h4');heading.textContent=name;item.append(heading);
    if(lines){
      const source=lines.join('\n');
      const block=document.createElement('pre'),code=document.createElement('code');
      code.textContent=source;block.append(code);
      const copy=document.createElement('button');copy.type='button';copy.textContent=t('复制代码');
      let reset:ReturnType<typeof setTimeout>|undefined;
      copy.onclick=async()=>{
        try{await navigator.clipboard.writeText(source);copy.textContent=t('已复制');}
        catch{copy.textContent=t('复制失败');}
        clearTimeout(reset);
        reset=setTimeout(()=>{copy.textContent=t('复制代码');},1500);
      };
      const area=document.createElement('div');area.className='markdown-help-source';area.append(block,copy);item.append(area);
    }
    if(note)item.append(preferenceHint(note));
    guide.append(item);
  }
  return guide;
}
export class PreferencesDialog {
  private dialog=document.createElement('dialog');
  private content=document.createElement('div');
  private draft!:Configuration;
  private tab:PreferenceTab='general';
  private node:TreeNode|null=null;
  private priority:string='';
  private deck:DeckConfiguration|null=null;
  private inherit=true;
  // 一键优化的结果与提示要跨 render() 存活（render 每次交互都会重建 DOM）。
  private optimizeResult:OptimizeResult|null=null;
  private optimizeNote='';
  private pendingWeights:number[]|null=null;
  private optimizeBusy=false;
  // 同步设置（独立于复习设置草稿，改动即时生效并落盘）
  private syncDraft={enabled:false,port:38641,peers:[] as Array<{name:string;address:string}>};
  private syncHasPassphrase=false;
  // 本机设备名（用于对端按名字区分）
  private syncName='';
  private syncState:Awaited<ReturnType<typeof window.reading.syncStatus>>|null=null;
  private viewVersion=0;
  // 窗口位置（left/top，px），拖动后记在本机
  private position={x:0,y:0};
  constructor(private apply:(draft:Configuration,node:TreeNode|null,priority:number|null)=>Promise<Configuration>,
    private applyDeck:(id:string,overrides:Partial<ReviewSettings>|null)=>Promise<DeckConfiguration>,
    private openConflicts:()=>void,
    private applyPriority:(node:TreeNode,priority:number|null)=>Promise<void>){
    this.dialog.id='preferences';this.content.className='preference-content';this.dialog.append(this.content);document.body.append(this.dialog);
    // 默认固定尺寸（CSS 给 720×760），用户拖动改过的尺寸记在本机 localStorage，下次沿用。
    try{
      const saved=JSON.parse(localStorage.getItem('preferencesSize')||'null') as {width:number;height:number}|null;
      if(saved&&saved.width>360&&saved.height>320){this.dialog.style.width=saved.width+'px';this.dialog.style.height=saved.height+'px';}
    }catch{/* 读取失败就用默认尺寸 */}
    window.addEventListener('resize',()=>{if(this.dialog.open)this.moveDialog(this.position);});
    let timer:ReturnType<typeof setTimeout>|undefined;
    new ResizeObserver(()=>{
      if(!this.dialog.open)return;
      const width=Math.round(this.dialog.getBoundingClientRect().width),height=Math.round(this.dialog.getBoundingClientRect().height);
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{try{localStorage.setItem('preferencesSize',JSON.stringify({width,height}));}catch{}},500);
    }).observe(this.dialog);
  }
  private moveDialog(position:{x:number;y:number}){
    const {width,height}=this.dialog.getBoundingClientRect();
    this.position={
      x:Math.max(0,Math.min(Math.round(position.x),innerWidth-width)),
      y:Math.max(0,Math.min(Math.round(position.y),innerHeight-height)),
    };
    this.dialog.style.left=this.position.x+'px';this.dialog.style.top=this.position.y+'px';
  }
  private placeDialog(){
    const rect=this.dialog.getBoundingClientRect();
    let position={x:(innerWidth-rect.width)/2,y:(innerHeight-rect.height)/2};
    try{
      const saved=JSON.parse(localStorage.getItem('preferencesPosition')||'null');
      if(Number.isFinite(saved?.x)&&Number.isFinite(saved?.y))position=saved;
    }catch{/* 沿用居中位置 */}
    this.moveDialog(position);
  }
  open(tab:PreferenceTab,configuration:Configuration,node:TreeNode|null){
    const version=++this.viewVersion;
    if(this.dialog.open){this.dialog.close();}
    this.draft=structuredClone(configuration);this.tab=tab;this.node=node;this.priority=node?.priority?.toString()??'';this.deck=null;
    this.optimizeResult=null;this.optimizeNote='';this.pendingWeights=null;this.optimizeBusy=false;
    const show=()=>{
      if(version!==this.viewVersion)return;
      this.render();this.dialog.showModal();this.placeDialog();
    };
    if(tab==='sync')void this.loadSync(version).then(show);
    else show();
  }
  openDeck(deck:DeckConfiguration,configuration:Configuration,node:TreeNode){
    this.viewVersion++;
    if(this.dialog.open)this.dialog.close();
    this.draft=structuredClone(configuration);this.deck=structuredClone(deck);this.tab='general';
    this.inherit=false;this.node=node;this.priority=node.priority?.toString()??'';
    this.optimizeResult=null;this.optimizeNote='';this.pendingWeights=null;this.optimizeBusy=false;
    this.render();this.dialog.showModal();this.placeDialog();
  }
  private render(){
    // 改动即时生效（Obsidian 行为），不需要保存按钮
    const error=document.createElement('p');error.className='preference-error';error.hidden=true;error.setAttribute('role','alert');
    let commit=async()=>{};
    // ===== 仿 Obsidian 设置窗口——左侧分组导航 + 搜索框，右侧卡片式内容 =====
    const SHELL:Array<[string,string,PreferenceTab[]]>=this.deck?[[t('设置'),'',['general','review','reading']]]:[
      [t('选项'),'',['appearance','general','review','reading','files','sync','backup','trash']],
      [t('其它'),'',['shortcuts','contextMenu','help']],
    ];
    const LABELS:{[key in PreferenceTab]:string}={appearance:t('外观'),general:t('常规'),review:t(this.deck?'复习设置':'默认复习'),reading:t(this.deck?'待办设置':'默认待办'),files:t('文件管理'),sync:t('同步'),backup:t('备份'),trash:t('垃圾桶'),shortcuts:t('快捷键'),contextMenu:t('右键菜单'),help:t('帮助')};
    const title=document.createElement('h3');title.textContent=this.deck?t('设置')+' · '+this.deck.title:t('设置');
    const nav=document.createElement('nav');nav.className='preference-nav';
    const search=document.createElement('input');search.type='search';search.placeholder=t('搜索设置…');search.className='preference-search';
    search.setAttribute('aria-label',t('搜索设置'));
    const navList=document.createElement('div');
    for(const [groupName,,keys] of SHELL){
      const group=document.createElement('div');group.className='preference-nav-group';
      group.append(Object.assign(document.createElement('p'),{className:'preference-nav-heading',textContent:groupName}));
      for(const key of keys){
        const button=document.createElement('button');button.dataset.tab=key;button.className='preference-nav-item';
        button.textContent=LABELS[key];button.classList.toggle('is-active',key===this.tab);
        button.onclick=()=>{
          const version=++this.viewVersion;
          if(key===this.tab&&(key!=='sync'||this.syncState))return;
          const show=()=>{
            if(version!==this.viewVersion||!this.dialog.open)return;
            this.collect();this.tab=key;this.render();
          };
          if(key==='sync')void this.loadSync(version).then(show);
          else show();
        };
        group.append(button);
      }
      navList.append(group);
    }
    // 搜索：按标签过滤左侧项（不隐藏当前页，避免内容闪空）
    search.oninput=()=>{const keyword=search.value.trim();
      for(const item of navList.querySelectorAll<HTMLButtonElement>('.preference-nav-item'))
        item.hidden=!!keyword&&!item.textContent!.includes(keyword);};
    nav.append(search,navList);
    const body=document.createElement('div');body.className='preference-body';
    // 右上角关闭按钮（×），与小窗口一致的关闭手势。
    const close=document.createElement('button');close.className='preference-close';close.type='button';
    close.textContent='×';close.setAttribute('aria-label',t('关闭设置'));close.title=t('关闭（Esc）');
    close.onclick=()=>this.dialog.close();
    const main=document.createElement('div');main.className='preference-main';
    // 把 恢复默认 / 取消 / 保存 三个小按钮放到标题右边（不再用底部三条大色块）
    const header=document.createElement('div');header.className='preference-header';
    header.append(title);
    main.append(header,close,body);
    // 拖动标题栏移动窗口（按钮/× 不触发）
    header.style.cursor='move';
    header.addEventListener('pointerdown',event=>{
      if((event.target as HTMLElement).closest('button'))return;
      event.preventDefault();
      const rect=this.dialog.getBoundingClientRect();
      const start={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
      const move=(moveEvent:PointerEvent)=>{
        this.moveDialog({x:start.left+moveEvent.clientX-start.x,y:start.top+moveEvent.clientY-start.y});
      };
      const stop=()=>{
        window.removeEventListener('pointermove',move);
        window.removeEventListener('pointerup',stop);
        window.removeEventListener('pointercancel',stop);
        try{localStorage.setItem('preferencesPosition',JSON.stringify(this.position));}catch{}
      };
      window.addEventListener('pointermove',move);
      window.addEventListener('pointerup',stop);
      window.addEventListener('pointercancel',stop);
    });
    let currentCard:HTMLElement|null=null;
    if(!this.deck&&this.tab==='shortcuts'){
      body.append(preferenceHint(t('点击输入框后按下组合键。复习评分键只在对应卡片中生效，文字编辑时保留正常输入。')));
      for(const command of COMMANDS){
        const row=document.createElement('label');row.className='shortcut-row';
        const name=document.createElement('span');name.textContent=t(command.name);
        const input=document.createElement('input');input.readOnly=true;input.value=this.draft.shortcuts[command.id];input.placeholder=t('未绑定');
        input.setAttribute('aria-label',t('{0}快捷键',t(command.name)));input.dataset.command=command.id;
        input.onkeydown=event=>{
          if(event.key==='Tab')return;
          event.preventDefault();event.stopPropagation();if(event.key==='Escape'){input.blur();return;}
          if((event.key==='Backspace'||event.key==='Delete')&&!event.ctrlKey&&!event.altKey&&!event.metaKey){input.value='';this.draft.shortcuts[command.id]='';return;}
          const value=shortcutFromEvent(event);if(value){input.value=value;this.draft.shortcuts[command.id]=value;}
        };
        input.onblur=()=>void commit();
        const clear=document.createElement('button');clear.type='button';clear.textContent=t('清除');clear.onclick=event=>{event.preventDefault();input.value='';this.draft.shortcuts[command.id]='';void commit();};
        row.append(name,input,clear);body.append(row);
      }
    }else{
      // 每个 section 开一张新卡片，形成 Obsidian 那种分组卡片列表
    const section=(name:string)=>{
      const card=document.createElement('section');card.className='preference-card';
      const heading=document.createElement('h4');heading.className='preference-group-title';heading.textContent=name;card.append(heading);
      body.append(card);currentCard=card;
      return card;
    };
      const field=(label:string,key:keyof StudySettings,type:'number'|'select'|'checkbox'|'text',options?:Array<[string,string]>,limits?:[number,number,number])=>{
        // 牌组还在继承时，参数一律不显示（默认值就是默认值，改过才需要看见）
        if(this.deck&&this.inherit)return;
        const row=document.createElement('label');row.className='setting-row';const text=document.createElement('span');text.textContent=label;
        const input=type==='select'?document.createElement('select'):document.createElement('input');input.dataset.setting=key;input.setAttribute('aria-label',label);
        const value=this.deck?(this.inherit?this.deck.inherited:this.deck.effective)[key as keyof ReviewSettings]:this.draft.settings[key];
        if(input instanceof HTMLSelectElement){for(const [value,name] of options||[]){const item=document.createElement('option');item.value=value;item.textContent=name;input.append(item);}input.value=String(value);}
        else{input.type=type==='text'?'text':type;input.value=String(value??'');if(type==='checkbox')input.checked=!!value;
          if(limits){input.min=String(limits[0]);input.max=String(limits[1]);input.step=String(limits[2]);}}
        input.disabled=!!this.deck&&this.inherit;
        // 学习步骤输入框的可用状态跟着「启用短期学习步骤」走，所以这个开关改完要重绘一次
        input.addEventListener('change',()=>{void commit();if(key==='enableShortTerm')this.render();});
        row.append(text,input);(currentCard||body).append(row);
      };
      const hint=(text:string)=>(currentCard||body).append(preferenceHint(text));
      if(this.deck&&this.tab==='review'){
        // 不显示「继承上级设置/继承来源」这一层关系——默认值就是默认的，
        // 牌组自己改过的参数按改过的算（保存时也只写改过的键）。
        hint(t('牌组：{0}。没改过的参数用默认值；改过的按这个牌组的设置算。',this.deck.path));
      }
      // 牌组还在继承时不显示任何参数（默认值就是默认值，改过才需要看见）
      if(this.deck&&this.tab==='general'){
        section(t('常规'));
        hint(t('文件夹路径 · {0}',this.deck.path));
      }else if(this.deck&&this.tab==='reading'){
        const group=section(t('待办设置'));
        const row=document.createElement('label');row.className='setting-row';
        const label=document.createElement('span');label.textContent=t('待办优先级');
        const select=document.createElement('select');select.id='node-priority';
        select.add(new Option(t('继承父级／默认'),''));
        select.add(new Option(t('0 · 优先处理'),'0'));
        for(let priority=1;priority<=9;priority++)select.add(new Option(String(priority),String(priority)));
        select.value=this.priority;select.onchange=()=>void commit();
        row.append(label,select);group.append(row);
        hint(t('文件夹的待办优先级供下级项目继承。'));
      }else if((this.deck&&!this.inherit)||(!this.deck&&this.tab==='review')){
        if(!this.deck){
          section(t('回答按钮'));
          field(t('显示「困难」'),'showHardRating','checkbox');
          field(t('显示「简单」'),'showEasyRating','checkbox');
        }
        // 按 Anki 的牌组选项分组：新卡片 / 每日上限 / 遗忘 / 展示顺序 / FSRS
        const profile=this.deck?(this.inherit?this.deck.inherited:this.deck.effective):this.draft.settings;
        const stepField=(label:string,key:'learningSteps'|'relearningSteps')=>{
          if(this.deck&&this.inherit)return;
          const row=document.createElement('label');row.className='setting-row short-term-step';
          const text=document.createElement('span');text.textContent=label;
          const input=document.createElement('input');input.dataset.memory=key;input.setAttribute('aria-label',label);
          // 学习/重学步骤只在启用短期学习步骤时生效，关闭时置灰而不是隐藏（位置固定，便于对照 Anki）
          input.disabled=(!!this.deck&&this.inherit)||!profile.enableShortTerm;
          input.value=(profile[key]||[]).map(step=>{const match=step.match(/^([\d.]+)([smhd])$/)!;return Number(match[1])*({s:1/60,m:1,h:60,d:1440}[match[2] as 's'|'m'|'h'|'d']);}).join(' ');
          input.placeholder=t('例如：1 10（分钟，空格分隔）');
          row.append(text,input);(currentCard||body).append(row);
        };
        section(t('新卡片'));
        stepField(t('初学间隔（分钟）'),'learningSteps');
        if(!this.deck){
          field(t('新卡片插入位置'),'newOrder','select',[['position',t('顺序插入（旧卡片在前）')],['random',t('随机排列')]]);
          hint(t('初学间隔里每一步到点后会再出现，走完才转成复习卡。'));
        }
        section(t('每日上限'));
        field(t('每天最多新卡'),'newPerDay','number',undefined,[0,10000,1]);
        field(t('每天最多复习'),'reviewPerDay','number',undefined,[0,10000,1]);
        if(!this.deck){
          field(t('新的一天从几点开始'),'dayStartHour','number',undefined,[0,23,1]);
          hint(t('「新的一天」默认凌晨 4 点：每日上限从这里重新计数，搁置也是挪到下一个这个时间点。'));
          hint(t('0 表示不限。只限制新卡与复习的条数，学习中/重学的卡片不占额度；按本机当天零点起算。'));
        }else hint(t('0 表示不限；按这个牌组（含子牌组）当天已做的数量计算。'));
        section(t('遗忘'));
        stepField(t('重学间隔（分钟）'),'relearningSteps');
        field(t('记忆难点（leech）阈值'),'leechThreshold','number',undefined,[0,1000000,1]);
        field(t('记忆难点（leech）处理'),'leechAction','select',[['suspend',t('暂停卡片')],['tag',t('只加 leech 标签')]]);
        field(t('搁置新的关联卡片到次日'),'buryNew','checkbox');
        field(t('搁置待复习的关联卡片到次日'),'buryReview','checkbox');
        field(t('搁置跨日学习中的关联卡片到次日'),'buryLearning','checkbox');
        hint(t('关联卡片＝记忆树里与这张卡相连的父/子检测卡。有子卡被搁置时父卡会一起搁置，其它没被搁置的子卡不受影响；搁置只是挪到明天零点，不改记忆状态。'));
        // 先修解锁条件（全局与各牌组都能调）
        section(t('先修解锁'));
        field(t('先修卡连续几次「良好」才解锁'),'masteryReps','number',undefined,[1,9,1]);
        hint(t('默认 4：先修卡最近连续 4 次评分都达到「良好/简单」才解锁依赖卡；设为 1 就退回原来的「最近一次良好」。中间有一次「困难/重来」会重新累计。'));
        if(!this.deck){
          hint(t('忘记次数达到阈值就按上面的方式处理；阈值 0 表示不判定。默认 4 次。'));
          section(t('展示顺序'));
          field(t('新学/复习的先后顺序'),'newReviewOrder','select',[['mixed',t('学新与复习混合（默认）')],['newFirst',t('新卡先出')],['reviewFirst',t('复习先出')]]);
          field(t('复习卡片排列顺序'),'reviewOrder','select',[['forgetting',t('最容易忘的先（默认）')],['due',t('按到期日期')],['random',t('随机排列卡片')]]);
          hint(t('学习/重学的卡片永远排在最前；「按到期日期」只影响复习卡的先后。'));
        }
        const reviewGroup=section('FSRS');
        if(!this.deck)hint(t('牌组默认使用这里的参数。可右键文件夹单独调整。'));
        field(t('FSRS 模型'),'fsrsVersion','select',[['FSRS-7','FSRS-7'],['FSRS-6',t('FSRS-6（兼容 Anki 已导入参数）')]]);
        field(t('目标记忆率'),'desiredRetention','number',undefined,[.7,.99,.01]);
        field(t('最长复习间隔（天）'),'maximumInterval','number',undefined,[1,36500,1]);
        field(t('启用短期学习步骤'),'enableShortTerm','checkbox');
        hint(t('默认启用：新卡按「初学间隔」按分钟再出现，走完才转成复习卡；关闭后新卡第一次回答就直接转成复习卡。关闭不会重置已有记忆状态。'));
        field(t('更改参数后重新计算到期日'),'rescheduleOnChange','checkbox');
        hint(t('Anki 的「更改时将卡片重新排程」。打开后，保存 FSRS 参数会按新参数重算复习卡的到期日（不改记忆状态）；默认关闭。'));
        const weightsRow=document.createElement('label');weightsRow.className='setting-row parameter-row';
        if(this.deck&&this.inherit)weightsRow.hidden=true;
        const weightsText=document.createElement('span');weightsText.textContent=t('FSRS 参数');
        const weightsInput=document.createElement('textarea');weightsInput.dataset.memory='fsrsWeights';weightsInput.setAttribute('aria-label',t('FSRS 参数'));
        weightsInput.disabled=!!this.deck&&this.inherit;
        weightsInput.value=(profile.fsrsWeights||[]).join(', ');
        weightsInput.placeholder=t('留空使用所选模型的默认参数');
        // 点"填入优化参数"时若牌组还在继承状态，会先取消继承并整页重建，这里把参数补回输入框。
        if(this.pendingWeights){weightsInput.value=this.pendingWeights.join(', ');this.pendingWeights=null;}
        weightsRow.append(weightsText,weightsInput);(currentCard||body).append(weightsRow);
        hint(t('参数沿用导入值，也可手动粘贴。切换模型时，可清空参数以使用该模型默认值；修改设置不重置已学进度。'));
        // —— 1.6 ⑥ / 一键优化参数 + 留存度测算 ——
        // 留存度评估：
        //   · 一键优化只用最近 2 万条复习记录，训练从数分钟降到几十秒；
        //   · 「测算留存度」不再训练 + 时间序列评测，改为 SQL 直算真实通过率，秒级返回。
        const optimizeRow=document.createElement('div');optimizeRow.className='preference-optimize';
        // 进度条。单牌组训练只有一个阻塞调用（拿不到真实进度）→ 不确定进度条 + 已用秒数；
        // 逐牌组优化按「已完成牌组数 / 总数」给真实进度。
        const progress=document.createElement('div');progress.className='progress is-indeterminate';
        progress.hidden=true;const progressFill=document.createElement('span');progress.append(progressFill);
        const hideProgress=()=>{progress.hidden=true;progress.classList.add('is-indeterminate');progressFill.style.width='';};
        const runOptimize=()=>void (async()=>{
          if(this.optimizeBusy)return;
          this.optimizeBusy=true;this.optimizeResult=null;
          let seconds=0,timer:ReturnType<typeof setInterval>|undefined;
          try{
            // 重建 DOM 前先把已输入但未保存的字段收集进草稿，避免用户刚改的值被丢。
            try{this.collect();}
            catch(reason){this.optimizeNote=t('无法开始优化：{0}',(reason instanceof Error?reason.message:String(reason)));return;}
            this.optimizeNote=t('正在用全部符合条件的记录优化参数…');
            this.render();
            const live=document.querySelector('#preferences .progress') as HTMLElement|null;
            if(live)live.hidden=false;
            timer=setInterval(()=>{seconds++;
              const note=document.querySelector('#preferences .preference-optimize .preference-hint');
              if(note)note.textContent=t('正在本地计算参数优化… 已用 {0} 秒',seconds);},1000);
            try{
              const profile2=this.deck?(this.inherit?this.deck.inherited:this.deck.effective):this.draft.settings;
              this.optimizeResult=await window.reading.request<OptimizeResult>('optimizeDeck',{
                folderId:this.deck?this.deck.folderId:null,modelVersion:profile2.fsrsVersion,enableShortTerm:profile2.enableShortTerm,
                currentWeights:profile2.fsrsWeights?.length?profile2.fsrsWeights:null,evaluate:false});
              this.optimizeNote=t('输入 {0} 张卡、{1} 条评分，生成 {2} 个训练样本。耗时 {3} 秒。点「填入优化参数」应用结果。',this.optimizeResult.cardCount,this.optimizeResult.reviewCount,this.optimizeResult.trainingItemCount,(this.optimizeResult.durationMs/1000).toFixed(1));
            }catch(reason){this.optimizeNote=reason instanceof Error?reason.message:String(reason);}
          }finally{if(timer)clearInterval(timer);this.optimizeBusy=false;hideProgress();this.render();}
        })();
        const runRetention=()=>void (async()=>{
          if(this.optimizeBusy)return;
          this.optimizeBusy=true;
          try{
            this.optimizeNote=t('正在统计记忆保留率…');this.render();
            try{
              const report=await window.reading.request<any>('retentionReport',{folderId:this.deck?this.deck.folderId:null});
              const pct=(row:any)=>row.total?(row.rate*100).toFixed(1)+'%（'+row.pass+'/'+row.total+'）':'—';
              const lines=[t('总通过率：{0}',pct(report.overall))]
                .concat([t('欠熟练（难度>5）：{0}',pct(report.byDifficulty.hard)),t('已熟练（难度≤5）：{0}',pct(report.byDifficulty.easy))])
                .concat(report.periods.map((row:any)=>row.label+'：'+pct(row)));
              this.optimizeNote=t('记忆保留率（只计间隔≥1天的复习，{0} ms）——{1}',report.durationMs,lines.join('；'));
            }catch(reason){this.optimizeNote=reason instanceof Error?reason.message:String(reason);}
          }finally{this.optimizeBusy=false;this.render();}
        })();
        const optimizeButton=document.createElement('button');optimizeButton.type='button';
        // 牌组右键进来的「复习设置」只优化当前牌组（含子牌组），不会动全局参数。
        optimizeButton.textContent=this.deck?t('一键优化本牌组参数'):t('一键优化参数（实验性）');
        optimizeButton.disabled=this.optimizeBusy;
        optimizeButton.onclick=()=>runOptimize();
        const evaluateButton=document.createElement('button');evaluateButton.type='button';evaluateButton.textContent=t('测算留存度');evaluateButton.disabled=this.optimizeBusy;
        evaluateButton.onclick=()=>runRetention();
        const optimizeStatus=preferenceHint(this.optimizeNote||(this.deck
          ?t('根据本牌组（含子牌组）的复习历史训练参数（完整历史，本地计算）；结果只作预览，保存后才生效。其他牌组不受影响。')
          :t('根据全部牌组的复习历史训练全局默认参数（完整历史，本地计算）；保存后生效。留存度为即时统计。')));
        const simulate=document.createElement('button');simulate.type='button';simulate.textContent=t('模拟复习工作量');simulate.disabled=this.optimizeBusy;
        simulate.onclick=async()=>{
          simulate.disabled=true;
          optimizeStatus.textContent=t('正在模拟未来 30 天…');
          try{
            const report=await window.reading.request<{cards:number;days:number;historyCount:number;results:{retention:number;total:number;peak:number}[]}>('simulateWorkload',{folderId:this.deck?.folderId});
            const ratings=report.historyCount?t('按 {0} 条历史评分的比例抽样',report.historyCount):t('暂无历史，按每次答「良好」估算');
            optimizeStatus.textContent=t('{0} 张卡 · {1}。沿用首次到期日，每天处理到期卡，忽略分钟步骤。{2}',report.cards,ratings,report.results.map(row=>
              t('{0}% 平均 {1} 次/日，峰值 {2}',Math.round(row.retention*100),(row.total/report.days).toFixed(1),row.peak)).join(t('；')));
          }catch(error){optimizeStatus.textContent=String(error);}
          finally{simulate.disabled=false;}
        };
        optimizeRow.append(optimizeButton,evaluateButton,simulate,progress,optimizeStatus);
        // 全局优化 = 每个牌组各自训练、各自保存（不是把所有牌组混成一套参数）。
        if(!this.deck){
          const globalRow=document.createElement('div');globalRow.className='preference-optimize';
          const globalButton=document.createElement('button');globalButton.type='button';
          globalButton.textContent=t('一键全局优化（逐个牌组）');globalButton.disabled=this.optimizeBusy;
          globalButton.onclick=()=>void (async()=>{
            if(this.optimizeBusy)return;
            if(!window.confirm(t('将对每个有复习记录的牌组分别训练并写入该牌组的参数（各牌组参数互不影响）。可能耗时数分钟，继续？')))return;
            this.optimizeBusy=true;this.optimizeNote=t('正在读取牌组清单…');this.render();
            try{
              // 逐牌组执行以获得真实进度（i / total），每牌组 5000 条、60 秒超时。
              const decks=await window.reading.request<Array<{folderId:string;title:string;count:number}>>('optimizeDeckList');
              if(!decks.length)throw Error(t('没有复习记录达到训练要求的牌组。'));
              const bar=document.querySelector('#preferences .progress') as HTMLElement|null;
              const fill=bar?.querySelector('span') as HTMLElement|null;
              if(bar&&fill){bar.hidden=false;bar.classList.remove('is-indeterminate');fill.style.width='0%';}
              const done:any[]=[];const failed:any[]=[];
              for(let index=0;index<decks.length;index++){
                const deck=decks[index];
                this.optimizeNote=t('正在优化 {0}/{1}：{2}（{3} 条）…',(index+1),decks.length,deck.title,deck.count);
                const note=document.querySelector('#preferences .preference-optimize .preference-hint');
                if(note)note.textContent=this.optimizeNote;
                try{
                  const result=await window.reading.request<OptimizeResult>('optimizeDeckApply',{folderId:deck.folderId});
                  done.push({title:deck.title,reviewCount:result.reviewCount,durationMs:result.durationMs});
                }catch(reason){failed.push({title:deck.title,error:reason instanceof Error?reason.message:String(reason)});}
                if(fill)fill.style.width=Math.round((index+1)/decks.length*100)+'%';
              }
              this.optimizeNote=t('全局优化完成：')+done.length+'/'+decks.length+t(' 个牌组已各自训练并写入')
                +(failed.length?t('；失败 ')+failed.length+t(' 个：')+failed.map(item=>item.title+'（'+item.error+'）').join('、'):'')
                +'。'+done.map(item=>t('{0}（{1} 条 / {2} 秒）',item.title,item.reviewCount,(item.durationMs/1000).toFixed(1))).join('；');
            }catch(reason){this.optimizeNote=reason instanceof Error?reason.message:String(reason);}
            finally{this.optimizeBusy=false;hideProgress();this.render();}
          })();
          const globalNote=preferenceHint(t('按各牌组当前的 FSRS 模型分别训练并保存参数。每组使用本级卡片的全部可用复习记录。'));
          globalRow.append(globalButton,globalNote);optimizeRow.append(globalRow);
        }
        if(this.optimizeResult){
          const fillButton=document.createElement('button');fillButton.type='button';fillButton.textContent=t('填入优化参数');
          fillButton.onclick=()=>{
            if(!this.optimizeResult)return;
            try{this.collect();}
            catch(reason){this.optimizeNote=t('无法填入参数：{0}',(reason instanceof Error?reason.message:String(reason)));this.render();return;}
            // 牌组继承时，填入参数意味着"取消继承并显式设置"，与手动改字段的行为保持一致。
            if(this.deck&&this.inherit){this.inherit=false;this.deck.effective={...this.deck.inherited};}
            this.pendingWeights=this.optimizeResult.weights;
            this.optimizeNote=t('已填入优化参数，检查后点“保存设置”生效（保存前不影响现有复习排程）。');
            this.render();
          };
          optimizeRow.append(fillButton);
        }
        reviewGroup.append(optimizeRow);
      }else if(this.tab==='appearance'){
        // 外观单独一页——主题、字号等影响界面观感的设置都放这里
        section(t('主题'));
        field(t('颜色主题'),'theme','select',[['dark',t('深色（默认）')],['light',t('浅色')],['system',t('跟随系统')]]);
        hint(t('深色是默认主题；选「跟随系统」时会随 Windows 的浅色/深色自动切换。'));
        section(t('文字'));
        field(t('正文字号'),'fontSize','number',undefined,[10,48,1]);
        hint(t('工作区正文与卡片内容的字号（10–48px）。Ctrl+滚轮也能临时缩放。'));
        const custom=section(t('自定义样式'));
        const cssArea=document.createElement('textarea');
        cssArea.className='preference-css';cssArea.spellcheck=false;
        cssArea.placeholder=':root { --accent:#e07a5f; --background-primary:#fffdf8; }';
        cssArea.value=this.draft.settings.customCss||'';
        cssArea.oninput=()=>{this.draft.settings.customCss=cssArea.value;};
        custom.append(cssArea);
        hint(t('写标准 CSS（变量、选择器都行），保存后立即生效，留空表示不用。常用变量：--accent / --background-primary / --border / --text-normal。'));
      }else if(this.tab==='general'){
        const languageSection=section(t('语言'));
        const languageRow=document.createElement('label');languageRow.className='setting-row';
        const languageLabel=document.createElement('span');languageLabel.textContent=t('界面语言');
        const languageSelect=document.createElement('select');languageSelect.id='interface-language';
        languageSelect.add(new Option(t('简体中文'),'zh-CN'));
        languageSelect.add(new Option('English','en'));
        languageSelect.value=getLocale();
        const languageNote=preferenceHint('');
        languageNote.setAttribute('role','status');
        const updateLanguageNote=()=>{
          languageNote.textContent=languageSelect.value===getLocale()?'':t('已保存。重新打开 Kasaneri 后应用新语言。');
        };
        languageSelect.disabled=true;
        void window.reading.getLanguage().then(value=>{
          languageSelect.value=value;updateLanguageNote();
        }).catch(reason=>{languageNote.textContent=String(reason);}).finally(()=>{languageSelect.disabled=false;});
        languageSelect.onchange=async()=>{
          const locale=parseLocale(languageSelect.value);
          if(!locale)return;
          languageSelect.disabled=true;
          try{
            await window.reading.setLanguage(locale);
            updateLanguageNote();
          }catch(reason){
            languageSelect.value=await window.reading.getLanguage().catch(()=>getLocale());
            languageNote.textContent=String(reason);
          }finally{languageSelect.disabled=false;}
        };
        languageRow.append(languageLabel,languageSelect);languageSection.append(languageRow,languageNote);
        hint(t('语言偏好保存在本机，适用于所有窗口。'));

        // 默认文件夹名称（没有文件夹时自动创建；旧「未归类」按它改名）
        section(t('目录'));field(t('默认文件夹名称'),'defaultFolderName','text');
        hint(t('资料库没有任何文件夹时自动创建这个文件夹；旧库的「未归类」会改成这里的名字。也可以直接在目录树里 F2 改。'));
        // 音频自动播放（全局）
        section(t('媒体'));field(t('音频自动播放'),'audioAutoplay','checkbox');
        hint(t('打开后，正文/卡片里的音频与视频会一出现就自动播放；关闭时需手动点播放。'));
        // 删除确认框可关（默认关＝直接删，仍能撤销或到垃圾桶恢复）
        section(t('删除'));field(t('删除前弹确认框'),'confirmDelete','checkbox');
        hint(t('默认关闭：点「删除卡片 / 删除文件夹」直接进垃圾桶。打开后每次删除都先问一次。两种方式都能用 Ctrl+Z 撤销，或到垃圾桶恢复。'));
        const functions=section(t('功能栏'));
        const descriptions:Array<[IconName,string]>=[['panel-right-close',t('目录树 · 展开或收起右侧目录')],['play',t('复习 · 统一复习全部牌组的检测卡')],['book-open',t('待办 · 按优先级阅读主题与提取')],['panels-top-left',t('浏览卡片 · 筛选并编辑卡片')],['keyboard',t('快捷键 · 修改操作组合键')],['settings',t('设置 · 外观、复习与待办设置')]];
        for(const [name,text] of descriptions){const row=document.createElement('div');row.className='function-description';const graphic=document.createElement('span');graphic.innerHTML=icon(name);const description=document.createElement('span');description.textContent=text;row.append(graphic,description);functions.append(row);}
        hint(t('目录标题右侧的黄色、绿色、蓝色按钮分别筛选主题、提取和检测卡。可叠加；全部关闭时显示全部。'));
        // 快照导出/导入（同步方案阶段 0）
        const dataGroup=section(t('数据'));
        const dataRow=document.createElement('div');dataRow.className='preference-optimize';
        // 附件管理完整版（占用、未引用清理、回收站恢复/彻底删除）
        const assetButton=document.createElement('button');assetButton.type='button';assetButton.textContent=t('附件管理…');
        assetButton.onclick=()=>void openAttachmentManager();
        const assetOpen=document.createElement('button');assetOpen.type='button';assetOpen.textContent=t('打开附件目录');
        assetOpen.onclick=()=>void window.reading.request('assetUsage').then((usage:any)=>window.reading.request('openPath',{path:usage.dir}));
        dataRow.append(assetButton,assetOpen);
        const dataNote=preferenceHint('');
        const exportButton=document.createElement('button');exportButton.type='button';exportButton.textContent=t('导出快照…');
        exportButton.onclick=()=>void (async()=>{exportButton.disabled=true;try{const result=await window.reading.exportSnapshot();dataNote.textContent=result.cancelled?t('已取消'):t('已导出到：{0}',result.path);}catch(reason){dataNote.textContent=reason instanceof Error?reason.message:String(reason);}finally{exportButton.disabled=false;}})();
        const importButton=document.createElement('button');importButton.type='button';importButton.textContent=t('导入快照…（替换资料库并重启）');
        importButton.onclick=()=>void (async()=>{importButton.disabled=true;try{const result=await window.reading.importSnapshot();dataNote.textContent=result.cancelled?t('已取消'):t('导入完成，正在重启…');}catch(reason){dataNote.textContent=reason instanceof Error?reason.message:String(reason);}finally{importButton.disabled=false;}})();
        const ankiButton=document.createElement('button');ankiButton.type='button';ankiButton.textContent=t('导入或补导 Anki…');
        ankiButton.onclick=async()=>{
          ankiButton.disabled=true;
          try{
            const result=await window.reading.request<{cards:number;missingMedia:string[]}|null>('importAnkiBundle');
            if(result)dataNote.textContent=t('已核对 {0} 张 Anki 卡，仍缺 {1} 个附件。',result.cards,result.missingMedia.length);
          }catch(error){dataNote.textContent=String(error);}
          finally{ankiButton.disabled=false;}
        };
        dataRow.append(exportButton,importButton,ankiButton,dataNote);dataGroup.append(dataRow);
        hint(t('快照包含 data\\library\\ 的全部内容（资料库 + 附件），可拷贝到 Windows/Linux 另一台机器后用「导入快照」恢复；导入会先备份当前资料库再替换。'));
      }else if(this.tab==='reading'){
        hint(t('独立于检测卡复习。从全部文件夹的主题与提取中，按到期时间、优先级和来源分散进入待办队列；允许积压，不自动延后。'));
        field(t('首次阅读间隔（天）'),'readingInitialDays','number',undefined,[.001,3650,.1]);
        field(t('「稍后」固定延期（天）'),'readingLaterDays','number',undefined,[0,36500,1]);
        hint(t('填 0 时沿用间隔增长。填正数时按固定天数延期，保留原阅读间隔和次数。'));
        field(t('默认优先级（1 高，9 低）'),'defaultPriority','number',undefined,[1,9,1]);field(t('高低优先级的待办权重比'),'priorityRatio','number',undefined,[1,100,.1]);
      if(this.node&&this.node.kind!=='folder'&&this.node.kind!=='cloze'){
        const projectGroup=section(t('当前项目 · {0}',this.node.title));
        const row=document.createElement('label');row.className='setting-row';const label=document.createElement('span');label.textContent=t('当前项目优先级');
        const select=document.createElement('select');select.id='node-priority';select.setAttribute('aria-label',t('当前项目优先级'));
        for(const [value,name] of [['',t('继承父级／默认')],['0',t('0 · 优先处理')],...Array.from({length:9},(_,i)=>[String(i+1),String(i+1)])]){
          const option=document.createElement('option');option.value=value;option.textContent=name;select.append(option);
        }
        select.value=this.priority;row.append(label,select);projectGroup.append(row);
      }
      }else if(this.tab==='sync'){
        // ===== 同步图形面板（即时生效，不参与"保存设置"流程）=====
        if(!this.syncState){hint(t('读取同步设置失败，点击「同步」重试。'));}
        else{
          const initialSync=this.syncState;
          const banner=document.createElement('p');
          banner.className='sync-feedback error';banner.setAttribute('role','alert');banner.hidden=true;
          const renderStatus=(state:any,errorOnly=false)=>{
            banner.hidden=!state.status.error;
            if(banner.textContent!==state.status.error)banner.textContent=state.status.error;
            const lines=document.createDocumentFragment();
            const row=(label:string,value:string,cls='')=>{const line=document.createElement('div');line.className='sync-status-line '+cls;
              const name=document.createElement('span');name.className='sync-status-label';name.textContent=label;
              const val=document.createElement('span');val.className='sync-status-value';val.textContent=value;
              line.append(name,val);lines.append(line);};
            // 旧版/把"同步到底有没有在跑"讲清楚
            if(state.status.running){row(t('进度'),t('正在同步…'),'info');}
            if(state.status.error){row(t('同步出错'),state.status.error,'error');}
            else if(errorOnly){status.replaceChildren(lines);return;}
            const ago=(time:number)=>{if(!time)return '—';const seconds=Math.max(0,Math.round((Date.now()-time)/1000));
              if(seconds<60)return t('{0} 秒前',seconds);if(seconds<3600)return t('{0} 分钟前',Math.round(seconds/60));return t('{0} 小时前',Math.round(seconds/3600));};
            const enabled=!!state.config.enabled;
            const peers:any[]=state.config.peers||[];
            const healthy=!!state.status.lastOk&&!state.status.error;
            const connection=state.status.error?t('有对端同步失败'):healthy?t('同步正常'):t('等待首次成功同步');
            row(t('状态'),enabled?(peers.length?t('● 已开启 · {0}',connection):t('● 已开启 · 但没有对端')):t('○ 已关闭'),enabled&&peers.length&&healthy?'ok':'');
            row(t('上次成功'),state.status.lastOk?new Date(state.status.lastOk).toLocaleTimeString(getLocale())+'（'+ago(state.status.lastOk)+'）':t('还没有成功同步过'));
            if(enabled&&peers.length){
              row(t('上次检查'),state.status.lastCheck?ago(state.status.lastCheck):t('尚未检查'));
            }
            row(t('设备名'),state.deviceName||this.syncName||t('（未设置）'));
            row(t('本机 ID'),state.deviceId.slice(0,8)+'…');
            row(t('对端'),peers.length?peers.map((peer:any)=>peer.name===peer.address?peer.name:peer.name+'（'+peer.address+'）').join('、'):t('未添加'));
            row(t('累计'),t('拉取 {0} 条 · 推送 {1} 条',state.status.pulled,state.status.pushed));
            const logsAll:any[]=state.status.logs||[];
            for(const peer of peers){
              const last=logsAll.find((entry:any)=>entry.peer===peer.name||entry.peer===peer.address);
              const detail=last?(last.ok?t('✓ 成功 · {0} · 拉 {1} / 推 {2}',ago(last.at),last.pulled,last.pushed):t('✗ 失败 · {0} · {1}',ago(last.at),last.message)):t('尚未尝试');
              row(t('设备状态'),peer.name+' · '+detail,last?(last.ok?'ok':'error'):'');
            }
            const logs:any[]=(state.status.logs||[]).slice(0,10);
            if(logs.length){
              const list=document.createElement('div');list.className='sync-log';
              const title=document.createElement('div');title.className='sync-log-title';title.textContent=t('最近同步记录（只在有变化或出错时记录）');
              const copy=document.createElement('button');
              copy.type='button';copy.textContent=t('复制日志');
              copy.onclick=async()=>{
                const lines=logsAll.map(entry=>[
                  new Date(entry.at).toLocaleString(getLocale()),entry.peer,entry.ok?t('成功'):t('失败'),
                  t('拉取 {0} / 推送 {1}',entry.pulled,entry.pushed),entry.ms+' ms',entry.message,
                ].join(' · '));
                try{await navigator.clipboard.writeText(lines.join('\n'));copy.textContent=t('已复制');}
                catch{copy.textContent=t('复制失败');}
              };
              title.append(' ',copy);list.append(title);
              for(const entry of logs){
                const line=document.createElement('div');line.className='sync-log-line'+(entry.ok?'':' error');
                const time=document.createElement('span');time.className='sync-log-time';time.textContent=new Date(entry.at).toLocaleTimeString(getLocale());
                const peer=document.createElement('span');peer.className='sync-log-peer';peer.textContent=entry.peer;
                const message=document.createElement('span');message.className='sync-log-message';
                message.textContent=(entry.ok?'✓ ':'✗ ')+entry.message+(entry.ms?'（'+entry.ms+' ms）':'');
                line.append(time,peer,message);list.append(line);
              }
              lines.append(list);
            }
            status.replaceChildren(lines);
          };
          const status=document.createElement('div');status.className='sync-status';
          // 同步页打开时每 3 秒刷新一次，倒计时与状态是活的
          const refresh=async()=>{try{renderStatus(await window.reading.syncStatus());}catch{}};
          const timer=setInterval(()=>{if(!document.body.contains(status)){clearInterval(timer);return;}void refresh();},3000);
          const apply=async(changes:{passphrase?:string;name?:string}={})=>{
            try{
              const state=await window.reading.syncConfigure({...this.syncDraft,...changes});
              this.syncState=state;this.syncHasPassphrase=Boolean(state.hasPassphrase);this.syncName=state.deviceName||'';
              renderKeyStatus();renderStatus(state);renderAddresses(state);
              return true;
            }catch(reason){
              status.replaceChildren();const err=document.createElement('div');err.className='sync-status-line error';err.textContent=reason instanceof Error?reason.message:String(reason);status.append(err);
            }
          };
          // 顶部工具条——立即同步 / 冲突文件
          const topBar=document.createElement('div');topBar.className='sync-topbar';
          const syncNowTop=document.createElement('button');syncNowTop.type='button';syncNowTop.textContent=t('立即同步');syncNowTop.className='primary';
          const conflictsButton=document.createElement('button');conflictsButton.type='button';conflictsButton.textContent=t('打开冲突文件');
          const manualResult=document.createElement('p');
          manualResult.className='sync-feedback';manualResult.setAttribute('role','status');manualResult.hidden=true;
          topBar.append(syncNowTop,conflictsButton);body.append(topBar,banner,manualResult);
          // 写清同步范围和限制（自动同步已取消，只保留「立即同步」）。
          const syncNotes=document.createElement('div');syncNotes.className='preference-hint';
          syncNotes.append(
            t('同步会交换复习/阅读记录和卡片内容（正文、标题、附件、增删）。两边都改过的卡片会进入「冲突文件」，可以逐张选择或删除。'),
            document.createElement('br'),
            t('只走局域网明文 HTTP + HMAC，请在可信网络使用；两端时钟相差超过 2 分钟会被拒绝，请先校准系统时间。'),
          );
          body.append(syncNotes);
          conflictsButton.onclick=()=>{this.dialog.close();this.openConflicts();};
          syncNowTop.onclick=async()=>{
            syncNowTop.disabled=true;syncNowTop.textContent=t('同步中…');
            manualResult.hidden=false;manualResult.textContent=t('同步中…');
            try{
              const state=await window.reading.syncNow();
              renderStatus(state);
              const cycle=state.status.lastCycle;
              if(!state.config.enabled)manualResult.textContent=t('请先启用同步。');
              else if(!state.config.peers.length)manualResult.textContent=t('请先添加对端设备。');
              else if(cycle)manualResult.textContent=t('{0} · 拉取 {1} 条 · 推送 {2} 条 · {3} 秒',cycle.failed?t('有 {0} 台设备同步失败',cycle.failed):t('同步完成'),cycle.pulled,cycle.pushed,(cycle.ms/1000).toFixed(1));
            }catch(reason){manualResult.textContent=reason instanceof Error?reason.message:String(reason);}
            finally{syncNowTop.disabled=false;syncNowTop.textContent=t('立即同步');}
          };

          const statusGroup=section(t('状态'));statusGroup.append(status);renderStatus(initialSync);
          // 把本机可用于同步的「地址:端口」列出来，方便填到另一台机器；点击即复制。
          const addressBox=document.createElement('div');
          const addressTitle=document.createElement('p');addressTitle.className='preference-hint';
          addressTitle.textContent=t('本机地址（把其中一条填到另一台机器的「对端」里）：');
          const addressList=document.createElement('div');addressList.className='sync-addresses';
          addressBox.append(addressTitle,addressList);
          statusGroup.append(addressBox);
          const renderAddresses=(state:typeof initialSync)=>{
            const addresses:Array<{address:string;kind:string}> = state.addresses||[];
            const port=state.port||state.config.port;
            const rows=addresses.map(item=>{
              const row=document.createElement('button');row.type='button';row.className='sync-address';
              const address=item.address+':'+port;
              row.textContent=address+'（'+item.kind+'）';
              row.title=t('点击复制');
              row.onclick=()=>{void navigator.clipboard.writeText(address);row.textContent=t('已复制 {0}',address);};
              return row;
            });
            addressList.replaceChildren(...(rows.length?rows:[preferenceHint(t('没有检测到可用网卡地址。'))]));
          };
          renderAddresses(initialSync);
          const connection=section(t('连接'));
          const enableRow=document.createElement('label');enableRow.className='setting-row';
          const enableText=document.createElement('span');enableText.textContent=t('启用同步');
          const enable=document.createElement('input');enable.type='checkbox';enable.checked=this.syncDraft.enabled;
          enable.onchange=()=>{this.syncDraft.enabled=enable.checked;void apply();};
          enableRow.append(enableText,enable);connection.append(enableRow);
          const portRow=document.createElement('label');portRow.className='setting-row';
          const portText=document.createElement('span');portText.textContent=t('监听端口');
          const port=document.createElement('input');port.type='number';port.value=String(this.syncDraft.port);port.setAttribute('aria-label',t('监听端口'));
          port.onchange=()=>{this.syncDraft.port=Math.max(1024,Math.min(65535,Math.floor(Number(port.value)||38641)));port.value=String(this.syncDraft.port);void apply();};
          portRow.append(portText,port);connection.append(portRow);
          const keyRow=document.createElement('div');keyRow.className='setting-row';
          const keyText=document.createElement('label');keyText.textContent=t('同步口令');keyText.htmlFor='sync-passphrase';
          const key=document.createElement('input');key.type='password';key.id='sync-passphrase';
          key.onchange=()=>{const passphrase=key.value;if(passphrase){key.value='';void apply({passphrase});}};
          const clearKey=document.createElement('button');clearKey.type='button';clearKey.textContent=t('清除口令');
          clearKey.onclick=()=>void apply({passphrase:''});
          const renderKeyStatus=()=>{
            key.placeholder=this.syncHasPassphrase?t('已保存，输入可更换'):t('两端填写相同口令');
            clearKey.hidden=!this.syncHasPassphrase;
          };
          renderKeyStatus();
          const keyControls=document.createElement('span');keyControls.className='sync-key-controls';keyControls.append(key,clearKey);
          keyRow.append(keyText,keyControls);connection.append(keyRow);
          // 本机设备名（对端按名字区分）
          const nameRow=document.createElement('label');nameRow.className='setting-row';
          const nameText=document.createElement('span');nameText.textContent=t('本机设备名');
          const deviceNameInput=document.createElement('input');deviceNameInput.type='text';deviceNameInput.placeholder=t('例如：台式机');
          deviceNameInput.value=this.syncName||'';deviceNameInput.setAttribute('aria-label',t('本机设备名'));
          deviceNameInput.onchange=()=>void apply({name:deviceNameInput.value.trim()});
          nameRow.append(nameText,deviceNameInput);connection.append(nameRow);
          const peers=section(t('对端设备'));
          if(!this.syncDraft.peers.length){const empty=document.createElement('p');empty.className='preference-hint';empty.textContent=t('输入另一台设备的地址和端口以添加对端。');peers.append(empty);}
          for(const peer of this.syncDraft.peers){
            const line=document.createElement('div');line.className='sync-peer';
            const address=document.createElement('span');address.className='sync-peer-address';address.textContent=(peer as any).name||(peer as any).address;
            const test=document.createElement('button');test.type='button';test.textContent=t('测试连接');
            const result=document.createElement('p');result.className='preference-hint';result.setAttribute('role','status');result.hidden=true;
            test.onclick=async()=>{
              test.disabled=true;result.hidden=false;result.textContent=t('测试中…');
              try{result.textContent=(await window.reading.syncTestPeer(peer.address)).message;}
              catch(error){result.textContent=error instanceof Error?error.message:String(error);}
              finally{test.disabled=false;}
            };
            const remove=document.createElement('button');remove.type='button';remove.textContent=t('移除');
            remove.onclick=()=>{remove.disabled=true;this.syncDraft.peers=this.syncDraft.peers.filter(item=>item!==peer);void apply().then(saved=>{
              if(saved&&this.tab==='sync'&&this.dialog.open)this.render();
              else remove.disabled=false;
            });};
            line.append(address,test,remove);peers.append(line,result);
          }
          const addRow=document.createElement('div');addRow.className='sync-peer-add';
          const peerInput=document.createElement('input');peerInput.placeholder='192.168.1.8:38641';peerInput.setAttribute('aria-label',t('对端地址'));
          const add=document.createElement('button');add.type='button';add.textContent=t('＋ 添加对端');
          const nameInput=document.createElement('input');nameInput.placeholder=t('设备名（如：笔记本）');nameInput.setAttribute('aria-label',t('对端设备名'));
          add.onclick=()=>{const value=peerInput.value.trim();if(!value)return;const name=nameInput.value.trim()||value;this.syncDraft.peers.push({name,address:value});void apply().then(saved=>{if(saved&&this.tab==='sync'&&this.dialog.open)this.render();});};
          addRow.append(nameInput,peerInput,add);peers.append(addRow);
          hint(t('两台设备使用同一口令，并互相添加对端地址。开启后每 60 秒自动同步，也可以点「立即同步」。'));
        }
      }else if(this.tab==='backup'){
        // ===== 自动备份（定时把快照导出到指定文件夹）=====
        hint(t('自动备份 = 定时把 data\\library 的完整快照导出到你选的文件夹（内容与「导出快照」一致：数据库 + 附件 + 缓存）。建议放到另一块磁盘或网盘同步目录。'));
        const status=preferenceHint(t('正在读取备份设置…'));
        body.append(status);
        const render=(state:any)=>{
          const last=state.config.lastAt?new Date(state.config.lastAt).toLocaleString(getLocale()):t('从未');
          const keep=Number(state.config.keepLast||0);
          const pruned=state.status?.pruned?t('（刚清理 {0} 份旧备份）',state.status.pruned):'';
          const error=state.status?.error?t(' · 最近错误：{0}',state.status.error):'';
          status.textContent=t('文件夹：{0} · 间隔 {1} 小时 · 上次备份 {2} · 保留 {3}{4}{5}{6}',
            state.config.folder||t('未选择'),state.config.intervalHours||24,last,
            keep>0?t('最近 {0} 份',keep):t('全部'),pruned,state.config.enabled?t(' · 已启用'):t(' · 未启用'),error);
        };
        const row=(label:string,control:HTMLElement)=>{
          const line=document.createElement('label');line.className='setting-row';
          const text=document.createElement('span');text.textContent=label;line.append(text,control);body.append(line);
        };
        const enable=document.createElement('input');enable.type='checkbox';
        const interval=document.createElement('input');interval.type='number';interval.min='1';interval.max='720';
        // 保留份数（0 = 不清理）。只删带 manifest.json 的快照目录。
        const keepLast=document.createElement('input');keepLast.type='number';keepLast.min='0';keepLast.max='3650';
        const apply=async(patch:Record<string,unknown>)=>{
          try{render(await window.reading.backupConfigure({enabled:enable.checked,
            intervalHours:Math.max(1,Math.min(720,Number(interval.value)||24)),
            keepLast:Math.max(0,Math.min(3650,Math.floor(Number(keepLast.value)||0))),...patch}));}
          catch(reason){status.textContent=reason instanceof Error?reason.message:String(reason);}
        };
        enable.onchange=()=>void apply({});
        interval.onchange=()=>void apply({});
        keepLast.onchange=()=>void apply({});
        row(t('启用自动备份'),enable);
        row(t('间隔（小时）'),interval);
        row(t('保留份数（0 = 不清理）'),keepLast);
        const actions=document.createElement('div');actions.className='preference-optimize';
        const choose=document.createElement('button');choose.type='button';choose.textContent=t('选择文件夹…');
        choose.onclick=()=>void (async()=>{try{render(await window.reading.backupChooseFolder());}catch(reason){status.textContent=String(reason);}})();
        const now=document.createElement('button');now.type='button';now.textContent=t('立即备份');
        now.onclick=()=>void (async()=>{now.disabled=true;
          try{const state:any=await window.reading.backupNow();
            status.textContent=state.result?.ok?t('已备份到：{0}',state.result.path):t('备份失败：{0}',state.result?.error||state.status?.error||t('未知错误'));
          }catch(reason){status.textContent=reason instanceof Error?reason.message:String(reason);}
          finally{now.disabled=false;}})();
        const openFolder=document.createElement('button');openFolder.type='button';openFolder.textContent=t('打开备份文件夹');
        openFolder.onclick=()=>void (async()=>{try{const state:any=await window.reading.backupStatus();
          if(state.config.folder)await window.reading.request('openPath',{path:state.config.folder});}catch{}})();
        actions.append(choose,now,openFolder);body.append(actions);
        void (async()=>{try{const state:any=await window.reading.backupStatus();
          enable.checked=!!state.config.enabled;interval.value=String(state.config.intervalHours||24);
          keepLast.value=String(state.config.keepLast==null?14:state.config.keepLast);render(state);}
          catch(reason){status.textContent=reason instanceof Error?reason.message:String(reason);}})();
        hint(t('备份文件是普通文件夹（Kasaneri-快照-<时间>），可以直接拷贝到另一台机器用「导入快照」恢复。')
          +t('「保留份数」= 备份文件夹里最多留几份快照，超出时自动删最旧的；只删带 manifest.json 的快照目录，同文件夹里的其他内容不动。填 0 表示不清理。'));
      }else if(this.tab==='files'){
        // ===== 文件管理——新建主题的默认落点 =====
        hint(t('用快捷键 Alt+F 新建主题时，会直接创建在下面选定的「默认文件夹」里；选「跟随当前选中」则用目录树里选中的文件夹。'));
        const select=document.createElement('select');select.setAttribute('aria-label',t('默认文件夹'));
        const none=document.createElement('option');none.value='';none.textContent=t('跟随当前选中');select.append(none);
        const row=document.createElement('label');row.className='setting-row';const label=document.createElement('span');label.textContent=t('新建主题的默认文件夹');
        row.append(label,select);(currentCard||body).append(row);
        void (async()=>{
          const raw=await window.reading.request<Array<{id:string;title:string;parentId:string|null}>>('folders');
          const byId=new Map(raw.map(folder=>[folder.id,folder]));
          const pathOf=(start:any)=>{const parts:string[]=[];const seen=new Set<string>();let cursor=start;
            while(cursor&&!seen.has(cursor.id)){seen.add(cursor.id);parts.unshift(cursor.title);cursor=cursor.parentId?byId.get(cursor.parentId):null;}
            return parts.join('/');};
          for(const folder of raw.slice().sort((a,b)=>pathOf(a).localeCompare(pathOf(b)))){
            const option=document.createElement('option');option.value=folder.id;option.textContent=pathOf(folder);select.append(option);
          }
          try{const saved=await window.reading.request<{folderId?:string}|null>('settingGet',{key:'defaultTopicFolder'});select.value=saved?.folderId||'';}catch{}
        })();
        select.onchange=()=>void window.reading.request('settingSet',{key:'defaultTopicFolder',value:select.value?{folderId:select.value}:null});
        hint(t('「移至…」：右键任意卡片/文件夹 →「移至…」，输入或用 ↑↓ 选父级目录（输入框里可用 / 逐级定位，例如 Anime/1），回车即移动，之后目录树会自动展开并选中这张卡片。'));      }else if(this.tab==='trash'){
        // ===== 垃圾桶独立设置页 =====
        hint(t('删除的卡片先放进垃圾桶，可以恢复或彻底删除。超过保留天数后自动永久删除；启动时与每 6 小时检查一次。'));
        field(t('垃圾桶保留天数'),'trashRetentionDays','number',undefined,[7,3650,1]);
        const trashGroup=section(t('当前垃圾桶'));
        const trashRow=document.createElement('div');trashRow.className='preference-optimize';
        const trashNote=preferenceHint(t('正在统计…'));
        const openButton=document.createElement('button');openButton.type='button';openButton.textContent=t('打开垃圾桶');
        openButton.onclick=()=>{document.querySelector<HTMLButtonElement>('#open-trash')?.click();this.dialog.close();};
        const cleanButton=document.createElement('button');cleanButton.type='button';cleanButton.textContent=t('立即清理');
        const refreshTrash=async()=>{try{const items=await window.reading.request<any[]>('trashList',{limit:300});
          trashNote.textContent=items.length?(t('共 ')+items.length+t(' 项，最早的删除于 ')+new Date(Math.min(...items.map(item=>Number(item.deletedAt)))).toLocaleString(getLocale())+'。'):t('垃圾桶是空的。');}
          catch(reason){trashNote.textContent=reason instanceof Error?reason.message:String(reason);}};
        cleanButton.onclick=()=>void (async()=>{cleanButton.disabled=true;
          try{const result=await window.reading.request<any>('trashCleanup',{retentionDays:Number((this.draft.settings as any).trashRetentionDays)||30});
            trashNote.textContent=t('清理完成：永久删除 {0} 项。',(result.purged||0));}
          catch(reason){trashNote.textContent=reason instanceof Error?reason.message:String(reason);}
          finally{cleanButton.disabled=false;void refreshTrash();}})();
        trashRow.append(openButton,cleanButton,trashNote);trashGroup.append(trashRow);
        void refreshTrash();
        hint(t('「撤销删除」在正文没有可撤销编辑时可用 Ctrl+Z，或在垃圾桶里手动恢复。彻底删除会连同复习记录一起删除，不可恢复。'));
      }else if(this.tab==='contextMenu'){
        body.append(contextMenuPreferences());
      }else if(this.tab==='help'){
        // ===== 帮助页＝常用操作 + 名词解释；按板块折叠，先讲怎么做再讲是什么 =====
        const GUIDE:Array<{title:string;children:Array<{title:string;texts:string[]}>}>=[
  {title:t('一、常用操作'),children:[
    {title:t('复习检测卡'),texts:[
      t('空格显示答案，再按 1/2/3/4 评分：1 重来、2 困难、3 良好、4 简单。'),
      t('提示条上的时间是「按这个评分，下次什么时候回来」。'),
      t('底部「更多⌄」里有搁置、待办暂停、留存判定、撤销上次、浏览卡片。'),
      t('Ctrl+Z 撤销上一次操作，排程、日志、附件引用一起回滚。')]},
    {title:t('读待办材料'),texts:[
      t('空格读完（间隔按增长因子变大）、2 稍后（更短间隔再推）、1 置于末尾（本轮再来一次）、0 完成（不再推送）。'),
      t('右下角「加入复习」把材料里的检测卡送回复习队列。'),
      t('读的时候随时能改正文、摘录、生成子卡；Alt+E 也能直接进编辑。')]},
    {title:t('编辑与摘录'),texts:[
      t('正文和答案自动保存，标题点一下就能改，失焦或回车生效。'),
      t('Alt+A 摘录为提取、Alt+S 选区生成检测卡、Alt+D 新建提取、Alt+F 新建主题；建完留在当前卡，不会跳走。'),
      t('图片、音频、视频直接拖入或粘贴；显示宽度按卡片保存。')]},
    {title:t('目录树与记忆树'),texts:[
      t('目录树：单击只选中聚焦，双击有子项的文件夹或卡片展开一级，再双击收起；行左侧 +／− 也能收展。'),
      t('目录树右键可新建、重命名（F2）、移至、删除、进入复习、卡片信息；主题右键还有「新建子主题」。'),
      t('记忆树：单击父卡或子卡，工作区打开对应卡片，目录树同步定位。记忆树保持原来的收展和滚动位置。'),
      t('在目录树或记忆树的卡片上右键新建子卡，两个树里都会显示它。记忆树用行左侧的 +／− 收展。'),
      t('记忆树右键「关联卡片…」可以挑一张卡做跳转链接；关联不影响排程。')]},
    {title:t('浏览卡片'),texts:[
      t('搜索框输完按回车才查（拼音没选词时不会搜），匹配标题、正文、答案和标签。'),
      t('左侧按状态、类型、牌组筛选；表头右键可显示/隐藏列，列宽能拖。'),
      t('Ctrl 多选、Shift 连选，底部可批量停止/恢复、移动、查看信息；双击一行在独立窗口编辑。')]},
    {title:t('入口在哪'),texts:[
      t('最右一列图标：目录树、复习、待办、浏览卡片、添加卡片、统计、垃圾桶、快捷键、设置。'),
      t('工作区底部左侧是高亮开关与「编辑」，中间是队列按钮，右侧是「卡片属性」和「更多⌄」。'),
      t('所有命令都能改键，见设置→快捷键；右键菜单的项目可在设置→右键菜单里排序或隐藏。')]}]},
  {title:t('二、名词解释'),children:[
    {title:t('三种卡片'),texts:[
      t('主题（topic）：一篇材料，比如教材的一节，可以再套子主题。'),
      t('提取（extract）：从主题里摘出来的一段，可以接着读、再摘、再生成检测卡。'),
      t('检测卡（cloze）：正文里有 [...] 挖空的卡片，走 FSRS 复习；没写答案或没挖空算「未完成」，不进队列。')]},
    {title:t('两个队列'),texts:[
      t('复习队列：只有检测卡，按 FSRS 安排下一次复习。'),
      t('待办队列：主题与提取按到期日、优先级推送，读的时候可以改内容，等于边读边优化材料。'),
      t('两者共享同一份内容，排程互不影响。')]},
    {title:t('四种「停」'),texts:[
      t('待办暂停：检测卡退出复习、留在待办里被反复推送优化；点「加入复习」回去时评分清零，当新卡重新计分，历史保留。'),
      t('留存判定：打上这个状态后复习和待办都不推送，相当于暂存点，之后在浏览卡片里决定留下还是删掉。'),
      t('搁置：只把到期日推到下一个日切点，明天自己回来（快捷键 =）。'),
      t('已完成：在待办里点了「完成」，内容保留但不再推送。')]},
    {title:t('leech（难记）'),texts:[
      t('同一张卡连续重来达到阈值（默认 4 次）就自动变成待办暂停，并打上 leech 标签。'),
      t('回到复习时整套记忆状态清零、当新卡重新计分，标签和复习记录都保留，所以下一轮又从 4 次开始。'),
      t('标签后面带累计重来次数，比如 leech(6)，一眼能看出循环了几轮；撤销掉的评分不算。'),
      t('标签只会在手动删除、撤销那次触发它的评分、或同步覆盖时消失。')]},
    {title:t('先修卡'),texts:[
      t('记忆树里的检测子卡是父卡的先修。每张先修卡最近连续 N 次达到「良好」或「简单」，父卡才解锁（N 默认 4，设置→复习里改）。'),
      t('在卡片信息里可以添加或忽略先修。解锁后的卡片按自己的到期日进入队列。')]},
    {title:t('优先级与推送'),texts:[
      t('优先级 0-9，0 是绝对优先，不设就继承上层文件夹；它不影响 FSRS，只影响待办推送间隔。'),
      t('增长因子 = 1.1 + (优先级 − 1) × 0.05：优先级 1 时读完只涨 10%，9 时涨 50%。'),
      t('「自动推迟」会让低优先级、久未读的材料往后排，避免一次冒出太多。')]},
    {title:t('锚点与阅读点'),texts:[
      t('锚点：摘录和挖空在原文留下的彩色标记，按住 Ctrl 点它能跳回原处。'),
      t('阅读点：离开材料时记住读到哪，下次回到待办接着读。')]},
    {title:t('数据与备份'),texts:[
      t('整个资料库就是一个文件夹：library.sqlite（SQLite，WAL）、assets（附件按 sha256 去重）、cache（可重建的图片预览）。'),
      t('自动快照默认保留最近 14 份，也能做一份不退出程序的在线快照。'),
      t('删除都是软删除进垃圾桶，彻底删除之前会写一份 Markdown 快照。')]},
    {title:t('状态徽标'),texts:[
      t('新卡 / 学习中 / 复习：FSRS 的正常状态。'),
      t('待办中：在待办队列里等阅读；未完成：检测卡还缺内容，不参与排程。'),
      t('待办暂停 / 留存判定 / 已搁置 / 已完成：见上面「四种「停」」。'),
      t('难记：命中 leech 阈值；冲突文件：同步发现两个版本，要在浏览卡片里选保留哪份。')]}]},
];

        hint(t('设置即时生效。默认参数在「默认复习 / 默认待办」调整，单个牌组在目录树右键文件夹 →「设置」。'));
        const outline=document.createElement('div');outline.className='preference-outline';(currentCard||body).append(outline);
        outline.append(markdownReference());
        for(const [index,chapter] of GUIDE.entries()){
          const node=outlineSection(chapter.title,'preference-folder',index===0);
          for(const item of chapter.children){
            const child=outlineSection(item.title,'preference-sub');
            child.append(...item.texts.map(preferenceHint));node.append(child);
          }
          outline.append(node);
        }
      }
    }
    // 仿 Obsidian——没有保存/取消按钮，改动即时写回；出错显示在底部提示行。
    // 牌组只保存「和继承值不同」的参数，避免一取消继承就把默认值整批写进牌组。
    commit=async()=>{
      try{
        this.collect();
        if(this.deck){
          if(this.tab==='reading'&&this.node){
            await this.applyPriority(this.node,this.priority===''?null:Number(this.priority));
            error.hidden=true;
            return;
          }
          if(this.tab!=='review')return;
          const inherited=this.deck.inherited as Record<string,unknown>,effective=this.deck.effective as Record<string,unknown>;
          const overrides:Record<string,unknown>={};
          for(const key of REVIEW_KEYS)if(JSON.stringify(effective[key])!==JSON.stringify(inherited[key]))overrides[key]=effective[key];
          await this.applyDeck(this.deck.folderId,Object.keys(overrides).length?overrides as Partial<ReviewSettings>:null);
        }
        else this.draft=await this.apply(this.draft,this.tab==='reading'?this.node:null,this.priority===''?null:Number(this.priority));
        error.hidden=true;
      }catch(reason){error.textContent=reason instanceof Error?reason.message:String(reason);error.hidden=false;}
    };
    body.append(error);
    this.content.replaceChildren(nav,main);
  }
  private async loadSync(version:number){
    // 只显示是否已配置口令，具体口令留在主进程。
    try{const state=await window.reading.syncStatus();
      if(version!==this.viewVersion)return;
      this.syncState=state;
      this.syncDraft={enabled:state.config.enabled,port:state.config.port,peers:(state.config.peers||[]).map((peer:any)=>typeof peer==='string'?{name:peer,address:peer}:{name:peer.name||peer.address,address:peer.address})};
        this.syncHasPassphrase=Boolean(state.hasPassphrase);
        this.syncName=state.deviceName||'';
    }catch{if(version===this.viewVersion)this.syncState=null;}
  }
  private collect(){
    for(const element of this.content.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-setting]')){
      const key=element.dataset.setting as keyof StudySettings;
      const value=element instanceof HTMLInputElement&&element.type==='checkbox'?element.checked:element instanceof HTMLInputElement?(element.type==='text'?element.value:Number(element.value)):element.value;
      if(this.deck){if(!this.inherit)(this.deck.effective as any)[key]=value;}else(this.draft.settings as any)[key]=value;
    }
    for(const element of this.content.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-memory]')){
      if(element.disabled)continue;const key=element.dataset.memory as 'learningSteps'|'relearningSteps'|'fsrsWeights';
      const values=element.value.trim().replace(/[\[\]]/g,'').split(/[\s,，]+/).filter(Boolean).map(Number);
      const target=this.deck?this.deck.effective:this.draft.settings;(target as any)[key]=key==='fsrsWeights'?values:values.map(value=>value+'m');
    }
    const select=this.content.querySelector<HTMLSelectElement>('#node-priority');if(select)this.priority=select.value;
  }
}
