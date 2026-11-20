import { t } from '../core/i18n';
import { createServer, type ServerResponse } from 'node:http';
import { SYNC_CLOCK_TOLERANCE_MS, SYNC_PROTOCOL_HEADER, type createSyncRequestVerifier } from './request-auth';
import { CONTENT_IDS_PATH, CONTENT_READ_PATH } from './content-transport';
import { CONTENT_BATCH_SIZE, isVersionId } from './content-versions';
import { CONTENT_ASSET_PATH } from './content-assets';
import {isStudyDecision} from './resolve-conflict';

type ServerDependencies = {
  contentSync?:boolean;
  passphrase:()=>string;
  verify:ReturnType<typeof createSyncRequestVerifier>;
  waitForDatabase:()=>Promise<void>;
  call:(action:string, payload?:unknown)=>Promise<any>;
  getVersion:()=>string;
  deviceId:string;
  promoteLegacyDecisions:()=>Promise<void>;
  writeConflicts:(items:any[], peer:string)=>Promise<void>;
  onError:(error:unknown)=>void;
};

function syncJson(res:ServerResponse,payload:unknown){
  res.writeHead(200,{'content-type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(payload));
}

export function createSyncHttpServer({
  contentSync, passphrase, verify, waitForDatabase, call, getVersion, deviceId,
  promoteLegacyDecisions, writeConflicts, onError,
}:ServerDependencies){
  const server=createServer(async(req,res)=>{
    res.setHeader(SYNC_PROTOCOL_HEADER,'2');
    try{
      const settingsPath=req.url==='/sync/settings';
      const contentPath=req.url===CONTENT_IDS_PATH||req.url===CONTENT_READ_PATH||req.url===CONTENT_ASSET_PATH;
      const secret=passphrase();
      const allowContent=Boolean(contentSync&&secret&&req.headers[SYNC_PROTOCOL_HEADER]==='2');
      if(contentPath&&!allowContent){res.writeHead(contentSync&&secret?401:404).end();return;}
      if((contentPath||settingsPath)&&req.method!=='POST'){res.writeHead(405).end();return;}
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req.iterator({destroyOnReturn:false})){
        size+=chunk.length;
        if((contentPath||settingsPath)&&size>32768){res.writeHead(413,{connection:'close'}).end();return;}
        chunks.push(chunk as Buffer);
      }
      const body=Buffer.concat(chunks).toString('utf8');
      const denied=verify(req.headers,secret,req.method||'',req.url||'',body);
      if(denied){res.writeHead(denied);res.end();return;}
      let payload;
      try{payload=body?JSON.parse(body):{};}catch{res.writeHead(400).end();return;}
      await waitForDatabase();
      if(contentPath){
        if(!payload||typeof payload!=='object'||Array.isArray(payload)){res.writeHead(400).end();return;}
        if(req.url===CONTENT_IDS_PATH){
          const after=payload.after??null;
          if(after!==null&&!isVersionId(after)){res.writeHead(400).end();return;}
          syncJson(res,await call('syncContentList',{after}));
        }else if(req.url===CONTENT_ASSET_PATH){
          const {id,offset}=payload;
          if(!isVersionId(id)||!Number.isSafeInteger(offset)||offset<0){res.writeHead(400).end();return;}
          syncJson(res,{chunk:await call('syncContentAssetRead',{id,offset})});
        }else{
          const ids=payload.ids;
          if(!Array.isArray(ids)||ids.length>CONTENT_BATCH_SIZE||!ids.every(isVersionId)){
            res.writeHead(400).end();return;
          }
          syncJson(res,{versions:await call('syncContentRead',{ids})});
        }
        return;
      }
      // 时钟保护——ping 带上服务器时间，对端据此判断时钟偏差；
      // push 时拒绝"来自未来"的 op（会打乱 (reviewedAt, id) 全序，导致重放错序）。
      if(req.url==='/sync/health'){
        // 同步协议的标识沿用发布版的值，让旧客户端也能识别。
        syncJson(res,{app:'leafloop',now:Date.now()});
      }
      else if(req.url==='/sync/ping'){
        syncJson(res,{app:'leafloop',version:getVersion(),deviceId:deviceId,now:Date.now(),studyChanges:1,settingsSync:1,
          ...(allowContent?{contentVersions:1,contentAssets:1}:{})});}
      else if(req.url==='/sync/settings'){
        if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Array.isArray(payload.snapshots)){
          res.writeHead(400).end();return;
        }
        const peerLabel=typeof payload.peer==='string'&&payload.peer.trim()?payload.peer.trim().slice(0,80):(req.socket.remoteAddress||t('未知对端'));
        const received=await call('syncSettingsReceive',{snapshots:payload.snapshots,peer:peerLabel,deviceId});
        const snapshots=await call('syncSettingsExport',{deviceId});
        syncJson(res,{snapshots,received});
      }
      else if(req.url==='/sync/ids')syncJson(res,{ids:await call('syncIdsAll',{studyChanges:payload.studyChanges}),scheduleChoices:2});
      else if(req.url==='/sync/decisions'){
        await promoteLegacyDecisions();
        if(payload.decisions===undefined){
          const decisions=await call('syncDecisions');
          syncJson(res,{decisions:decisions.filter((item:any)=>
            (payload.choiceRounds===1||!item.round)&&(payload.studyChanges===1||!isStudyDecision(item)))});
        }
        else syncJson(res,await call('syncApplyDecisions',{decisions:payload.decisions}));
      }
      else if(req.url==='/sync/fetch')syncJson(res,{ops:await call('syncOps',{ids:payload.ids})});
      else if(req.url==='/sync/push'){
        const ops=Array.isArray(payload.ops)?payload.ops:[];
        const limit=Date.now()+SYNC_CLOCK_TOLERANCE_MS;
        const future=ops.find((op:any)=>Number(op?.reviewedAt)>limit);
        if(future){
          syncJson(res,{ok:false,error:'clock-skew',detail:t('对端时钟比本机快，请先校准系统时间（Windows：设置→时间和语言→立即同步；Linux：chrony/systemd-timesyncd）。')});
          return;
        }
        const result=await call('syncApplyOps',{ops});
        if(result.conflicts?.length)await writeConflicts(result.conflicts,req.socket.remoteAddress||t('未知对端'));
        syncJson(res,result);
      }
      else{res.writeHead(404);res.end();}
    }catch(error){onError(error);res.writeHead(500);res.end(String(error));}
  });
  server.on('error',onError);
  return server;
}
