import {getLocale, type Locale} from '../core/i18n';
import type {Repository} from './database';
import legacyTopics from './onboarding/legacy-v1.json';
import {ONBOARDING_TOPICS} from './onboarding';

/** 引导内容的写入标记：新库写入一次，旧库刷新一次，之后不再改动用户的卡片。 */
const SEED_FLAG = 'seedLibraryV2';
/** 更早版本写入过引导的资料库会带这个标记，刷新时按它判断。 */
const LEGACY_SEED_FLAG = 'seedLibraryV1';

const locale = ():Locale => (getLocale() === 'en' ? 'en' : 'zh-CN');

/** 只统计用户可能自己建过的卡片，默认文件夹本身不算。 */
function userCardCount(repository:Repository):number {
  return Number(repository.query(
    "SELECT count(*) n FROM nodes WHERE deleted_at IS NULL AND id NOT IN ('folder:unfiled','folder:recovered')",
  ).get()!.n);
}

/** 新资料库：把引导主题写进默认文件夹，并保证它们不参与「撤销新建」。 */
function seedFreshLibrary(repository:Repository, register:(id:string)=>void):void {
  const folderId = repository.ensureDefaultFolder();
  const language = locale();
  repository.transaction(() => {
    for (const topic of ONBOARDING_TOPICS) {
      const created = repository.create({
        parentId: folderId,
        kind: 'topic',
        title: topic.title[language],
        content: topic.content[language],
      });
      repository.query('DELETE FROM creation_undo WHERE node_id=?').run(created.node.id);
      register(created.node.id);
    }
    repository.setSetting(SEED_FLAG, true);
  });
}

/**
 * 旧资料库：如果里面还留着上一版原封不动的引导卡，就换成当前版本的内容；
 * 用户改过的卡片（标题或正文不再等于旧文案）一律不动。
 */
function refreshLegacySeed(repository:Repository):void {
  const language = locale();
  repository.transaction(() => {
    for (let index = 0; index < legacyTopics.length && index < ONBOARDING_TOPICS.length; index++) {
      const previous = legacyTopics[index], topic = ONBOARDING_TOPICS[index];
      const rows = repository.query(
        "SELECT id,revision FROM nodes WHERE kind='topic' AND title=? AND content=? AND deleted_at IS NULL",
      ).all(previous.title, previous.content);
      for (const row of rows) {
        const id = String(row.id);
        repository.rename(id, topic.title[language]);
        repository.save({id, revision: Number(row.revision), content: topic.content[language], answer: ''});
      }
    }
    repository.setSetting(SEED_FLAG, true);
  });
}

/**
 * 新资料库自动带一份使用引导，老资料库只在内容仍是旧版原文时更新一次。
 * 调用方是 worker 打开资料库之后，此时 StudyService 已经就绪、能给新卡建排程。
 */
export function seedDefaultLibrary(repository:Repository, register:(id:string)=>void):boolean {
  if (repository.getSetting(SEED_FLAG)) return false;
  if (userCardCount(repository) === 0) {
    seedFreshLibrary(repository, register);
    return true;
  }
  if (repository.getSetting(LEGACY_SEED_FLAG)) {
    refreshLegacySeed(repository);
    return true;
  }
  // 用户自己的资料库：只记下已经处理过，不塞任何卡片。
  repository.setSetting(SEED_FLAG, true);
  return false;
}
