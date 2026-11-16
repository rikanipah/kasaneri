import { t, getLocale } from '../core/i18n';
// ===== 垃圾桶 =====
// 删除 = 软删除 + trash 条目；这里做「列表 / 恢复 / 彻底删除 / 立即清理」。
// 清理策略见 database.ts trashCleanup()：超过保留天数即永久删除。
const el=(tag:string,text='',className='')=>{const node=document.createElement(tag);node.textContent=text;node.className=className;return node;};

export interface TrashItem{
  nodeId:string;deletedAt:number;parentId:string|null;kind:string;title:string;
  content?:string;answer?:string;parentTitle?:string;childCount?:number;
}

export class TrashDialog{
  private dialog=document.createElement('dialog');
  private body=document.createElement('div');
  private list=document.createElement('div');
  private note=el('p','','preference-hint');
  private sequence=0;

  constructor(private request:(action:string,payload?:any)=>Promise<any>,private onRestore:()=>void){
    this.dialog.id='trash';
    this.body.className='trash-body';
    const header=el('div','','statistics-heading');
    header.append(el('h3',t('垃圾桶')));
    this.body.append(header,this.list,this.note);
    // 底部按钮栏（与统计窗口一致，关闭在右下角）
    const footer=el('div','','dialog-actions');
    const closeButton=el('button',t('关闭')) as HTMLButtonElement;
    closeButton.onclick=()=>{this.sequence++;this.dialog.close();};
    footer.append(closeButton);
    this.dialog.append(this.body,footer);
    document.body.append(this.dialog);
  }

  async open(){
    const sequence=++this.sequence;
    await this.render(sequence);
    if(sequence===this.sequence&&!this.dialog.open)this.dialog.showModal();
  }

  private async render(sequence:number){
    const items:TrashItem[]=await this.request('trashList',{limit:300});
    if(sequence!==this.sequence)return;
    this.list.replaceChildren();
    const heading=el('div','','trash-heading');
    heading.append(el('span',t('共 {0} 项（新的在前）',items.length)));
    const cleanup=el('button',t('立即清理')) as HTMLButtonElement;
    cleanup.onclick=()=>void (async()=>{
      cleanup.disabled=true;
      try{const result=await this.request('trashCleanup',{});this.note.textContent=t('清理完成：永久删除 {0} 项。',(result.purged+result.thinned));}
      catch(reason){this.note.textContent=reason instanceof Error?reason.message:String(reason);}
      finally{cleanup.disabled=false;await this.render(sequence);}
    })();
    // 一键清空（把垃圾桶里所有条目立即永久删除）
    const emptyAll=el('button',t('清空垃圾桶')) as HTMLButtonElement;
    emptyAll.onclick=()=>void (async()=>{
      if(!items.length)return;
      if(!window.confirm(t('清空垃圾桶？将立即永久删除全部 {0} 项，内容与复习历史都会删除，无法恢复。',items.length)))return;
      emptyAll.disabled=true;cleanup.disabled=true;
      let done=0;
      try{
        for(const item of items){await this.request('trashPurge',{id:item.nodeId});done++;}
        this.note.textContent=t('已清空垃圾桶：永久删除 {0} 项。',done);
      }catch(reason){this.note.textContent=t('已删除 {0} 项后出错：{1}',done,(reason instanceof Error?reason.message:String(reason)));}
      finally{emptyAll.disabled=false;cleanup.disabled=false;await this.render(sequence);}
    })();
    heading.append(emptyAll,cleanup);
    this.list.append(heading);
    if(!items.length){this.list.append(el('p',t('垃圾桶是空的。删除的卡片会先放到这里，可以恢复或彻底删除。'),'preference-hint'));}
    for(const item of items){
      const row=el('div','','trash-item');
      const head=el('div','','trash-item-head');
      const kindLabel=item.kind==='folder'?t('文件夹'):item.kind==='cloze'?t('检测卡'):item.kind==='topic'?t('主题'):t('提取');
      head.append(el('span',kindLabel,'trash-kind trash-kind-'+item.kind));
      head.append(el('span',item.title||t('（无标题）'),'trash-item-title'));
      // 文件夹（或带下级的主题/提取）是连内容一起删的，这里标出「含 N 项」，恢复时整棵一起回来。
      const contained=Number(item.childCount)>0?t(' · 含 {0} 项',item.childCount):'';
      head.append(el('span',t('{0} · 原位置：{1} · {2}',contained,item.parentTitle||t('未归类'),new Date(Number(item.deletedAt)).toLocaleString(getLocale())),'trash-item-meta'));
      row.append(head);
      const preview=(item.content||'').trim().slice(0,160);
      if(preview)row.append(el('p',preview,'trash-item-preview'));
      const actions=el('div','','trash-item-actions');
      const restore=el('button',t('恢复')) as HTMLButtonElement;restore.className='primary';
      restore.onclick=()=>void (async()=>{
        restore.disabled=true;
        try{await this.request('trashRestore',{id:item.nodeId});this.note.textContent=t('已恢复「{0}」。',item.title);this.onRestore();}
        catch(reason){this.note.textContent=reason instanceof Error?reason.message:String(reason);}
        finally{await this.render(sequence);}
      })();
      // 垃圾桶里也能先打开看看内容，再决定恢复/删除
      const view=el('button',t('查看')) as HTMLButtonElement;
      const full=el('pre','','trash-item-full');full.hidden=true;
      view.onclick=()=>{
        const text=[(item.content||'').trim(),(item.answer||'').trim()?(t('\n\n—— 答案 ——\n{0}',(item.answer||'').trim())):''].join('');
        full.textContent=text||t('（这张卡片没有正文）');
        full.hidden=!full.hidden;view.textContent=full.hidden?t('查看'):t('收起');
      };
      const purge=el('button',t('彻底删除')) as HTMLButtonElement;
      purge.onclick=()=>void (async()=>{
        if(!window.confirm(t('彻底删除「{0}」？内容与复习记录都会被删除，无法恢复。',item.title)))return;
        purge.disabled=true;
        try{await this.request('trashPurge',{id:item.nodeId});this.note.textContent=t('已彻底删除「{0}」。',item.title);}
        catch(reason){this.note.textContent=reason instanceof Error?reason.message:String(reason);}
        finally{await this.render(sequence);}
      })();
      actions.append(view,restore,purge);
      row.append(actions,full);
      this.list.append(row);
    }
    if(!this.note.textContent)this.note.textContent=t('自动清理：超过保留天数后永久删除（保留天数在 设置 → 垃圾桶 里调整）。');
  }
}
