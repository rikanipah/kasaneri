import { t } from '../core/i18n';
// ===== 1.6 ⑧：卡片内嵌终端 =====
// 渲染层：xterm.js 视图（纯 JS，随 esbuild 打进 renderer.js；样式 xterm.css 由构建脚本复制）。
// 主进程：node-pty 起真实 shell（见 main.ts 'reading:terminal:*'）。
// 数据流：xterm 输入 → terminalInput(单向 send) → PTY；PTY 输出 → onTerminalData → xterm.write。
// 生命周期：对话框关闭时 dispose xterm 并 kill PTY；PTY 自己退出时由 onTerminalExit 提示。
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';

Terminal.strings.promptLabel=t('终端输入');
Terminal.strings.tooMuchOutput=t('输出过多，无法完整播报。');

export class TerminalDialog{
  private dialog=document.createElement('dialog');
  private host=document.createElement('div');
  private note=document.createElement('p');
  private fit=new FitAddon();
  private term:Terminal|null=null;
  private id:string|null=null;
  constructor(){
    this.dialog.id='card-terminal';
    const head=document.createElement('div');head.className='terminal-head';
    const title=document.createElement('h3');title.textContent=t('内嵌终端');
    const close=document.createElement('button');close.type='button';close.textContent=t('关闭');close.onclick=()=>this.close();
    head.append(title,close);
    this.host.className='terminal-host';this.note.className='terminal-note';
    this.dialog.append(head,this.host,this.note);
    document.body.append(this.dialog);
    // 主进程推送的事件只注册一次；按 id 过滤，防止多次打开后串台。
    window.reading.onTerminalData(event=>{if(this.term&&event.id===this.id)this.term.write(event.data);});
    window.reading.onTerminalExit(event=>{
      if(event.id!==this.id)return;
      this.note.textContent=t('终端已退出。');
      if(this.term)this.term.write(t('\r\n\x1b[33m[终端已退出]\x1b[0m\r\n'));
    });
    this.dialog.addEventListener('close',()=>{
      if(this.term){this.term.dispose();this.term=null;}
      if(this.id){window.reading.terminalKill(this.id);this.id=null;}
      this.host.replaceChildren();this.note.textContent='';
    });
    // 对话框尺寸变化时重新适配并同步 PTY 行列。
    new ResizeObserver(()=>this.syncSize()).observe(this.host);
  }
  async open(cwd?:string){
    if(this.dialog.open)return;
    this.dialog.showModal();
    try{
      const created=await window.reading.terminalNew({cwd,cols:80,rows:24});
      this.id=created.id;
      this.term=new Terminal({convertEol:false,cursorBlink:true,fontSize:13,fontFamily:'Consolas, "Cascadia Mono", monospace'});
      this.term.loadAddon(this.fit);
      this.term.open(this.host);
      this.term.onData(data=>{if(this.id)window.reading.terminalInput(this.id,data);});
      this.syncSize();
      this.term.focus();
      this.note.textContent=t('PID {0} · 退出终端或点关闭结束会话',created.pid);
    }catch(error){
      this.note.textContent=error instanceof Error?error.message:String(error);
    }
  }
  close(){if(this.dialog.open)this.dialog.close();}
  private syncSize(){
    if(!this.term||!this.host.clientWidth)return;
    try{
      this.fit.fit();
      if(this.id&&this.term.cols>0)window.reading.terminalResize(this.id,this.term.cols,this.term.rows);
    }catch{/* 对话框未布局完成时忽略 */}
  }
}
