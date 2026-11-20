/**
 * 撤销栈（从 ui/app.ts 抽出的纯逻辑）。
 *
 * 只负责「记一条、取最新、撤掉后从栈里删掉、连续打字时合并」，不碰 DOM、不碰 IPC；
 * 真正的还原动作由调用方塞进 `run`，栈只在必要时回调 `applied()`。
 *
 * 2026-11-20 抽出，为的是让 app.ts 只剩会话与装配。
 */
import type { AttachmentDocument } from '../core/attachment-document';

/** 一次文本编辑的快照，用来判断「连续打字要不要合并成一条撤销」。 */
export interface TextSnapshot {
  id: string;
  section: 'question' | 'answer';
  before: string;
  beforeDocument: AttachmentDocument;
  after: string;
  /** 0 表示这次不是「打字」（例如粘贴、工具栏操作），不参与合并 */
  typedAt: number;
}

export interface UndoEntry {
  /** 执行撤销；做完调用 applied() 让栈把这条删掉 */
  run: (applied: () => void) => Promise<void>;
  text?: TextSnapshot;
}

export interface UndoStack {
  push(entry: UndoEntry): void;
  latest(): UndoEntry | null;
  size(): number;
  /** 撤销前把某条从栈里移除（由 run 里的 applied() 调用） */
  remove(entry: UndoEntry): void;
  clear(): void;
  /**
   * 连续打字合并：把上一次的 after 换成新的，并刷新时间。
   * 返回 false 表示不合并，调用方应当另记一条。
   */
  coalesceText(next: { id: string; section: 'question' | 'answer'; previous: string; value: string; now: number }): boolean;
}

const DEFAULT_LIMIT = 100;
const TYPING_WINDOW_MS = 500;

export function createUndoStack(limit = DEFAULT_LIMIT): UndoStack {
  const entries: UndoEntry[] = [];
  return {
    push(entry) {
      entries.push(entry);
      if (entries.length > limit) entries.shift();
    },
    latest() {
      return entries.length ? entries[entries.length - 1] : null;
    },
    size() {
      return entries.length;
    },
    remove(entry) {
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
    },
    clear() {
      entries.length = 0;
    },
    coalesceText(next) {
      const last = entries.length ? entries[entries.length - 1].text : undefined;
      if (!last) return false;
      if (!last.typedAt) return false;
      if (last.id !== next.id || last.section !== next.section) return false;
      if (last.after !== next.previous) return false;
      if (next.now - last.typedAt >= TYPING_WINDOW_MS) return false;
      last.after = next.value;
      last.typedAt = next.now;
      return true;
    },
  };
}
