import { getLocale, t } from '../core/i18n';
import { localizeMarkup } from './localize-markup';
import type {CatalogPage,CatalogQuery,CatalogRow,CatalogStatus,FolderInfo,Material,NodeKind,SaveInput,SyncConflictItem} from '../core/model';
import {icon} from './icons';
import {showSyncConflicts,type ConflictGroup} from './sync-conflicts';

interface BrowserActions {
  run:(task:()=>Promise<void>)=>Promise<void>;
  beforeOpen:()=>Promise<void>;
  beforeQuery:()=>Promise<void>;
  select:(id:string|null)=>Promise<void>;
  /** 双击一行 → 在新窗口里编辑这张卡 */
  openWindow:(id:string)=>void;
  setEnabled:(ids:string[],enabled:boolean)=>Promise<void>;
  move:(ids:string[])=>Promise<void>;
  /** Ctrl 多选后批量删除（有冲突的卡片走冲突处理里的删除版本）。 */
  remove:(ids:string[])=>Promise<void>;
  saveEdit:(input:SaveInput)=>Promise<{revision:number}>;
  /** 浏览表格里右键一行。传整行信息，垃圾桶里的卡片（冲突筛选能看到）也要有菜单。 */
  context:(row:{id:string;kind:NodeKind;deletedAt:string|null},event:MouseEvent)=>void;
  info:(id:string)=>void;
  contentChanged:(id:string)=>Promise<void>;
  closed:()=>Promise<void>;
  visibility:(visible:boolean)=>void;
  /** 右上角按钮文案。独立浏览窗口里「回到编辑」没有意义，改成关窗。 */
  closeLabel?:string;
}
// SM 术语。topic=主题，material=提取（extract），cloze=检测卡；
// 推送=待办队列（outstanding queue），停止推送=搁置（dismiss）。
const states={new:t('新卡'),learning:t('学习中'),review:t('复习'),hold:t('留存判定'),buried:t('已搁置'),suspended:t('待办暂停'),empty:t('未完成'),push:t('待办中'),leech:t('难记')};
const kinds={folder:t('文件夹'),topic:t('主题'),material:t('提取'),cloze:t('检测卡')};
// 1.6 ①②：表头列定义。sort 键必须与 storage/catalog.ts 的排序白名单一致；
// key 同时用作列宽持久化与列顺序的键。
// 列可配置——右键表头勾选显示哪些列，拖动表头换顺序；顺序/隐藏状态存 settings['browserColumns']。
type ColumnKey='title'|'kind'|'folder'|'state'|'due'|'reps'|'createdAt'|'updatedAt';
// 照 Anki 的 `_set_column_sizes()`——每一列都是固定像素宽（可拖），**只有最后一列 Stretch**。
// 所以编辑区左移时前面的列宽度完全不变，只有最后一列在缩；缩到最小后表格溢出、被编辑区盖住。
const columnDefs:ReadonlyArray<{key:ColumnKey;label:string;sort?:CatalogQuery['sort'];asc?:boolean;width:number}>=[
  {key:'title',label:t('标题'),sort:'title',asc:true,width:260},
  {key:'kind',label:t('类型'),sort:'kind',width:70},
  {key:'folder',label:t('文件夹'),sort:'folder',asc:true,width:130},
  {key:'state',label:t('状态'),sort:'state',width:92},
  {key:'due',label:t('到期'),sort:'due',width:150},
  {key:'reps',label:t('次数'),sort:'reps',width:60},
  {key:'createdAt',label:t('添加日期'),sort:'created',width:102},
  {key:'updatedAt',label:t('修改日期'),sort:'updated',width:102},
];
const columnByKey=new Map(columnDefs.map(column=>[column.key,column]));
// 多选筛选的开关——再点一次就取消。
function toggleSet<T>(set:Set<T>,value:T){if(set.has(value))set.delete(value);else set.add(value);}
// 虚拟滚动的总高度上限。超过就按比例压缩，保证滚动条滑块不会短到按不住。
export class CardBrowser {
  visible=false;
  private items:CatalogRow[]=[];
  private activeId:string|null=null;
  private selectedIds=new Set<string>();
  private selectionAnchor:string|null=null;
  private total=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private autosaveTimer:ReturnType<typeof setTimeout>|undefined;
  private titleTimer:ReturnType<typeof setTimeout>|undefined;
  // 表格按可视区虚拟滚动（只渲染屏幕内的行），上万张也不卡
  private rowHeight=30;
  private syncScrollbar:()=>void=()=>{};
  private order:CatalogQuery['sort']='created';
  private direction:CatalogQuery['direction']='desc';
  private sequence=0;
  // 搜索不再一次把一万行全搬回来——先取一屏多一点，滚到底再续。
  private static readonly loadChunk=400;
  private loadingMore=false;
  private ratio=42;
  // 右侧编辑区当前编辑的卡片
  private editorId:string|null=null;
  private editorRevision=0;
  private editorSaved={content:'',answer:''};
  private folderId:string|null=null;
  // 卡片类型 / 学习状态改成多选——空集合 = 不筛选；点一下选中，再点一下取消。
  private kinds=new Set<NodeKind>();
  private statuses=new Set<CatalogStatus>();
  private folders:FolderInfo[]=[];
  private expandedDecks=new Set<string>();
  private groupOpen:Record<string,boolean>={folder:true,kind:false,status:false};
  private activeFolder:string|null=null;
  private conflicts=new Map<string,SyncConflictItem[]>();
  // 侧边栏牌组后面显示今日到期数（仿 Anki 的牌组计数）
  private folderCounts:Record<string,{new:number;learning:number;review:number}>={};
  // 列的显示/顺序（存在 settings['browserColumns']）
  private columnOrder:ColumnKey[]=columnDefs.map(column=>column.key);
  private columnWeights:Partial<Record<ColumnKey,number>>={};
  private hiddenColumns=new Set<ColumnKey>();
  private dragColumn:ColumnKey|null=null;
  constructor(private host:HTMLElement,private rule:HTMLElement,private filters:HTMLElement,private actions:BrowserActions){
    // 1.6 ①②：工具栏不再放排序下拉框，排序改由表头点击完成（用户 01:25 的要求）。
    host.innerHTML=`<div class="browser-heading"><h2 data-i18n>浏览卡片</h2><span id="browser-total"></span></div>
      <div class="browser-toolbar"><input data-i18n-attrs="aria-label placeholder" id="browser-query" type="search" aria-label="搜索卡片" placeholder="搜索标题、正文或答案…（回车搜索）" autocomplete="off"></div>
      <div class="browser-body"><div id="browser-table-pane"><table id="browser-table-head" aria-hidden="true"><colgroup id="browser-head-cols"></colgroup><thead><tr id="browser-head"></tr></thead></table><div id="browser-table-scroll"><div id="browser-table-canvas"><table data-i18n-attrs="aria-label" id="browser-table" aria-label="卡片列表"><colgroup id="browser-body-cols"></colgroup><tbody id="browser-rows"></tbody></table></div></div><div id="browser-scrollbar" aria-hidden="true"><div id="browser-scrollbar-thumb"></div></div></div><div data-i18n-attrs="aria-label" id="browser-editor-rule" role="separator" aria-label="调整编辑区宽度" aria-orientation="vertical" tabindex="0"></div><aside data-i18n-attrs="aria-label" id="browser-editor" aria-label="卡片编辑区" hidden>
        <div data-i18n-attrs="aria-label" class="browser-editor-toolbar" role="toolbar" aria-label="文本格式">
          <button data-i18n-attrs="title" type="button" data-wrap="**" title="加粗（Ctrl+B）">B</button>
          <button data-i18n-attrs="title" type="button" data-wrap="*" title="斜体（Ctrl+I）">I</button>
          <button data-i18n-attrs="title" type="button" data-wrap="~~" title="删除线">S</button>
          <button data-i18n-attrs="title" type="button" data-wrap="&#96;" title="行内代码">&lt;/&gt;</button>
          <button data-i18n-attrs="title" type="button" data-wrap="==" title="高亮">■</button>
          <button data-i18n-attrs="title" type="button" data-wrap="$" title="公式">∑</button>
          <button data-i18n-attrs="title" type="button" data-prefix="> " title="引用">❝</button>
          <button data-i18n-attrs="title" type="button" data-prefix="- " title="无序列表">•</button>
          <button data-i18n-attrs="title" type="button" data-prefix="1. " title="有序列表">1.</button>
          <button data-i18n-attrs="title" type="button" data-link="1" title="链接">🔗</button>
        </div>
        <div class="browser-editor-head"><input data-i18n-attrs="aria-label placeholder" id="browser-editor-title" aria-label="卡片标题" placeholder="卡片标题"></div>

        <details class="browser-editor-section" id="browser-editor-front" open><summary data-i18n>正面</summary>
          <textarea id="browser-editor-content" rows="10" spellcheck="false"></textarea></details>
        <details class="browser-editor-section" id="browser-editor-back" open><summary data-i18n>背面</summary>
          <textarea id="browser-editor-answer" rows="6" spellcheck="false"></textarea></details>
        <div class="browser-editor-hint" id="browser-editor-hint"></div>
      </aside></div>
      <div class="browser-footer"><button data-i18n id="browser-refresh">刷新</button><button data-i18n id="browser-enabled" disabled>暂停</button><button data-i18n id="browser-resume" hidden>加入 / 恢复</button><button data-i18n id="browser-move" disabled>移至…</button><button data-i18n id="browser-delete" class="danger" disabled>删除</button><button data-i18n id="browser-info" disabled>卡片信息</button><span class="browser-hint" id="browser-selection" aria-live="polite"></span></div>`;
    localizeMarkup(host);
    // 打开浏览页时把焦点给搜索框，直接就能打字搜索
    queueMicrotask(()=>{(this.element('browser-query') as HTMLInputElement).focus();});
    // 搜索改成回车才查——边打边查会在拼音还拼着的时候就搜一轮，结果乱跳。
    // 现在输入只清旧结果标记，按回车（或点刷新）才真正查询；清空（含输入框自带的 ×）立即查一次。
    const query=(this.element('browser-query') as HTMLInputElement);
    query.addEventListener('input',event=>{
      if((event as InputEvent).isComposing)return;
      clearTimeout(this.timer);
      if(query.value)return;
      this.sequence++;
      void this.refresh();
    });
    query.addEventListener('keydown',event=>{
      // 拼音候选窗里的回车只是选词，不能当成搜索。
      if(event.key!=='Enter'||event.isComposing||event.keyCode===229)return;
      event.preventDefault();
      clearTimeout(this.timer);this.sequence++;
      void this.refresh();
    });
    // —— 表头点击排序；右缘拖拽调列宽；表头可拖动换顺序、右键勾选显示哪些列。
    this.renderHead();
    this.bindRowEvents();
    // 自绘滚动条——原生滑块在几千行时会被压成几像素，抓不住；
    // 这里固定滑块最小 64px，拖动用 pointer 自己算 scrollTop，原生滚动条隐藏。
    const tableScroll=this.element('browser-table-scroll');
    const bar=this.element('browser-scrollbar'),thumb=this.element('browser-scrollbar-thumb');
    const minThumb=64;
    const syncBar=()=>{
      const track=bar.clientHeight;
      const content=tableScroll.scrollHeight,view=tableScroll.clientHeight;
      if(content<=view+1){bar.hidden=true;return;}
      bar.hidden=false;
      const size=Math.min(track,Math.max(minThumb,Math.round(track*view/content)));
      const maxScroll=content-view;
      const top=Math.round((tableScroll.scrollTop/maxScroll)*(track-size));
      thumb.style.height=size+'px';thumb.style.transform=`translateY(${top}px)`;
    };
    // 滚动时只换可视区的几十行
    let rowFrame=0;
    tableScroll.addEventListener('scroll',()=>{
      syncBar();
      if(!this.visible||rowFrame)return;
      rowFrame=requestAnimationFrame(()=>{rowFrame=0;this.renderRows();});
    },{passive:true});
    // 窗口/分区尺寸变化后要重算可视行数，否则最大化后下面会空一大片
    let resizeFrame=0;
    new ResizeObserver(()=>{
      if(resizeFrame)return;
      resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;this.renderRows();});
    }).observe(tableScroll);
    window.addEventListener('resize',()=>{
      if(resizeFrame)return;
      resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;this.fitColumns();this.renderRows();});
    });
    thumb.onpointerdown=event=>{
      if(event.button!==0)return;event.preventDefault();event.stopPropagation();
      thumb.setPointerCapture(event.pointerId);
      const startY=event.clientY,startScroll=tableScroll.scrollTop,size=thumb.clientHeight;
      const maxScroll=tableScroll.scrollHeight-tableScroll.clientHeight;
      const travel=bar.clientHeight-size;
      const move=(pointer:PointerEvent)=>{
        if(travel<=0)return;
        tableScroll.scrollTop=Math.max(0,Math.min(maxScroll,startScroll+((pointer.clientY-startY)/travel)*maxScroll));
      };
      thumb.onpointermove=move;
      const finish=()=>{thumb.onpointermove=null;thumb.onpointerup=null;thumb.onpointercancel=null;};
      thumb.onpointerup=finish;thumb.onpointercancel=finish;
    };
    bar.onpointerdown=event=>{
      if(event.target===thumb)return;event.preventDefault();
      const size=thumb.clientHeight,maxScroll=tableScroll.scrollHeight-tableScroll.clientHeight,travel=bar.clientHeight-size;
      if(travel<=0)return;
      const ratio=(event.clientY-bar.getBoundingClientRect().top-size/2)/travel;
      tableScroll.scrollTop=Math.max(0,Math.min(maxScroll,ratio*maxScroll));
    };
    this.syncScrollbar=syncBar;
    this.updateSortMarkers();
    this.element('browser-refresh').onclick=()=>void this.refresh();
    this.element('browser-enabled').onclick=()=>{
      const nodes=this.selectedCards();
      if(nodes.length)void this.changeEnabled(nodes,nodes.length===1&&!this.enabled(nodes[0]!));
    };
    this.element('browser-resume').onclick=()=>void this.changeEnabled(this.selectedCards(),true);
    this.element('browser-move').onclick=()=>void this.actions.run(async()=>{
      const ids=this.selectedCards().map(node=>node.id);
      if(ids.length){await this.flushEdit();await this.actions.move(ids);}
    });
    this.element('browser-info').onclick=()=>{if(this.activeId)this.actions.info(this.activeId);};
    this.element('browser-delete').onclick=()=>void this.actions.run(async()=>{
      const ids=this.selectedCards().filter(node=>!node.deletedAt).map(node=>node.id);
      if(ids.length){await this.flushEdit();await this.actions.remove(ids);}
    });
    // 编辑区工具条（Markdown 语法），作用在最后获得焦点的正文/答案框上
    let lastField:HTMLTextAreaElement|null=null;
    for(const field of [this.element('browser-editor-content'),this.element('browser-editor-answer')]){
      field.addEventListener('focusin',()=>{lastField=field as HTMLTextAreaElement;});
    }
    const insert=(transform:(text:string,start:number,end:number)=>{text:string;start:number;end:number},forceField?:HTMLTextAreaElement)=>{
      const field=forceField||lastField||this.element('browser-editor-content') as HTMLTextAreaElement;
      const start=field.selectionStart??field.value.length,end=field.selectionEnd??start;
      const next=transform(field.value,start,end);
      field.value=next.text;
      field.selectionStart=next.start;field.selectionEnd=next.end;
      field.focus();
      field.dispatchEvent(new Event('input',{bubbles:true}));
    };
    for(const button of this.host.querySelectorAll<HTMLButtonElement>('.browser-editor-toolbar button')){
      button.onclick=()=>{
        const wrap=button.dataset.wrap,prefix=button.dataset.prefix;
        if(wrap)insert((text,start,end)=>{
          const selected=text.slice(start,end)||t('文字');
          return {text:text.slice(0,start)+wrap+selected+wrap+text.slice(end),start:start+wrap.length,end:start+wrap.length+selected.length};
        });
        else if(prefix)insert((text,start,end)=>{
          const lineStart=text.lastIndexOf('\n',Math.max(0,start-1))+1;
          return {text:text.slice(0,lineStart)+prefix+text.slice(lineStart),start:start+prefix.length,end:end+prefix.length};
        });
        else if(button.dataset.link)insert((text,start,end)=>{
          const selected=text.slice(start,end)||t('链接文字');
          const inserted='['+selected+']()';
          return {text:text.slice(0,start)+inserted+text.slice(end),start:start+inserted.length-1,end:start+inserted.length-1};
        });
        button.blur();
      };
    }
    rule.setAttribute('aria-valuemin','22');rule.setAttribute('aria-valuemax','65');
    rule.onpointerdown=event=>{
      if(event.button!==0)return;event.preventDefault();rule.setPointerCapture(event.pointerId);
      const parent=host.parentElement!,bounds=parent.getBoundingClientRect(),top=host.getBoundingClientRect().top;
      rule.onpointermove=move=>{this.ratio=Math.max(22,Math.min(65,(move.clientY-top)/(bounds.bottom-top)*100));this.applyRatio();};
      const finish=()=>{rule.onpointermove=null;rule.onpointerup=null;rule.onpointercancel=null;void window.reading.request('settingSet',{key:'browserSplit',value:this.ratio});};
      rule.onpointerup=finish;rule.onpointercancel=finish;
    };
    rule.onkeydown=event=>{
      if(!['ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();
      this.ratio=event.key==='Home'?42:Math.max(22,Math.min(65,this.ratio+(event.key==='ArrowUp'?-5:5)));this.applyRatio();
      void window.reading.request('settingSet',{key:'browserSplit',value:this.ratio});
    };
    // 表格和右侧编辑区之间加一条可拖动的分隔线（和 Anki 浏览器一样能调编辑区宽度）
    const editorRule=this.element('browser-editor-rule');
    editorRule.onpointerdown=event=>{
      if(event.button!==0)return;event.preventDefault();editorRule.setPointerCapture(event.pointerId);document.body.classList.add('browser-dragging');
      const body=this.host.querySelector('.browser-body')!.getBoundingClientRect();
      document.body.classList.add('browser-resizing');
      const apply=(width:number)=>{
        const clamped=Math.max(240,Math.min(body.width*0.72,width));
        this.host.style.setProperty('--browser-editor-width',Math.round(clamped)+'px');
      };
      const move=(pointer:PointerEvent)=>apply(body.right-pointer.clientX);
      editorRule.onpointermove=move;
      const finish=()=>{
        editorRule.onpointermove=null;editorRule.onpointerup=null;editorRule.onpointercancel=null;document.body.classList.remove('browser-dragging');
        document.body.classList.remove('browser-resizing');
        const width=parseFloat(getComputedStyle(this.element('browser-editor')).width)||360;
        void window.reading.request('settingSet',{key:'browserEditorWidth',value:Math.round(width)});
      };
      editorRule.onpointerup=finish;editorRule.onpointercancel=finish;
    };
  }
  private editorText(){
    return {
      content:(this.element('browser-editor-content') as HTMLTextAreaElement).value,
      answer:(this.element('browser-editor-answer') as HTMLTextAreaElement).value,
    };
  }
  private editorDirty():boolean{
    if(!this.editorId)return false;
    const {content,answer}=this.editorText();
    return content!==this.editorSaved.content||answer!==this.editorSaved.answer;
  }
  private async saveEditor():Promise<void>{
    const id=this.editorId;
    if(!id)return;
    const text=this.editorText();
    const result=await this.actions.saveEdit({id,...text,revision:this.editorRevision});
    if(this.editorId===id){
      this.editorRevision=result.revision;this.editorSaved=text;
      this.element('browser-editor-hint').textContent=t('已保存 {0}',new Date().toLocaleTimeString(getLocale()));
    }
  }
  async flushEdit():Promise<void>{
    while(this.editorDirty())await this.saveEditor();
  }
  private releaseEditor():void{
    this.element('browser-editor').hidden=true;this.editorId=null;
    window.reading.setEditorCard('browser',null);
  }
  private element(id:string){return this.host.querySelector<HTMLElement>('#'+id)!;}
  private enabled(node:CatalogRow){return node.kind==='cloze'?node.reviewEnabled:node.pushEnabled;}
  private selectedCards(){
    return this.items.filter(row=>this.selectedIds.has(row.id)&&!row.deletedAt&&row.kind!=='folder');
  }
  private changeEnabled(nodes:CatalogRow[],enabled:boolean){return this.actions.run(async()=>{
    await this.flushEdit();
    await this.actions.setEnabled(nodes.filter(node=>this.enabled(node)!==enabled).map(node=>node.id),enabled);
    await this.reload();
  });}
  private selectRow(id:string,event?:MouseEvent|KeyboardEvent){
    const extend=event?.shiftKey,toggle=event?.ctrlKey||event?.metaKey;
    const anchor=this.items.findIndex(item=>item.id===this.selectionAnchor);
    const next=this.items.findIndex(item=>item.id===id);
    if(extend&&anchor!==-1&&next!==-1){
      if(!toggle)this.selectedIds.clear();
      for(const row of this.items.slice(Math.min(anchor,next),Math.max(anchor,next)+1))this.selectedIds.add(row.id);
    }else{
      this.selectionAnchor=id;
      if(toggle&&this.selectedIds.has(id))this.selectedIds.delete(id);
      else{
        if(!toggle)this.selectedIds.clear();
        this.selectedIds.add(id);
      }
    }
    this.activeId=this.selectedIds.has(id)?id:[...this.selectedIds].at(-1)??null;
    this.highlight();
  }
  // 刷新表头排序指示（▲/▼ + aria-sort）。每次排序状态变化后调用。
  private updateSortMarkers(){
    for(const th of this.host.querySelectorAll<HTMLElement>('#browser-table th[data-sort]')){
      const active=th.dataset.sort===this.order;
      th.setAttribute('aria-sort',active?(this.direction==='asc'?'ascending':'descending'):'none');
      th.querySelector('.sort-arrow')!.textContent=active?(this.direction==='asc'?'▲':'▼'):'';
    }
  }
  // ===== 列配置（右键表头勾选显示哪些列、拖动表头换顺序，顺序与隐藏状态落入设置）=====
  private visibleColumns():ColumnKey[]{return this.columnOrder.filter(key=>!this.hiddenColumns.has(key));}
  private persistColumns(){void window.reading.request('settingSet',{key:'browserColumns',value:{order:this.columnOrder,hidden:[...this.hiddenColumns]}});}
  private renderHead(){
    const head=this.element('browser-head');head.replaceChildren();
    const visible=this.visibleColumns();
    const lastKey=visible.at(-1);
    for(const key of visible){
      const def=columnByKey.get(key)!;
      const th=document.createElement('th');th.dataset.key=key;if(def.sort)th.dataset.sort=def.sort;th.draggable=true;
      // 固定像素宽；最后一列交给表格吃掉剩余空间（Anki 的 Stretch）
      if(key===lastKey)th.style.width='auto';
      else th.style.width=(this.columnWeights[key]??def.width)+'px';
      const button=document.createElement('button');button.type='button';button.className='browser-th-sort';
      button.setAttribute('aria-label',t('按{0}排序',def.label));button.append(document.createTextNode(def.label));
      const arrow=document.createElement('span');arrow.className='sort-arrow';arrow.setAttribute('aria-hidden','true');button.append(arrow);
      const handle=document.createElement('span');handle.className='browser-th-resize';handle.setAttribute('aria-hidden','true');
      th.append(button,handle);
      if(def.sort){
        button.onclick=()=>{
          if(this.order===def.sort)this.direction=this.direction==='asc'?'desc':'asc';
          else{this.order=def.sort!;this.direction=def.asc?'asc':'desc';}
          this.updateSortMarkers();void this.refresh();
        };
      }else button.disabled=true;
      handle.onpointerdown=event=>{
        if(event.button!==0)return;event.preventDefault();event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        const startX=event.clientX,startWidth=th.getBoundingClientRect().width;
        document.body.classList.add('browser-resizing');
        // 列宽由 colgroup 控制（表格是 table-layout:fixed），拖拽要改 col 而不是 th
        handle.onpointermove=move=>this.setColumnWidth(key,Math.max(42,startWidth+move.clientX-startX));
        const finish=()=>{
          handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;document.body.classList.remove('browser-resizing');
          const widths:Partial<Record<ColumnKey,number>>={};
          for(const cell of this.host.querySelectorAll<HTMLElement>('#browser-table-head th[data-key]'))
            widths[cell.dataset.key as ColumnKey]=Math.round(cell.getBoundingClientRect().width);
          this.columnWeights=widths;
          void window.reading.request('settingSet',{key:'browserColumnWidths',value:widths});
          this.renderHead();this.updateSortMarkers();
        };
        handle.onpointerup=finish;handle.onpointercancel=finish;
      };
      th.ondragstart=event=>{this.dragColumn=key;th.classList.add('is-dragging');event.dataTransfer?.setData('text/plain',key);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';};
      th.ondragend=()=>{this.dragColumn=null;th.classList.remove('is-dragging');for(const cell of this.host.querySelectorAll('.browser-th-drop'))cell.classList.remove('browser-th-drop');};
      th.ondragover=event=>{
        if(!this.dragColumn||this.dragColumn===key)return;event.preventDefault();
        if(event.dataTransfer)event.dataTransfer.dropEffect='move';
        for(const cell of this.host.querySelectorAll('.browser-th-drop'))cell.classList.remove('browser-th-drop');
        th.classList.add('browser-th-drop');
      };
      th.ondragleave=()=>th.classList.remove('browser-th-drop');
      th.ondrop=event=>{
        event.preventDefault();const from=this.dragColumn;th.classList.remove('browser-th-drop');
        if(!from||from===key)return;
        const order=this.columnOrder.filter(item=>item!==from),bounds=th.getBoundingClientRect();
        const index=order.indexOf(key)+(event.clientX>bounds.left+bounds.width/2?1:0);
        order.splice(index,0,from);
        this.columnOrder=order;this.renderHead();this.persistColumns();this.render();
      };
      th.oncontextmenu=event=>{event.preventDefault();this.showColumnMenu(event);};
      head.append(th);
    }
    this.syncColgroups(visible,lastKey);
    this.fitColumns();
  }
  /** 表头表与表体表共用同一套列宽（colgroup），保证虚拟表格两边的列对齐。 */
  /** 按列 key 设置像素宽（同时改表头表与表体表的 col），拖拽列宽用。 */
  /** 窗口变窄时按比例压缩各列像素宽（只保留最后一列最小 90px），窗口变宽则回到保存的像素宽。
   *  只在窗口 resize 时调用——拖编辑区分隔线不改列宽（保持 Anki 那种固定列宽的手感）。 */
  private fitColumns(){
    const pane=this.element('browser-table-pane').clientWidth||0;
    if(!pane)return;
    const visible=this.visibleColumns(),lastKey=visible.at(-1);
    const fixed=visible.filter(key=>key!==lastKey);
    const widths=fixed.map(key=>this.columnWeights[key]??columnByKey.get(key)!.width);
    const sum=widths.reduce((total,width)=>total+width,0);
    if(!sum)return;
    const available=pane-90;
    const factor=sum>available?Math.max(.4,available/sum):1;
    fixed.forEach((key,index)=>this.setColumnWidth(key,widths[index]!*factor));
  }
  private setColumnWidth(key:ColumnKey,width:number){
    const index=this.visibleColumns().indexOf(key);
    if(index<0)return;
    const value=Math.round(Math.max(42,width))+'px';
    for(const id of ['browser-head-cols','browser-body-cols']){
      const col=this.element(id).children[index] as HTMLElement|undefined;
      if(col)col.style.width=value;
    }
  }
  private syncColgroups(visible:ColumnKey[],lastKey?:ColumnKey){
    for(const id of ['browser-head-cols','browser-body-cols']){
      const group=this.element(id);group.replaceChildren();
      for(const key of visible){
        const col=document.createElement('col');
        col.style.width=key===lastKey?'auto':((this.columnWeights[key]??columnByKey.get(key)!.width)+'px');
        group.append(col);
      }
    }
  }
  private showColumnMenu(event:MouseEvent){
    this.element('browser-column-menu')?.remove();
    const menu=document.createElement('div');menu.id='browser-column-menu';menu.className='browser-column-menu';menu.setAttribute('role','menu');
    const title=document.createElement('p');title.textContent=t('显示的列');menu.append(title);
    for(const def of columnDefs){
      const row=document.createElement('label');row.className='browser-column-row';
      const input=document.createElement('input');input.type='checkbox';input.checked=!this.hiddenColumns.has(def.key);
      input.onchange=()=>{
        if(input.checked)this.hiddenColumns.delete(def.key);
        else{
          if(this.visibleColumns().length<=1){input.checked=true;return;}
          this.hiddenColumns.add(def.key);
        }
        this.renderHead();this.render();this.updateSortMarkers();this.persistColumns();
      };
      const text=document.createElement('span');text.textContent=def.label;row.append(input,text);menu.append(row);
    }
    const reset=document.createElement('button');reset.type='button';reset.className='browser-column-reset';reset.textContent=t('恢复默认列');
    reset.onclick=()=>{this.columnOrder=columnDefs.map(column=>column.key);this.hiddenColumns.clear();this.renderHead();this.render();this.updateSortMarkers();this.persistColumns();menu.remove();};
    menu.append(reset);
    this.host.append(menu);
    const bounds=this.host.getBoundingClientRect();
    menu.style.left=Math.max(4,Math.min(event.clientX-bounds.left,bounds.width-230))+'px';
    menu.style.top=Math.max(4,event.clientY-bounds.top)+'px';
    const onDown=(down:PointerEvent)=>{if(down.target instanceof Node&&menu.contains(down.target))return;menu.remove();document.removeEventListener('pointerdown',onDown,true);};
    setTimeout(()=>document.addEventListener('pointerdown',onDown,true),0);
  }
  /** 在右侧编辑区显示并允许编辑这张卡（Anki 浏览器的做法） */
  private async showEditor(id:string,refresh=false):Promise<void>{
    if(this.editorId===id&&!refresh)return;
    const panel=this.element('browser-editor');
    panel.inert=true;
    try{
      if(this.editorId!==id)await this.flushEdit();
      const node=await window.reading.readEditorCard('browser',id);
      if(!node){if(this.editorId===id)this.releaseEditor();return;}
      this.editorId=id;this.editorRevision=node.revision;
      this.editorSaved={content:node.content,answer:node.answer};
      this.element('browser-editor').hidden=false;
      (this.element('browser-editor-title') as HTMLInputElement).value=node.title;
      (this.element('browser-editor-content') as HTMLTextAreaElement).value=node.content;
      (this.element('browser-editor-answer') as HTMLTextAreaElement).value=node.answer;
      // 搜索命中后，在下方编辑区选中并滚到第一处命中（标题命中就不选）。
      this.revealMatch((this.element('browser-query') as HTMLInputElement).value,node.content,node.answer);
      // 像 Anki 一样按「正面/背面」两个可折叠区显示；非检测卡只显示正面
      this.element('browser-editor-back').hidden=node.kind!=='cloze';
      this.element('browser-editor-hint').textContent=t('改动自动保存（标题也可以直接改）；双击行可用新窗口编辑');
      this.bindTitleEditing(id);
      // Anki 式即时编辑——正文/答案改完自动保存，不用点「保存」
      const autosave=(input:HTMLTextAreaElement)=>{
        input.oninput=()=>{
          clearTimeout(this.autosaveTimer);
          this.autosaveTimer=setTimeout(()=>void this.actions.run(async()=>{
            if(!this.editorDirty())return;
            await this.flushEdit();
          }),500);
        };
      };
      autosave(this.element('browser-editor-content') as HTMLTextAreaElement);
      autosave(this.element('browser-editor-answer') as HTMLTextAreaElement);
    }finally{
      panel.inert=false;
      window.reading.setEditorCard('browser',this.editorId);
    }
  }
  private revealMatch(query:string,content:string,answer:string){
    const needle=query.trim();if(!needle)return;
    const fields=[[this.element('browser-editor-content') as HTMLTextAreaElement,content],
      [this.element('browser-editor-answer') as HTMLTextAreaElement,answer]] as const;
    for(const [field,text] of fields){
      if(field.offsetParent===null)continue;
      const at=text.toLowerCase().indexOf(needle.toLowerCase());
      if(at<0)continue;
      field.focus();field.setSelectionRange(at,at+needle.length);
      const before=text.slice(0,at),lineHeight=parseFloat(getComputedStyle(field).lineHeight)||18;
      field.scrollTop=Math.max(0,before.split('\n').length*lineHeight-field.clientHeight/2);
      return;
    }
  }
  /** 编辑区顶部的标题可直接改，停手 500ms 自动保存，并同步表格行与目录树。 */
  private bindTitleEditing(id:string){
    const input=this.element('browser-editor-title') as HTMLInputElement;
    clearTimeout(this.titleTimer);
    input.oninput=()=>{
      clearTimeout(this.titleTimer);
      this.titleTimer=setTimeout(()=>void this.actions.run(async()=>{
        const value=input.value.trim();
        if(!value||value===this.items.find(item=>item.id===id)?.title)return;
        await window.reading.request('rename',{id,title:value});
        const row=this.items.find(item=>item.id===id);
        if(row)row.title=value;
        this.renderRows();
        await this.actions.contentChanged(id);
      }),500);
    };
  }
  hasUnsavedEdit(id:string,content:string,answer:string):boolean{
    return this.visible&&this.editorId===id&&(
      (this.element('browser-editor-content') as HTMLTextAreaElement).value!==content||
      (this.element('browser-editor-answer') as HTMLTextAreaElement).value!==answer);
  }
  async reloadEdit(id:string){
    if(this.visible&&this.editorId===id)await this.showEditor(id,true);
  }
  private applyRatio(){this.host.style.flexBasis=this.ratio+'%';this.rule.setAttribute('aria-valuenow',String(Math.round(this.ratio)));}
  private renderFilters(folders:FolderInfo[]){
    this.filters.replaceChildren();
    const persist=()=>void window.reading.request('settingSet',{key:'browserFilterLayout',value:{groups:this.groupOpen,decks:[...this.expandedDecks]}});
    const section=(text:string,key:string)=>{
      const details=document.createElement('details');details.className='browser-filter-section';details.dataset.section=key;details.open=!!this.groupOpen[key];
      const heading=document.createElement('summary');heading.textContent=text;const content=document.createElement('div');details.append(heading,content);this.filters.append(details);
      details.ontoggle=event=>{if(event.target!==details)return;this.groupOpen[key]=details.open;persist();};return content;
    };
    const choice=(host:HTMLElement,label:string,group:'folder'|'kind'|'status',value:string)=>{
      const button=document.createElement('button');button.dataset.group=group;button.dataset.value=value;
      if(group==='folder')button.innerHTML=icon('folder');
      // 学习状态前加彩色圆点（仿 Anki），一眼区分状态
      if(group==='status'&&value){const dot=document.createElement('i');dot.className='state-dot state-'+value;dot.setAttribute('aria-hidden','true');button.append(dot);}
      const text=document.createElement('span');text.textContent=label;button.append(text);button.title=label;
      button.onclick=event=>{event.preventDefault();event.stopPropagation();
        // 默认不选 = 不筛选；点一次选中（可多选），再点一次取消。牌组仍是单选，「全部牌组」= 不筛牌组。
        if(group==='folder')this.folderId=value||null;
        else if(group==='kind')toggleSet(this.kinds,value as NodeKind);
        else toggleSet(this.statuses,value as CatalogStatus);
        this.highlightFilters();void this.refresh();};
      // 牌组后面跟今日到期数（新卡+学习中+复习），仿 Anki 的牌组计数
      if(group==='folder'&&value){
        const counts=this.folderCounts[value],due=(counts?.new||0)+(counts?.learning||0)+(counts?.review||0);
        const badge=document.createElement('span');badge.className='browser-filter-count';badge.textContent=due?String(due):'';
        button.append(badge);
      }
      host.append(button);return button;
    };
    const deckHost=section(t('牌组'),'folder');choice(deckHost,t('全部牌组'),'folder','');
    const children=new Map<string|null,FolderInfo[]>();for(const folder of folders){const list=children.get(folder.parentId)||[];list.push(folder);children.set(folder.parentId,list);}
    const stack=(children.get(null)||[]).slice().reverse().map(node=>({node,host:deckHost}));
    while(stack.length){const {node,host}=stack.pop()!,sub=children.get(node.id)||[];
      if(sub.length){const details=document.createElement('details');details.className='browser-deck';details.dataset.deck=node.id;details.open=this.expandedDecks.has(node.id);
        const summary=document.createElement('summary'),content=document.createElement('div');content.className='browser-deck-children';choice(summary,node.title,'folder',node.id);details.append(summary,content);host.append(details);
        details.ontoggle=event=>{if(event.target!==details)return;if(details.open)this.expandedDecks.add(node.id);else this.expandedDecks.delete(node.id);persist();};
        for(const child of sub.slice().reverse())stack.push({node:child,host:content});
      }else choice(host,node.title,'folder',node.id);
    }
    const kindHost=section(t('卡片类型'),'kind');for(const [value,label] of [['topic',t('主题')],['material',t('提取')],['cloze',t('检测卡')]])choice(kindHost,label,'kind',value);
    const statusHost=section(t('学习状态'),'status');for(const [value,label] of [['new',t('新卡')],['learning',t('学习中')],['due',t('已到期')],['review',t('复习')],['hold',t('留存判定')],['buried',t('已搁置')],['suspended',t('待办暂停')],['push',t('待办中')],['leech',t('难记（leech）')],['empty',t('未完成')],['conflict',t('冲突文件')]])choice(statusHost,label,'status',value);
    this.highlightFilters();
  }
  private highlightFilters(){for(const button of this.filters.querySelectorAll<HTMLButtonElement>('button')){
    const group=button.dataset.group,value=button.dataset.value??'';
    // 牌组空值（「全部牌组」）在没有牌组筛选时高亮；类型/状态按是否选中高亮，可同时多个。
    const active=group==='folder'?(this.folderId===null?value==='':this.folderId===value)
      :group==='kind'?this.kinds.has(value as NodeKind):this.statuses.has(value as CatalogStatus);
    button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));
    button.classList.toggle('is-current',group==='folder'&&value===this.activeFolder);
  }}
  open(status?:'conflict',initialId?:string|null){return this.actions.run(async()=>{
    await this.actions.beforeOpen();this.activeFolder=null;this.visible=true;this.host.hidden=false;this.rule.hidden=false;this.filters.hidden=false;this.actions.visibility(true);
    // 读取并行发出，少绕几趟 IPC（打开更快）
    const [folders,layout,ratio,widths,columnsSaved,editorWidth,folderCounts]=await Promise.all([
      window.reading.request<FolderInfo[]>('folders'),
      window.reading.request<any>('settingGet',{key:'browserFilterLayout'}),
      window.reading.request<number>('settingGet',{key:'browserSplit'}),
      window.reading.request<Record<string,number>|null>('settingGet',{key:'browserColumnWidths'}),
      window.reading.request<{order?:string[];hidden?:string[]}|null>('settingGet',{key:'browserColumns'}),
      window.reading.request<number|null>('settingGet',{key:'browserEditorWidth'}),
      window.reading.request<Record<string,{new:number;learning:number;review:number}>>('folderCounts'),
    ]);
    const savedColumns=columnsSaved;
    if(folderCounts)this.folderCounts=folderCounts;
    // 编辑区宽度（拖动表格/编辑区之间的分隔线保存下来的）
    if(typeof editorWidth==='number'&&editorWidth>=240)this.host.style.setProperty('--browser-editor-width',Math.round(editorWidth)+'px');
    this.folders=folders;
    if(layout){this.groupOpen={...this.groupOpen,...layout.groups};this.expandedDecks=new Set(layout.decks||[]);}
    // 恢复列顺序与隐藏状态
    if(savedColumns){
      const known=new Set<string>(columnDefs.map(column=>column.key));
      const order=(savedColumns.order||[]).filter(key=>known.has(key)) as ColumnKey[];
      for(const def of columnDefs)if(!order.includes(def.key))order.push(def.key);
      this.columnOrder=order;
      this.hiddenColumns=new Set((savedColumns.hidden||[]).filter(key=>known.has(key)) as ColumnKey[]);
      if(!this.visibleColumns().length){this.hiddenColumns.clear();this.columnOrder=columnDefs.map(column=>column.key);}
      this.renderHead();this.updateSortMarkers();
    }
    if(status==='conflict'){
      this.statuses=new Set(['conflict']);this.kinds.clear();this.folderId=null;this.groupOpen.status=true;
      (this.element('browser-query') as HTMLInputElement).value='';
    }
    if(!folders.some(folder=>folder.id===this.folderId))this.folderId=null;this.renderFilters(folders);
    if(ratio)this.ratio=Math.max(22,Math.min(65,ratio));this.applyRatio();
    // 恢复上次的列宽权重（按列 key 存）；标题列也参与比例分配，表格不会横向溢出
    if(widths)for(const [key,value] of Object.entries(widths)){
      if(typeof value==='number'&&value>0)this.columnWeights[key as ColumnKey]=value;
    }
    this.renderHead();this.updateSortMarkers();
    // 冲突列表要读冲突文件+查库，比列表本身慢。普通打开时先出列表，冲突标记随后补；
    // 只有「打开冲突文件」这种本来就只看冲突的场景才先等它。
    if(status==='conflict')await this.loadConflicts().catch(()=>{});
    else void this.loadConflicts().then(()=>{if(this.visible)this.render();}).catch(()=>{});
    await this.reload();
    // 打开时默认选中主窗口目录树里那张卡（并滚到它、在右侧显示）
    // 如果这张卡被当前筛选挡住了，先清掉筛选再找，保证一定能选中
    let target=initialId&&this.items.some(item=>item.id===initialId)?initialId:this.activeId;
    if(initialId&&target!==initialId){
      this.statuses.clear();this.kinds.clear();this.folderId=null;
      (this.element('browser-query') as HTMLInputElement).value='';
      this.highlightFilters();
      await this.reload();
      target=this.items.some(item=>item.id===initialId)?initialId:this.activeId;
    }
    if(target){
      this.activeId=target;this.selectedIds=new Set([target]);
      this.scrollToItem(target);this.highlight();
      await this.showEditor(target);
    }
    (this.element('browser-query') as HTMLInputElement).focus();
    // 窗口显示/最大化可能在首帧之后才完成，补一次重算，保证铺满
    setTimeout(()=>{if(this.visible)this.renderRows();},150);
  });}
  close(){return this.actions.run(async()=>{await this.actions.beforeQuery();await this.flushEdit();this.hide();await this.actions.closed();});}
  hide(){
    if(!this.editorDirty())this.releaseEditor();
    this.visible=false;this.sequence++;clearTimeout(this.timer);this.host.hidden=true;this.rule.hidden=true;this.filters.hidden=true;this.actions.visibility(false);
  }
  toggle(){return this.visible?this.close():this.open();}
  refresh(){return this.actions.run(async()=>{await this.loadConflicts().catch(()=>{});await this.reload();});}
  private async loadConflicts(){
    const {items}=await window.reading.syncConflicts();
    const conflicts=new Map<string,SyncConflictItem[]>();
    for(const item of items){
      const list=conflicts.get(item.nodeId);
      if(list)list.push(item);else conflicts.set(item.nodeId,[item]);
    }
    this.conflicts=conflicts;
  }
  filterFolder(id:string){this.folderId=id;this.highlightFilters();void this.refresh();}
  markActive(id:string,folderId?:string|null){
    if(!this.visible||this.selectedIds.size<=1)this.selectRow(id);
    if(!this.visible)return;
    this.scrollToItem(id);
    if(!folderId)return;this.activeFolder=folderId;
    const map=new Map(this.folders.map(folder=>[folder.id,folder]));let cursor=map.get(folderId);
    while(cursor?.parentId){const parent=this.filters.querySelector<HTMLDetailsElement>('details[data-deck="'+CSS.escape(cursor.parentId)+'"]');if(parent)parent.open=true;cursor=map.get(cursor.parentId);}
    const group=this.filters.querySelector<HTMLDetailsElement>('[data-section="folder"]');if(group)group.open=true;
    this.highlightFilters();const button=this.filters.querySelector<HTMLElement>('button[data-group="folder"][data-value="'+CSS.escape(folderId)+'"]');
    if(button){const bounds=button.getBoundingClientRect(),host=this.filters.getBoundingClientRect();if(bounds.top<host.top||bounds.bottom>host.bottom)button.scrollIntoView({block:'nearest'});}
  }
  private highlight(){
    for(const row of this.host.querySelectorAll<HTMLElement>('tbody tr[data-id]')){
      const selected=this.selectedIds.has(row.dataset.id!);row.classList.toggle('is-selected',selected);row.setAttribute('aria-selected',String(selected));
    }
    const node=this.items.find(row=>row.id===this.activeId),button=this.element('browser-enabled') as HTMLButtonElement;
    const cards=this.selectedCards(),multi=cards.length>1;
    const canEnable=(item:CatalogRow)=>item.kind!=='cloze'||item.reviewReady;
    button.disabled=multi?!cards.some(item=>this.enabled(item)):!cards.length||(!this.enabled(cards[0]!)&&!canEnable(cards[0]!));
    button.textContent=multi?t('暂停 / 搁置'):node?.kind==='cloze'?(node.reviewEnabled?t('暂停复习'):t('加入复习')):(node?.pushEnabled?t('搁置'):t('恢复待办'));
    const resume=this.element('browser-resume') as HTMLButtonElement;
    resume.hidden=!multi;
    resume.disabled=!cards.some(item=>!this.enabled(item))||cards.some(item=>!this.enabled(item)&&!canEnable(item));
    (this.element('browser-move') as HTMLButtonElement).disabled=!cards.length;
    // 多选删除；垃圾桶里的卡片不能再软删，所以只按未删除的选中项决定可用性。
    (this.element('browser-delete') as HTMLButtonElement).disabled=!cards.some(card=>!card.deletedAt);
    // 标题栏显示总数与已选数（仿 Anki 的「已选取 N 张卡片，共 M 张」）
    this.element('browser-total').textContent=t('共 {0} 张{1}',this.total,this.selectedIds.size?t(' · 已选 {0} 张',this.selectedIds.size):'');
    (this.element('browser-info') as HTMLButtonElement).disabled=cards.length!==1;
    this.element('browser-selection').textContent=this.selectedIds.size>1?t('已选 {0} 张',this.selectedIds.size):t('Ctrl 多选 · Shift 连选');
  }
  /** 搜索/筛选的查询条件，分页取数时复用。 */
  private queryInput(offset:number,limit:number,countTotal=true):CatalogQuery{
    const input:CatalogQuery={query:(this.element('browser-query') as HTMLInputElement).value,folderId:this.folderId,
      kinds:[...this.kinds],statuses:[...this.statuses],
      sort:this.order,direction:this.direction,offset,limit,countTotal};
    if(this.statuses.has('conflict'))input.conflictIds=[...this.conflicts.keys()];
    return input;
  }
  private async reload(){
    if(!this.visible)return;await this.actions.beforeQuery();
    const sequence=++this.sequence;
    this.loadingMore=false;
    const page=await window.reading.request<CatalogPage>('catalog',this.queryInput(0,CardBrowser.loadChunk));
    if(sequence!==this.sequence||!this.visible)return;
    // 先取前 400 行（打字时不至于每次都搬上万行），滚到已加载的末尾再续下一段。
    this.items=page.items;this.total=page.total;this.render();
    const visible=new Set(this.items.map(item=>item.id));
    this.selectedIds=new Set([...this.selectedIds].filter(id=>visible.has(id)));
    const selected=this.items.find(row=>row.id===this.activeId&&this.selectedIds.has(row.id))||
      this.items.find(row=>this.selectedIds.has(row.id))||this.items[0];
    this.activeId=selected?.id||null;
    if(this.activeId&&!this.selectedIds.size)this.selectRow(this.activeId);else this.highlight();
    await this.actions.select(this.activeId);
  }
  /** 滚到已加载末尾时续下一段（最多续到 total）。 */
  private async loadMore(){
    if(this.loadingMore||!this.visible||this.items.length>=this.total)return;
    this.loadingMore=true;
    const sequence=this.sequence;
    try{
      const page=await window.reading.request<CatalogPage>('catalog',this.queryInput(this.items.length,CardBrowser.loadChunk,false));
      if(sequence!==this.sequence||!this.visible)return;
      if(page.total>=0)this.total=page.total;
      if(page.items.length)this.items=this.items.concat(page.items);
      this.renderRows();
    }finally{this.loadingMore=false;}
  }
  private cellValue(node:CatalogRow,key:ColumnKey,editable:boolean,state:string):string{
    switch(key){
      case 'title':return node.title;
      case 'kind':return kinds[node.kind];
      case 'folder':return node.folderTitle||'—';
      case 'state':return state;
      case 'due':return !editable?'—':node.state==='new'?t('新卡片 #{0}',node.id):(node.dueAt?new Date(node.dueAt).toLocaleString(getLocale(),{dateStyle:'short',timeStyle:'short'}):'—');
      case 'reps':return editable?String(node.reps):'—';
      case 'createdAt':return node.createdAt?new Date(node.createdAt).toLocaleDateString(getLocale()):'—';
      case 'updatedAt':return node.updatedAt?new Date(node.updatedAt).toLocaleDateString(getLocale()):'—';
    }
  }
  private render(){
    this.element('browser-total').textContent=t('共 {0} 张',this.total);
    // 底部不再重复显示总数（标题栏已有「共 N 张」）
    this.element('browser-table-scroll').scrollTop=0;
    this.renderRows();
  }
  /** 真正的虚拟表格（和 Anki 的 QTableView 同思路）：表头单独一张固定表，
   *  表体只渲染可视区上下各 8/16 行，外面用固定高度的 canvas 撑出滚动范围。
   *  DOM 里永远只有约 40 行，拖动分隔线/缩放/滚动都是常数成本。 */
  private renderRows(){
    const rows=this.element('browser-rows'),scroll=this.element('browser-table-scroll');
    const columns=this.visibleColumns(),loaded=this.items.length,total=Math.max(loaded,this.total);
    const canvas=this.element('browser-table-canvas'),body=this.element('browser-table');
    canvas.style.height=(total*this.rowHeight)+'px';
    if(!total){
      body.style.top='0px';
      const cell=document.createElement('td');cell.className='browser-empty';cell.colSpan=Math.max(1,columns.length);
      cell.textContent=t('没有匹配的卡片');
      const row=document.createElement('tr');row.append(cell);rows.replaceChildren(row);
      this.syncScrollbar();return;
    }
    const view=Math.max(120,scroll.clientHeight||window.innerHeight-170);
    const first=Math.floor(scroll.scrollTop/this.rowHeight);
    // 可视区快碰到已加载的末尾就续下一段，滚动条高度按 total 撑，位置不会跳。
    if(first+Math.ceil(view/this.rowHeight)+16>loaded&&loaded<this.total)void this.loadMore();
    const start=Math.max(0,Math.min(loaded-1,first-8));
    const end=Math.min(loaded,start+Math.ceil(view/this.rowHeight)+16);
    body.style.top=(start*this.rowHeight)+'px';
    rows.innerHTML=this.renderRowsHtml(columns,start,end);
    // 虚拟滚动重建行后会丢选中/聚焦样式，这里补回。
    this.highlight();
    this.syncScrollbar();
  }
  /** 拼 HTML 字符串一次赋值（比逐格 createElement 快一个量级）；事件委托挂在 tbody 上。 */
  private renderRowsHtml(columns:ColumnKey[],from:number,to:number):string{
    const esc=(value:string)=>value.replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch] as string));
    const parts:string[]=[];
    for(let index=from;index<to;index++){
      const node=this.items[index]!;
      const editable=!node.deletedAt&&node.kind!=='folder';
      const state=node.deletedAt?t('垃圾桶'):node.kind==='folder'?'—':states[node.state];
      const cells:string[]=[];
      for(const key of columns){
        const value=esc(this.cellValue(node,key,editable,state));
        if(key==='due')cells.push('<td class="browser-due state-'+esc(node.state)+'">'+value+'</td>');
        else if(key==='state'){
          const conflicts=this.conflicts.get(node.id);
          const badge=conflicts?.length?'<button type="button" class="browser-conflict-badge" data-conflict="'+esc(node.id)+'">'+esc(t('冲突文件'))+'</button> ':'';
          cells.push('<td class="browser-state state-'+esc(node.state)+'">'+badge+value+'</td>');
        }
        else cells.push('<td title="'+value+'">'+value+'</td>');
      }
      parts.push('<tr data-id="'+esc(node.id)+'" tabindex="0">'+cells.join('')+'</tr>');
    }
    return parts.join('');
  }
  private bindRowEvents(){
    const rows=this.element('browser-rows');
    rows.addEventListener('click',event=>{
      const target=event.target as HTMLElement;
      const conflict=target.closest<HTMLElement>('[data-conflict]');
      if(conflict){event.stopPropagation();void this.openConflict(conflict.dataset.conflict!);return;}
      const row=target.closest<HTMLElement>('tr[data-id]');if(!row)return;
      void this.actions.run(async()=>{
        const id=row.dataset.id!;this.selectRow(id,event);
        const node=this.items.find(item=>item.id===id);
        if(node&&this.selectedIds.size===1&&this.activeId===node.id&&!node.deletedAt&&node.kind!=='folder')await this.showEditor(node.id);
      });
    });
    rows.addEventListener('dblclick',event=>{
      const row=(event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');if(!row)return;
      const node=this.items.find(item=>item.id===row.dataset.id);
      if(!node)return;
      if(event.ctrlKey||event.metaKey||event.shiftKey)return;
      // 有冲突的卡片双击直接进入冲突处理（一张接一张），不先打开编辑窗口。
      if(this.conflicts.get(node.id)?.length){this.selectRow(node.id);void this.openConflict(node.id);return;}
      if(node.deletedAt||node.kind==='folder')return;
      this.selectRow(node.id);this.actions.openWindow(node.id);
    });
    rows.addEventListener('contextmenu',event=>{
      const row=(event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');if(!row)return;
      const node=this.items.find(item=>item.id===row.dataset.id);
      // 文件夹和垃圾桶里的卡片（冲突筛选会显示）以前直接 return，右键没菜单；现在都交给上层。
      if(!node)return;
      event.preventDefault();this.actions.context({id:node.id,kind:node.kind,deletedAt:node.deletedAt},event);
    });
    rows.addEventListener('keydown',event=>{
      if(!['ArrowUp','ArrowDown','Enter'].includes(event.key))return;event.preventDefault();
      const row=(event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');if(!row)return;
      const index=this.items.findIndex(item=>item.id===row.dataset.id);
      const target=this.items[Math.max(0,Math.min(this.items.length-1,index+(event.key==='ArrowUp'?-1:event.key==='ArrowDown'?1:0)))];
      if(!target)return;
      void this.actions.run(async()=>{
        this.selectRow(target.id,event);await this.actions.select(target.id);
        this.scrollToItem(target.id);
        this.host.querySelector<HTMLElement>('tr[data-id="'+CSS.escape(target.id)+'"]')?.focus();
      });
    });
  }
  /** 右键菜单用——这张卡是否有内容/排程冲突。 */
  hasConflict(id:string):boolean{return Boolean(this.conflicts.get(id)?.length);}
  /** 把当前冲突按卡片分组，标题优先用表格行，取不到再退回版本标题/编号。 */
  private async conflictGroups():Promise<ConflictGroup[]>{
    const groups:ConflictGroup[]=[];
    for(const [nodeId,items] of this.conflicts){
      const row=this.items.find(item=>item.id===nodeId);
      let title=row?.title||'';
      if(!title){
        const content=items.find(item=>item.kind==='content');
        title=content?.kind==='content'?(content.versions.map(version=>version.value?.title).find(Boolean)||''):'';
      }
      if(!title){
        const note=await window.reading.request<Material|null>('get',{id:nodeId}).catch(()=>null);
        title=note?.title||'';
      }
      groups.push({nodeId,title:title||nodeId,items});
    }
    return groups;
  }
  /** 右键「冲突文件…」入口；按队列处理，一张接一张。 */
  async openConflict(id:string):Promise<void>{
    if(!this.conflicts.get(id)?.length)return;
    const groups=await this.conflictGroups();
    if(!groups.length)return;
    const start=Math.max(0,groups.findIndex(group=>group.nodeId===id));
    showSyncConflicts(groups,start,{
      chooseContent:async(item,selected)=>{
        const current=await window.reading.request<Material|null>('get',{id:item.nodeId});
        if(current&&this.hasUnsavedEdit(item.nodeId,current.content,current.answer))throw Error(t('请先保存浏览器里的卡片编辑。'));
        await this.actions.beforeQuery();
        const result=await window.reading.syncChooseContent(item.nodeId,item.versions.map(version=>version.id),selected);
        if(result.status==='applied'){
          await this.actions.contentChanged(item.nodeId);
          await this.reloadEdit(item.nodeId);
        }
        return result;
      },
      discard:nodeId=>window.reading.syncDiscardContent(nodeId),
      reload:async()=>{await this.loadConflicts();return this.conflictGroups();},
      refresh:()=>this.refresh(),
    });
  }
  private scrollToItem(id:string){
    const index=this.items.findIndex(item=>item.id===id);
    if(index<0)return;
    const row=this.host.querySelector<HTMLElement>('tr[data-id="'+CSS.escape(id)+'"]');
    if(row){row.scrollIntoView({block:'nearest'});return;}
    const scroll=this.element('browser-table-scroll');
    scroll.scrollTop=Math.max(0,index*this.rowHeight-scroll.clientHeight/2);
  }
}
