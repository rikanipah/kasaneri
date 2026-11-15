import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

export const SYNC_CLOCK_TOLERANCE_MS=2*60*1000;
export const SYNC_PROTOCOL_HEADER='x-sync-protocol';
const timeHeader='x-sync-time';
const nonceHeader='x-sync-nonce';
const tokenHeader='x-sync-token';

export function syncToken(passphrase:string, method:string, path:string, body:string):string {
  const key=createHash('sha256').update('ir-sync-v1:'+passphrase).digest();
  return createHmac('sha256',key).update(method+' '+path+' '+body).digest('hex');
}

function requestToken(passphrase:string,method:string,path:string,body:string,timestamp:string,nonce:string):string{
  const key=createHash('sha256').update('ir-sync-v2:'+passphrase).digest();
  return createHmac('sha256',key).update(JSON.stringify([method,path,body,timestamp,nonce])).digest('hex');
}

export function signedSyncHeaders(passphrase:string,method:string,path:string,body:string,now=Date.now()):Record<string,string>{
  const timestamp=String(now),nonce=randomUUID();
  return {[SYNC_PROTOCOL_HEADER]:'2',[timeHeader]:timestamp,[nonceHeader]:nonce,
    [tokenHeader]:requestToken(passphrase,method,path,body,timestamp,nonce)};
}

function matchesToken(value:unknown,expected:string):boolean{
  return typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)
    &&timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(expected,'hex'));
}

export function createSyncRequestVerifier(noncesPath:string,clock=Date.now){
  let database:DatabaseSync|undefined,nextCleanup=0;
  return (headers:IncomingHttpHeaders,passphrase:string,method:string,path:string,body:string):0|401|408|409=>{
    const protocol=headers[SYNC_PROTOCOL_HEADER];
    if(protocol===undefined){
      if(!passphrase||matchesToken(headers[tokenHeader],syncToken(passphrase,method,path,body)))return 0;
      return 401;
    }
    const timestamp=headers[timeHeader],nonce=headers[nonceHeader];
    if(protocol!=='2'||typeof timestamp!=='string'||!/^\d{1,16}$/u.test(timestamp)||
        typeof nonce!=='string'||!/^[-a-f0-9]{36}$/u.test(nonce)||
        !matchesToken(headers[tokenHeader],requestToken(passphrase,method,path,body,timestamp,nonce)))return 401;
    const now=clock(),sentAt=Number(timestamp);
    if(!Number.isSafeInteger(sentAt)||Math.abs(now-sentAt)>SYNC_CLOCK_TOLERANCE_MS)return 408;
    if(!database){
      database=new DatabaseSync(noncesPath);
      database.exec(`CREATE TABLE IF NOT EXISTS sync_request_nonce(nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS sync_request_expiry ON sync_request_nonce(expires_at)`);
    }
    if(now>=nextCleanup){
      database.prepare('DELETE FROM sync_request_nonce WHERE expires_at<?').run(now);
      nextCleanup=now+SYNC_CLOCK_TOLERANCE_MS;
    }
    const inserted=database.prepare('INSERT OR IGNORE INTO sync_request_nonce(nonce,expires_at) VALUES(?,?)')
      .run(nonce,sentAt+SYNC_CLOCK_TOLERANCE_MS);
    return inserted.changes?0:409;
  };
}
