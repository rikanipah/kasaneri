import { t } from '../../core/i18n';
import {LIBRARY_SCHEMA_VERSION} from '../../core/library-schema';
import {migrateMemoryPrerequisites} from './migrate-memory-prerequisites';
import type {Repository} from '../database';
import {migrateStudy} from './migrate-study';
import {migrateDecks} from './migrate-decks';
import {migrateAnki} from './migrate-anki';
import {migrateWorkflow} from './migrate-workflow';
import {migrateContentSync} from './migrate-content-sync';

export function migrateLibrary(repository:Repository):void{
  const version = Number(repository.query('PRAGMA user_version').get()!.user_version);
  if (version > LIBRARY_SCHEMA_VERSION) throw Error(t('这个资料库来自更新版本，请先更新程序。'));
  repository.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  if (!version) {
    repository.transaction(() => {
      repository.db.exec(`
        CREATE TABLE nodes(
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
          source_id TEXT REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
          kind TEXT NOT NULL CHECK(kind IN ('folder','topic','material','cloze')),
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          answer TEXT NOT NULL DEFAULT '',
          anchor TEXT,
          position INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX nodes_parent_order ON nodes(parent_id, deleted_at, position, id);
        CREATE INDEX nodes_source ON nodes(source_id, deleted_at);
        CREATE INDEX nodes_position ON nodes(position);
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE assets(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL,
          size INTEGER NOT NULL, relative_path TEXT NOT NULL);
        CREATE TABLE creation_undo(node_id TEXT PRIMARY KEY REFERENCES nodes(id),
          parent_id TEXT, fingerprint TEXT NOT NULL, anchor TEXT, undone_at TEXT);
        CREATE VIRTUAL TABLE nodes_fts USING fts5(title,content,answer,content='nodes',content_rowid='rowid',tokenize='unicode61');
        CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid,title,content,answer) VALUES(new.rowid,new.title,new.content,new.answer);
        END;
        CREATE TRIGGER nodes_fts_update AFTER UPDATE OF title,content,answer ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts,rowid,title,content,answer) VALUES('delete',old.rowid,old.title,old.content,old.answer);
          INSERT INTO nodes_fts(rowid,title,content,answer) VALUES(new.rowid,new.title,new.content,new.answer);
        END;
        PRAGMA user_version=1;
      `);
    });
  }
  repository.db.exec('CREATE INDEX IF NOT EXISTS nodes_position ON nodes(position);');
  if(version<2)repository.transaction(()=>{
    repository.db.exec(`
      CREATE TABLE review_cards(
        node_id TEXT PRIMARY KEY REFERENCES nodes(id),
        algorithm TEXT NOT NULL, algorithm_version TEXT NOT NULL,
        state TEXT NOT NULL, due_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
      CREATE INDEX review_due ON review_cards(enabled,due_at,node_id);
      CREATE TABLE review_log(
        event_id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id),
        reviewed_at INTEGER NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4),
        algorithm_version TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}', undone_at INTEGER
      );
      CREATE INDEX review_log_card_time ON review_log(node_id,reviewed_at);
      CREATE TABLE external_links(
        node_id TEXT NOT NULL REFERENCES nodes(id), system TEXT NOT NULL, external_id TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(node_id,system), UNIQUE(system,external_id)
      );
      PRAGMA user_version=2;
    `);
  });
  if(version<3)repository.transaction(()=>migrateStudy(repository));
  if(version<4)repository.transaction(()=>migrateDecks(repository));
  if(version<5)repository.transaction(()=>migrateAnki(repository));
  if(version<6)repository.transaction(()=>migrateWorkflow(repository));
  if(version<7)repository.transaction(()=>{
    // 1.7 ③：阅读点。字符偏移，0 表示没有记录；切换/评分时由渲染层写回。
    repository.db.exec('ALTER TABLE reading_state ADD COLUMN reading_position INTEGER NOT NULL DEFAULT 0;PRAGMA user_version=7;');
  });
  if(version<8)repository.transaction(()=>{
    // 1.13：垃圾桶。删除=软删除（nodes.deleted_at）+ 这里记一条回收站条目，
    // 供「撤销删除 / 垃圾桶列表 / 阶段式清理」使用。parent_id 与 kind 是删除时的快照，
    // 恢复时用来把卡片放回原处并还原复习/待办状态。
    repository.db.exec(`
      CREATE TABLE IF NOT EXISTS trash(
        node_id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL,
        parent_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        restored_at INTEGER,
        purged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS trash_time ON trash(deleted_at);
      CREATE INDEX IF NOT EXISTS trash_parent ON trash(parent_id);
      PRAGMA user_version=8;
    `);
  });
  // 注意：迁移必须按版本升序执行（每个迁移都会把 user_version 写成自己的版本号），
  // 之前的顺序放反会导致升到 9 之后又被 8 覆盖回 8。
  if(version<9)repository.transaction(()=>{
    // 1.29：记录上次自动延后时间。auto-postpone 每天最多作用一次，避免反复进入待办把同一批材料越推越远。
    repository.db.exec('ALTER TABLE reading_state ADD COLUMN postponed_at INTEGER NOT NULL DEFAULT 0;PRAGMA user_version=9;');
  });
  if(version<10)repository.transaction(()=>repository.db.exec(`
    CREATE TABLE card_relations(
      parent_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      child_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('memory','related')),
      PRIMARY KEY(parent_id,child_id,kind),
      CHECK(parent_id<>child_id),
      CHECK(kind<>'related' OR parent_id<child_id)
    ) WITHOUT ROWID;
    CREATE INDEX card_relations_child ON card_relations(child_id,kind,parent_id);
    PRAGMA user_version=10;
  `));
  if(version<11)repository.transaction(()=>repository.db.exec(`
    CREATE TABLE card_dependency_overrides(
      prerequisite_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      dependent_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('require','ignore')),
      PRIMARY KEY(prerequisite_id,dependent_id),
      CHECK(prerequisite_id<>dependent_id)
    ) WITHOUT ROWID;
    CREATE INDEX card_dependency_by_dependent ON card_dependency_overrides(dependent_id,prerequisite_id);
    PRAGMA user_version=11;
  `));
  if(version<12)repository.transaction(()=>migrateContentSync(repository));
  if(version<13)repository.transaction(()=>migrateMemoryPrerequisites(repository));
}
