/**
 * 卡片草稿的纯逻辑（从 ui/app.ts 抽出）。
 *
 * `Draft` 是「编辑器里这份内容」的运行时快照：正文/答案、上次保存的值、文档对象、两个编辑器状态。
 * 这里只放**不依赖 DOM 与 IPC** 的部分：脏判定、只读/遮罩判定。
 */
import type { CardDocuments } from '../core/attachment-document';
import type { Material } from '../core/model';

export interface Draft {
  note: Material;
  content: string;
  answer: string;
  savedContent: string;
  savedAnswer: string;
  documents: CardDocuments;
  questionState?: any;
  answerState?: any;
}

/** 有没有没保存的改动。 */
export function isDirty(draft: Draft): boolean {
  return draft.content !== draft.savedContent || draft.answer !== draft.savedAnswer;
}

export interface StudyFlags {
  studyMode: 'cards' | 'reading' | null;
  studyItemId: string | null;
  editing: boolean;
  answerShown: boolean;
  hasImageMask: boolean;
}

export interface Presentation {
  readOnly: boolean;
  coverMask: boolean;
  hideAnswer: boolean;
}

/**
 * 这张卡现在该怎么呈现：复习/待办里默认只读（Alt+E 或左下「编辑」才进编辑），
 * 复习未揭答案时遮住答案；带图片遮挡而答案为空时也先遮。
 */
export function cardPresentation(draft: Draft, flags: StudyFlags): Presentation {
  const active = flags.studyItemId === draft.note.id && flags.studyMode !== null;
  const reviewing = active && flags.studyMode === 'cards' && draft.note.kind === 'cloze';
  const reading = active && flags.studyMode === 'reading';
  const readOnly = (reviewing || reading) && !flags.editing;
  const coverMask = reviewing && !flags.answerShown;
  return {
    readOnly,
    coverMask,
    hideAnswer: coverMask || (reviewing && !flags.editing && !draft.answer.trim() && flags.hasImageMask),
  };
}
