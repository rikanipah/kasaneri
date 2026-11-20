import { t } from '../core/i18n';
import type { ChildrenPage,DirectoryBranch, TreeNode,FolderCounts } from '../core/model';
import {setIcon} from './icons';
import { sortTreeRows,TreeSelection,updateTreeToggle,type TreeSort,type TreeType } from './tree-controls';

interface Branch {items:TreeNode[];cursor:ChildrenPage['cursor'];loaded:boolean;loading:boolean}
interface Row {node:TreeNode|null;parentId:string|null;depth:number;last:boolean;ancestors:boolean[];more?:boolean}
export interface TreeActions {
  select:(node:TreeNode)=>void;
  context:(node:TreeNode|null,event:MouseEvent)=>void;
  move:(nodes:TreeNode[],parentId:string|null,peerId?:string,allowCardParent?:boolean)=>void;
  rename:(node:TreeNode)=>void;
  canRelate:(nodes:TreeNode[])=>boolean;
  relate:(nodes:TreeNode[])=>void;
  /** 点目录树空白处取消牌组聚焦。 */
  deselect?:()=>void;
}

export class DirectoryTree {
  private cache=new Map<string,Branch>();
  private expanded=new Set<string>();
  private flattened:Row[]=[];
  private spacer:HTMLDivElement;
  private layer:HTMLDivElement;
  private readonly selection=new TreeSelection();
  private pendingFrame=0;
  private dragged:TreeNode[]=[];
  private rendered=new Map<string,{element:HTMLElement;signature:string}>();
  private counts:Record<string,FolderCounts>={};
  private topSticky=document.createElement('div');
  private bottomSticky=document.createElement('div');
  private indexByNode=new Map<string,number>();
  private branchEnds=new Map<string,number>();
  private types:TreeType[]=[];
  private sort:TreeSort='position';
  private generation=0;
  /** 双击自己判——浏览器 detail 为偶数、且 600 ms 内是同一行。 */
  private static readonly doubleClickDelay=600;
  private lastClick:{id:string;at:number}={id:'',at:0};
  private lastToggle:{id:string;at:number}={id:'',at:0};
  readonly rowHeight=28;
  readonly nodes=new Map<string,TreeNode>();

  constructor(readonly host:HTMLElement,readonly actions:TreeActions,private readonly expandButton:HTMLButtonElement){
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
      this.selection.select(null);this.render();this.actions.deselect?.();
    });
    // 普通行和吸顶行共用点击语义，事件委托在重绘期间保持稳定。
    const clickRow=(event:MouseEvent)=>{
      const target=event.target as HTMLElement;
      if(target.closest('.tree-toggle'))return;
      const row=target.closest('.tree-row') as HTMLElement|null;
      const node=row?.dataset.id?this.nodes.get(row.dataset.id):undefined;
      if(node)this.rowClick(node,event);
    };
    this.layer.addEventListener('click',clickRow);
    this.topSticky.addEventListener('click',clickRow);
    this.bottomSticky.addEventListener('click',clickRow);
    host.oncontextmenu=event=>{
      if((event.target as HTMLElement).closest('.tree-row'))return;
      event.preventDefault();actions.context(null,event);
    };
    const rootDrop=()=>this.dragged.length>0&&this.dragged.every(node=>node.kind==='folder');
    const relatedDrop=()=>this.dragged.length>0&&this.dragged.every(node=>node.kind!=='folder')&&this.actions.canRelate(this.dragged);
    host.ondragover=event=>{
      if((event.target as HTMLElement).closest('.tree-row')||(!rootDrop()&&!relatedDrop()))return;
      event.preventDefault();host.classList.add('drop-root');
    };
    host.ondragleave=()=>host.classList.remove('drop-root');
    host.ondrop=event=>{
      if((event.target as HTMLElement).closest('.tree-row')||(!rootDrop()&&!relatedDrop()))return;
      event.preventDefault();host.classList.remove('drop-root');
      if(rootDrop())this.actions.move(this.dragged,null);else this.actions.relate(this.dragged);
      this.dragged=[];
    };
    new ResizeObserver(()=>this.render()).observe(host);
  }

  private key(parentId:string|null):string{return parentId||'$root';}

  async initialize():Promise<void>{await this.load(null);this.flatten();}
  selectedNode():TreeNode|null{return this.selection.anchor?this.nodes.get(this.selection.anchor)||null:null;}
  selectNode(id:string):void{
    if(this.selection.anchor!==id)this.selection.select(id);
    this.render();
  }
  draggedCards():TreeNode[]{return this.dragged.filter(node=>node.kind!=='folder');}
  selectedForMove(node:TreeNode):TreeNode[]{
    if(!this.selection.includes(node.id))return [node];
    return this.flattened.flatMap(({node})=>node&&this.selection.includes(node.id)?[node]:[]);
  }
  selectMany(ids:string[]):void{this.selection.selectMany(ids);this.render();}
  hasExpandedBranches():boolean{
    return this.flattened.some(({node})=>node!==null&&this.expanded.has(node.id));
  }
  setCounts(counts:Record<string,FolderCounts>):void{this.counts=counts;this.render();}
  setSort(sort:TreeSort):void{this.sort=sort;this.flatten();}
  async setTypes(types:TreeType[]):Promise<void>{
    this.types=[...new Set(types.filter(type=>['topic','material','cloze'].includes(type)))];
    await this.reset();
  }
  async reset():Promise<void>{
    this.generation++;
    if(this.expanded.size){
      if(!await this.loadAllBranches())return;
    }else{
      this.cache.clear();
      this.nodes.clear();
      await this.load(null);
    }
    this.flatten();if(this.selection.anchor)await this.reveal(this.selection.anchor);
  }

  async expandAll():Promise<void>{
    if(!await this.loadAllBranches())return;
    for(const node of this.nodes.values()){
      if(node.hasChildren)this.expanded.add(node.id);
    }
    this.flatten();
  }

  collapseAll():void{
    this.expanded.clear();
    this.flatten();
  }

  private async loadAllBranches():Promise<boolean>{
    const generation=this.generation;
    const branches=await window.reading.request<DirectoryBranch[]>('directoryBranches',{types:this.types});
    if(generation!==this.generation)return false;
    this.generation++;
    this.cache.clear();
    this.nodes.clear();
    this.cache.set(this.key(null),{items:[],cursor:null,loaded:true,loading:false});
    for(const {parentId,items} of branches){
      this.cache.set(this.key(parentId),{items,cursor:null,loaded:true,loading:false});
      for(const node of items)this.nodes.set(node.id,node);
    }
    return true;
  }

  /** 单击只选中聚焦；同一行的偶数次点击（2、4、6…）算双击，只展开/收起它自己这一级。 */
  private rowClick(node:TreeNode,event:MouseEvent):void{
    if(event.shiftKey){
      this.lastClick={id:'',at:0};
      if(this.selection.extend(this.flattened.flatMap(row=>row.node?[row.node.id]:[]),node.id)){
        this.render();
        return;
      }
    }
    if(event.ctrlKey||event.metaKey){
      this.lastClick={id:'',at:0};this.selection.toggle(node.id);this.render();return;
    }
    const now=Date.now();
    const sameRow=this.lastClick.id===node.id&&now-this.lastClick.at<DirectoryTree.doubleClickDelay;
    this.lastClick={id:node.id,at:now};
    const twice=sameRow&&event.detail>=2&&event.detail%2===0;
    if(!twice){this.focusRow(node);return;}
    // 连点两下（同一行 250ms 内已经切过）不再切回去，避免手快了看起来「没展开」。
    if(this.lastToggle.id===node.id&&now-this.lastToggle.at<250)return;
    this.lastToggle={id:node.id,at:now};
    if(node.kind==='folder'||node.hasChildren)void this.toggle(node);
  }

  private focusRow(node:TreeNode):void{
    this.selection.select(node.id);
    this.render();
    this.actions.select(node);
  }

  private async load(parentId:string|null,more=false):Promise<void>{
    const key=this.key(parentId);
    const branch=this.cache.get(key)||{items:[],cursor:null,loaded:false,loading:false};
    if(branch.loading||(!more&&branch.loaded))return;
    branch.loading=true;this.cache.set(key,branch);
    const generation=this.generation;
    try{
      const merged=new Map((more?branch.items:[]).map(node=>[node.id,node]));
      let cursor=more?branch.cursor:null;
      do{
        const page:ChildrenPage=await window.reading.request('children',{parentId,cursor,limit:250,types:this.types});
        if(generation!==this.generation)return;
        for(const node of page.items)merged.set(node.id,node);
        cursor=page.cursor;
      }while(cursor);
      branch.items=[...merged.values()].sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
      for(const node of branch.items)this.nodes.set(node.id,node);
      branch.cursor=null;branch.loaded=true;
    }finally{branch.loading=false;}
  }

  async toggle(node:TreeNode):Promise<void>{
    if(this.expanded.delete(node.id)){this.flatten();return;}
    this.expanded.add(node.id);
    this.flatten();
    try{await this.load(node.id);}finally{this.flatten();}
  }

  async refresh(parentIds:Array<string|null>,expandId?:string):Promise<void>{
    if(expandId)this.expanded.add(expandId);
    if(this.types.length){await this.reset();return;}
    const branches=new Set(parentIds);
    // The expand toggle belongs to the parent row, which is stored in its own parent’s branch.
    for(const id of parentIds){
      const node=id?this.nodes.get(id):undefined;
      if(node)branches.add(node.parentId);
    }
    for(const parentId of branches){
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
    if(this.selection.anchor!==id)this.selection.select(id);
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
    const branchRows=(id:string|null)=>sortTreeRows(this.cache.get(this.key(id))?.items??[],this.sort);
    const stack=[{parentId:null as string|null,depth:0,ancestors:[] as boolean[],index:0,items:branchRows(null)}];
    while(stack.length){
      const frame=stack[stack.length-1],branch=this.cache.get(this.key(frame.parentId)),items=frame.items;
      if(frame.index>=items.length){
        
        if(frame.parentId)this.branchEnds.set(frame.parentId,result.length);stack.pop();continue;
      }
      const node=items[frame.index++],last=frame.index===items.length&&!branch?.cursor;
      this.indexByNode.set(node.id,result.length);result.push({node,parentId:frame.parentId,depth:frame.depth,last,ancestors:frame.ancestors});
      if(node.kind!=='folder'&&!node.hasChildren)this.expanded.delete(node.id);
      if(this.expanded.has(node.id))stack.push({parentId:node.id,depth:frame.depth+1,ancestors:[...frame.ancestors,last],index:0,items:branchRows(node.id)});
    }
    this.flattened=result;
    updateTreeToggle(this.expandButton,!!this.host.closest('details')?.open&&this.hasExpandedBranches());
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
      const selected=!!row.node&&this.selection.includes(row.node.id);
      const signature=JSON.stringify([index,row.depth,row.last,row.ancestors,row.parentId,row.node?.title,row.node?.kind,
        row.node?.hasChildren,row.node?.sourceId,row.node?.parentId,this.expanded.has(row.node?.id||''),row.node?.kind==='folder'?this.counts[row.node.id]:null]);
      keep.add(key);
      const previous=this.rendered.get(key);
      if(previous?.signature===signature){
        previous.element.classList.toggle('is-active',selected);
        elements.push(previous.element);continue;
      }
      const element=document.createElement('div');
      this.rendered.set(key,{element,signature});
      element.className='tree-row'+(selected?' is-active':'');
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
      toggle.disabled=!expandable;
      if(expandable){
        const open=this.expanded.has(node.id);
        toggle.textContent=open?'−':'+';
        toggle.setAttribute('aria-expanded',String(open));
        toggle.setAttribute('aria-label',open?t('折叠'):t('展开'));
      }
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
        if(event.key==='ArrowRight'&&expandable&&!this.expanded.has(node.id))void this.toggle(node);
        if(event.key==='ArrowLeft'&&this.expanded.has(node.id))void this.toggle(node);
      };
      label.draggable=true;
      label.ondragstart=event=>{
        this.dragged=this.selectedForMove(node);
        event.dataTransfer?.setData('application/x-reading-node',node.id);
        if(event.dataTransfer)event.dataTransfer.effectAllowed='move';
      };
      label.ondragend=()=>{this.dragged=[];this.host.classList.remove('drop-root');};
      this.bindDropTarget(element,node);
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
  private bindDropTarget(element:HTMLElement,target:TreeNode):void{
    const folder=target.kind==='folder';
    const parentId=folder?target.id:target.parentId;
    const canDrop=()=>this.dragged.length>0&&
      !this.dragged.some(node=>node.id===target.id)&&
      (folder||(parentId!==null&&(
        this.nodes.get(parentId)?.kind==='folder'||this.dragged.every(node=>node.kind!=='folder')
      )));
    const toChildren=(event:DragEvent)=>{
      if(folder||this.dragged.some(node=>node.kind==='folder'))return folder;
      const bounds=element.getBoundingClientRect(),offset=(event.clientY-bounds.top)/bounds.height;
      return offset>=.2&&(offset<=.8||this.expanded.has(target.id));
    };
    const clear=()=>element.classList.remove('is-drop-target','is-list-drop-target');
    element.ondragover=event=>{
      if(!canDrop())return;
      event.preventDefault();event.stopPropagation();clear();
      if(event.dataTransfer)event.dataTransfer.dropEffect='move';
      element.classList.add(toChildren(event)?'is-drop-target':'is-list-drop-target');
    };
    element.ondragleave=clear;
    element.ondrop=event=>{
      if(!canDrop())return;
      event.preventDefault();event.stopPropagation();clear();
      const child=toChildren(event),nodes=this.dragged;this.dragged=[];
      this.actions.move(nodes,child?target.id:parentId,child?undefined:target.id,child&&!folder);
    };
  }

  private rootIndex(index:number):number{
    let parent=this.flattened[index].parentId;
    while(parent){
      const parentIndex=this.indexByNode.get(parent);
      if(parentIndex===undefined)break;
      index=parentIndex;
      parent=this.flattened[index].parentId;
    }
    return index;
  }

  private renderSticky():void{
    if(!this.host.clientHeight||!this.flattened.length){
      this.topSticky.replaceChildren();this.bottomSticky.replaceChildren();
      return;
    }
    const last=Math.min(this.flattened.length-1,
      Math.ceil((this.host.scrollTop+this.host.clientHeight)/this.rowHeight)-1);
    const branchIndex=this.rootIndex(last);
    const branch=this.flattened[branchIndex].node;
    // Pin the first following top-level folder beneath the viewport.
    const below:number[]=[];
    for(let index=(branch&&this.branchEnds.get(branch.id))??(last+1);index<this.flattened.length;){
      const node=this.flattened[index].node;
      if(node?.kind==='folder'){
        below.push(index);
        break;
      }
      index=(node&&this.branchEnds.get(node.id))??(index+1);
    }
    this.renderStickyRows(this.topSticky,this.topAncestorIndices(below.length),'top');
    this.renderStickyRows(this.bottomSticky,below,'bottom');
  }

  private topAncestorIndices(bottomRows:number):number[]{
    const {scrollTop,clientHeight}=this.host;
    const limit=Math.floor(clientHeight/this.rowHeight)-bottomRows-1;
    const ancestors:number[]=[];
    let parentId:string|null=null;
    for(let depth=0;depth<limit;depth++){
      // Each pinned parent covers one row. The next level follows the
      // branch at the first row underneath that stack.
      const slot=scrollTop+depth*this.rowHeight;
      let index=Math.floor(slot/this.rowHeight);
      let row=this.flattened[index];
      while(row&&row.depth>depth){
        const parentIndex=row.parentId?this.indexByNode.get(row.parentId):undefined;
        if(parentIndex===undefined)break;
        index=parentIndex;row=this.flattened[index];
      }
      if(!row?.node||row.depth!==depth||row.parentId!==parentId||index*this.rowHeight>=slot)break;
      const end=this.branchEnds.get(row.node.id);
      // Release the old header as its last child passes the slot.
      if(end===undefined||end*this.rowHeight<=slot+this.rowHeight)break;
      ancestors.push(index);parentId=row.node.id;
    }
    return ancestors;
  }

  private renderStickyRows(container:HTMLElement,indices:number[],side:'top'|'bottom'):void{
    const previous=new Map(Array.from(container.children,child=>{
      const row=child as HTMLElement;
      return [row.dataset.id!,row] as const;
    }));
    let next=container.firstElementChild;
    for(const index of indices){
      const row=this.flattened[index],node=row.node!;
      const signature=JSON.stringify([row.depth,node.title,node.kind,node.parentId,this.expanded.has(node.id),this.counts[node.id]]);
      const existing=previous.get(node.id);
      const element=existing?.dataset.stickySignature===signature?existing:this.stickyRow(index,side);
      element.dataset.stickySignature=signature;
      element.classList.toggle('is-active',this.selection.includes(node.id));
      element.style.paddingLeft=Math.min(row.depth*20+3,Math.max(3,this.host.clientWidth-105))+'px';
      if(element===next)next=element.nextElementSibling;
      else container.insertBefore(element,next);
      if(existing===element)previous.delete(node.id);
    }
    for(const element of previous.values())element.remove();
  }
  private stickyRow(index:number,side:'top'|'bottom'){
    const row=this.flattened[index],node=row.node!,element=document.createElement('div');
    element.className='tree-row sticky-row'+(this.selection.includes(node.id)?' is-active':'');
    element.dataset.id=node.id;element.dataset.kind=node.kind;element.dataset.side=side;
    // 上下吸附行与普通行共用点击处理。
    const open=this.expanded.has(node.id);
    const toggle=document.createElement('button');toggle.className='tree-toggle';toggle.textContent=open?'−':'+';
    toggle.setAttribute('aria-label',t('收展 {0}',node.title));toggle.setAttribute('aria-expanded',String(open));
    toggle.onclick=event=>{event.stopPropagation();void this.toggle(node);};
    const label=document.createElement('button');label.className='tree-label';label.title=node.title;
    const badge=document.createElement('span');badge.className='tree-type tree-type-'+node.kind;if(node.kind==='folder')setIcon(badge,'folder');else badge.textContent=node.kind==='cloze'?'L':'T';
    const text=document.createElement('span');text.className='tree-name';text.textContent=node.title;label.append(badge,text);
    element.append(toggle,label);
    if(node.kind==='folder'){const group=document.createElement('span');group.className='folder-counts';const counts=this.counts[node.id]||{new:0,learning:0,review:0};for(const key of ['new','learning','review'] as const){const count=document.createElement('span');count.className='count-'+key+(counts[key]===0?' is-zero':'');count.textContent=String(counts[key]);group.append(count);}element.append(group);}
    this.bindDropTarget(element,node);
    element.oncontextmenu=event=>{event.preventDefault();this.actions.context(node,event);};return element;
  }
}
