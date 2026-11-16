import { t } from '../core/i18n';
import type { IpcMain, WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { localAddresses, normalizePeers, syncPeerPost, type SyncPeer } from './peers';
import { createSyncRequestVerifier, SYNC_CLOCK_TOLERANCE_MS } from './request-auth';
import { isConflictFile,isStudyDecision } from './resolve-conflict';
import { createSyncHttpServer } from './server';
import { pullContentVersions } from './content-transport';
import { isVersionId } from './content-versions';
import type { SyncConflictItem } from '../core/model';

type SyncDependencies = {
  contentSync?:boolean;
  call:<T=any>(action:string, payload?:unknown)=>Promise<T>;
  waitForDatabase:()=>Promise<void>;
  isDatabaseRunning:()=>boolean;
  isMainWindow:(sender:WebContents)=>boolean;
  /** 独立浏览窗口也要能读冲突列表并处理冲突（浏览卡片常驻子窗口）。 */
  isOurWindow?:(sender:WebContents)=>boolean;
  isEditingElsewhere:(sender:WebContents,nodeId:string)=>boolean;
  dataDir:string;
  stateDir:string;
  getVersion:()=>string;
  writeLog:(scope:string, detail:unknown)=>void;
};

const syncDefault={enabled:false,port:38641,peers:[] as SyncPeer[]};

export function createSyncService({
  contentSync, call, waitForDatabase, isDatabaseRunning, isMainWindow, isOurWindow, isEditingElsewhere, dataDir, stateDir, getVersion, writeLog,
}:SyncDependencies){
  // 冲突列表与冲突处理允许主窗口和独立浏览子窗口发起，其余同步操作仍只认主窗口。
  const canHandleConflicts=(sender:WebContents)=>isMainWindow(sender)||Boolean(isOurWindow?.(sender));
  let syncDeviceName=hostname();
  let syncConfig={...syncDefault};let syncPassphrase='';let syncServer:ReturnType<typeof createSyncHttpServer>|null=null;
  // 同步反馈——running 表示正在跑，logs 保存最近 30 次结果（时间/对端/条数/耗时/错误）
  let syncStatus:any={at:0,pulled:0,pushed:0,error:'',running:false,lastOk:0,lastCheck:0,logs:[] as any[]};
  let lastLogSignature='';
  function pushSyncLog(entry:any){syncStatus.logs.unshift(entry);if(syncStatus.logs.length>30)syncStatus.logs.length=30;}
  const syncDeviceId=(()=>{const file=join(stateDir,'sync-device-id');try{if(existsSync(file))return readFileSync(file,'utf8').trim();}catch{}const id=randomUUID();try{writeFileSync(file,id,'utf8');}catch{}return id;})();
  const verify=createSyncRequestVerifier(join(stateDir,'sync-requests.sqlite'));

  async function startSyncServer(){
    if(syncServer){syncServer.close();syncServer=null;}
    if(!syncConfig.enabled)return;
    syncServer=createSyncHttpServer({
      contentSync,passphrase:()=>syncPassphrase,verify,waitForDatabase,call,getVersion,deviceId:syncDeviceId,
      promoteLegacyDecisions,writeConflicts,
      onError:error=>{syncStatus.error=error instanceof Error?error.message:String(error);},
    });
    syncServer.listen(syncConfig.port);
  }

  // 冲突文件目录 = <data>/conflicts，文件名带日期时间与卡片 id（类似 Syncthing 的 .sync-conflict）
  const conflictsDir=join(dataDir,'conflicts');
  async function writeConflicts(list:any[],peer:string){
    try{
      await mkdir(conflictsDir,{recursive:true});
      for(const item of list){
        const stamp=new Date(item.opAt||Date.now()).toISOString().replace(/[:.]/g,'-');
        const id=createHash('sha256').update(JSON.stringify([item.opId,item.local?.id,item.localAt])).digest('hex').slice(0,20);
        const file=join(conflictsDir,stamp+'_'+id+'.json');
        const payload={at:item.opAt,peer,...item};
        await writeFile(file,JSON.stringify(payload,null,2),'utf8');
      }
      syncStatus.conflicts=countConflicts();
    }catch{}
  }
  function countConflicts(){try{return readdirSync(conflictsDir).filter((name:string)=>name.endsWith('.json')).length;}catch{return 0;}}
  let promotion:Promise<void>|undefined;
  function promoteLegacyDecisions(){
    return promotion??=(async()=>{
      const items=await call('syncLegacyDecisions');
      for(const {file,choice} of items){
        if(!isConflictFile(file))continue;
        try{
          const conflict=JSON.parse(readFileSync(join(conflictsDir,file),'utf8'));
          await call('syncResolveConflict',{file,choice,conflict});
        }catch(error){writeLog(t('同步历史选择'),error);}
      }
    })().catch(error=>{promotion=undefined;throw error;});
  }
  async function listScheduleConflicts():Promise<SyncConflictItem[]>{
    try{
      await mkdir(conflictsDir,{recursive:true});
      const names=readdirSync(conflictsDir).filter((name:string)=>name.endsWith('.json')).sort().reverse();
      const items=names.map((name:string)=>{
        let info:any={};
        try{info=JSON.parse(readFileSync(join(conflictsDir,name),'utf8'));}catch{}
        return {kind:'schedule' as const,file:name,at:Number(info.at||0),nodeId:String(info.nodeId||''),peer:String(info.peer||''),detail:info,
          selectable:isConflictFile(name)&&!!info.local&&!!info.incoming};
      });
      const resolutions=await call('syncConflictResolutions',{items:items.map(({file,detail})=>({file,detail}))});
      return items.map(item=>({...item,...resolutions[item.file]}))
        .filter(item=>item.nodeId&&(!item.resolution||item.dispute));
    }catch{return [];}
  }

  async function syncWithPeer(base:string){
    const startedAt=Date.now();let pulled=0,pushed=0;
    let contentSummary='',contentError:Error|undefined;
    const post=syncPeerPost(base,syncPassphrase);
    // 时钟保护——先 ping 拿到对端时间，偏差超过容差就拒绝同步，
    // 否则两端 (reviewedAt, id) 全序会错乱（快的一方"未来"op 会盖掉慢的一方）。
    const ping=await post('/sync/ping',{});
    const peerNow=Number(ping.now);
    if(Number.isFinite(peerNow)){
      const skew=peerNow-Date.now();
      if(Math.abs(skew)>SYNC_CLOCK_TOLERANCE_MS){
        throw Error(t('时钟偏差 {0} 秒，请先校准两台机器的系统时间。',Math.round(Math.abs(skew)/1000)));
      }
    }
    if(contentSync&&syncPassphrase&&ping.contentVersions===1){
      try{
        const content=await pullContentVersions(post,call,ping.contentAssets===1);
        if(content.received||content.applied||content.merged||content.conflicts||content.pending||content.attachments){
          contentSummary=t(' · 内容接收 {0} / 写入 {1} / 附件 {2} / 冲突 {3} / 待处理 {4}',content.received,content.applied,content.attachments,content.conflicts,content.pending)
            +(content.merged?t(' / 自动合并 {0}',content.merged):'');
          writeLog(t('卡片内容同步'),JSON.stringify({peer:base,...content}));
        }
      }catch(error){
        contentError=Error(t('卡片内容同步失败 · {0}',syncErrorMessage(error)),{cause:error});
        writeLog(t('卡片内容同步失败 {0}',base),error);
      }
    }
    const replayed=await call('syncReplayPending');
    syncStatus.pulled+=replayed.applied;pulled+=replayed.applied;
    if(replayed.conflicts?.length)await writeConflicts(replayed.conflicts,t('先前暂存的对端操作'));
    const studyChanges=ping.studyChanges===1?1:undefined;
    const peerIndex=await post('/sync/ids',{studyChanges});
    const peerIds:string[]=peerIndex.ids||[];
    const ourIds:string[]=await call('syncIdsAll',{studyChanges});
    const peerSet=new Set(peerIds),ourSet=new Set(ourIds);
    const toFetch=peerIds.filter(id=>!ourSet.has(id));
    const toSend=ourIds.filter(id=>!peerSet.has(id));
    for(let start=0;start<toFetch.length;start+=2000){
      const batch=toFetch.slice(start,start+2000);
      const {ops}=await post('/sync/fetch',{ids:batch});
      const result=await call('syncApplyOps',{ops});syncStatus.pulled+=result.applied;pulled+=result.applied;
      // 被覆盖的操作写成冲突文件（保留内容与日期），供用户判断
      if(Array.isArray(result.conflicts)&&result.conflicts.length)await writeConflicts(result.conflicts,base);
    }
    for(let start=0;start<toSend.length;start+=2000){
      const batch=toSend.slice(start,start+2000);
      const ops=await call('syncOps',{ids:batch});
      const answer=await post('/sync/push',{ops});
      if(answer&&answer.ok===false&&answer.error==='clock-skew')throw Error(String(answer.detail||t('对端时钟与推送数据不一致。')));
      syncStatus.pushed+=ops.length;pushed+=ops.length;
    }
    if(peerIndex.scheduleChoices===1||peerIndex.scheduleChoices===2){
      await promoteLegacyDecisions();
      const own=await call('syncDecisions');
      const supportsRounds=peerIndex.scheduleChoices===2;
      const remote=(await post('/sync/decisions',{choiceRounds:supportsRounds?1:undefined,studyChanges})).decisions;
      const errors=new Set<string>();
      const compatible=studyChanges?own:own.filter((item:any)=>!isStudyDecision(item));
      const send=supportsRounds?compatible:compatible.filter((item:any)=>!item.round);
      if(send.length!==compatible.length)errors.add(t('对端需更新才能接收再次选择的排程。'));
      for(let i=0;i<send.length;i+=200){
        const result=await post('/sync/decisions',{decisions:send.slice(i,i+200)});
        for(const error of result.errors||[])errors.add(String(error));
      }
      if(Array.isArray(remote))for(let i=0;i<remote.length;i+=200){
        const result=await call('syncApplyDecisions',{decisions:remote.slice(i,i+200)});
        for(const error of result.errors||[])errors.add(String(error));
      }
      if(errors.size)throw Error([...errors].join(' '));
    }
    if(contentError)throw contentError;
    syncStatus.at=Date.now();
    syncStatus.lastOk=Date.now();
    // 没有变化就不刷日志（Syncthing 风格），只更新时间戳
    if(pulled>0||pushed>0||contentSummary){
      const signature='ok:'+base+':'+pulled+':'+pushed+contentSummary;
      if(signature!==lastLogSignature){lastLogSignature=signature;
        pushSyncLog({at:Date.now(),peer:base,ok:true,pulled,pushed,ms:Date.now()-startedAt,message:t('拉取 {0} 条 / 推送 {1} 条{2}',pulled,pushed,contentSummary)});}
    }
  }
  function syncErrorMessage(reason:unknown):string{
    if(!(reason instanceof Error))return String(reason);
    const error=reason as Error&{status?:number;cause?:{code?:string}};
    if(error.status===401)return t('口令不一致（401），请核对两台设备的同步口令。');
    if(error.status===408)return t('同步请求时间超出容差，请校准两端系统时间。');
    if(error.status===409)return t('对端拒绝了重复的同步请求。');
    if(error.cause?.code==='ECONNREFUSED')return t('连接被拒绝，请检查对端程序和端口。');
    if(error.name==='TimeoutError')return t('连接超时，请检查对端和网络。');
    return error.message;
  }
  let activeSyncCycle:Promise<void>|undefined;
  let configurationQueue=Promise.resolve();
  function runSyncCycle():Promise<void>{
    if(activeSyncCycle)return activeSyncCycle;
    if(!syncConfig.enabled||!syncConfig.peers.length)return Promise.resolve();
    activeSyncCycle=performSyncCycle([...syncConfig.peers]).finally(()=>{activeSyncCycle=undefined;});
    return activeSyncCycle;
  }
  async function performSyncCycle(peers:typeof syncConfig.peers){
    const started=Date.now(),beforePull=syncStatus.pulled,beforePush=syncStatus.pushed;
    const failures:string[]=[];
    syncStatus.running=true;
    syncStatus.lastCheck=started;
    try{
      for(const peer of peers){
        const startedAt=Date.now();
        try{await syncWithPeer(peer.address);}
        catch(error){
          const message=syncErrorMessage(error);
          failures.push(peer.name+'：'+message);
          // 同一条错误不重复刷屏，只在变化时记一条
          const signature='error:'+peer.name+':'+message;
          if(signature!==lastLogSignature){lastLogSignature=signature;
            pushSyncLog({at:Date.now(),peer:peer.name,ok:false,pulled:0,pushed:0,ms:Date.now()-startedAt,message});}
        }
      }
    }finally{
      syncStatus.error=failures.join('；');
      syncStatus.lastCycle={pulled:syncStatus.pulled-beforePull,pushed:syncStatus.pushed-beforePush,ms:Date.now()-started,failed:failures.length};
      syncStatus.running=false;
    }
  }

  function registerIpc(ipcMain:Pick<IpcMain,'handle'>){
    const state=()=>({status:{...syncStatus,conflicts:countConflicts()},config:syncConfig,deviceId:syncDeviceId,deviceName:syncDeviceName,
      hasPassphrase:Boolean(syncPassphrase),addresses:localAddresses(),port:syncConfig.port});
    ipcMain.handle('sync:configure',async(event,payload:unknown)=>{
      if(!isMainWindow(event.sender))throw Error(t('无效请求。'));
      const input=(payload||{}) as {enabled?:unknown;port?:unknown;peers?:unknown;passphrase?:unknown;name?:unknown};
      const update=configurationQueue.then(async()=>{
        if(!isDatabaseRunning())throw Error(t('资料库暂不可用。'));
        await waitForDatabase();
        const config={enabled:!!input.enabled,port:Math.max(1024,Math.min(65535,Math.floor(Number(input.port)||38641))),
          peers:normalizePeers(input.peers)};
        const passphrase=typeof input.passphrase==='string'?input.passphrase:syncPassphrase;
        const name=typeof input.name==='string'?input.name.trim().slice(0,80)||hostname():syncDeviceName;
        await call('syncSaveSettings',{config,secret:{pass:Buffer.from(passphrase,'utf8').toString('base64')},name});
        const restart=config.enabled!==syncConfig.enabled||config.port!==syncConfig.port||(config.enabled&&!syncServer?.listening);
        syncConfig=config;syncPassphrase=passphrase;syncDeviceName=name;
        if(restart)await startSyncServer();
        return state();
      });
      configurationQueue=update.then(()=>{},()=>{});
      return update;
    });
    ipcMain.handle('sync:now',async(event)=>{
      if(!isMainWindow(event.sender))throw Error(t('无效请求。'));
      await runSyncCycle();
      return state();
    });
    ipcMain.handle('sync:conflicts',async(event)=>{
      if(!canHandleConflicts(event.sender))throw Error(t('无效请求。'));
      const items=await listScheduleConflicts();
      if(contentSync)items.push(...await call<SyncConflictItem[]>('syncContentConflicts'));
      return {count:new Set(items.map(item=>item.nodeId)).size,items};
    });
    ipcMain.handle('sync:resolve-conflict',async(event,file:unknown,choice:unknown)=>{
      if(!canHandleConflicts(event.sender)||!isConflictFile(file)||(choice!=='local'&&choice!=='incoming'))
        throw Error(t('无效的冲突选择。'));
      const conflict=JSON.parse(readFileSync(join(conflictsDir,file),'utf8'));
      return call('syncResolveConflict',{file,choice,conflict});
    });
    ipcMain.handle('sync:choose-content',async(event,nodeId:unknown,heads:unknown,selected:unknown)=>{
      if(!contentSync||!canHandleConflicts(event.sender)||typeof nodeId!=='string'||!nodeId||
          !Array.isArray(heads)||!heads.every(isVersionId)||!isVersionId(selected))throw Error(t('无效的冲突选择。'));
      if(isEditingElsewhere(event.sender,nodeId))throw Error(t('请先保存并关闭这张卡片的独立编辑窗口。'));
      return call('syncChooseContent',{nodeId,heads,selected});
    });
    // 冲突处理里直接删除这张卡片（写删除版本 + 进垃圾桶），不再要求先选某一版。
    ipcMain.handle('sync:discard-content',async(event,nodeId:unknown)=>{
      if(!contentSync||!canHandleConflicts(event.sender)||typeof nodeId!=='string'||!nodeId)throw Error(t('无效的冲突处理。'));
      if(isEditingElsewhere(event.sender,nodeId))throw Error(t('请先保存并关闭这张卡片的独立编辑窗口。'));
      return call('syncDiscardContent',{nodeId});
    });
    ipcMain.handle('sync:test-peer',async(event,address:unknown)=>{
      if(!isMainWindow(event.sender)||typeof address!=='string'||!syncConfig.peers.some(peer=>peer.address===address))
        throw Error(t('请先添加该对端。'));
      const started=Date.now();
      try{
        const reply=await syncPeerPost(address,syncPassphrase)('/sync/health',{},AbortSignal.timeout(5000));
        // 同步对端可使用旧应用名称。
  if(!['kasaneri','leafloop','IncrementalReading'].includes(reply?.app)||!Number.isFinite(reply.now))
          return {ok:false,message:t('对端返回了无效响应。')};
        const duration=Date.now()-started;
        const skew=Math.abs(reply.now-started-duration/2);
        if(skew>SYNC_CLOCK_TOLERANCE_MS)
          return {ok:false,message:t('时钟偏差 {0} 秒，请先校准两端系统时间。',Math.round(skew/1000))};
        return {ok:true,message:t('连接正常 · {0} ms',duration)};
      }catch(reason){
        const error=reason as Error&{status?:number;cause?:{code?:string}};
        if(error.status===401)return {ok:false,message:t('口令不一致（401）。')};
        if(error.status===408)return {ok:false,message:t('时钟偏差超出容差，请校准两端系统时间。')};
        if(error.status===404)return {ok:false,message:t('对端不支持连接测试，请更新对端。')};
        if(error.name==='TimeoutError')return {ok:false,message:t('连接超时（5 秒）。')};
        if(error.cause?.code==='ECONNREFUSED')return {ok:false,message:t('连接被拒绝，请检查对端程序和端口。')};
        return {ok:false,message:error.status?t('对端返回 HTTP {0}。',error.status):t('连接失败，请检查对端地址和网络。')};
      }
    });
    ipcMain.handle('sync:status',async(event)=>{
      if(!isMainWindow(event.sender))throw Error(t('无效请求。'));
      return state();
    });
  }

  async function loadSettings(){
    // 恢复上次的同步设置并启动监听；每 60 秒跑一轮对等同步。
    const saved=await call<{enabled?:boolean;port?:number;peers?:unknown}>('settingGet',{key:'syncSettings'});
    if(saved){syncConfig={enabled:!!saved.enabled,port:saved.port||38641,peers:normalizePeers(saved.peers)};}
    // 设备名（可在设置里改，缺省用主机名）
    try{const savedName=await call<string|null>('settingGet',{key:'syncDeviceName'});if(savedName)syncDeviceName=String(savedName);}catch{}
    // 把上次保存的口令恢复回来，否则重启后所有对端都会 401
    try{const secret=await call<{pass?:string}|null>('settingGet',{key:'syncSecret'});
      if(secret?.pass)syncPassphrase=Buffer.from(secret.pass,'base64').toString('utf8');}catch{}
    await startSyncServer();
  }

  return {registerIpc,loadSettings};
}
