import type {Repository} from '../database';
export function migrateAnki(repository:Repository){
 repository.db.exec(`CREATE TABLE IF NOT EXISTS anki_sources(source_key TEXT PRIMARY KEY,imported_at INTEGER NOT NULL,details TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS anki_review_log(source_key TEXT NOT NULL REFERENCES anki_sources(source_key),review_id TEXT NOT NULL,
   card_id TEXT NOT NULL,node_id TEXT REFERENCES nodes(id),reviewed_at INTEGER NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(source_key,review_id));
 CREATE INDEX IF NOT EXISTS anki_review_card_time ON anki_review_log(source_key,card_id,reviewed_at);
 PRAGMA user_version=5;`);
}
