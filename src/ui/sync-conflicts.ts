import { t } from '../core/i18n';
import type { SyncConflictItem } from '../core/model';

export type ConflictGroup={nodeId:string;title:string;items:SyncConflictItem[]};

type Result={status:string;reason?:string};
type ConflictHandlers={
  chooseContent:(item:Extract<SyncConflictItem,{kind:'content'}>,selected:string)=>Promise<Result>;
  discard:(nodeId:string)=>Promise<Result>;
  /** 处理完一张后重新取一遍冲突列表（浏览器里的 conflicts 也一起刷新）。 */
  reload:()=>Promise<ConflictGroup[]>;
  refresh:()=>Promise<void>;
};

const pendingReason=(reason?:string)=>
  reason==='children'?t('这张卡片还有子卡片，先处理子卡片，或用正常删除流程。')
  :reason==='history'?t('卡片版本还没收齐，再同步一次后再试。')
  :reason==='editing'?t('卡片正在编辑，请先保存并关闭编辑窗口。')
  :t('暂时还不能删除：{0}',reason||t('未知原因'));

/** 冲突处理队列——处理完一张自动跳到下一张，不用关窗口再点开。
 *  底部和右键菜单都有「删除卡片」（写删除版本，卡片进垃圾桶）。 */
export function showSyncConflicts(groups:ConflictGroup[],startIndex:number,handlers:ConflictHandlers):void{
  const queue=groups.slice();
  let index=Math.max(0,Math.min(startIndex,queue.length-1));
  let busy=false;
  const dialog=document.createElement('dialog');
  dialog.className='browser-conflict-dialog';
  dialog.setAttribute('aria-label',t('冲突文件'));
  const header=document.createElement('header');
  const heading=document.createElement('h2');
  const counter=document.createElement('span');counter.className='browser-conflict-count';
  const close=document.createElement('button');close.type='button';close.textContent=t('关闭');
  close.onclick=()=>dialog.close();
  header.append(heading,counter,close);
  const body=document.createElement('div');body.className='browser-conflict-body';
  const footer=document.createElement('div');footer.className='sync-topbar';
  const discard=document.createElement('button');discard.type='button';discard.textContent=t('删除卡片');discard.className='danger';
  const hint=document.createElement('span');hint.className='browser-conflict-hint';hint.textContent=t('右键也能删除；处理完一张会自动跳到下一张');
  footer.append(discard,hint);
  const status=document.createElement('p');status.className='browser-conflict-status';status.setAttribute('role','status');
  // 右键菜单（和底部按钮同一个动作）
  const menu=document.createElement('div');menu.className='browser-conflict-menu';menu.hidden=true;
  const menuItem=document.createElement('button');menuItem.type='button';menuItem.textContent=t('删除卡片');
  menu.append(menuItem);
  dialog.append(header,body,footer,status,menu);

  dialog.addEventListener('contextmenu',event=>{
    event.preventDefault();
    if(!queue.length)return;
    const bounds=dialog.getBoundingClientRect();
    menu.style.left=Math.max(4,event.clientX-bounds.left)+'px';
    menu.style.top=Math.max(4,event.clientY-bounds.top)+'px';
    menu.hidden=false;
  });
  dialog.addEventListener('click',event=>{if(!menu.contains(event.target as Node))menu.hidden=true;});

  const current=()=>queue[index];

  const advance=async()=>{
    // 处理完当前这张：重新读冲突列表，若这张还有记录就留在原地，否则删掉并显示下一张。
    const nodeId=current()?.nodeId;
    await handlers.refresh();
    const fresh=await handlers.reload();
    const still=nodeId?fresh.find(group=>group.nodeId===nodeId):undefined;
    if(still&&nodeId){queue[index]=still;render();return;}
    if(nodeId){const at=queue.findIndex(group=>group.nodeId===nodeId);if(at>=0)queue.splice(at,1);}
    if(!queue.length){render();return;}
    if(index>=queue.length)index=queue.length-1;
    render();
  };

  const run=async(work:()=>Promise<Result>,done:(result:Result)=>string)=>{
    if(busy||!current())return;
    busy=true;menu.hidden=true;
    const buttons=[...body.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);discard.disabled=true;
    status.textContent=t('正在处理…');
    try{
      const result=await work();
      if(result.status==='applied'||result.status==='current'||result.status==='empty'){
        status.textContent=done(result);
        await advance();
        discard.disabled=false;
        if(queue.length)status.textContent=t('{0} 已跳到下一张。',done(result));
      }else if(result.status==='conflict'){
        status.textContent=t('还有别的冲突没处理完，请继续选择。');
      }else{
        status.textContent=pendingReason(result.reason);
        buttons.forEach(button=>button.disabled=false);discard.disabled=false;
      }
    }catch(error){
      status.textContent=error instanceof Error?error.message:String(error);
      buttons.forEach(button=>button.disabled=false);discard.disabled=false;
    }finally{busy=false;}
  };

  const doDiscard=()=>run(()=>handlers.discard(current().nodeId),
    result=>result.status==='applied'?t('已删除卡片，冲突记录已清除。'):t('已处理。'));
  discard.onclick=()=>void doDiscard();
  menuItem.onclick=()=>{menu.hidden=true;void doDiscard();};

  function render(){
    menu.hidden=true;
    if(!queue.length){
      heading.textContent=t('冲突文件');counter.textContent='';
      body.replaceChildren();
      const done=document.createElement('p');done.textContent=t('所有冲突都处理完了。');
      body.append(done);footer.hidden=true;
      status.textContent=t('窗口会自动关闭。');
      setTimeout(()=>{if(dialog.open)dialog.close();},1200);
      return;
    }
    footer.hidden=false;
    const group=current();
    heading.textContent=t('冲突文件 · {0}',group.title);
    counter.textContent=t('第 {0} / {1} 张',(index+1),queue.length);
    body.replaceChildren();
    for(const item of group.items){
      const section=document.createElement('section');
      const summary=document.createElement('h3');
      const controls=document.createElement('div');controls.className='sync-topbar';
      const note=document.createElement('p');note.setAttribute('role','status');
      const addChoice=(label:string,choose:()=>Promise<Result>)=>{
        const button=document.createElement('button');button.type='button';button.textContent=label;
        button.onclick=()=>void run(choose,result=>result.status==='pending'?t('已保存选择，卡片仍待写回。'):t('已应用所选版本。'));
        controls.append(button);
      };
      if(item.kind==='schedule'){
        summary.textContent=t('排程冲突{0}',(item.peer?' · '+item.peer:''));
        section.append(summary);
        const detail=document.createElement('details');
        const label=document.createElement('summary');label.textContent=t('双方排程记录');
        const record=document.createElement('pre');record.className='sync-conflict-detail';
        record.textContent=JSON.stringify({文件:item.file,记录:item.detail??null,选择分歧:item.dispute??undefined},(key,value)=>{
          if(typeof value==='string'&&['beforeState','afterState','incomingState','localState','details'].includes(key)){
            try{return JSON.parse(value);}catch{return value;}
          }
          return value;
        },2);
        detail.append(label,record);section.append(detail);
        if(item.selectable){
          for(const [choice,label] of [['local',t('本机排程')],['incoming',t('对端排程')]] as const){
            addChoice((item.dispute?t('再次选用'):t('用'))+label,async()=>{
              await window.reading.syncResolveConflict(item.file,choice);
              return {status:'applied'};
            });
          }
        }else note.textContent=t('记录缺少可应用的双方操作。');
      }else{
        summary.textContent=t('卡片内容冲突');section.append(summary);
        item.versions.forEach((version,versionIndex)=>{
          const labelText=version.id===item.localVersionId?t('本机版本'):t('版本 {0}',(versionIndex+1));
          const detail=document.createElement('details');detail.open=true;
          const label=document.createElement('summary');label.textContent=labelText;
          const record=document.createElement('pre');record.className='sync-conflict-detail';
          const value=version.value;
          record.textContent=value?[value.title,value.parentId?t('上级 {0}',value.parentId):'',value.content,
            value.answer?t('答案\n{0}',value.answer):''].filter(Boolean).join('\n\n'):t('该版本删除卡片');
          detail.append(label,record);section.append(detail);
          addChoice(t('用{0}',labelText),()=>handlers.chooseContent(item as Extract<SyncConflictItem,{kind:'content'}>,version.id));
        });
      }
      section.append(controls,note);body.append(section);
    }
  }

  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  document.body.append(dialog);
  render();
  dialog.showModal();
}
