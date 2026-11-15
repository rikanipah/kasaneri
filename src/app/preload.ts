import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ReadingBridge } from '../core/model';

const bridge:ReadingBridge={
  request:(action,payload)=>ipcRenderer.invoke('reading:request',action,payload),
  uiStateGet:key=>ipcRenderer.invoke('reading:ui-state-get',key),
  uiStateSet:(key,value)=>ipcRenderer.invoke('reading:ui-state-set',key,value),
  getLanguage:()=>ipcRenderer.invoke('reading:language-get'),
  setLanguage:value=>ipcRenderer.invoke('reading:language-set',value),
  async importFiles(files){
    const entries=[];
    for(const file of files){
      const path=webUtils.getPathForFile(file);
      entries.push(path?{path,name:file.name}:{name:file.name,bytes:new Uint8Array(await file.arrayBuffer())});
    }
    return ipcRenderer.invoke('reading:import-files',entries);
  },
  mediaUrl:id=>'reading-asset://local/'+id,
  windowAction:action=>ipcRenderer.send('reading:window',action),
  // 1.178：让渲染层知道平台（niri 这类平铺合成器没有最小化，Linux 上要隐藏最小化按钮）
  platform:process.platform,
  // 1.26：浏览卡片双击 → 独立编辑窗口
  openCardWindow:id=>ipcRenderer.invoke('reading:card-window',{id}),
  // 1.133：浏览卡片与添加卡片各自独立成窗
  openBrowserWindow:(status,cardId)=>ipcRenderer.invoke('reading:browser-window',{status,cardId}),
  openAddCardWindow:folderId=>ipcRenderer.invoke('reading:add-card-window',{folderId}),
  closeCardWindow:()=>ipcRenderer.send('reading:card-window-close'),
  onCloseRequested:callback=>ipcRenderer.on('reading:close-requested',()=>callback()),
  confirmClose:()=>ipcRenderer.send('reading:close-ready'),
  readEditorCard:(slot,id)=>ipcRenderer.invoke('reading:editor-card',slot,id),
  setEditorCard:(slot,id)=>ipcRenderer.send('reading:editor-active',slot,id),
  onSyncedContent:callback=>ipcRenderer.on('reading:synced-content',(_event,applied,parentId,nodeId)=>callback(applied,parentId,nodeId)),
  // 1.6 ⑦：启动外部程序/终端。只透传受限参数，具体校验与 spawn 在主进程完成。
  launch:request=>ipcRenderer.invoke('reading:launch',request),
  // 1.6 ⑧：内嵌终端。输入/改尺寸/关闭走单向消息，数据与退出由主进程推回；
  // 渲染层拿不到 PTY 句柄，只能通过这几个白名单方法操作。
  terminalNew:request=>ipcRenderer.invoke('reading:terminal:new',request),
  terminalInput:(id,data)=>ipcRenderer.send('reading:terminal:input',{id,data}),
  terminalResize:(id,cols,rows)=>ipcRenderer.send('reading:terminal:resize',{id,cols,rows}),
  terminalKill:id=>ipcRenderer.send('reading:terminal:kill',{id}),
  onTerminalData:callback=>ipcRenderer.on('reading:terminal:data',(_event,payload)=>callback(payload as {id:string;data:string})),
  onTerminalExit:callback=>ipcRenderer.on('reading:terminal:exit',(_event,payload)=>callback(payload as {id:string})),
  // 1.8：快照导出/导入（同步方案阶段 0）。target/source 缺省时由主进程弹目录选择框。
  exportSnapshot:target=>ipcRenderer.invoke('reading:snapshot:export',target),
  importSnapshot:source=>ipcRenderer.invoke('reading:snapshot:import',source),
  // 1.9：桌面对等同步。配置即时生效（开启监听/更新对端），passphrase 只用于派生 HMAC 密钥、不落盘。
  syncConfigure:config=>ipcRenderer.invoke('sync:configure',config),
  syncNow:()=>ipcRenderer.invoke('sync:now'),
  syncStatus:()=>ipcRenderer.invoke('sync:status'),
  syncTestPeer:address=>ipcRenderer.invoke('sync:test-peer',address),
  syncConflicts:()=>ipcRenderer.invoke('sync:conflicts'),
  syncResolveConflict:(file,choice)=>ipcRenderer.invoke('sync:resolve-conflict',file,choice),
  syncChooseContent:(nodeId,heads,selected)=>ipcRenderer.invoke('sync:choose-content',nodeId,heads,selected),
  syncDiscardContent:nodeId=>ipcRenderer.invoke('sync:discard-content',nodeId),
  // 1.30：自动备份
  backupStatus:()=>ipcRenderer.invoke('backup:status'),
  backupConfigure:config=>ipcRenderer.invoke('backup:configure',config),
  backupChooseFolder:()=>ipcRenderer.invoke('backup:choose'),
  backupNow:()=>ipcRenderer.invoke('backup:now'),
};
contextBridge.exposeInMainWorld('reading',bridge);
