import { t } from '../core/i18n';
import {normalizeReviewOverrides,reviewSettings,type ReviewSettings,type StudySettings} from '../core/settings';
import type {DeckConfiguration,FolderInfo} from '../core/model';
import {Repository} from '../data/database';
export class DeckProfiles {
  readonly folders:Map<string,FolderInfo>;
  readonly global:ReviewSettings;
  private overrides=new Map<string,Partial<ReviewSettings>>();
  private effective=new Map<string,ReviewSettings>();
  constructor(repository:Repository,settings:StudySettings,proposed?:{folderId:string;overrides:Partial<ReviewSettings>|null}){
    this.global=reviewSettings(settings);this.folders=new Map(repository.folders().map(folder=>[folder.id,folder]));
    for(const row of repository.query('SELECT folder_id,overrides FROM deck_settings').all()){
      if(this.folders.has(String(row.folder_id)))this.overrides.set(String(row.folder_id),normalizeReviewOverrides(JSON.parse(String(row.overrides)))||{});
    }
    if(proposed){if(proposed.overrides)this.overrides.set(proposed.folderId,proposed.overrides);else this.overrides.delete(proposed.folderId);}
    for(const id of this.folders.keys())this.resolve(id);
  }
  resolve(id:string|null):ReviewSettings {
    if(!id)return this.global;
    if(this.effective.has(id))return this.effective.get(id)!;
    const chain:string[]=[],seen=new Set<string>();let cursor:string|null=id;
    while(cursor&&this.folders.has(cursor)&&!this.effective.has(cursor)){
      if(seen.has(cursor))throw Error(t('牌组目录包含循环。'));seen.add(cursor);chain.push(cursor);cursor=this.folders.get(cursor)!.parentId;
    }
    let base=cursor?this.effective.get(cursor)||this.global:this.global;
    for(const current of chain.reverse()){
      const overrides=this.overrides.get(current);
      const changesModel=overrides?.fsrsVersion!==undefined&&overrides.fsrsVersion!==base.fsrsVersion;
      base={...base,fsrsWeights:changesModel?[]:base.fsrsWeights,...overrides};
      this.effective.set(current,base);
    }
    return this.effective.get(id)||this.global;
  }
  all(){return [this.global,...this.effective.values()];}
  configuration(id:string):DeckConfiguration {
    const folder=this.folders.get(id);if(!folder)throw Error(t('牌组不存在或已删除。'));
    const path:string[]=[];let cursor:FolderInfo|undefined=folder,from=t('全局默认');
    while(cursor){path.unshift(cursor.title);cursor=cursor.parentId?this.folders.get(cursor.parentId):undefined;}
    cursor=folder.parentId?this.folders.get(folder.parentId):undefined;
    while(cursor){if(this.overrides.has(cursor.id)){from=cursor.title;break;}cursor=cursor.parentId?this.folders.get(cursor.parentId):undefined;}
    return {folderId:id,title:folder.title,path:path.join(' / '),inheritedFrom:from,overrides:this.overrides.get(id)||null,
      inherited:this.resolve(folder.parentId),effective:this.resolve(id)};
  }
}
export function profileKey(value:ReviewSettings){return JSON.stringify([value.desiredRetention,value.maximumInterval,value.enableShortTerm,value.fsrsVersion||'FSRS-7',value.fsrsWeights,value.learningSteps,value.relearningSteps]);}
