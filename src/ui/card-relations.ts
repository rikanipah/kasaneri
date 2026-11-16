import { t } from '../core/i18n';
import { bindTreeFilters,bindTreeSort,sortTreeRows,TreeSelection,updateTreeFilters,updateTreeToggle,type TreeSort,type TreeType } from './tree-controls';
import type {CardRelationCandidate,CardRelationKey,MemoryTreeCard,MemoryTreeLink,MemoryTreeSnapshot} from '../core/model';

interface Actions {
  add(id:string,targetId:string):void;
  open(id:string):void;
  context(targetId:string,kind:MemoryTreeLink['kind'],relation:CardRelationKey|null,event:MouseEvent):void;
  error(message:string):void;
}

export class CardRelationsPanel {
  private cardId:string|null=null;
  private readonly tree:HTMLUListElement;
  private readonly heading:HTMLElement;
  private roots:string[]=[];
  private readonly selection=new TreeSelection();
  private readonly expandButton:HTMLButtonElement;
  private readonly filters:HTMLElement;
  private types:TreeType[]=[];
  private sort:TreeSort='position';
  private displayed=new Map<string,MemoryTreeCard>();
  private cards=new Map<string,MemoryTreeCard>();
  /** 忽略当前卡的路径标识，只比较已经显示的树结构和内容。 */
  private signature='';
  // 内容默认展开；这里只记用户手动收起的节点，跨卡片保持并持久化。
  private readonly collapsed=new Set<string>();
  private readonly input:HTMLInputElement;
  private readonly results:HTMLElement;
  private searchTimer:ReturnType<typeof setTimeout>|undefined;
  private searchVersion=0;
  private activeResult=-1;
  private showVersion=0;

  constructor(private readonly host:HTMLDetailsElement,private readonly picker:HTMLDialogElement,
    private readonly actions:Actions){
    this.tree=host.querySelector('#memory-tree')!;
    this.heading=host.querySelector('summary')!;
    this.expandButton=host.querySelector('#memory-toggle-all')!;
    this.filters=host.querySelector('#memory-filters')!;
    this.expandButton.onclick=event=>{
      event.preventDefault();
      const expand=!this.host.open||!this.hasExpandedBranches();
      if(expand)this.host.open=true;
      this.setAllExpanded(expand);
    };
    host.addEventListener('toggle',()=>this.updateExpandButton());
    try{
      const saved:unknown=JSON.parse(localStorage.getItem('ir.memoryTree.types')??'[]');
      if(Array.isArray(saved))this.types=saved.filter(type=>['topic','material','cloze'].includes(type));
    }catch{}
    updateTreeFilters(this.filters,this.types);
    bindTreeFilters(this.filters,type=>{
      this.types=this.types.includes(type)?this.types.filter(value=>value!==type):[...this.types,type];
      updateTreeFilters(this.filters,this.types);
      try{localStorage.setItem('ir.memoryTree.types',JSON.stringify(this.types));}catch{}
      this.renderTree();
    });
    bindTreeSort(host.querySelector('#memory-sort')!,'ir.memoryTree.sort',sort=>{this.sort=sort;this.renderTree();});
    this.input=picker.querySelector('input')!;
    this.results=picker.querySelector('.relation-results')!;
    // 记忆树空白处右键不做任何事（建子卡片要右键某张卡片作为父级）。
    try{const saved=JSON.parse(localStorage.getItem('ir.memoryTree.collapsed')||'[]');if(Array.isArray(saved))for(const value of saved)if(typeof value==='string')this.collapsed.add(value);}catch{}
    this.tree.addEventListener('contextmenu',event=>{
      if((event.target as HTMLElement).closest('.tree-row'))return;
      event.preventDefault();
    });
  }

  async show(id:string|null):Promise<void>{
    const version=++this.showVersion;
    if(!id){this.cardId=null;this.host.hidden=true;return;}
    const {roots,cards}=await window.reading.request<MemoryTreeSnapshot>('memoryTree',{id});
    if(version!==this.showVersion)return;
    const changed=id!==this.cardId;
    const scrollTop=this.host.scrollTop;
    const wasSelected=this.selection.includes(id)&&this.selection.anchor===id;
    if(changed&&!wasSelected)this.selection.select(id);
    const sameTree=roots.length===this.roots.length&&roots.every((root,index)=>root===this.roots[index]);
    const signature=JSON.stringify([roots,cards.map(({onPath,...card})=>card)]);
    this.cardId=id;
    this.host.hidden=false;
    if(signature===this.signature){
      this.markSelection();
      if(changed&&!wasSelected)this.scrollToCurrent();
      return;
    }
    this.signature=signature;
    // 内容默认全部展开，只记住用户手动收起的节点；切卡/刷新不改状态。
    this.roots=roots;
    this.cards=new Map(cards.map(card=>[card.id,card]));
    this.renderTree();
    this.host.scrollTop=sameTree?scrollTop:0;
    if(changed||!sameTree)this.scrollToCurrent();
  }

  private renderTree(){
    this.displayed=this.filteredCards();
    const next=document.createDocumentFragment();
    const roots=this.roots.flatMap(id=>this.displayed.get(id)??[]);
    for(const card of sortTreeRows(roots,this.sort))this.appendCard(next,card.id);
    this.tree.replaceChildren(next);
    this.markSelection();
    this.updateExpandButton();
  }

  private filteredCards():Map<string,MemoryTreeCard>{
    if(!this.types.length)return this.cards;
    const filtered=new Map<string,MemoryTreeCard>();
    const visit=(id:string):boolean=>{
      const card=this.cards.get(id);
      if(!card)return false;
      const children=card.children.filter(visit);
      const related=card.related.filter(target=>this.types.includes(target.kind));
      if(!this.types.includes(card.kind)&&!children.length&&!related.length)return false;
      filtered.set(id,{...card,children,related});
      return true;
    };
    this.roots.forEach(visit);
    return filtered;
  }

  private hasExpandedBranches():boolean{
    return this.roots.some(id=>{
      const card=this.displayed.get(id);
      return !!card&&!!(card.children.length||card.related.length)&&!this.collapsed.has(id);
    });
  }

  private updateExpandButton():void{
    updateTreeToggle(this.expandButton,this.host.open&&this.hasExpandedBranches());
  }

  private setAllExpanded(expanded:boolean){
    const scrollTop=this.host.scrollTop;
    for(const card of this.cards.values()){
      if(!card.children.length&&!card.related.length)continue;
      if(expanded)this.collapsed.delete(card.id);
      else this.collapsed.add(card.id);
    }
    this.saveCollapsed();
    this.renderTree();
    this.host.scrollTop=scrollTop;
    if(expanded)this.scrollToCurrent();
  }

  private saveCollapsed(){
    try{localStorage.setItem('ir.memoryTree.collapsed',JSON.stringify([...this.collapsed]));}catch{}
  }

  private markSelection(){
    for(const row of this.tree.querySelectorAll<HTMLElement>('[data-selection-key]')){
      row.classList.toggle('is-active',this.selection.includes(row.dataset.selectionKey!));
      const label=row.querySelector('.tree-label')!;
      if(row.dataset.selectionKey===this.cardId)label.setAttribute('aria-current','true');
      else label.removeAttribute('aria-current');
    }
  }

  private appendCard(list:HTMLUListElement|DocumentFragment,id:string,parentId?:string){
    const card=this.displayed.get(id)!;
    const {item,row,toggle}=this.makeRow(card.title,card.kind);
    const relation:CardRelationKey|null=parentId?{parentId,childId:id,kind:'memory'}:null;
    item.dataset.memoryId=id;
    this.bindCard(row,id,card.kind,relation);
    list.append(item);
    if(card.children.length||card.related.length){
      this.branch(item,toggle,card.title,this.collapsed,id,children=>{
        const rows=[
          ...card.children.map(child=>({card:this.displayed.get(child)!,related:false})),
          ...card.related.map(target=>({card:target,related:true})),
        ].map(entry=>({...entry,title:entry.card.title,kind:entry.card.kind}));
        for(const {card:child,related} of sortTreeRows(rows,this.sort)){
          if(related)this.appendRelated(children,card,child);
          else this.appendCard(children,child.id,id);
        }
      });
    }
  }

  private appendRelated(list:HTMLUListElement|DocumentFragment,card:MemoryTreeCard,target:MemoryTreeLink){
    const {item,row,label}=this.makeRow(target.title,target.kind);
    item.classList.add('memory-related');
    // 关联卡片保留目录树同款 L/T 图标，再加一个 ↗ 表示只是关联、不是子级。
    const badge=label.querySelector<HTMLElement>('.tree-type');
    if(badge){
      const arrow=document.createElement('span');arrow.className='relation-link-badge';arrow.textContent='↗';arrow.title=t('关联卡片（只用于跳转）');arrow.setAttribute('aria-hidden','true');
      badge.after(arrow);
    }
    label.title=t('{0}（关联卡片，只用于跳转）',target.title);
    this.bindCard(row,target.id,target.kind,{parentId:card.id,childId:target.id,kind:'related'});
    list.append(item);
  }

  private makeRow(title:string,kind?:MemoryTreeLink['kind']){
    const item=document.createElement('li');
    const row=document.createElement('div');row.className='tree-row';if(kind)row.dataset.kind=kind;
    const toggle=document.createElement('button');toggle.type='button';toggle.className='tree-toggle';toggle.disabled=true;
    const label=document.createElement('button');label.type='button';label.className='tree-label';label.title=title;
    const badge=document.createElement('span');badge.setAttribute('aria-hidden','true');
    badge.className='tree-type '+(kind?'tree-type-'+kind:'relation-link-badge');
    badge.textContent=kind==='cloze'?'L':kind?'T':'↗';
    const text=document.createElement('span');text.className='tree-name';text.textContent=title;
    label.append(badge,text);row.append(toggle,label);item.append(row);
    return {item,row,label,toggle};
  }

  private bindCard(row:HTMLElement,id:string,kind:MemoryTreeLink['kind'],relation:CardRelationKey|null){
    const key=relation?.kind==='related'?JSON.stringify([relation.parentId,id]):id;
    row.dataset.selectionKey=key;
    row.onclick=event=>{
      if((event.target as HTMLElement).closest('.tree-toggle'))return;
      if(event.shiftKey){
        const visible=[...this.tree.querySelectorAll<HTMLElement>('[data-selection-key]')]
          .filter(item=>!item.closest('ul[hidden]')).map(item=>item.dataset.selectionKey!);
        if(this.selection.extend(visible,key)){this.markSelection();return;}
      }
      if(event.ctrlKey||event.metaKey){this.selection.toggle(key);this.markSelection();return;}
      this.selection.select(key);
      this.markSelection();
      this.actions.open(id);
    };
    row.oncontextmenu=event=>{event.preventDefault();this.actions.context(id,kind,relation,event);};
  }

  private branch(item:HTMLLIElement,toggle:HTMLButtonElement,title:string,collapsed:Set<string>,id:string,
    populate:(list:HTMLUListElement)=>void):void{
    const list=document.createElement('ul');
    item.append(list);toggle.disabled=false;
    const update=()=>{
      const open=!collapsed.has(id);
      list.hidden=!open;
      toggle.textContent=open?'−':'+';
      toggle.setAttribute('aria-label',(open?t('收起 '):t('展开 '))+title);
      toggle.setAttribute('aria-expanded',String(open));
      if(open&&!list.hasChildNodes())populate(list);
    };
    const flip=()=>{
      if(!collapsed.delete(id))collapsed.add(id);
      this.saveCollapsed();
      update();
      this.markSelection();
      this.updateExpandButton();
    };
    toggle.onclick=flip;
    update();
  }

  private scrollToCurrent(){
    if(!this.host.open)return;
    const selected=this.tree.querySelector<HTMLElement>('.tree-label[aria-current="true"]');
    if(selected?.closest('ul[hidden]'))return;
    if(!selected)return;
    const bounds=this.host.getBoundingClientRect(),row=selected.getBoundingClientRect();
    const top=bounds.top+this.heading.offsetHeight;
    if(row.top<top)this.host.scrollTop+=row.top-top;
    else if(row.bottom>bounds.bottom)this.host.scrollTop+=row.bottom-bounds.bottom;
  }

  openPicker(id:string){
    this.input.value='';this.results.replaceChildren();
    const search=()=>{
      clearTimeout(this.searchTimer);
      const version=++this.searchVersion;
      this.searchTimer=setTimeout(()=>void this.search(id,version),120);
    };
    this.input.oninput=search;
    this.input.onkeydown=event=>{
      if(event.isComposing)return;
      const rows=[...this.results.querySelectorAll<HTMLButtonElement>('button')];
      if(!rows.length)return;
      if(event.key==='Enter'){event.preventDefault();rows[this.activeResult]?.click();return;}
      if(!['ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();
      this.activeResult=Math.max(0,Math.min(rows.length-1,this.activeResult+(event.key==='ArrowDown'?1:-1)));
      rows.forEach((row,index)=>row.classList.toggle('is-active',index===this.activeResult));
      rows[this.activeResult].scrollIntoView({block:'nearest'});
    };
    this.picker.showModal();this.input.focus();search();
  }

  private async search(id:string,version:number){
    try{
      const cards=await window.reading.request<CardRelationCandidate[]>('searchRelatedCards',{id,query:this.input.value});
      if(!this.picker.open||version!==this.searchVersion)return;
      this.results.replaceChildren();
      this.activeResult=cards.length?0:-1;
      for(const [index,card] of cards.entries()){
        const row=document.createElement('button');row.type='button';row.textContent=card.path;
        row.classList.toggle('is-active',index===0);
        row.onclick=()=>{this.picker.close();this.actions.add(id,card.id);};
        this.results.append(row);
      }
      if(!cards.length)this.results.textContent=t('没有匹配的卡片');
    }catch(error){
      if(this.picker.open&&version===this.searchVersion)this.actions.error(String(error));
    }
  }
}
