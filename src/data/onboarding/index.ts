import type {Locale} from '../../core/i18n';
import incrementalReadingZh from './zh-CN/01-incremental-reading.md';
import reviewZh from './zh-CN/02-review.md';
import readingZh from './zh-CN/03-reading.md';
import directoryTreeZh from './zh-CN/04-directory-tree.md';
import memoryTreeZh from './zh-CN/05-memory-tree.md';
import markdownZh from './zh-CN/06-markdown.md';
import incrementalReadingEn from './en/01-incremental-reading.md';
import reviewEn from './en/02-review.md';
import readingEn from './en/03-reading.md';
import directoryTreeEn from './en/04-directory-tree.md';
import memoryTreeEn from './en/05-memory-tree.md';
import markdownEn from './en/06-markdown.md';

export interface OnboardingTopic {
  id: string;
  title: Record<Locale, string>;
  content: Record<Locale, string>;
}

/**
 * 新资料库自带的引导内容。正文放在同目录的 Markdown 文件里，按界面语言各一份，
 * 打包时随程序一起分发，不依赖资料库里的旧卡片。
 */
export const ONBOARDING_TOPICS: OnboardingTopic[] = [
  {
    id: 'incremental-reading',
    title: {'zh-CN': '渐进阅读', en: 'Incremental Reading'},
    content: {'zh-CN': incrementalReadingZh, en: incrementalReadingEn},
  },
  {
    id: 'review',
    title: {'zh-CN': '关于复习', en: 'Reviewing Test Cards'},
    content: {'zh-CN': reviewZh, en: reviewEn},
  },
  {
    id: 'reading',
    title: {'zh-CN': '关于待办', en: 'Working Through To-do'},
    content: {'zh-CN': readingZh, en: readingEn},
  },
  {
    id: 'directory-tree',
    title: {'zh-CN': '目录树', en: 'Directory Tree'},
    content: {'zh-CN': directoryTreeZh, en: directoryTreeEn},
  },
  {
    id: 'memory-tree',
    title: {'zh-CN': '关于记忆树', en: 'Memory Tree and Prerequisites'},
    content: {'zh-CN': memoryTreeZh, en: memoryTreeEn},
  },
  {
    id: 'markdown',
    title: {'zh-CN': 'markdown示例', en: 'Markdown Examples'},
    content: {'zh-CN': markdownZh, en: markdownEn},
  },
];
