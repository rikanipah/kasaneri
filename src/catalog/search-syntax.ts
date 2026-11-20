/**
 * 2026-11-19：Anki 风格搜索语法的解析层（第一步：字段 + 否定 + AND/OR）。
 *
 * 支持的写法（对齐 Anki 的高频子集）：
 *   deck:日语           按目录名（含子目录）
 *   tag:leech           按标签（含子标签）
 *   is:new|learning|review|suspended|buried|due
 *   prop:ivl>=7         卡片标签比较（ivl/reps/lapses/ease/due）
 *   review:>=3          复习次数（等价 prop:reps>=3）
 *   rated:7 / rated:7:1 最近 7 天答过 / 最近 7 天答过「重来」（1–4 评价）
 *   added:7 / edited:7  最近 7 天新增 / 修改过的卡片
 *   "带空格的词"         引号包裹
 *   -tag:x              否定
 *   a and b / a or c    逻辑（无括号，按 AND 优先）
 *   其它文本              走原来的全文搜索
 *
 * 本文件只做「解析」：把查询串切成结构化的条件列表，真正的 SQL 由调用方拼。
 * 这样解析规则可以单独测试，不需要数据库。
 */

export type SearchComparison = '=' | '!=' | '<' | '<=' | '>' | '>=';

export interface SearchTerm {
  /** 字段名；空串表示全文搜索 */
  field: '' | 'deck' | 'tag' | 'is' | 'prop' | 'review' | 'rated' | 'added' | 'edited';
  /** 字段的参数（如 tag 名、prop 名） */
  key?: string;
  /** 值或文本 */
  value: string;
  /** prop/review 这类字段的比较符 */
  op?: SearchComparison;
  /** 前面有 `-` 表示否定 */
  negated: boolean;
}

export interface ParsedSearch {
  terms: SearchTerm[];
  /** 是否解析失败（例如比较符后没有数字）；失败时调用方应回退到全文搜索 */
  error?: string;
}

const COMPARISON = /^(>=|<=|!=|=|<|>)(.+)$/u;
const PROP_NAMES = new Set(['ivl', 'reps', 'lapses', 'ease', 'due']);
const STATE_NAMES = new Set(['new', 'learning', 'review', 'suspended', 'buried', 'due']);

/** 把查询串切成 token，保留引号内的空格。 */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of query.trim()) {
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/u.test(char)) { if (current) { tokens.push(current); current = ''; } continue; }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseTerm(raw: string): SearchTerm | null {
  let text = raw;
  const negated = text.startsWith('-') && text.length > 1;
  if (negated) text = text.slice(1);
  const colon = text.indexOf(':');
  // 全文搜索（没有字段名，或者冒号后面为空）
  if (colon <= 0 || colon === text.length - 1) return { field: '', value: text, negated };
  const field = text.slice(0, colon).toLowerCase();
  const rest = text.slice(colon + 1);
  switch (field) {
    case 'deck':
    case 'tag':
      return { field, value: rest, negated };
    case 'is': {
      const value = rest.toLowerCase();
      if (!STATE_NAMES.has(value)) return { field: '', value: text, negated };
      return { field, value, negated };
    }
    case 'prop': {
      // prop:ivl>=7 / prop:due<0
      const match = rest.match(/^([a-z]+)(>=|<=|!=|=|<|>)(.+)$/u);
      if (!match) return { field: '', value: text, negated };
      const key = match[1].toLowerCase();
      if (!PROP_NAMES.has(key)) return { field: '', value: text, negated };
      return { field, key, op: match[2] as SearchComparison, value: match[3], negated };
    }
    case 'review': {
      // review:>=3 等价 prop:reps>=3
      const match = rest.match(COMPARISON);
      if (match) return { field, op: match[1] as SearchComparison, value: match[2], negated };
      return { field, op: '<=', value: rest, negated };
    }
    case 'rated':
    case 'added':
    case 'edited': {
      // 2026-11-19：这三个字段不支持比较符（Anki 里就是「最近 N 天」）。
      // rated 额外支持 rated:N:评价（只看某个评价的复习），例如 rated:7:1 = 近 7 天评过「重来」。
      if (COMPARISON.test(rest)) return { field: '', value: text, negated };
      return { field, value: rest, negated };
    }
    default:
      // 不认识的字段：当全文搜索（Anki 也是这样，未知 key 会被当作字段名搜索）
      return { field: '', value: text, negated };
  }
}

/**
 * 解析查询串。约定：
 * - 相邻词之间是 AND（与 Anki 一致）；
 * - 出现独立的 `or`/`OR` 时，它两侧的组用 OR 连接——这里先扁平成列表，
 *   由调用方按 `groups` 处理；为简化第一步，只把 `or` 记录成 term 分隔标记。
 */
export function parseSearch(query: string): ParsedSearch {
  const terms: SearchTerm[] = [];
  for (const token of tokenize(query)) {
    const lower = token.toLowerCase();
    if (lower === 'and') continue;
    if (lower === 'or') { terms.push({ field: '', value: '__OR__', negated: false }); continue; }
    const term = parseTerm(token);
    if (!term) { return { terms, error: `无法解析：${token}` }; }
    // 数值字段要求是数字（rated 允许 N:评价）
    if (term.op && term.field !== 'tag' && term.field !== 'deck' && term.field !== 'is' && term.field !== '') {
      if (!Number.isFinite(Number(term.value))) return { terms, error: `需要数字：${token}` };
    }
    if (term.field === 'rated' && !/^\d+(?::[1-4])?$/u.test(term.value)) return { terms, error: `需要数字：${token}` };
    if ((term.field === 'added' || term.field === 'edited') && !/^\d+$/u.test(term.value)) return { terms, error: `需要数字：${token}` };
    terms.push(term);
  }
  return { terms };
}
