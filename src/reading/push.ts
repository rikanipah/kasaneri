import type {Repository} from '../data/database';
import type {StudySettings} from '../core/settings';
import {resolveInheritedPushQueuePriority} from '../vendor/foliole/unifiedPushQueueRules';

type Row=Record<string,any>;

/** 阅读推送要用的依赖（牌组路径查优先级 + 设置里的默认值与间隔）。 */
export interface PushContext{
  repository:Repository;
  settings:StudySettings;
}

// ===== 采用 Foliole 阅读推送算法，四动作：读完/稍后/本轮再出/搁置 =====
// 公式对照 foliole/src/features/review/model/unifiedPushQueueRules.ts：
//   growth = 1.1 + (priority-1) * (1.5-1.1) / 8    ← 优先级 1 → 1.1，优先级 9 → 1.5，线性映射
//   nextInterval = max(初始间隔, prevInterval * growth^exponent)
//   读完 exponent=1（全增长）；稍后 exponent=0.5（只乘平方根，稍拉长）；首读固定初始间隔（1 天）。
// 「本轮再出」不动间隔与次数（见 reading/actions.ts 的 soon 分支）。
export const GROWTH_MIN=1.1;
export const GROWTH_MAX=1.5;

/** 卡片继承来的推送优先级（父级优先）。 */
export function pushPriority(context:PushContext,id:string):number{
  return resolveInheritedPushQueuePriority(context.repository.path(id).reverse().map(node=>node.priority),
    context.settings.defaultPriority as any);
}

/** 这张卡的阅读推送增长因子：优先级 1 → 1.1，9 → 1.5。 */
export function readingGrowth(context:PushContext,id:string):number{
  const priority=pushPriority(context,id)||context.settings.defaultPriority;
  return Math.round((GROWTH_MIN+(priority-1)*(GROWTH_MAX-GROWTH_MIN)/8)*100)/100;
}

/** 读完 / 稍后 之后的下次到期、间隔与次数（「本轮再出」不走这里）。 */
export function pushSchedule(context:PushContext,id:string,row:Row,action:'read'|'later',now:number){
  const settings=context.settings;
  if(action==='later'&&settings.readingLaterDays>0){
    return {dueAt:now+settings.readingLaterDays*86400000,interval:Number(row.interval_ms),reps:Number(row.reps)};
  }
  const initial=settings.readingInitialDays*86400000;
  const reps=Number(row.reps);
  const interval=Math.round(reps<=0?initial:Math.max(initial,Number(row.interval_ms)*Math.pow(readingGrowth(context,id),action==='later'?0.5:1)));
  return {dueAt:now+interval,interval,reps:reps+1};
}
