/**
 * 2026-11-19 重构（§9.1 复习调度域第一刀）：把纯函数的 fuzz 计算从 StudyService 里搬出来。
 * 对齐 Anki main 的 states/fuzz.rs；这里不碰仓储、不碰状态，只有数字进数字出。
 */

/** fuzz.rs::fuzz_delta——间隔 <2.5 天不抖动，之后按分段加成。 */
export function fuzzDelta(interval: number): number {
  if (!(interval >= 2.5)) return 0;
  return 1
    + 0.15 * Math.max(0, Math.min(interval, 7) - 2.5)
    + 0.10 * Math.max(0, Math.min(interval, 20) - 7)
    + 0.05 * Math.max(0, interval - 20);
}

export function fuzzBounds(interval: number): [number, number] {
  const delta = fuzzDelta(interval);
  return [Math.round(interval - delta), Math.round(interval + delta)];
}

/** fuzz.rs::constrained_fuzz_bounds——夹到 [minimum,maximum]，并保证上下界不等（除非 maximum 不允许）。 */
export function constrainedFuzzBounds(interval: number, minimum: number, maximum: number): [number, number] {
  const min = Math.min(minimum, maximum);
  const clamped = Math.min(Math.max(interval, min), maximum);
  let [lower, upper] = fuzzBounds(clamped);
  lower = Math.min(Math.max(lower, min), maximum);
  upper = Math.min(Math.max(upper, min), maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}

/** fuzz.rs::minimum_review_fuzz_interval——不让 fuzz 把间隔缩到比上次还短。 */
export function minimumReviewFuzzInterval(interval: number, previous: number, maximum: number): number {
  const rounded = Math.round(interval);
  const [, upper] = constrainedFuzzBounds(interval, 1, maximum);
  if (rounded > previous) return previous + 1;
  if (previous <= upper) return previous;
  return 0;
}

/** 与学习步抖动一致的确定性随机（FNV-1a + mulberry32 一步），同样输入得到同样结果，测试可复现。 */
export function stableRandom(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) { hash ^= seed.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  let a = (hash + 1831565813) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), a | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
