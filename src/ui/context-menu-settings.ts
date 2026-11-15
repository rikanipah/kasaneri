import { t } from '../core/i18n';

// The existing labels are also persisted menu IDs. Translate at display time.
const common=['修改显示名','移至…'];
const createCards=['新建提取','新建检测卡'];
const memory=['新建检测子卡片','关联卡片…'];
const conversions=['转换为主题','转换为提取','转换为检测卡'];
const tools=['运行启动命令','设置启动命令…','内嵌终端'];
const review=['卡片信息','记录一次遗忘','重置记忆信息…'];
const folders=[...common,'进入复习','新建子文件夹','新建主题',...createCards,'牌组统计','复习设置','删除文件夹'];
const cards=(kind:string)=>[...common,...(kind==='主题'?['新建子主题']:[]),...createCards,...(kind==='检测卡'?memory:[]),
  ...conversions.filter(label=>label!=='转换为'+kind),...(kind==='检测卡'?review:['卡片信息']),
  ...tools,...(kind==='检测卡'?['加入／暂停复习','搁置／恢复待办']:['搁置／恢复待办']),'删除卡片'];

export const contextMenus={
  blank:['目录树空白处','右键目录树里没有文件夹或卡片的地方。',['新建文件夹']],
  folder:['目录树文件夹','右键目录树中的文件夹或牌组。',folders],
  topic:['目录树主题','右键目录树中的主题。',cards('主题')],
  material:['目录树提取','右键目录树中的摘录卡片。',cards('提取')],
  cloze:['目录树检测卡','右键目录树中的检测卡，包含记录遗忘和重置记忆。',cards('检测卡')],
  browser:['浏览卡片','右键浏览表格中的卡片。选项随卡片类型变化。',[...new Set([...cards('检测卡'),...cards('主题'),'冲突文件…','恢复卡片'])]],
  relation:['记忆树','右键记忆树中的检测卡或关联卡片。',['打开','在目录树中定位','卡片信息',...memory,'解除关系']],
  editor:['正文或答案','在可编辑的正文或答案区域右键。',['插入附件…']],
  image:['正文图片','在可编辑的库内图片上右键。',['图片遮挡…']],
} satisfies Record<string,[string,string,string[]]>;

type MenuKind=keyof typeof contextMenus;
type Layout={order:string[];hidden:string[]};
let layouts:Partial<Record<MenuKind,Layout>>={};
export async function loadContextMenus(){
  layouts=await window.reading.request<typeof layouts>('settingGet',{key:'contextMenuLayouts'})||{};
}

function layout(kind:MenuKind):Layout{
  const defaults=contextMenus[kind][2],saved=layouts[kind];
  const order=Array.isArray(saved?.order)?saved.order.filter(id=>defaults.includes(id)):[];
  return {order:[...new Set([...order,...defaults])],hidden:Array.isArray(saved?.hidden)?saved.hidden:[]};
}

export function arrangeContextMenu(menu:HTMLElement,kind:MenuKind):boolean{
  if(!layouts[kind])return !!menu.querySelector('button:not([hidden])');
  const {order,hidden}=layout(kind);
  const buttons=[...menu.querySelectorAll('button')];
  const byId=new Map(buttons.map(button=>[button.dataset.action,button]));
  for(const id of order){
    const button=byId.get(id);
    if(!button)continue;
    if(hidden.includes(id))button.remove();
    else menu.append(button);
  }
  menu.querySelectorAll('hr').forEach(rule=>rule.remove());
  return !!menu.querySelector('button:not([hidden])');
}

export function contextMenuPreferences():HTMLElement{
  const host=document.createElement('section');
  const choice=document.createElement('select');choice.setAttribute('aria-label',t('右键菜单场景'));
  const description=document.createElement('p');description.className='preference-hint';
  const rows=document.createElement('div');
  const feedback=document.createElement('p');feedback.className='preference-error';feedback.setAttribute('role','status');
  for(const [id,[label]] of Object.entries(contextMenus))choice.add(new Option(t(label),id));
  const reset=document.createElement('button');reset.type='button';reset.textContent=t('恢复此菜单默认');
  const toolbar=document.createElement('div');toolbar.className='preference-optimize';toolbar.append(choice,reset);
  host.append(toolbar,description,rows,feedback);
  const save=async(kind:MenuKind,value?:Layout)=>{
    const old=layouts;layouts={...layouts,[kind]:value};render();
    try{await window.reading.request('settingSet',{key:'contextMenuLayouts',value:layouts});feedback.textContent='';}
    catch(error){layouts=old;render();feedback.textContent=String(error);}
  };
  const render=()=>{
    const kind=choice.value as MenuKind;
    const {order,hidden}=layout(kind);
    description.textContent=t(contextMenus[kind][1])+t(' 勾选可将选项加回菜单。仅在适用时显示。');
    rows.replaceChildren();
    order.forEach((id,index)=>{
      const row=document.createElement('div');row.className='setting-row';
      const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=!hidden.includes(id);
      check.onchange=()=>void save(kind,{order,hidden:check.checked?hidden.filter(key=>key!==id):[...hidden,id]});
      label.append(check,' '+t(id));
      const controls=document.createElement('div');controls.className='context-order-buttons';
      for(const [direction,text] of [[-1,t('上移')],[1,t('下移')]] as const){
        const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute('aria-label',text+' '+t(id));
        button.disabled=index+direction<0||index+direction>=order.length;
        button.onclick=()=>{
          const next=[...order];
          [next[index],next[index+direction]]=[next[index+direction]!,next[index]!];
          void save(kind,{order:next,hidden});
        };
        controls.append(button);
      }
      row.append(label,controls);rows.append(row);
    });
  };
  choice.onchange=render;
  reset.onclick=()=>void save(choice.value as MenuKind);
  render();
  return host;
}
