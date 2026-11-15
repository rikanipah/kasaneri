import { t } from './i18n';

/** Built-in spellings are accepted in either language. Persisted tags use stable values. */
export const TAG_LABELS:Record<string,string>={hold:'留存判定',buried:'已搁置'};

const TAG_VALUES:Record<string,string>=Object.fromEntries(Object.entries(TAG_LABELS).map(([tag,label])=>[label,tag] as const));

/** 标签值 → 界面文字。 */
export function tagLabel(tag:string):string{
  const label=TAG_LABELS[tag];
  return label?t(label):tag;
}

/** 界面输入 → 标签值。写「留存判定」「已搁置」等于写 hold / buried；其它原样保留。 */
export function tagFromLabel(text:string):string{
  const value=text.replace(/\s+/gu,' ').trim();
  return TAG_VALUES[value]??Object.entries(TAG_LABELS).find(([,label])=>t(label)===value)?.[0]??value;
}
