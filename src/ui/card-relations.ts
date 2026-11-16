import { t } from '../core/i18n';
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
    const sameTree=roots.length===this.roots.length&&roots.every((root,index)=>root===this.roots[index]);
    const signature=JSON.stringify([roots,cards.map(({onPath,...card})=>card)]);
    this.cardId=id;
    this.host.hidden=false;
    if(signature===this.signature){
      const row=this.tree.querySelector<HTMLElement>('li[data-memory-id="'+CSS.escape(id)+'"] > .tree-row');
      const alreadyActive=row?.classList.contains('is-active');
      this.markActive(row);
      if(changed&&!alreadyActive)this.scrollToCurrent();
      return;
    }
    this.signature=signature;
    // 内容默认全部展开，只记住用户手动收起的节点；切卡/刷新不改状态。
    this.roots=roots;
    this.cards=new Map(cards.map(card=>[card.id,card]));
    const next=document.createDocumentFragment();
    for(const root of roots)this.appendCard(next,root);
    this.tree.replaceChildren(next);
    this.host.scrollTop=sameTree?scrollTop:0;
    if(changed||!sameTree)this.scrollToCurrent();
  }

  private markActive(row:HTMLElement|null){
    for(const row of this.tree.querySelectorAll<HTMLElement>('.tree-row.is-active')){
      row.classList.remove('is-active');row.querySelector('.tree-label')?.removeAttribute('aria-current');
    }
    if(row){row.classList.add('is-active');row.querySelector('.tree-label')?.setAttribute('aria-current','true');}
  }

  private appendCard(list:HTMLUListElement|DocumentFragment,id:string,parentId?:string){
    const card=this.cards.get(id)!;
    const {item,row,label,toggle}=this.makeRow(card.title,card.kind);
    const relation:CardRelationKey|null=parentId?{parentId,childId:id,kind:'memory'}:null;
    item.dataset.memoryId=id;
    this.bindCard(row,label,id,card.kind,relation);
    if(id===this.cardId){row.classList.add('is-active');label.setAttribute('aria-current','true');}
    list.append(item);
    if(card.children.length||card.related.length){
      this.branch(item,toggle,card.title,this.collapsed,id,children=>{
        for(const child of card.children)this.appendCard(children,child,id);
        // 关联卡片不再单独一行做分组，直接和子卡片并列显示，靠 ↗ 标记区分。
        for(const target of card.related)this.appendRelated(children,card,target);
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
    this.bindCard(row,label,target.id,target.kind,{parentId:card.id,childId:target.id,kind:'related'});
    list.append(item);
  }

  private makeRow(title:string,kind?:MemoryTreeLink['kind']){
    const item=document.createElement('li');
    const row=document.createElement('div');row.className='tree-row';
    const toggle=document.createElement('button');toggle.type='button';toggle.className='tree-toggle';toggle.disabled=true;
    const label=document.createElement('button');label.type='button';label.className='tree-label';label.title=title;
    const badge=document.createElement('span');badge.setAttribute('aria-hidden','true');
    badge.className='tree-type '+(kind?'tree-type-'+kind:'relation-link-badge');
    badge.textContent=kind==='cloze'?'L':kind?'T':'↗';
    const text=document.createElement('span');text.className='tree-name';text.textContent=title;
    label.append(badge,text);row.append(toggle,label);item.append(row);
    return {item,row,label,toggle};
  }

  private bindCard(row:HTMLElement,label:HTMLButtonElement,id:string,kind:MemoryTreeLink['kind'],relation:CardRelationKey|null){
    // 单击选中并打开卡片，收展由行左侧的 +／− 控制。
    label.onclick=()=>{
      this.markActive(row);
      this.actions.open(id);
    };
    row.oncontextmenu=event=>{event.preventDefault();this.actions.context(id,kind,relation,event);};
  }

  private branch(item:HTMLLIElement,toggle:HTMLButtonElement,title:string,collapsed:Set<string>,id:string,
    populate:(list:HTMLUListElement)=>void):()=>void{
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
      try{localStorage.setItem('ir.memoryTree.collapsed',JSON.stringify([...collapsed]));}catch{}
      update();
    };
    toggle.onclick=flip;
    update();
    return flip;
  }

  private scrollToCurrent(){
    if(!this.host.open)return;
    const selected=this.tree.querySelector<HTMLElement>('.tree-row.is-active');
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
