import { t } from './i18n';
import type { Anchor } from './model';

export const CARD_START = '<!-- irtree-card -->\n';
export const CARD_DIVIDER = '\n\n<!-- irtree-answer -->\n';

export function titleFrom(text: string): string {
  return Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 100).join('') || t('未命名');
}

export function makeAnchor(text: string, from: number, to: number, section?: Anchor['section']): Anchor {
  return {
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - 40), from),
    suffix: text.slice(to, to + 40),
    start: from,
    ...(section ? { section } : {}),
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

export function cardParts(body: string): { content: string; answer: string } {
  const normalized = body.replace(/\r\n/g, '\n');
  if (normalized.startsWith(CARD_START)) {
    const boundary = normalized.indexOf(CARD_DIVIDER, CARD_START.length);
    if (boundary >= 0) return {
      content: normalized.slice(CARD_START.length, boundary),
      answer: normalized.slice(boundary + CARD_DIVIDER.length),
    };
  }
  const old = normalized.match(/^## 检测内容\n\n([\s\S]*?)\n\n---\n\n## 答案\n\n([\s\S]*)$/u);
  if (old) return { content: old[1], answer: old[2] };
  const matches = [...normalized.matchAll(/\{\{c1::([\s\S]+?)\}\}/gu)];
  if (matches.length === 1 && !matches[0][1].includes('{{')) {
    const match = matches[0];
    const at = match.index!;
    return { content: normalized.slice(0, at) + '[...]' + normalized.slice(at + match[0].length), answer: match[1] };
  }
  return { content: body, answer: '' };
}

export function readAnchor(value: unknown): Anchor | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const data = value as Partial<Anchor> | null;
  if (!data || typeof data.quote !== 'string' || !data.quote) return null;
  return {
    quote: data.quote,
    prefix: typeof data.prefix === 'string' ? data.prefix : '',
    suffix: typeof data.suffix === 'string' ? data.suffix : '',
    ...(Number.isSafeInteger(data.start) ? { start: data.start } : {}),
    ...(data.section === 'answer' || data.section === 'question' ? { section: data.section } : {}),
  };
}
