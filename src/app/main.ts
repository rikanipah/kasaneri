import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type WebContents } from 'electron';
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { EditorSlot } from '../core/model';
import { assetHandler, importAttachments, type IncomingAttachment } from './assets';
import { createBackupService, defaultBackupConfig } from './backup';
import { DatabaseClient } from './database-client';
import { installApplicationLogging } from './logging';
import { defaultDataDirectory, migrateLibraryFolder, migrateStateFiles } from './paths';
import { registerTerminalHost } from './terminal-host';
import { restoreSnapshot, writeSnapshot } from './snapshot';
import { createSyncService } from '../sync/runtime';
import { existingLibrary, readStartupConfiguration, saveStartupConfiguration, showOnboarding } from './onboarding';
import { LocalUiState } from './local-state';
import { DEFAULT_LOCALE, getLocale, parseLocale, setLocale, t } from '../core/i18n';

// Windows 11 的「自动隐藏滚动条」会让 Chromium 用 overlay 滚动条——鼠标悬停时滑块会临时变宽，
// 盖住旁边内容。这里关掉 overlay 滚动条，让样式表里的固定宽度滚动条始终生效。
app.commandLine.appendSwitch('disable-features','OverlayScrollbar');
// Linux 上让 Electron 用 Wayland（niri 下平铺/最大化才正常），并启用 Wayland 输入法
if(process.platform==='linux'){
  // Electron 的 ozone 平台在 JS 执行前就定了，这里只能设 hint；真正的 Wayland 参数
  // 由 Linux 包的 run-linux.sh 在启动命令行加上（有 WAYLAND_DISPLAY 时用 --ozone-platform=wayland）。
  app.commandLine.appendSwitch('ozone-platform-hint','auto');
  app.commandLine.appendSwitch('enable-wayland-ime');
}

protocol.registerSchemesAsPrivileged([{
  scheme:'reading-asset',
  privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true},
}]);

const appDirectory=realpathSync(app.isPackaged?dirname(app.getPath('exe')):resolve(__dirname,'..'));
const defaultDataDir=defaultDataDirectory(appDirectory);
const configuredDataDir=process.env.READING_DATA_DIR;
const dataDirectoryOverride=configuredDataDir&&existsSync(configuredDataDir)?realpathSync(configuredDataDir):configuredDataDir;
let dataDir=dataDirectoryOverride||defaultDataDir;
// ===== 数据目录分离 =====
// data\library\ 是"同步单元"：资料库 SQLite + 附件 + 可重建缓存（备份/同步只搬这个文件夹）。
// data\window-profile 是 Chromium 运行时缓存，永远不参与同步。首启自动把旧布局迁移进来。
let libraryDir=join(dataDir,'library');
// data 目录只保留「资料库 / 垃圾桶 / 快照备份」；窗口缓存与设备 id 属于本机状态，
// 挪到同级 state 目录，避免被误当成用户数据备份或同步出去。
const stateDir=join(dirname(dataDir),'state');
const startupFile=join(stateDir,'startup.json');
// 本机界面状态（聚焦的卡片等），不跟资料库/快照/同步走。
const uiState=new LocalUiState(stateDir);
function installerLocale(){
  try{return parseLocale(readFileSync(join(appDirectory,'install-language.txt'),'utf8').trim());}
  catch{return undefined;}
}
setLocale(parseLocale(uiState.get('language'))??installerLocale()??DEFAULT_LOCALE);
app.commandLine.appendSwitch('lang',getLocale());
const writeLog=installApplicationLogging(stateDir);
migrateStateFiles(dataDir,stateDir);
app.setPath('userData',join(stateDir,'window-profile'));
app.setName('Kasaneri');
// 浏览卡片里双击打开的独立编辑窗口（每个窗口只编辑一张卡）
const cardWindows=new Set<BrowserWindow>();
const approvedCardClosures=new WeakSet<BrowserWindow>();
const editorCards=new Map<number,Map<EditorSlot,Set<string>>>();
let waitingForEditors:string[]=[];
let contentRetry:ReturnType<typeof setTimeout>|undefined;
let lastContentReport=0;
function windowOf(sender:WebContents):BrowserWindow|null{
  if(window&&!window.isDestroyed()&&sender===window.webContents)return window;
  for(const child of cardWindows)if(!child.isDestroyed()&&sender===child.webContents)return child;
  return null;
}
const isOurWindow=(sender:WebContents)=>Boolean(windowOf(sender));
let database:DatabaseClient|undefined;
let contentRequestId=0, window:BrowserWindow, allowClose=false, shuttingDown=false;
let librarySwitching=false;
function activeDatabase():DatabaseClient{
  if(librarySwitching)throw Error(t('资料库正在切换。'));
  if(!database?.available)throw Error(t('资料库暂不可用。'));
  return database;
}
const waitForDatabase=async()=>activeDatabase().ready;

async function call<T=any>(action:string,payload?:unknown):Promise<T> {
  const client=activeDatabase();
  if(action!=='syncContentApply'){
    const result=await client.request<T>(action,payload);
    if(['syncApplyOps','syncReplayPending','syncApplyDecisions'].includes(action)&&window&&!window.isDestroyed()){
      const update=result as {applied?:number;conflicts?:unknown[]};
      if(update.applied||update.conflicts?.length)window.webContents.send('reading:synced-content',false);
    }
    return result;
  }
  const id=++contentRequestId;
  const result=await client.request<{applied:number;conflicts:number;editingIds?:string[]}>(action,{protectedIds:[...protectedCards()]});
  if(id>lastContentReport){
    lastContentReport=id;
    waitingForEditors=result.editingIds??[];
    retryAfterEditing();
  }
  if((result.applied||result.conflicts)&&window&&!window.isDestroyed())window.webContents.send('reading:synced-content',result.applied>0);
  return result as T;
}

function protectedCards(except?:number):Set<string>{
  const ids=new Set<string>();
  for(const [sender,slots] of editorCards){
    if(sender===except)continue;
    for(const cards of slots.values())for(const id of cards)ids.add(id);
  }
  return ids;
}

function retryAfterEditing():void{
  if(shuttingDown||contentRetry||!waitingForEditors.length)return;
  const protectedIds=protectedCards();
  if(waitingForEditors.every(id=>protectedIds.has(id)))return;
  contentRetry=setTimeout(()=>{
    contentRetry=undefined;
    if(!shuttingDown)void call('syncContentApply').catch(error=>writeLog(t('同步写回重试'),error));
  },0);
}

function editorSlot(value:unknown):value is EditorSlot{return value==='workspace'||value==='browser';}

ipcMain.handle('reading:editor-card',async(event,slot:unknown,id:unknown)=>{
  if(!isOurWindow(event.sender)||!editorSlot(slot)||typeof id!=='string'||!id)throw Error(t('无效的卡片请求。'));
  await waitForDatabase();
  if(event.sender.isDestroyed())return null;
  const sender=event.sender.id;
  let slots=editorCards.get(sender);
  if(!slots){
    slots=new Map();editorCards.set(sender,slots);
    const release=()=>{editorCards.delete(sender);retryAfterEditing();};
    event.sender.once('destroyed',release);
    event.sender.once('render-process-gone',release);
  }
  const cards=slots.get(slot)??new Set<string>();
  cards.add(id);slots.set(slot,cards);
  return call('get',{id});
});
ipcMain.on('reading:editor-active',(event,slot:unknown,id:unknown)=>{
  if(!isOurWindow(event.sender)||!editorSlot(slot)||(id!==null&&typeof id!=='string'))return;
  const slots=editorCards.get(event.sender.id);
  if(!slots)return;
  if(typeof id==='string'&&slots.get(slot)?.has(id))slots.set(slot,new Set([id]));
  else slots.delete(slot);
  retryAfterEditing();
});

async function bootDatabase():Promise<void>{
  await mkdir(dataDir,{recursive:true});
  await mkdir(libraryDir,{recursive:true});
  const worker=new Worker(join(__dirname,'worker.cjs'),{
    workerData:{libraryDir,trashDir:join(dataDir,'trash'),contentSync:true,locale:getLocale(),
      sourceVault:process.env.READING_SOURCE_VAULT},
  });
  const client=new DatabaseClient(worker,error=>{
    writeLog(t('资料库进程'),error);
    if(!shuttingDown&&window&&!window.isDestroyed())window.webContents.send('storage-error',error.message);
  });
  database=client;
  try{await client.ready;}
  catch(error){await closeDatabase().catch(()=>{});throw error;}
}

async function closeDatabase():Promise<void>{
  const client=database;
  database=undefined;
  await client?.close();
}

const allowed=new Set(['info','children','get','path','anchors','save','create','rename','move','restoreMove','remove','simulateWorkload',
  'moveCards','restoreMovedCards','setStudyEnabledBatch','restoreStudyEnabledBatch',
  'createMemoryChild','cardRelations','memoryTree','searchRelatedCards','addRelatedCard','removeCardRelation',
  'searchPrerequisites','setPrerequisite','reviewAgainDependents','recordForgotten','resetMemory','saveImageOcclusion','undoImageOcclusion',
  'undoCreation','cardTags','addCardTag','removeCardTag','search','settingGet','settingSet','asset','folders','configGet','configSave','folderCounts','nodeStudy',
  'setPriority','setStudyEnabled','buryCard','setCardHold','reviewStart','reviewStop','reviewRefresh','reviewGrade','reviewUndo','catalog','directoryPath','deckConfig','deckConfigSave','setPushEnabled','setReadingPosition','changeKind','cardInfo','statistics','readingStatistics','assetUsage','assetTrashUnused','assetTrashList','assetRestore','assetPurge','nodeMetadata','optimizeDeck','optimizeDeckApply','trashList','trashRestore','trashPurge','trashCleanup','retentionReport','optimizeDeckList','cardWindow','openPath']);
// 本机界面状态的读写（state/ui-state.json，各机器独立）。
ipcMain.handle('reading:ui-state-get',(event,key:unknown)=>{
  if(!isOurWindow(event.sender)||typeof key!=='string'||!key||key.length>64)throw Error(t('无效的本机状态请求。'));
  return uiState.get(key);
});
ipcMain.handle('reading:ui-state-set',(event,key:unknown,value:unknown)=>{
  if(!isOurWindow(event.sender)||typeof key!=='string'||!key||key.length>64)throw Error(t('无效的本机状态请求。'));
  uiState.set(key,value);
});
ipcMain.handle('reading:language-get',event=>{
  if(!isOurWindow(event.sender))throw Error(t('无效请求。'));
  return parseLocale(uiState.get('language'))??getLocale();
});
ipcMain.handle('reading:language-set',(event,value:unknown)=>{
  const language=parseLocale(value);
  if(!isOurWindow(event.sender)||!language)throw Error(t('无效请求。'));
  uiState.set('language',language);
});
ipcMain.handle('reading:request',async(event,action,payload)=>{
  if(action==='importAnkiBundle'&&windowOf(event.sender)===window){
    const bundle=(await dialog.showOpenDialog(window,{title:t('选择 Anki 导出包文件夹'),properties:['openDirectory']})).filePaths[0];
    if(!bundle)return null;
    const media=(await dialog.showOpenDialog(window,{title:t('选择 Anki collection.media 文件夹'),properties:['openDirectory']})).filePaths[0];
    if(!media)return null;
    const result=await call('importAnkiExport',{bundle,media});
    window.webContents.send('reading:synced-content',true);
    return result;
  }
  // 独立编辑窗口也走同一个 worker。
  if(!isOurWindow(event.sender)||!allowed.has(action))throw Error(t('无效请求。'));
  // 打开独立编辑窗口是主进程行为，不进 worker。
  if(action==='cardWindow'){openCardWindow(String(payload?.id||''));return true;}
  // 在文件管理器里打开某个目录（备份文件夹）
  if(action==='openPath'){const target=String((payload as any)?.path||'');if(target)await shell.openPath(target);return true;}
  const result=await call(action,payload);
  // 独立「添加卡片」等子窗口新建内容后，通知主窗口刷新目录树与计数（否则要等下次数同步才看到）
  // 带上新卡所在父级，主窗口只刷新那一个分支，避免整棵树重建造成的闪动
  if(action==='create'&&!window.isDestroyed()&&event.sender!==window.webContents)
    window.webContents.send('reading:synced-content',true,String((payload as any)?.parentId||'')||null,String((result as any)?.node?.id||'')||null);
  return result;
});
ipcMain.handle('reading:import-files',async(event,files:IncomingAttachment[])=>{
  if(!isOurWindow(event.sender)||!Array.isArray(files)||files.length>100)throw Error(t('无效附件。'));
  await waitForDatabase();
  return importAttachments(dataDir,files,call);
});
ipcMain.on('reading:window',(event,action)=>{
  const target=windowOf(event.sender);if(!target)return;
  // Linux（尤其 niri/Wayland 平铺）没有最小化语义，忽略而不是卡住窗口
  if(action==='minimize'&&process.platform!=='linux')target.minimize();
  if(action==='maximize')target.isMaximized()?target.unmaximize():target.maximize();
  if(action==='close')target.close();
});
// ===== 为某张卡片打开独立编辑窗口 =====
// 浏览卡片里双击一行 → 这里新建一个 BrowserWindow，用 ?card=<id> 告诉渲染层"只编辑这张卡"。
// 子窗口与主窗口共用同一个 worker（同一份数据库），界面走 solo 布局（隐藏目录树与功能栏）。
// 子窗口统一走这一条路径——卡片编辑（?card=）、浏览卡片（?browser=1）、添加卡片（?add=1）。
function openChildWindow(key:string,query:Record<string,string>,size:{width:number;height:number;minWidth:number;minHeight:number}){
  for(const child of cardWindows){if(child.isDestroyed()){cardWindows.delete(child);continue;}}
  const existing=[...cardWindows].find(child=>child.getTitle()===key);
  if(existing&&!existing.isDestroyed()){existing.show();existing.focus();return;}
  // 子窗口先把深色窗框显示出来（窗口本身很便宜），内容加载期间不再是"点了没反应"。
  const child=new BrowserWindow({...size,frame:false,backgroundColor:'#1e1e1e',show:false,
    webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,
      // 允许自动播放（否则 Chromium 会拦截无手势的 play()）
      autoplayPolicy:'no-user-gesture-required'}});
  child.removeMenu();child.setTitle(key);
  child.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))shell.openExternal(url);return {action:'deny'};});
  child.webContents.on('will-navigate',event=>event.preventDefault());
  child.once('ready-to-show',()=>{if(!child.isDestroyed())child.show();});
  child.on('close',event=>{
    if(approvedCardClosures.has(child)||child.webContents.isCrashed())return;
    event.preventDefault();
    child.webContents.send('reading:close-requested');
  });
  child.on('closed',()=>cardWindows.delete(child));
  cardWindows.add(child);
  void child.loadFile(join(__dirname,'index.html'),{query:{...query,locale:getLocale()}});
  return child;
}
function openCardWindow(id:string){
  openChildWindow('IR-card-'+id,{card:id},{width:920,height:760,minWidth:520,minHeight:420});
}
// 浏览卡片与「添加卡片」各自独立成窗，主窗口的工作区不被占用，也不会闪。
function openBrowserWindow(status?:'conflict',cardId?:string|null){
  const child=openChildWindow('IR-browser',{browser:'1',...(status?{status}:{}),...(cardId?{select:cardId}:{})},{width:1280,height:840,minWidth:880,minHeight:520});
  // 浏览卡片默认全屏——新窗口直接最大化（窗口还没显示，不会出现"小窗变大窗"）
  if(child&&!child.isDestroyed())child.maximize();
}
function openAddCardWindow(folderId:string|null){
  openChildWindow('IR-add',{add:'1',...(folderId?{folderId}:{})},{width:760,height:640,minWidth:560,minHeight:460});
}
function closeCardWindowFor(sender:WebContents){const target=windowOf(sender);if(target&&target!==window)target.close();}
ipcMain.handle('reading:card-window',(event,payload:unknown)=>{
  if(!isOurWindow(event.sender))throw Error(t('无效请求。'));
  const id=String((payload as any)?.id||'');if(!id)throw Error(t('卡片编号无效。'));
  openCardWindow(id);
  return true;
});
ipcMain.handle('reading:browser-window',(event,payload:unknown)=>{
  if(!isOurWindow(event.sender))throw Error(t('无效请求。'));
  openBrowserWindow((payload as any)?.status==='conflict'?'conflict':undefined,
    typeof (payload as any)?.cardId==='string'?(payload as any).cardId||null:null);
  return true;
});
ipcMain.handle('reading:add-card-window',(event,payload:unknown)=>{
  if(!isOurWindow(event.sender))throw Error(t('无效请求。'));
  const folderId=String((payload as any)?.folderId||'')||null;
  openAddCardWindow(folderId);
  return true;
});
ipcMain.on('reading:card-window-close',event=>closeCardWindowFor(event.sender));
// ===== 从卡片启动外部程序/终端 =====
// 渲染层在沙盒（sandbox:true, nodeIntegration:false）里，只有这里能 spawn。
// 安全边界（不要放松）：
//   1. 只接受本窗口发来的请求；
//   2. 始终 shell:false——command 按可执行文件路径直接执行，参数逐个传入，
//      卡片里存的字符串不会经过任何 shell 解析，命令注入无从发生；
//   3. cwd 必须真实存在且是目录，缺省回落到程序数据目录。
// 终端模式（command 为 'cmd'/'cmd.exe'/':terminal'）在 cwd 打开一个新的控制台窗口；
// 目前按 Windows cmd.exe 实现，Linux 的终端启动留待 Linux 实机验证。
ipcMain.handle('reading:launch',async(event,payload:unknown)=>{
  if(event.sender!==window.webContents)throw Error(t('无效请求。'));
  const input=(payload||{}) as {command?:unknown;args?:unknown;cwd?:unknown};
  const command=typeof input.command==='string'?input.command.trim():'';
  const args=Array.isArray(input.args)?input.args.slice(0,20).map(value=>String(value).slice(0,512)):[];
  const cwd=typeof input.cwd==='string'&&input.cwd.trim()?input.cwd.trim():dataDir;
  if(!command||command.length>512||/[\u0000-\u001f]/.test(command))throw Error(t('启动命令无效。'));
  if(!existsSync(cwd)||!statSync(cwd).isDirectory())throw Error(t('工作目录不存在：{0}',cwd));
  const terminal=command.toLowerCase()==='cmd'||command.toLowerCase()==='cmd.exe'||command===':terminal';
  const child=terminal
    ?spawn('cmd.exe',['/d','/s','/c','start','','cmd.exe'],{cwd,detached:true,stdio:'ignore',windowsHide:false})
    :spawn(command,args,{cwd,detached:true,stdio:'ignore',windowsHide:false});
  // spawn 的 ENOENT 等错误是异步事件；不监听会变成未处理异常，这里等它落定再返回。
  await new Promise<void>((resolvePromise,rejectPromise)=>{
    child.once('spawn',()=>resolvePromise());
    child.once('error',rejectPromise);
  });
  child.unref();return {ok:true,pid:child.pid};
});
ipcMain.on('reading:close-ready',event=>{
  const target=windowOf(event.sender);
  if(!target)return;
  if(target===window)allowClose=true;
  else approvedCardClosures.add(target);
  target.close();
});

const closeTerminals=registerTerminalHost(ipcMain,()=>window,()=>dataDir);

let backupService:ReturnType<typeof createBackupService>|undefined;
let snapshotQueue=Promise.resolve();
// Keep an export's database and attachments together when a restore is requested at the same time.
function withSnapshot<T>(run:()=>Promise<T>):Promise<T>{
  const work=snapshotQueue.then(async()=>{
    if(shuttingDown||librarySwitching)throw Error(t('资料库正在关闭或重启。'));
    await waitForDatabase();
    return run();
  });
  snapshotQueue=work.then(()=>{},()=>{});
  return work;
}
const exportSnapshot=(destination:string)=>withSnapshot(()=>writeSnapshot(libraryDir,destination));
ipcMain.handle('reading:snapshot:export',async(event,payload:unknown)=>{
  if(event.sender!==window.webContents)throw Error(t('无效请求。'));
  const destination=typeof payload==='string'&&payload?payload
    :(await dialog.showOpenDialog(window,{title:t('选择快照保存位置'),properties:['openDirectory','createDirectory']})).filePaths[0];
  if(!destination)return {ok:false,cancelled:true};
  return {ok:true,path:await exportSnapshot(destination)};
});
ipcMain.handle('reading:snapshot:import',async(event,payload:unknown)=>{
  if(event.sender!==window.webContents)throw Error(t('无效请求。'));
  const source=typeof payload==='string'&&payload?payload
    :(await dialog.showOpenDialog(window,{title:t('选择快照文件夹（含 manifest.json）'),properties:['openDirectory']})).filePaths[0];
  if(!source)return {ok:false,cancelled:true};
  return withSnapshot(async()=>{
    try{
      await restoreSnapshot(source,libraryDir,async()=>{
        librarySwitching=true;
        await closeDatabase();
      });
    }catch(error){
      if(librarySwitching&&!shuttingDown&&existsSync(join(libraryDir,'library.sqlite'))){
        try{
          await bootDatabase();
          librarySwitching=false;
        }catch(reason){
          writeLog(t('重新打开原资料库'),reason);
          throw Error(t('导入失败，原资料库已保留。请重启程序。'),{cause:error});
        }
      }
      throw error;
    }
    if(!shuttingDown){setTimeout(()=>{app.relaunch();app.exit(0);},600);}
    return {ok:true};
  });
});

// ===== 桌面对等同步（阶段 1，Windows/Linux 通用）=====
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(async()=>{
    const managedStartup=process.platform==='win32'&&!dataDirectoryOverride;
    let startup=managedStartup?readStartupConfiguration(startupFile):null;
    if(managedStartup&&!startup&&!existingLibrary(dataDir)){
      startup=await showOnboarding(defaultDataDir);
      if(!startup){app.quit();return;}
      saveStartupConfiguration(startupFile,startup);
    }
    if(startup){
      dataDir=startup.dataDir;
      libraryDir=join(dataDir,'library');
      if(!startup.initialOptions&&!existingLibrary(dataDir))throw Error(t('找不到上次使用的资料库：{0}',dataDir));
      migrateStateFiles(dataDir,stateDir);
    }
    migrateLibraryFolder(dataDir,libraryDir);
    await bootDatabase();
    if(startup?.initialOptions){
      const {backup,sync}=startup.initialOptions;
      await call('settingSet',{key:'backupSettings',value:{...defaultBackupConfig,enabled:backup,folder:join(dataDir,'backups')}});
      await call('settingSet',{key:'syncSettings',value:{enabled:sync,port:38641,peers:[]}});
      saveStartupConfiguration(startupFile,{dataDir});
    }
    const syncService=createSyncService({
      contentSync:true,call,waitForDatabase,dataDir,stateDir,writeLog,getVersion:()=>app.getVersion(),
      isDatabaseRunning:()=>Boolean(database?.available)&&!librarySwitching,
      isMainWindow:sender=>Boolean(window&&!window.isDestroyed()&&sender===window.webContents),
      isOurWindow,
      isEditingElsewhere:(sender,nodeId)=>protectedCards(sender.id).has(nodeId),
    });
    syncService.registerIpc(ipcMain);
    await syncService.loadSettings();
    backupService=createBackupService({
      dataDir,call,isOurWindow,exportSnapshot,
      chooseFolder:async()=>{
        const picked=await dialog.showOpenDialog(window,{title:t('选择备份文件夹'),properties:['openDirectory','createDirectory']});
        return picked.canceled?undefined:picked.filePaths[0];
      },
    });
    backupService.registerIpc(ipcMain);
    await backupService.loadSettings();
    backupService.start();
    // 垃圾桶阶段式清理——启动时跑一次，之后每 6 小时一次（永久删除超期条目）。
    const runTrashCleanup=()=>{void call('trashCleanup').catch(()=>{});};
    runTrashCleanup();setInterval(runTrashCleanup,6*3600*1000);
    protocol.handle('reading-asset',assetHandler(libraryDir,call));
    window=new BrowserWindow({
      width:1440,height:920,minWidth:760,minHeight:500,frame:false,backgroundColor:'#1e1e1e',
      show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true},
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(({url})=>{
      if(/^https?:\/\//i.test(url))shell.openExternal(url);
      return {action:'deny'};
    });
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.on('close',event=>{
      if(allowClose)return;
      event.preventDefault();
      window.webContents.send('reading:close-requested');
    });
    window.once('ready-to-show',()=>{
      window.maximize();
      window.show();
    });
    await window.loadFile(join(__dirname,'index.html'),{query:{locale:getLocale()}});
  }).catch(error=>{dialog.showErrorBox(t('程序启动失败'),String(error));app.quit();});
  app.on('window-all-closed',async()=>{
    if(!window)return; // 首次启动窗口关闭后仍要继续打开主窗口。
    shuttingDown=true;
    await backupService?.stop();
    await snapshotQueue;
    // 退出前回收所有 PTY，避免残留 shell 进程。
    closeTerminals();
    await closeDatabase().catch(()=>{});
    app.quit();
  });
}
