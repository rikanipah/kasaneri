import { t } from '../core/i18n';
import { DatabaseSync } from 'node:sqlite';
import { LIBRARY_SCHEMA_VERSION } from '../core/library-schema';

export function readSnapshotSchemaVersion(file: string): number {
  const db = new DatabaseSync(file, {readOnly:true});
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > LIBRARY_SCHEMA_VERSION) throw Error(t('快照来自更新版本，请先更新程序。'));
    if (!Number.isInteger(version) || version < 1 ||
        !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='nodes'").get()) {
      throw Error(t('快照缺少有效的资料库。'));
    }
    return version;
  } finally {
    db.close();
  }
}
