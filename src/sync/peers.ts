import { networkInterfaces } from 'node:os';
import { signedSyncHeaders, SYNC_PROTOCOL_HEADER, syncToken } from './request-auth';

export type SyncPeer={name:string;address:string};
export function normalizePeers(input:unknown):SyncPeer[]{
  if(!Array.isArray(input))return [];
  return input.slice(0,50).map((item:any)=>typeof item==='string'
    ? {name:item,address:item}
    : {name:String(item?.name||item?.address||''),address:String(item?.address||'')})
    .filter(peer=>peer.address);
}

/**
 * 1.76：列出本机可用于同步的地址。
 * - 局域网 IPv4（192.168/10/172.16）；
 * - Tailscale 地址（100.64.0.0/10，跨网络时用它）；
 * - 回环地址不列（对方连不上）。
 */
export function localAddresses():Array<{address:string;kind:string}>{
  const result:Array<{address:string;kind:string}>=[];const interfaces=networkInterfaces();
  for(const [name,entries] of Object.entries(interfaces)){
    for(const entry of entries||[]){
      if(entry.family!=='IPv4'||entry.internal)continue;
      const tailscale=/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(entry.address);
      result.push({address:entry.address,kind:tailscale?'Tailscale':name});
    }
  }
  return result;
}

export function syncPeerPost(base:string, passphrase:string){
  const origin=/^https?:\/\//i.test(base)?base.replace(/\/+$/,''):'http://'+base.replace(/\/+$/,'');
  let protocol:'current'|'legacy'|undefined;
  return async(path:string,body:unknown,signal?:AbortSignal)=>{
    const text=JSON.stringify(body);
    const deadline=signal??AbortSignal.timeout(path==='/sync/ping'?5000:30000);
    const send=(headers:Record<string,string>)=>fetch(origin+path,{method:'POST',
      headers:{'content-type':'application/json',...headers},body:text,signal:deadline,redirect:'error'});
    const legacyHeaders:Record<string,string>=passphrase?{'x-sync-token':syncToken(passphrase,'POST',path,text)}:{};
    let response=await send(protocol==='legacy'?legacyHeaders:signedSyncHeaders(passphrase,'POST',path,text));
    if(response.headers.get(SYNC_PROTOCOL_HEADER)==='2')protocol='current';
    if(protocol===undefined&&response.status===401){
      await response.body?.cancel();
      response=await send(legacyHeaders);
      if(response.ok)protocol='legacy';
    }
    if(!response.ok)throw Object.assign(Error(path+' → HTTP '+response.status),{status:response.status});
    return response.json();
  };
}
