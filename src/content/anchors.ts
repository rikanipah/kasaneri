import type { Anchor } from '../core/model';

/**
 * 锚点：从正文里的一段文字，到「能不能在被编辑后找回它」的全部逻辑。
 * 2026-11-19 结构性收拢：从 core/card.ts 搬出来，和卡片正文渲染/管道分层无关的代码分家。
 */

export function makeAnchor(text: string, from: number, to: number, section?: Anchor['section']): Anchor {
  return {
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - 40), from),
    suffix: text.slice(to, to + 40),
    start: from,
    ...(section ? { section } : {}),
  };
}

/**
 * 2026-11-19：正文被编辑后，把锚点区间按「改动的位置」搬到新文本上。
 * 规则：区间内删字就收缩、紧贴区间两端加字就扩张、整体被替换就覆盖新内容；
 * 区间被删光则返回 null（调用方据此把锚点丢掉）。
 */
export function remapAnchor(oldText: string, newText: string, anchor: Anchor): Anchor | null {
  if (!anchor.quote) return null;
  if (oldText === newText) return anchor;
  const start = anchor.start !== undefined && anchor.start >= 0 ? anchor.start : oldText.indexOf(anchor.quote);
  if (start < 0 || start > oldText.length) return anchor;
  const end = start + anchor.quote.length;
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  const changeStart = prefix, changeEnd = oldText.length - suffix, delta = newText.length - oldText.length;
  // 2026-11-20：改成「边界由用户拖棍决定」之后的规则——
  //   起点：改动整体落在起点之前（含贴着起点插入）→ 跟着右移，新字算区间外；
  //   终点：改动整体落在终点之前 → 跟着移；正好插在终点 → **不扩**（新字算区间外）；
  //         跨过终点（把尾巴删了）→ 收到改动起点。
  // 也就是说：只有删字会缩，插入永远不主动扩，扩缩由拖棍决定。
  const nextStart = start >= changeEnd ? start + delta : (start >= changeStart ? changeStart : start);
  let nextEnd: number;
  if (changeStart >= end) nextEnd = end;
  else if (changeEnd <= end) nextEnd = end + delta;
  else nextEnd = changeStart;
  const boundedStart = Math.max(0, Math.min(newText.length, nextStart));
  const boundedEnd = Math.max(0, Math.min(newText.length, nextEnd));
  if (boundedEnd <= boundedStart) return null;
  const quote = newText.slice(boundedStart, boundedEnd);
  return {
    ...anchor, quote,
    prefix: newText.slice(Math.max(0, boundedStart - 40), boundedStart),
    suffix: newText.slice(boundedEnd, boundedEnd + 40),
    start: boundedStart,
  };
}

export function locateAnchor(text: string, anchor: Anchor): number {
  if (!anchor.quote) return -1;
  const hits: number[] = [];
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) hits.push(at);
  if (hits.length === 1) return hits[0];
  const contextual = hits.filter(at =>
    text.slice(0, at).endsWith(anchor.prefix) && text.startsWith(anchor.suffix, at + anchor.quote.length));
  if (contextual.length === 1) return contextual[0];
  return anchor.start !== undefined && contextual.includes(anchor.start) ? anchor.start : -1;
}
