import type {Repository} from '../database';

// 卡片内容同步表原先在 ContentJournal 构造器里临时建，这里搬进正式迁移（schema 12）。
// sync_content_versions.created_at 记录版本首次入库时间（毫秒）；Anki 式合并按它挑较新的版本，
// 两边算出的赢家一致，合并结果才会收敛。
export function migrateContentSync(repository:Repository):void{
  const db=repository.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_content_versions(
      version_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,parents TEXT NOT NULL,value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sync_content_node ON sync_content_versions(node_id);
    CREATE TABLE IF NOT EXISTS sync_content_dirty(node_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sync_content_local(node_id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES sync_content_versions(version_id),
      applied_version_id TEXT REFERENCES sync_content_versions(version_id));
    INSERT OR IGNORE INTO sync_content_dirty SELECT id FROM nodes;
    -- 注意：不能用 INSERT OR IGNORE。nodes 走 UPSERT 时，UPDATE 触发器里的 OR IGNORE 会被外层
    -- ON CONFLICT 覆盖成直接报 UNIQUE（已用 node:sqlite 复现），这里改成显式存在性判断。
    DROP TRIGGER IF EXISTS sync_content_insert;
    CREATE TRIGGER sync_content_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO sync_content_dirty SELECT new.id WHERE NOT EXISTS(SELECT 1 FROM sync_content_dirty WHERE node_id=new.id);
    END;
    DROP TRIGGER IF EXISTS sync_content_update;
    CREATE TRIGGER sync_content_update AFTER UPDATE OF kind,parent_id,source_id,title,content,answer,anchor,position,priority,deleted_at ON nodes
    WHEN old.kind IS NOT new.kind OR old.parent_id IS NOT new.parent_id OR old.source_id IS NOT new.source_id OR
      old.title IS NOT new.title OR old.content IS NOT new.content OR old.answer IS NOT new.answer OR
      old.anchor IS NOT new.anchor OR old.position IS NOT new.position OR old.priority IS NOT new.priority OR
      old.deleted_at IS NOT new.deleted_at
    BEGIN
      INSERT INTO sync_content_dirty SELECT new.id WHERE NOT EXISTS(SELECT 1 FROM sync_content_dirty WHERE node_id=new.id);
    END;
    DROP TRIGGER IF EXISTS sync_content_delete;
    CREATE TRIGGER sync_content_delete AFTER DELETE ON nodes BEGIN
      INSERT INTO sync_content_dirty SELECT old.id WHERE NOT EXISTS(SELECT 1 FROM sync_content_dirty WHERE node_id=old.id);
    END;
  `);
  // 旧库（schema ≤11）的表已经由 ContentJournal 建过，只缺 created_at；按「现在」补齐，视为同一条基线。
  const versionColumns=repository.query('PRAGMA table_info(sync_content_versions)').all().map(row=>String(row.name));
  if(!versionColumns.includes('created_at')){
    db.exec(`ALTER TABLE sync_content_versions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE sync_content_versions SET created_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE created_at=0;`);
  }
  // Anki 式合并要区分「本机版本」和「对端已确认的版本」。旧库没有这一列，补上并把当前内容视为已确认；
  // 已经积压了分歧（多个 head）的节点保持 NULL，让它们继续作为冲突等用户选择，不静默合并掉。
  const localColumns=repository.query('PRAGMA table_info(sync_content_local)').all().map(row=>String(row.name));
  if(!localColumns.includes('applied_version_id')){
    db.exec(`ALTER TABLE sync_content_local ADD COLUMN applied_version_id TEXT REFERENCES sync_content_versions(version_id);
      UPDATE sync_content_local SET applied_version_id=version_id
      WHERE applied_version_id IS NULL AND node_id NOT IN(
        SELECT node_id FROM(
          SELECT v.node_id FROM sync_content_versions v
          WHERE NOT EXISTS(SELECT 1 FROM sync_content_versions c,json_each(c.parents) p
            WHERE c.node_id=v.node_id AND p.value=v.version_id)
        ) GROUP BY node_id HAVING count(*)>1
      );`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_content_pending(node_id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO sync_content_pending
      SELECT v.node_id FROM sync_content_versions v LEFT JOIN sync_content_local l ON l.node_id=v.node_id
      WHERE l.version_id IS NULL OR v.version_id<>l.version_id;
    CREATE TABLE IF NOT EXISTS sync_content_deleted_schedule(node_id TEXT PRIMARY KEY,review INTEGER,reading INTEGER);
    CREATE TRIGGER IF NOT EXISTS sync_content_before_delete BEFORE UPDATE OF deleted_at ON nodes
    WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
      INSERT OR REPLACE INTO sync_content_deleted_schedule VALUES(old.id,
        (SELECT enabled FROM review_cards WHERE node_id=old.id),
        (SELECT enabled FROM reading_state WHERE node_id=old.id));
    END;
    CREATE TRIGGER IF NOT EXISTS sync_content_after_restore AFTER UPDATE OF deleted_at ON nodes
    WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL BEGIN
      DELETE FROM sync_content_deleted_schedule WHERE node_id=new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_content_after_purge AFTER DELETE ON nodes BEGIN
      DELETE FROM sync_content_deleted_schedule WHERE node_id=old.id;
    END;
    PRAGMA user_version=12;
  `);
}
