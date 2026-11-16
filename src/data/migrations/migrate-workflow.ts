import type {Repository} from '../database';
export function migrateWorkflow(repository:Repository){
 const db=repository.db,now=Date.now();
 if(!repository.query('PRAGMA table_info(nodes)').all().some(row=>row.name==='push_ready'))db.exec('ALTER TABLE nodes ADD COLUMN push_ready INTEGER NOT NULL DEFAULT 0');
 db.exec(`UPDATE nodes SET push_ready=CASE WHEN trim(content)!='' OR trim(answer)!='' THEN 1 ELSE 0 END;
 CREATE INDEX IF NOT EXISTS nodes_push_ready ON nodes(kind,deleted_at,push_ready,folder_id);
 CREATE TABLE IF NOT EXISTS node_tags(node_id TEXT NOT NULL REFERENCES nodes(id),tag TEXT NOT NULL,PRIMARY KEY(node_id,tag));
 CREATE INDEX IF NOT EXISTS review_log_time ON review_log(reviewed_at,node_id) WHERE undone_at IS NULL;
 INSERT OR IGNORE INTO node_tags SELECT n.id,j.value FROM nodes n,json_each(n.metadata,'$.anki.tags') j WHERE j.type='text';
 INSERT OR IGNORE INTO reading_state(node_id,due_at,enabled) SELECT n.id,${now},CASE WHEN r.enabled=0 THEN 1 ELSE 0 END
 FROM nodes n JOIN review_cards r ON r.node_id=n.id WHERE n.kind='cloze' AND n.deleted_at IS NULL;
 PRAGMA user_version=6;`);
 // 这里原本强制 enableShortTerm=false（1.x 曾关闭学习步骤）。旧版 恢复 Anki 式三态后
 // 不再改写设置，只把旧值清掉，让全局设置回到当前默认（学习步骤启用）。
 const settings=repository.getSetting('studySettings') as any;
 if(settings&&'enableShortTerm' in settings){const next={...settings};delete next.enableShortTerm;repository.setSetting('studySettings',next);}
 const imported=new Map<string,any>();
 for(const source of repository.query('SELECT details FROM anki_sources').all()){
  const objects=JSON.parse(String(source.details)).objects;if(!objects)continue;
  const configs=new Map(objects.deckConfigs.map((config:any)=>[String(config.id),config]));
  for(const deck of objects.decks||[])imported.set('810'+deck.id,configs.get(String(deck.conf)));
 }
 for(const row of repository.query('SELECT folder_id,overrides FROM deck_settings').all()){
  const config=JSON.parse(String(row.overrides)),anki=imported.get(String(row.folder_id));
  delete config.enableShortTerm;
  if(anki){config.leechThreshold=anki.lapse?.leechFails??8;config.leechAction=anki.lapse?.leechAction===1?'tag':'suspend';}
  repository.query('UPDATE deck_settings SET overrides=? WHERE folder_id=?').run(JSON.stringify(config),row.folder_id);
 }
}
