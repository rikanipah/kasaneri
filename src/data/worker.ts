import {parentPort,workerData} from 'node:worker_threads';
import { DEFAULT_LOCALE, parseLocale, setLocale, t } from '../core/i18n';
import {join} from 'node:path';
import {Repository} from './database';
import {StudyService} from '../study/study';
import {CardCatalog} from '../catalog';
import {CardRelations} from './card-relations';
import {DirectoryProjection} from '../folders/directory';
import {importAsset,importVault} from './import-vault';
import {seedDefaultLibrary} from './seed-library';
import {existsSync} from 'node:fs';
import {imagePreview} from './image-preview';
import {saveImageOcclusion,undoImageOcclusion} from './image-occlusion';
import {MIN_OPTIMIZATION_REVIEWS,optimizeParameters,retentionReport} from '../study/optimizer';
import {importAnkiExport} from './import-anki';
import {applySyncOps,collectSyncIds,collectSyncOps,replayPendingSyncOps} from '../sync/engine';
import {ContentJournal} from '../sync/content-journal';
import {ContentAssets} from '../sync/content-assets';
import {applySyncDecisions,collectSyncDecisions,conflictResolutionKey,isConflictFile,isObsoleteConflict,resolveSyncConflict,syncDecisionFor,syncDecisionDispute} from '../sync/resolve-conflict';
const port=parentPort!;
setLocale(parseLocale(workerData.locale)??DEFAULT_LOCALE);
let repository:Repository,study:StudyService,catalog:CardCatalog,directory:DirectoryProjection,relations:CardRelations;
let journal:ContentJournal|undefined;
let assets:ContentAssets|undefined;
function contentJournal():ContentJournal{
  if(workerData.contentSync!==true)throw Error(t('卡片内容同步未启用。'));
  return journal??=new ContentJournal(repository);
}
function contentAssets():ContentAssets{
  if(workerData.contentSync!==true)throw Error(t('卡片内容同步未启用。'));
  return assets??=new ContentAssets(repository);
}
const ready=(async()=>{
  // workerData.libraryDir 是同步单元根目录（见 main.ts 的 migrateLibraryFolder）。
  // 垃圾桶文件夹与数据库文件夹同级——data/library 与 data/trash
  const libraryDir=workerData.libraryDir||workerData.dataDir;
  repository=new Repository(libraryDir,String(workerData.trashDir||join(libraryDir,'..','trash')));
 // 没有文件夹就建「默认」；旧库的「未归类」按当前设置改名。
 repository.ensureDefaultFolder();
  if(!repository.getSetting('importComplete')&&workerData.sourceVault&&existsSync(workerData.sourceVault))importVault(repository,workerData.sourceVault);
  study=await StudyService.create(repository);catalog=new CardCatalog(repository);directory=new DirectoryProjection(repository);
  // 全新的资料库在默认文件夹里放一份使用引导（老库不受影响）
  seedDefaultLibrary(repository,id=>study.register(id));
  relations=new CardRelations(repository);port.postMessage({ready:true,info:repository.info()});
})();
void ready.catch(error=>port.postMessage({fatal:error instanceof Error?error.message:String(error)}));
port.on('message',async({id,action,payload})=>{
  try{
    await ready;let result:unknown;
    switch(action){
      case 'info':result=repository.info();break;
      case 'children':result=directory.children(payload||{});break;
      case 'directoryBranches':result=directory.branches(payload?.types);break;
      case 'directoryPath':result=directory.path(payload.id,payload.types);break;
      case 'folders':result=repository.folders();break;
      case 'get':result=repository.getNode(payload.id);break;
      case 'editorGet':result=repository.getNodeForEditor(payload.id);break;
      case 'path':result=repository.path(payload.id);break;
      case 'anchors':result=repository.anchors(payload.id);break;
      // 2026-11-20：拖高亮棍改锚点边界（按行给 from/to）
      case 'setAnchor':result=repository.setAnchor({id:String(payload?.id||''),from:Number(payload?.from)||0,to:Number(payload?.to)||0});break;
      case 'save':result=repository.save(payload);study.register(payload.id);study.invalidate();break;
      case 'saveImageOcclusion':
        result=saveImageOcclusion(repository,payload,id=>study.register(id));directory.invalidate();study.invalidate();break;
      case 'undoImageOcclusion':
        undoImageOcclusion(repository,payload);directory.invalidate();study.invalidate();break;
      case 'create':
      case 'createMemoryChild':{
        const created=action==='create'?repository.create(payload):relations.createChild(payload.id,payload.title,payload.kind);
        study.register(created.node.id);
        repository.setSetting('studySeededV3',true);directory.invalidate();if(created.node.kind==='folder')await study.hierarchyChanged();result=created;break;
      }
      case 'cardRelations':result=relations.list(payload.id);break;
      case 'memoryTree':result=relations.tree(payload.id);break;
      case 'searchRelatedCards':result=relations.search(payload.id,payload.query);break;
      case 'searchPrerequisites':result=relations.search(payload.id,payload.query,true);break;
      case 'setPrerequisite':result=study.setPrerequisite(payload);break;
      case 'addRelatedCard':result=relations.addRelated(payload.id,payload.targetId);break;
      case 'addMemoryChild':result=relations.addMemoryChild(payload.id,payload.targetId);if(result)study.invalidate();break;
      case 'removeAllCardRelations':result=relations.removeAll(payload.id);if(result)study.invalidate();break;
      case 'removeCardRelation':
        result=relations.remove(payload.id,payload.relation);
        if(result&&payload.relation.kind==='memory')study.invalidate();
        break;
      case 'rename':result=repository.rename(payload.id,payload.title);break;
      case 'move':result=repository.move(payload.id,payload.parentId);directory.invalidate();await study.hierarchyChanged();break;
      case 'restoreMove':result=repository.move(payload.id,payload.parentId,{expectedParentId:payload.expectedParentId});directory.invalidate();await study.hierarchyChanged();break;
      case 'moveCards':{
        const ids=new Set<string>(payload.ids);
        result=repository.transaction(()=>[...ids].flatMap(id=>{
          const node=repository.getNode(id);
          if(!node||node.kind==='folder'&&payload.includeFolders!==true)throw Error(t('选择中有不存在的卡片。'));
          if(node.parentId===payload.parentId||repository.path(id).some(parent=>parent.id!==id&&ids.has(parent.id)))return [];
          repository.move(id,payload.parentId,undefined,payload.peerId,payload.allowCardParent===true);
          return [{id,parentId:node.parentId}];
        }));
        directory.invalidate();await study.hierarchyChanged();break;
      }
      case 'restoreMovedCards':
        repository.transaction(()=>{
          for(const {id,parentId} of payload.previous)repository.move(id,parentId,{expectedParentId:payload.expectedParentId});
        });
        directory.invalidate();await study.hierarchyChanged();break;
      case 'remove':result=repository.remove(payload.id,payload.mode==='single'?'single':'branch');directory.invalidate();await study.hierarchyChanged();break;
      case 'undoCreation':{
        const isFolder=repository.getNode(payload.id)?.kind==='folder';
        result=repository.undoCreation(payload.id);
        directory.invalidate();
        if(isFolder)await study.hierarchyChanged();else study.invalidate();
        break;
      }
      case 'search':result=repository.search(payload.query);break;
      // 卡片标签（标签）——列表 / 添加 / 删除
      case 'cardTags':result=repository.query('SELECT tag FROM node_tags WHERE node_id=? ORDER BY tag').all(String(payload.id)).map(row=>String(row.tag));break;
      // leech 属性后面显示累计重来次数
      case 'leechCount':result=study.leechLapses(String(payload.id));break;
      case 'addCardTag':{
        const tag=String(payload.tag||'').replace(/\s+/gu,' ').trim().slice(0,40);
        // hold / buried / leech 是内部状态，走 study 里带队列联动的那条路
        if(tag)study.setCardTag(String(payload.id),tag,true);
        result=!!tag;break;
      }
      case 'removeCardTag':study.setCardTag(String(payload.id),String(payload.tag),false);result=true;break;
      case 'catalog':result=catalog.list(payload||{});break;
      case 'settingGet':result=repository.getSetting(payload.key);break;
      case 'settingSet':result=repository.setSetting(payload.key,payload.value);break;
      case 'syncSaveSettings':{
        repository.transaction(()=>{
          repository.setSetting('syncSettings',payload.config);
          repository.setSetting('syncSecret',payload.secret);
          repository.setSetting('syncDeviceName',payload.name);
        });
        break;
      }
      case 'nodeMetadata':{
        // 卡片 metadata 浅合并（目前只有启动配置 launch）。形状校验在这里做，
        // 真正的执行安全边界在 main.ts 的 'reading:launch'（spawn 时不经过 shell）。
        if(!payload||typeof payload.id!=='string'||!payload.patch||typeof payload.patch!=='object'||Array.isArray(payload.patch))throw Error(t('元数据无效。'));
        const patch=payload.patch as Record<string,unknown>;
        if(JSON.stringify(patch).length>8192)throw Error(t('元数据过大。'));
        if(patch.launch!==undefined&&patch.launch!==null){
          const launch=patch.launch as {command?:unknown;args?:unknown;cwd?:unknown};
          if(typeof launch!=='object'||Array.isArray(launch))throw Error(t('启动配置无效。'));
          if(typeof launch.command!=='string'||!launch.command.trim()||launch.command.length>512)throw Error(t('启动命令无效。'));
          if(launch.args!==undefined&&(!Array.isArray(launch.args)||launch.args.length>20||launch.args.some(value=>typeof value!=='string'||value.length>512)))throw Error(t('启动参数无效。'));
          if(launch.cwd!==undefined&&(typeof launch.cwd!=='string'||launch.cwd.length>1024))throw Error(t('工作目录无效。'));
        }
        result=repository.setNodeMetadata(payload.id,patch);break;
      }
      case 'asset':result=repository.getAsset(payload.id);break;
      case 'importAsset':result=importAsset(repository,payload.path);break;
      case 'preview':result=await imagePreview(repository,payload.id,payload.bound);break;
      case 'configGet':result=study.config();break;
      case 'configSave':{
        const before=study.config().settings.defaultFolderName;
        result=await study.saveConfig(payload);
        const after=study.config().settings.defaultFolderName;
        if(after&&after!==before){repository.renameDefaultFolder(after);directory.invalidate();}
        break;
      }
      case 'deckConfig':result=study.deckConfig(payload.folderId);break;
      case 'deckConfigSave':result=await study.saveDeckConfig(payload);break;
      case 'folderCounts':result=study.counts();break;
      case 'nodeStudy':result=study.nodeState(payload.id);break;
      case 'setPriority':result=study.setPriority(payload.id,payload.priority,payload.reading);break;
      case 'setStudyEnabled':result=study.setEnabled(payload.id,payload.enabled);break;
      case 'buryCard':result=study.buryActive(payload);break;
      case 'undoBuryCard':result=study.undoBury(payload.change,payload.sessionId);break;
      case 'setCardHold':result=study.setHold(payload.id,!!payload.hold);break;
      case 'setStudyEnabledBatch':result=study.setEnabledBatch(payload.ids,payload.enabled);break;
      case 'restoreStudyEnabledBatch':result=study.restoreEnabledBatch(payload.changes);break;
      case 'setPushEnabled':result=study.setPushEnabled(payload.id,payload.enabled);break;
      case 'setReadingPosition':result=study.setReadingPosition(payload.id,payload.position);break;
      case 'changeKind':result=study.changeKind(payload.id,payload.kind);directory.invalidate();break;
      case 'cardInfo':result=study.cardInfo(payload);break;
      case 'statistics':result=study.statistics(payload||{});break;
      case 'assetUsage':result={...repository.assetUsage(payload?.limit),dir:join(repository.dataDir,'assets')};break;
      case 'assetTrashUnused':result=repository.trashUnusedAssets();break;
      case 'assetTrashList':result=repository.trashedAssets();break;
      case 'assetRestore':result=repository.restoreAsset(payload.id);break;
      case 'assetPurge':result=repository.purgeTrashedAsset(payload.id);break;

      case 'readingStatistics':result=study.readingStatistics(payload||{});break;
      // FSRS 一键优化 + 留存度测算。只读复习历史，耗时较长（原生组件在 libuv 线程池跑），
      // 因此是 async action；完成前 worker 仍能处理其他消息。
      case 'optimizeDeck':result=await optimizeParameters(repository,payload);break;
      case 'optimizeDeckApply':{
        const folderId=String(payload?.folderId||'');
        const {effective}=study.deckConfig(folderId);
        const trained=await optimizeParameters(repository,{
          folderId,includeDescendants:false,modelVersion:effective.fsrsVersion,
          enableShortTerm:effective.enableShortTerm,currentWeights:effective.fsrsWeights,
        });
        const latest=study.deckConfig(folderId);
        if(latest.effective.fsrsVersion!==effective.fsrsVersion||
            latest.effective.enableShortTerm!==effective.enableShortTerm||
            JSON.stringify(latest.effective.fsrsWeights)!==JSON.stringify(effective.fsrsWeights)){
          throw Error(t('训练期间牌组的 FSRS 设置已更新，请重新优化。'));
        }
        await study.saveDeckConfig({folderId,overrides:{...latest.overrides,
          fsrsVersion:effective.fsrsVersion,fsrsWeights:trained.weights}});
        result=trained;break;
      }
      // 逐牌组优化的进度来源——列出有复习记录的牌组及条数
      case 'optimizeDeckList':{
        const rows=repository.query(`SELECT n.folder_id AS folderId,count(*) AS count FROM review_log l JOIN nodes n ON n.id=l.node_id
          WHERE l.undone_at IS NULL AND n.deleted_at IS NULL AND n.folder_id IS NOT NULL
          GROUP BY n.folder_id HAVING count(*)>=? ORDER BY count DESC`).all(MIN_OPTIMIZATION_REVIEWS) as Array<Record<string,any>>;
        result=rows.map(row=>{const folder=repository.getNode(String(row.folderId));return {folderId:String(row.folderId),title:folder?folder.title:String(row.folderId),count:Number(row.count)};});
        break;
      }
      // 留存度快速统计（秒级，不再训练）
      case 'retentionReport':result=retentionReport(repository,payload||{});break;
      // 2026-11-20：simulateWorkload 是异步的（要按留存率现造调度器），这里必须 await，
      // 否则 Promise 会被当成结果 postMessage，主进程侧报「could not be cloned」。
      case 'simulateWorkload':result=await study.simulateWorkload(payload?.folderId??null);break;
      case 'importAnkiExport':
        result=importAnkiExport(repository,payload.bundle,payload.media,true);
        directory.invalidate();await study.hierarchyChanged();break;
      // 桌面对等同步。ids=全部日志 id；ops=按 id 取回日志；apply=幂等落库 + 本地重放。
      case 'syncIdsAll':result=collectSyncIds(repository,payload?.studyChanges===1);break;
      case 'syncOps':result=collectSyncOps(repository,payload?.ids||[]);break;
      case 'syncApplyOps':result=applySyncOps(repository,payload?.ops||[]);study.invalidate();break;
      case 'syncReplayPending':result=replayPendingSyncOps(repository);study.invalidate();break;
      case 'syncSettingsExport':result=repository.exportSyncedSettings(payload?.deviceId?String(payload.deviceId):undefined);break;
      case 'syncSettingsReceive':{
        const res=repository.receiveSyncedSettings(Array.isArray(payload?.snapshots)?payload.snapshots:[],String(payload?.peer||''),payload?.deviceId?String(payload.deviceId):undefined);
        if(res.applied.length)await study.reloadSettings(true);
        result=res;break;
      }
      case 'syncSettingsConflicts':result=repository.listSettingsConflicts();break;
      case 'syncSettingsResolve':{
        const resolved=repository.resolveSettingsConflict(String(payload?.key||''),payload?.choice==='remote'?'remote':'local',Date.now(),payload?.deviceId?String(payload.deviceId):undefined);
        await study.reloadSettings(true);
        result=resolved;break;
      }
      case 'syncContentList':{
        const content=contentJournal(),after=payload?.after??null;
        if(after===null){
          content.enqueueUntracked();
          while(repository.query('SELECT 1 FROM sync_content_dirty LIMIT 1').get())content.captureDirty();
        }
        result=content.listVersionIds(after);break;
      }
      case 'syncContentPrepareFull':result=contentJournal().prepareFullSync();break;
      case 'syncContentRead':result=contentJournal().readVersions(payload?.ids);break;
      case 'syncContentMissing':result=contentJournal().missingVersionIds(payload?.ids);break;
      case 'syncContentReceive':contentJournal().receive(payload?.versions);result=true;break;
      case 'syncContentConflicts':result=contentJournal().listConflicts();break;
      case 'syncChooseContent':{
        const {nodeId,heads,selected}=payload;
        const journal=contentJournal();
        journal.choose(nodeId,heads,selected);
        const outcome=journal.apply(nodeId);
        if(outcome.status==='applied'){
          directory.invalidate();await study.hierarchyChanged();study.register(nodeId);
        }
        result=outcome;break;
      }
      // 冲突处理里的「删除卡片」——写一条删除版本再按正常删除进垃圾桶。
      case 'syncDiscardContent':{
        const journal=contentJournal();
        const outcome=journal.discard(String(payload?.nodeId||''));
        if(outcome.status==='applied'){directory.invalidate();await study.hierarchyChanged();}
        result=outcome;break;
      }
      case 'syncContentAssetRead':result=contentAssets().read(payload?.id,payload?.offset);break;
      case 'syncContentAssetReceive':result=contentAssets().receive(payload?.id,payload?.chunk);break;
      case 'syncContentAssetAbort':contentAssets().abort(payload?.id);result=true;break;
      case 'syncContentApply':{
        const outcomes=contentJournal().applyPending(new Set<string>(payload?.protectedIds??[]));
        const applied=outcomes.filter(item=>item.result.status==='applied');
        if(applied.length){
          directory.invalidate();await study.hierarchyChanged();
          for(const item of applied)study.register(item.nodeId);
        }
        const missingAssets=new Set<string>();
        const editingIds:string[]=[];
        for(const {nodeId,result:outcome} of outcomes){
          if(outcome.status==='pending'&&outcome.reason==='attachment')for(const id of outcome.ids)missingAssets.add(id);
          if(outcome.status==='pending'&&outcome.reason==='editing')editingIds.push(nodeId);
        }
        result={applied:applied.length,merged:applied.filter(item=>item.result.status==='applied'&&item.result.merged).length,
          conflicts:outcomes.filter(item=>item.result.status==='conflict').length,
          pending:outcomes.filter(item=>item.result.status==='pending').length,missingAssets:[...missingAssets],editingIds};
        break;
      }
      // 2026-11-21：陈旧冲突判定（卡片在那之后又变过，两侧都已无法应用）
      case 'syncConflictObsolete':result=isObsoleteConflict(repository,payload?.conflict);break;
      case 'syncConflictResolutions':result=Object.fromEntries((payload?.items||[]).filter((item:any)=>isConflictFile(item.file))
        .map((item:any)=>[item.file,{
          resolution:syncDecisionFor(repository,item.detail)??repository.getSetting(conflictResolutionKey(item.file)),
          dispute:syncDecisionDispute(repository,item.detail),
        }]));break;
      case 'syncResolveConflict':result=resolveSyncConflict(repository,payload.file,payload.conflict,payload.choice);study.invalidate();break;
      case 'syncDecisions':result=collectSyncDecisions(repository);break;
      case 'syncApplyDecisions':result=applySyncDecisions(repository,payload?.decisions);study.invalidate();break;
      case 'syncLegacyDecisions':result=repository.query("SELECT key,value FROM settings WHERE key GLOB 'syncResolution:*'").all()
        .map(row=>({file:String(row.key).slice('syncResolution:'.length),choice:JSON.parse(String(row.value)).choice}));break;
      case 'reviewStart':
        result=payload?.folderId==null?study.start(null,payload?.mode):study.startDeck(payload.folderId,payload?.mode==='reading'?'reading':'cards');break;
      case 'reviewStop':result=study.stop();break;
      case 'reviewRefresh':result=study.refresh();break;
      case 'reviewFocus':result=study.focus(payload.id);break;
      case 'pauseCard':result=study.pauseActive(payload);break;
      case 'undoPauseCard':result=study.undoPause(payload.change,payload.sessionId);break;
      case 'reviewGrade':result=study.grade(payload);break;
      case 'reviewAgainDependents':result=study.againDependents(payload);break;
      case 'recordForgotten':result=study.recordForgotten(payload.id);break;
      case 'resetMemory':result=study.resetMemory(payload.id);break;
      case 'reviewUndo':result=payload?.eventId?study.undo(payload.eventId):study.undo();break;
      // 2026-11-19：撤销「置于末尾」——只在会话队列里把卡片放回当前位
      case 'readingUnqueue':result=study.unqueue(String(payload?.id));break;
      // 垃圾桶（软删除的卡片）。cleanup 在启动与定时任务里跑。
      case 'trashList':result=repository.trashList(Number(payload?.limit)||200);break;
      case 'trashRestore':result=repository.trashRestore(String(payload?.id));directory.invalidate();await study.hierarchyChanged();break;
      case 'trashPurge':repository.trashPurge(String(payload?.id));result=true;study.invalidate();break;
      case 'trashCleanup':result=repository.trashCleanup(Number(payload?.now)||Date.now(),Number(payload?.retentionDays)||Number((study.config().settings as any).trashRetentionDays)||30);study.invalidate();break;
      case 'close':assets?.close();repository.close();result=true;break;
      default:throw Error(t('无效的数据操作。'));
    }
    port.postMessage({id,result});
  }catch(error){port.postMessage({id,error:error instanceof Error?t(error.message):String(error)});}
});
