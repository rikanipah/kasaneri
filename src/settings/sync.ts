import {createHash} from 'node:crypto';
import {DEFAULT_SETTINGS,normalizeSettings,REVIEW_KEYS,type StudySettings} from './index';

// 只同步全局默认复习/待办设置；牌组覆盖（deck_settings）、界面/设备偏好与仅今日临时额度保持本机。
export const SYNC_SETTING_KEYS=[...new Set<string>([
  ...REVIEW_KEYS,
  'dayStartHour',
  'readingInitialDays','readingLaterDays','defaultPriority','priorityRatio','learnAheadMinutes',
  'newReviewOrder','newOrder','reviewOrder','newCardsIgnoreReviewLimit','newCardGatherOrder',
  'learningStepFuzz','directoryDispersion','loadBalance','reviewFuzz','interdayLearningMix',
  'fsrsPerCycle','readingPerCycle','studyMode',
])];
const settingsKeySet=new Set(SYNC_SETTING_KEYS);
export const SETTINGS_CONFLICT_PREFIX='settingsSyncConflict:';
export const MAX_SETTINGS_ANCESTORS=32;

export type SettingsSnapshot={
  key:string;
  value:unknown;
  updatedAt:number;
  deviceId:string;
  valueHash:string;
  ancestors:string[];
};
export type SettingsConflict={
  key:string;
  local:SettingsSnapshot;
  remote:SettingsSnapshot;
  peer:string;
  detectedAt:number;
};
export type SettingsReceiveResult={
  applied:string[];
  conflicts:SettingsConflict[];
  skipped:number;
  rejected:number;
};

export function settingsHash(value:unknown):string{
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function settingVersionId(item:Pick<SettingsSnapshot,'updatedAt'|'deviceId'|'valueHash'>):string{
  return `${item.updatedAt}:${item.deviceId}:${item.valueHash.slice(0,16)}`;
}
export function mergeAncestors(...lists:Array<readonly string[]|undefined>):string[]{
  const seen=new Set<string>();
  const out:string[]=[];
  for(const list of lists){
    if(!list)continue;
    for(const item of list){
      if(typeof item!=='string'||!item||item.length>200||seen.has(item))continue;
      seen.add(item);
      out.push(item);
      if(out.length>=MAX_SETTINGS_ANCESTORS)return out;
    }
  }
  return out;
}
export function isSyncSettingKey(key:string):boolean{return settingsKeySet.has(key);}
export function projectSettings(settings:StudySettings):Record<string,unknown>{
  const all=normalizeSettings(settings);
  return Object.fromEntries(SYNC_SETTING_KEYS.map(key=>[key,(all as any)[key]]));
}
export function normalizeIncomingSetting(key:string,value:unknown):unknown{
  if(!settingsKeySet.has(key))throw Error('Setting is not synchronized');
  const normalized=normalizeSettings({...DEFAULT_SETTINGS,[key]:value});
  return (normalized as any)[key];
}
export function isCompatibleFsrsPair(version:StudySettings['fsrsVersion'],weights:number[]):boolean{
  if(!Array.isArray(weights)||weights.length===0)return true;
  if(version==='FSRS-6')return weights.length===17||weights.length===19||weights.length===21;
  if(version==='FSRS-7')return weights.length===34;
  return false;
}
export function validateSettingsSnapshot(input:unknown):SettingsSnapshot{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid setting snapshot');
  const item=input as Record<string,unknown>;
  if(typeof item.key!=='string'||!settingsKeySet.has(item.key)||!Number.isSafeInteger(item.updatedAt)||Number(item.updatedAt)<0||
    typeof item.deviceId!=='string'||!item.deviceId||item.deviceId.length>128||typeof item.valueHash!=='string'||!item.valueHash)
    throw Error('Invalid setting snapshot');
  if(item.ancestors!==undefined){
    if(!Array.isArray(item.ancestors)||item.ancestors.length>MAX_SETTINGS_ANCESTORS||
      item.ancestors.some(entry=>typeof entry!=='string'||!entry||entry.length>200))
      throw Error('Invalid setting snapshot');
  }
  const normalized=normalizeIncomingSetting(item.key,item.value);
  if(settingsHash(normalized)!==item.valueHash)throw Error('Setting hash mismatch');
  return {
    key:item.key,
    value:normalized,
    updatedAt:Number(item.updatedAt),
    deviceId:item.deviceId,
    valueHash:item.valueHash,
    ancestors:mergeAncestors(item.ancestors as string[]|undefined),
  };
}
export function shouldTakeRemote(local:Pick<SettingsSnapshot,'updatedAt'|'deviceId'>,remote:Pick<SettingsSnapshot,'updatedAt'|'deviceId'>):boolean{
  return remote.updatedAt>local.updatedAt||(remote.updatedAt===local.updatedAt&&remote.deviceId.localeCompare(local.deviceId)>0);
}
