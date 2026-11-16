import { t } from '../core/i18n';
import type { ChildrenPage, TreeNode,FolderCounts } from '../core/model';
import {setIcon} from './icons';
export type TreeType='topic'|'material'|'cloze';

interface Branch {items:TreeNode[];cursor:ChildrenPage['cursor'];loaded:boolean;loading:boolean}
interface Row {node:TreeNode|null;parentId:string|null;depth:number;last:boolean;ancestors:boolean[];more?:boolean}
export interface TreeActions {
  select:(node:TreeNode)=>void;
  context:(node:TreeNode|null,event:MouseEvent)=>void;
  move:(node:TreeNode,parentId:string|null)=>void;
  rename:(node:TreeNode)=>void;
  /** 点目录树空白处取消牌组聚焦。 */
  deselect?:()=>void;
}

export class DirectoryTree {
  private cache=new Map<string,Branch>();
  private expanded=new Set<string>();
  private flattened:Row[]=[];
  private spacer:HTMLDivElement;
  private layer:HTMLDivElement;
  private selected:string|null=null;
  private pendingFrame=0;
  private dragged:TreeNode|null=null;
  private rendered=new Map<string,{element:HTMLElement;signature:string}>();
  private counts:Record<string,FolderCounts>={};
  private topSticky=document.createElement('div');
  private bottomSticky=document.createElement('div');
  private indexByNode=new Map<string,number>();
  private branchEnds=new Map<string,number>();
  private types:TreeType[]=[];
  private generation=0;
  /** 双击自己判——浏览器 detail 为偶数、且 600 ms 内是同一行。 */
  private static readonly doubleClickDelay=600;
  private lastClick:{id:string;at:number}={id:'',at:0};
  private lastToggle:{id:string;at:number}={id:'',at:0};
  readonly rowHeight=28;
  readonly nodes=new Map<string,TreeNode>();

  constructor(readonly host:HTMLElement,readonly actions:TreeActions){
    this.spacer=document.createElement('div');this.spacer.className='tree-spacer';
    this.layer=document.createElement('div');this.layer.className='tree-layer';
    host.append(this.spacer,this.layer);
    this.topSticky.className='tree-sticky tree-sticky-top';this.bottomSticky.className='tree-sticky tree-sticky-bottom';
    host.parentElement!.append(this.topSticky,this.bottomSticky);
    const scrollFromSticky=(event:WheelEvent)=>{
      if(event.ctrlKey||!event.deltaY)return;
      const unit=event.deltaMode===WheelEvent.DOM_DELTA_LINE?this.rowHeight:
        event.deltaMode===WheelEvent.DOM_DELTA_PAGE?host.clientHeight:1;
      event.preventDefault();
      host.scrollTop+=event.deltaY*unit;
    };
    this.topSticky.addEventListener('wheel',scrollFromSticky,{passive:false});
    this.bottomSticky.addEventListener('wheel',scrollFromSticky,{passive:false});
    host.addEventListener('scroll',()=>{
      if(!this.pendingFrame)this.pendingFrame=requestAnimationFrame(()=>{this.pendingFrame=0;this.render();});
    });
    host.addEventListener('click',event=>{
      if((event.target as HTMLElement).closest('.tree-row'))return;
      this.selected=null;this.render();this.actions.deselect?.();
    });
    // 行的点击统一在 layer 上代理。行元素会随选中状态重绘被换掉，
    // 绑在行/标签上的点击会在快速连点时丢一次（mousedown 与 mouseup 落在不同元素上），
    // 代理挂在稳定的 layer 上就不会。收展按钮自己处理，跳过。
    this.layer.addEventListener('click',event=>{
      const target=event.target as HTMLElement;
      if(target.closest('.tree-toggle'))return;
      const row=target.closest('.tree-row') as HTMLElement|null;
      const node=row?.dataset.id?this.nodes.get(row.dataset.id):undefined;
      if(node)this.rowClick(node,event);
    });
    host.oncontextmenu=event=>{
      if((event.target as HTMLElement).closest('.tree-row'))return;
      event.preventDefault();actions.context(null,event);
    };
    host.ondragover=event=>{if(this.dragged?.kind==='folder'&&!(event.target as HTMLElement).closest('.tree-row')){event.preventDefault();host.classList.add('drop-root');}};
    host.ondragleave=()=>host.classList.remove('drop-root');
    host.ondrop=event=>{
      if(this.dragged?.kind!=='folder'||(event.target as HTMLElement).closest('.tree-row'))return;
      event.preventDefault();host.classList.remove('drop-root');this.actions.move(this.dragged,null);this.dragged=null;
    };
    new ResizeObserver(()=>this.render()).observe(host);
  }

  private key(parentId:string|null):string{return parentId||'$root';}

  async initialize():Promise<void>{await this.load(null);this.flatten();}
  selectedNode():TreeNode|null{return this.selected?this.nodes.get(this.selected)||null:null;}
  selectNode(id:string):void{this.selected=id;this.render();}
  setCounts(counts:Record<string,FolderCounts>):void{this.counts=counts;this.render();}
  async setTypes(types:TreeType[]):Promise<void>{
    this.types=[...new Set(types.filter(type=>['topic','material','cloze'].includes(type)))];
    await this.reset();
  }
  async reset():Promise<void>{
    this.generation++;this.cache.clear();this.nodes.clear();this.flatten();
    await this.load(null);
    for(const id of this.expanded)await this.load(id);
    this.flatten();if(this.selected)await this.reveal(this.selected);
  }

  /** 单击只选中聚焦；同一行的偶数次点击（2、4、6…）算双击，只展开/收起它自己这一级。 */
  private rowClick(node:TreeNode,event:MouseEvent):void{
    const now=Date.now();
    const sameRow=this.lastClick.id===node.id&&now-this.lastClick.at<DirectoryTree.doubleClickDelay;
    this.lastClick={id:node.id,at:now};
    const twice=sameRow&&event.detail>=2&&event.detail%2===0;
    if(!twice){this.actions.select(node);return;}
    // 连点两下（同一行 250ms 内已经切过）不再切回去，避免手快了看起来「没展开」。
    if(this.lastToggle.id===node.id&&now-this.lastToggle.at<250)return;
    this.lastToggle={id:node.id,at:now};
    if(node.kind==='folder'||node.hasChildren)void this.toggle(node);
  }

  private async load(parentId:string|null,more=false):Promise<void>{
    const key=this.key(parentId);
    const branch=this.cache.get(key)||{items:[],cursor:null,loaded:false,loading:false};
    if(branch.loading||(!more&&branch.loaded))return;
    branch.loading=true;this.cache.set(key,branch);
    const generation=this.generation;
    try{
      // 目录树一次取全该层（上限 2000），不再显示「加载更多」
      const page=await window.reading.request<ChildrenPage>('children',{parentId,limit:2000,types:this.types});
      if(generation!==this.generation)return;
      const merged=new Map((more?branch.items:[]).map(node=>[node.id,node]));
      for(const node of page.items){merged.set(node.id,node);this.nodes.set(node.id,node);}
      branch.items=[...merged.values()].sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
      branch.cursor=page.cursor;branch.loaded=true;
    }finally{branch.loading=false;}
  }

  async toggle(node:TreeNode):Promise<void>{
    if(this.expanded.delete(node.id)){this.flatten();return;}
    this.expanded.add(node.id);
    this.flatten();
    try{await this.load(node.id);}finally{this.flatten();}
  }

  async refresh(parentIds:Array<string|null>):Promise<void>{
    if(this.types.length){await this.reset();return;}
    for(const parentId of new Set(parentIds)){
      const branch=this.cache.get(this.key(parentId));
      if(branch)branch.loaded=false;
      await this.load(parentId);
    }
    this.flatten();
  }

  async reveal(id:string):Promise<void>{
    const generation=this.generation;
    const path=await window.reading.request<TreeNode[]>('directoryPath',{id,types:this.types});
    if(generation!==this.generation)return;
    let parentId:string|null=null;
    for(const node of path){
      await this.load(parentId);
      if(generation!==this.generation)return;
      const branch=this.cache.get(this.key(parentId))!;
      const position=branch.items.findIndex(item=>item.id===node.id);
      if(position===-1)branch.items.push(node);
      else branch.items[position]=node;
      branch.items.sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
      this.nodes.set(node.id,node);
      if(node.id!==id)this.expanded.add(node.id);
      parentId=node.id;
    }
    this.selected=id;
    this.flatten();
    const at=this.flattened.findIndex(row=>row.node?.id===id);
    if(at>=0){
      // 把当前卡片滚到**可视区中间**（以前只在贴边时才滚，进入复习/待办时
      // 当前卡片常常被顶到最底边甚至看不见，用户找不到它在哪一行）
      const rowTop=at*this.rowHeight;
      const centered=rowTop-this.host.clientHeight/2+this.rowHeight/2;
      const max=Math.max(0,this.host.scrollHeight-this.host.clientHeight);
      this.host.scrollTop=Math.max(0,Math.min(centered,max));
      this.render();
      // 布局稳定后再渲染一次，确保虚拟列表按新滚动位置生成行
      requestAnimationFrame(()=>this.render());
    }
  }

  update(node:TreeNode):void{
    this.nodes.set(node.id,node);
    for(const branch of this.cache.values()){const at=branch.items.findIndex(item=>item.id===node.id);if(at>=0)branch.items[at]=node;}
    this.flatten();
  }

  private flatten():void{
    const result:Row[]=[];
    this.indexByNode.clear();this.branchEnds.clear();
    const stack:Array<{parentId:string|null;depth:number;ancestors:boolean[];index:number}>=[{parentId:null,depth:0,ancestors:[],index:0}];
    while(stack.length){
      const frame=stack[stack.length-1],branch=this.cache.get(this.key(frame.parentId)),items=branch?.items||[];
      if(frame.index>=items.length){
        
        if(frame.parentId)this.branchEnds.set(frame.parentId,result.length);stack.pop();continue;
      }
      const node=items[frame.index++],last=frame.index===items.length&&!branch?.cursor;
      this.indexByNode.set(node.id,result.length);result.push({node,parentId:frame.parentId,depth:frame.depth,last,ancestors:frame.ancestors});
      if(this.expanded.has(node.id))stack.push({parentId:node.id,depth:frame.depth+1,ancestors:[...frame.ancestors,last],index:0});
    }
    this.flattened=result;
    this.spacer.style.height=(result.length*this.rowHeight)+'px';
    this.render();
  }

  private render():void{
    const first=Math.max(0,Math.floor(this.host.scrollTop/this.rowHeight)-8);
    const count=Math.ceil(this.host.clientHeight/this.rowHeight)+16;
    const elements:HTMLElement[]=[],keep=new Set<string>();
    for(let index=first;index<Math.min(this.flattened.length,first+count);index++){
      const row=this.flattened[index];
      const key=row.node?'node:'+row.node.id:'more:'+row.parentId;
      const signature=JSON.stringify([index,row.depth,row.last,row.ancestors,row.parentId,row.node?.title,row.node?.kind,
        row.node?.hasChildren,row.node?.sourceId,row.node?.parentId,row.node?.id===this.selected,this.expanded.has(row.node?.id||''),row.node?.kind==='folder'?this.counts[row.node.id]:null]);
      keep.add(key);
      const previous=this.rendered.get(key);
      if(previous?.signature===signature){elements.push(previous.element);continue;}
      const element=document.createElement('div');
      this.rendered.set(key,{element,signature});
      element.className='tree-row'+(row.node?.id===this.selected?' is-active':'');
      element.style.top=index*this.rowHeight+'px';
      element.style.paddingLeft=(row.depth*20+3)+'px';
      if(row.depth){
        row.ancestors.forEach((last,depth)=>{
          if(last||depth===0)return;
          const guide=document.createElement('span');guide.className='tree-rail';
          guide.style.left=(depth*20-7)+'px';element.append(guide);
        });
        const elbow=document.createElement('span');
        elbow.className='tree-elbow'+(row.last?' is-last':'');
        elbow.style.left=(row.depth*20-7)+'px';element.append(elbow);
      }
      if(row.more){
        const more=document.createElement('button');more.className='tree-more';more.textContent=t('加载更多…');
        more.onclick=()=>this.load(row.parentId,true).then(()=>this.flatten());
        element.append(more);elements.push(element);continue;
      }
      const node=row.node!;
      element.dataset.id=node.id;
      element.dataset.kind=node.kind;
      const toggle=document.createElement('button');toggle.className='tree-toggle';
      const expandable=node.kind==='folder'||node.hasChildren;
      toggle.textContent=expandable?(this.expanded.has(node.id)?'−':'+'):'';
      toggle.disabled=!expandable;
      toggle.setAttribute('aria-label',this.expanded.has(node.id)?t('折叠'):t('展开'));
      toggle.onclick=event=>{event.stopPropagation();void this.toggle(node);};
      const label=document.createElement('button');label.className='tree-label';
      label.title=node.title;
      const badge=document.createElement('span');
      badge.className='tree-type tree-type-'+node.kind;
      if(node.kind==='folder')setIcon(badge,'folder');else badge.textContent=node.kind==='cloze'?'L':'T';
      badge.setAttribute('aria-hidden','true');
      const text=document.createElement('span');text.className='tree-name';text.textContent=node.title;
      label.append(badge,text);
      // 点击统一交给 layer 上的代理处理（见 constructor），这里不再给每行绑 onclick。
      // 行的元素会随选中状态重绘被换掉，绑在行上的事件会在连点时丢一次，代理就不会。
      label.onkeydown=event=>{
        if(event.key==='ArrowRight'&&!this.expanded.has(node.id))void this.toggle(node);
        if(event.key==='ArrowLeft'&&this.expanded.has(node.id))void this.toggle(node);
      };
      if(node.kind==='folder'||node.kind==='topic'&&(!node.parentId||node.parentId===node.folderId)){
        label.draggable=true;
        label.ondragstart=event=>{
          this.dragged=node;
          event.dataTransfer?.setData('application/x-reading-topic',node.id);
          if(event.dataTransfer)event.dataTransfer.effectAllowed='move';
        };
        label.ondragend=()=>{this.dragged=null;this.host.classList.remove('drop-root');};
      }
      if(node.kind==='folder'){
        element.ondragover=event=>{
          if(!this.dragged||this.dragged.id===node.id)return;
          event.preventDefault();event.stopPropagation();element.classList.add('is-drop-target');
        };
        element.ondragleave=()=>element.classList.remove('is-drop-target');
        element.ondrop=event=>{
          if(!this.dragged)return;
          event.preventDefault();event.stopPropagation();element.classList.remove('is-drop-target');
          this.actions.move(this.dragged,node.id);this.dragged=null;
        };
      }
      element.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();this.actions.context(node,event);};
      element.append(toggle,label);
      if(node.kind==='folder'){
        const counts=this.counts[node.id]||{new:0,learning:0,review:0};
        const group=document.createElement('span');group.className='folder-counts';group.setAttribute('aria-label',t('新卡 {0}，学习中 {1}，到期复习 {2}',counts.new,counts.learning,counts.review));
        for(const [name,value] of [['new',counts.new],['learning',counts.learning],['review',counts.review]] as const){
          const badge=document.createElement('span');badge.className='count-'+name+(value===0?' is-zero':'');badge.textContent=String(value);group.append(badge);
        }
        element.append(group);
      }
      elements.push(element);
    }
    for(const [key,record] of this.rendered)if(!keep.has(key)){
      record.element.remove();this.rendered.delete(key);
    }
    const desired=new Set(elements);
    for(const element of Array.from(this.layer.children))if(!desired.has(element as HTMLElement))element.remove();
    let reference=this.layer.firstChild;
    for(const element of elements){
      if(element===reference)reference=reference.nextSibling;
      else this.layer.insertBefore(element,reference);
    }
    this.renderSticky();
  }
  private renderSticky(){
    this.topSticky.replaceChildren();this.bottomSticky.replaceChildren();
    if(!this.host.clientHeight||!this.flattened.length)return;
    const first=Math.min(this.flattened.length-1,Math.floor(this.host.scrollTop/this.rowHeight)),ancestors:number[]=[];
    let parent=this.flattened[first].parentId;
    while(parent){const index=this.indexByNode.get(parent);if(index===undefined)break;if(index*this.rowHeight<this.host.scrollTop)ancestors.unshift(index);parent=this.flattened[index].parentId;}
    const limit=Math.min(3,Math.max(1,Math.floor(this.host.clientHeight/this.rowHeight/5)));
    ancestors.slice(-limit).forEach((index,level)=>{
      const element=this.stickyRow(index,'top'),node=this.flattened[index].node!,end=this.branchEnds.get(node.id)||this.flattened.length;
      element.style.transform=`translateY(${Math.min(0,end*this.rowHeight-this.host.scrollTop-(level+1)*this.rowHeight)}px)`;this.topSticky.append(element);
    });
    const last=Math.floor((this.host.scrollTop+this.host.clientHeight)/this.rowHeight);let siblingParent:string|null|undefined;
    for(let i=last+1;i<this.flattened.length&&this.bottomSticky.children.length<limit;i++){
      const row=this.flattened[i];if(row.node?.kind!=='folder')continue;
      if(siblingParent===undefined)siblingParent=row.parentId;if(row.parentId!==siblingParent)continue;
      this.bottomSticky.append(this.stickyRow(i,'bottom'));
    }
  }
  private stickyRow(index:number,side:'top'|'bottom'){
    const row=this.flattened[index],node=row.node!,element=document.createElement('div');element.className='tree-row sticky-row';element.dataset.id=node.id;element.dataset.side=side;
    element.style.paddingLeft=Math.min(row.depth*20+3,43)+'px';
    // 顶部吸顶行点标签 = 原地收起该级（v16 测试覆盖）。
    // 底部「后续同级」吸底行点标签 = 直接跳转到那个目录，
    //       滚动到该行作为可见区顶端，并选中它；收展用左侧 +/− 按钮。
    const isBottom=side==='bottom';
    const toggle=document.createElement('button');toggle.className='tree-toggle';toggle.textContent=this.expanded.has(node.id)?'−':'+';toggle.setAttribute('aria-label',t('收展 {0}',node.title));
    toggle.onclick=event=>{event.stopPropagation();void this.toggle(node);};
    const label=document.createElement('button');label.className='tree-label';label.title=node.title;
    const badge=document.createElement('span');badge.className='tree-type tree-type-'+node.kind;if(node.kind==='folder')setIcon(badge,'folder');else badge.textContent=node.kind==='cloze'?'L':'T';
    const text=document.createElement('span');text.className='tree-name';text.textContent=node.title;label.append(badge,text);
    label.onclick=()=>{if(isBottom)this.jumpTo(index);else void this.toggle(node);};element.append(toggle,label);
    if(node.kind==='folder'){const group=document.createElement('span');group.className='folder-counts';const counts=this.counts[node.id]||{new:0,learning:0,review:0};for(const key of ['new','learning','review'] as const){const count=document.createElement('span');count.className='count-'+key+(counts[key]===0?' is-zero':'');count.textContent=String(counts[key]);group.append(count);}element.append(group);}
    element.oncontextmenu=event=>{event.preventDefault();this.actions.context(node,event);};return element;
  }
  /** 把某一行滚到可见区顶端（顶部吸顶栏占位要扣掉），并选中该目录。 */
  private jumpTo(index:number){
    const node=this.flattened[index]?.node;if(!node)return;
    this.selected=node.id;
    const stickyRows=this.topSticky.children.length||1;
    this.host.scrollTop=Math.max(0,index*this.rowHeight-stickyRows*this.rowHeight);
    this.actions.select(node);
    this.render();
  }
}
