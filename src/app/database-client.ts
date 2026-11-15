import { t } from '../core/i18n';
import type {Worker} from 'node:worker_threads';

type Reply={ready?:true;fatal?:string;id?:number;error?:string;result?:unknown};
type PendingRequest={resolve:(result:unknown)=>void;reject:(error:Error)=>void};

export class DatabaseClient {
  readonly ready:Promise<void>;
  private resolveReady!:()=>void;
  private rejectReady!:(error:Error)=>void;
  private readonly pending=new Map<number,PendingRequest>();
  private nextId=0;
  private failure:Error|undefined;
  private closing=false;
  private closeResult:Promise<void>|undefined;

  constructor(private readonly worker:Worker,private readonly onFailure:(error:Error)=>void){
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    void this.ready.catch(()=>{});
    worker.on('message',(reply:Reply)=>this.receive(reply));
    worker.on('error',reason=>this.fail(reason instanceof Error?reason:Error(String(reason))));
    worker.on('exit',code=>this.fail(Error(t('资料库进程已退出（{0}）。',code))));
  }

  get available(){return !this.closing&&!this.failure;}

  async request<T>(action:string,payload?:unknown):Promise<T>{
    await this.ready;
    if(this.closing)throw Error(t('资料库正在关闭。'));
    return this.send<T>(action,payload);
  }

  close():Promise<void>{
    this.closing=true;
    return this.closeResult??=this.closeWorker();
  }

  private async closeWorker():Promise<void>{
    try{
      if(!this.failure){
        await this.ready;
        await this.send('close');
      }
    }finally{await this.worker.terminate();}
  }

  private send<T>(action:string,payload?:unknown):Promise<T>{
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{
      const id=++this.nextId;
      this.pending.set(id,{resolve:value=>resolve(value as T),reject});
      try{this.worker.postMessage({id,action,payload});}
      catch(error){this.pending.delete(id);reject(error);}
    });
  }

  private receive(reply:Reply){
    if(reply.ready){this.resolveReady();return;}
    if(reply.fatal){this.fail(Error(reply.fatal));return;}
    if(reply.id===undefined)return;
    const request=this.pending.get(reply.id);
    if(!request)return;
    this.pending.delete(reply.id);
    if(reply.error!==undefined)request.reject(Error(reply.error));
    else request.resolve(reply.result);
  }

  private fail(error:Error){
    if(this.failure)return;
    this.failure=error;
    this.rejectReady(error);
    for(const request of this.pending.values())request.reject(error);
    this.pending.clear();
    if(!this.closing)this.onFailure(error);
  }
}
