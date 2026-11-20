import { t } from '../core/i18n';
import type { NodeKind,TreeNode } from '../core/model';
import { setIcon } from './icons';

export type TreeType='topic'|'material'|'cloze';

const sortModes=['position','name-asc','name-desc','type'] as const;
export type TreeSort=typeof sortModes[number];
const naturalName=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
const typeOrder:Record<NodeKind,number>={folder:0,topic:1,material:2,cloze:3};

export function sortTreeRows<T extends {title:string;kind:NodeKind}>(rows:readonly T[],sort:TreeSort):T[]{
  return [...rows].sort((a,b)=>{
    const folders=Number(b.kind==='folder')-Number(a.kind==='folder');
    if(folders)return folders;
    if(sort==='type')return typeOrder[a.kind]-typeOrder[b.kind];
    if(sort==='position')return 0;
    return naturalName.compare(a.title,b.title)*(sort==='name-desc'?-1:1);
  });
}

export function bindTreeSort(host:HTMLElement,setting:string,apply:(sort:TreeSort)=>void):void{
  const buttons=[...host.querySelectorAll<HTMLButtonElement>('button[data-sort]')];
  const choose=(sort:TreeSort)=>{
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.sort===sort));
    apply(sort);
  };
  let saved:string|null=null;
  try{saved=localStorage.getItem(setting);}catch{}
  choose(sortModes.find(mode=>mode===saved)??'position');
  for(const button of buttons)button.onclick=()=>{
    const sort=button.dataset.sort as TreeSort;
    choose(sort);
    try{localStorage.setItem(setting,sort);}catch{}
    host.hidePopover();
  };
}

export class TreeSelection {
  anchor:string|null=null;
  private selected=new Set<string>();

  select(id:string|null):void{
    this.anchor=id;
    this.selected=id===null?new Set():new Set([id]);
  }

  selectMany(ids:string[]):void{
    this.anchor=ids[0]??null;
    this.selected=new Set(ids);
  }

  toggle(id:string):void{
    if(this.selected.delete(id)){
      if(this.anchor===id)this.anchor=[...this.selected].at(-1)??null;
    }else{
      this.selected.add(id);
      this.anchor=id;
    }
  }

  includes(id:string):boolean{return this.selected.has(id);}

  extend(ids:string[],id:string):boolean{
    if(this.anchor===null)return false;
    const start=ids.indexOf(this.anchor),end=ids.indexOf(id);
    if(start<0||end<0)return false;
    this.selected=new Set(ids.slice(Math.min(start,end),Math.max(start,end)+1));
    return true;
  }
}

export function updateTreeToggle(button:HTMLButtonElement,expanded:boolean):void{
  const label=t(expanded?'收起全部':'展开全部');
  if(button.title===label&&button.firstChild)return;
  button.title=label;
  button.setAttribute('aria-label',label);
  setIcon(button,expanded?'chevrons-in':'chevrons-out');
}

export function updateTreeFilters(host:HTMLElement,types:readonly TreeType[]):void{
  for(const button of host.querySelectorAll<HTMLButtonElement>('button[data-type]')){
    button.setAttribute('aria-pressed',String(types.includes(button.dataset.type as TreeType)));
  }
}

export function bindTreeFilters(host:HTMLElement,pick:(type:TreeType)=>void):void{
  for(const button of host.querySelectorAll<HTMLButtonElement>('button[data-type]')){
    button.onclick=event=>{event.preventDefault();pick(button.dataset.type as TreeType);};
  }
}

/** 2026-11-17：两棵树的表头搜索。点开输入即按标题全文检索卡片，回车或点击打开。 */
export function bindTreeSearch(popover:HTMLElement,search:(query:string)=>Promise<TreeNode[]>,pick:(id:string)=>void):void{
  const input=popover.querySelector<HTMLInputElement>('.tree-search-input')!;
  const results=popover.querySelector<HTMLElement>('.tree-search-results')!;
  let timer:ReturnType<typeof setTimeout>|undefined,version=0,entries:TreeNode[]=[],active=-1;
  const close=()=>{if(popover.matches(':popover-open'))popover.hidePopover();};
  const mark=()=>{
    [...results.children].forEach((child,index)=>child.classList.toggle('is-active',index===active));
    results.children[active]?.scrollIntoView({block:'nearest'});
  };
  const show=(nodes:TreeNode[]|null)=>{
    entries=nodes??[];active=nodes?.length?0:-1;
    results.replaceChildren();
    if(nodes&&!nodes.length){
      const empty=document.createElement('p');empty.className='tree-search-empty';empty.textContent=t('没有匹配的卡片');
      results.append(empty);return;
    }
    for(const node of entries){
      const button=document.createElement('button');
      button.type='button';button.setAttribute('role','option');button.dataset.id=node.id;button.title=node.title;
      const badge=document.createElement('span');badge.className='tree-type tree-type-'+node.kind;badge.textContent=node.kind==='cloze'?'L':'T';
      badge.setAttribute('aria-hidden','true');
      const text=document.createElement('span');text.className='tree-name';text.textContent=node.title;
      button.append(badge,text);
      button.onclick=()=>{const id=node.id;close();pick(id);};
      results.append(button);
    }
    mark();
  };
  const run=async()=>{
    const query=input.value.trim(),current=++version;
    if(!query){show(null);return;}
    try{
      const nodes=await search(query);
      if(current===version)show(nodes);
    }catch{/* 出错时保留上一次的结果，不打断输入 */}
  };
  input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>void run(),150);};
  input.onkeydown=event=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      if(!entries.length)return;
      event.preventDefault();
      active=(active+(event.key==='ArrowDown'?1:entries.length-1))%entries.length;
      mark();
    }else if(event.key==='Escape'){
      event.preventDefault();close();
    }else if(event.key==='Enter'){
      const node=entries[active]??entries[0];
      if(!node)return;
      event.preventDefault();close();pick(node.id);
    }
  };
  popover.addEventListener('toggle',event=>{
    if((event as Event&{newState?:string}).newState!=='open')return;
    clearTimeout(timer);version++;input.value='';show(null);input.focus();
  });
}

