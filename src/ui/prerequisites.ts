import { t } from '../core/i18n';
import type {CardRelationCandidate,DependencyOverride,PrerequisiteChange,PrerequisiteState} from '../core/model';

interface Actions {
  search(query:string):Promise<CardRelationCandidate[]>;
  change(input:PrerequisiteChange):Promise<PrerequisiteState>;
}

export function prerequisiteSection(id:string,state:PrerequisiteState,actions:Actions):HTMLElement{
  const section=document.createElement('section');section.className='prerequisite-panel';section.setAttribute('aria-label',t('先修卡片'));
  const header=document.createElement('div');header.className='prerequisite-heading';
  const title=document.createElement('h4');title.textContent=t('先修卡片');
  const status=document.createElement('span');status.className='prerequisite-status';status.setAttribute('role','status');
  const add=document.createElement('button');add.type='button';add.textContent=t('添加先修');
  add.setAttribute('aria-expanded','false');
  header.append(title,status,add);
  const search=document.createElement('div');search.className='prerequisite-search';search.hidden=true;
  const input=document.createElement('input');input.type='search';input.placeholder=t('输入检测卡名称或路径');
  input.setAttribute('aria-label',t('查找先修卡片'));
  const results=document.createElement('div');results.className='prerequisite-results';
  search.append(input,results);
  const list=document.createElement('ul');list.className='prerequisite-list';
  const feedback=document.createElement('p');feedback.className='prerequisite-error';feedback.setAttribute('role','alert');feedback.hidden=true;
  section.append(header,search,list,feedback);
  let busy=false,version=0,timer:ReturnType<typeof setTimeout>|undefined;

  const toggleSearch=(visible:boolean)=>{
    search.hidden=!visible;add.setAttribute('aria-expanded',String(visible));
    add.textContent=visible?t('收起搜索'):t('添加先修');
    if(visible){input.value='';input.focus();scheduleSearch();}
    else{version++;clearTimeout(timer);results.replaceChildren();}
  };
  const fail=(error:unknown)=>{
    feedback.textContent=error instanceof Error?error.message:String(error);
    feedback.hidden=false;
  };
  const change=async(prerequisiteId:string,mode:DependencyOverride,expected:DependencyOverride)=>{
    if(busy)return;
    busy=true;feedback.hidden=true;
    try{
      state=await actions.change({id,prerequisiteId,mode,expected});
      toggleSearch(false);
      render();
    }catch(error){fail(error);}
    finally{busy=false;}
  };
  const render=()=>{
    status.textContent=state.blocked?t('等待先修'):t('未锁定');status.hidden=!state.cards.length;
    status.classList.toggle('is-blocked',state.blocked);
    list.replaceChildren();
    if(!state.cards.length){
      const empty=document.createElement('li');empty.className='prerequisite-empty';empty.textContent=t('无先修卡片');list.append(empty);
    }
    for(const card of state.cards){
      const row=document.createElement('li');row.className='prerequisite-row';
      const name=document.createElement('span');name.className='prerequisite-name';name.textContent=card.title;name.title=card.title;
      const detail=document.createElement('span');detail.className='prerequisite-detail';
      detail.textContent=(card.inherited?t('记忆树'):t('手动'))+' · '+(card.mode==='ignore'?t('已忽略'):
        card.blocked?t('等待上游先修'):card.mastered?t('已掌握'):t('未掌握'));
      const action=document.createElement('button');action.type='button';
      action.textContent=card.inherited?(card.mode==='ignore'?t('恢复默认'):t('忽略')):t('移除');
      action.setAttribute('aria-label',action.textContent+' '+card.title);
      action.onclick=()=>void change(card.id,card.inherited&&card.mode!=='ignore'?'ignore':null,card.mode);
      row.append(name,detail,action);list.append(row);
    }
  };
  const searchCards=async(sequence:number)=>{
    try{
      const candidates=await actions.search(input.value);
      if(sequence!==version||!section.isConnected)return;
      results.replaceChildren();
      for(const candidate of candidates.filter(card=>!state.cards.some(existing=>existing.id===card.id)).slice(0,12)){
        const button=document.createElement('button');button.type='button';button.textContent=candidate.path;
        button.onclick=()=>void change(candidate.id,'require',null);
        results.append(button);
      }
      if(!results.childElementCount)results.textContent=t('没有可添加的检测卡片');
    }catch(error){if(sequence===version&&section.isConnected)fail(error);}
  };
  const scheduleSearch=()=>{
    clearTimeout(timer);
    results.replaceChildren();
    const sequence=++version;timer=setTimeout(()=>void searchCards(sequence),120);
  };
  add.onclick=()=>{if(!busy)toggleSearch(search.hidden===true);};
  input.oninput=scheduleSearch;
  input.onkeydown=event=>{
    if(event.isComposing)return;
    if(event.key==='Enter'){event.preventDefault();results.querySelector('button')?.click();}
    if(event.key==='Escape'){event.preventDefault();toggleSearch(false);add.focus();}
  };
  render();
  return section;
}
