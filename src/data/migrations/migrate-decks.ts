import type {Repository} from '../database';
export function migrateDecks(repository:Repository):void {
  repository.db.exec(`
    CREATE TABLE IF NOT EXISTS deck_settings(folder_id TEXT PRIMARY KEY REFERENCES nodes(id),
      overrides TEXT NOT NULL CHECK(json_valid(overrides)),updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS folders_parent ON nodes(parent_id,position,id) WHERE kind='folder' AND deleted_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS folder_parent_insert BEFORE INSERT ON nodes
      WHEN NEW.kind='folder' AND NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.kind='folder' AND p.deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT,'子牌组只能建立在文件夹内'); END;
    CREATE TRIGGER IF NOT EXISTS folder_parent_update BEFORE UPDATE OF parent_id ON nodes
      WHEN NEW.kind='folder' AND NEW.deleted_at IS NULL AND NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.kind='folder' AND p.deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT,'子牌组只能放在文件夹内'); END;
    PRAGMA user_version=4;
  `);
}
