import type {Repository} from '../database';
export function migrateStudy(repository:Repository):void {
  const db=repository.db,now=Date.now(),iso=new Date(now).toISOString();
  db.exec(`
    ALTER TABLE nodes ADD COLUMN folder_id TEXT REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE nodes ADD COLUMN priority INTEGER CHECK(priority IS NULL OR priority BETWEEN 0 AND 9);
    ALTER TABLE nodes ADD COLUMN study_ready INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE review_cards ADD COLUMN stage INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX nodes_folder ON nodes(folder_id,kind,deleted_at,study_ready,position,id);
    CREATE INDEX review_stage_due ON review_cards(enabled,stage,due_at,node_id);
    CREATE TABLE reading_state(node_id TEXT PRIMARY KEY REFERENCES nodes(id),due_at INTEGER NOT NULL,
      interval_ms INTEGER NOT NULL DEFAULT 0,reps INTEGER NOT NULL DEFAULT 0,last_read_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX reading_due ON reading_state(enabled,due_at,node_id);
    CREATE TABLE reading_log(event_id TEXT PRIMARY KEY,node_id TEXT NOT NULL REFERENCES nodes(id),
      reviewed_at INTEGER NOT NULL,action TEXT NOT NULL,before_state TEXT NOT NULL,after_state TEXT NOT NULL,undone_at INTEGER);
    CREATE INDEX reading_log_node_time ON reading_log(node_id,reviewed_at);
    CREATE TABLE study_operations(event_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,node_id TEXT NOT NULL REFERENCES nodes(id),
      kind TEXT NOT NULL,reviewed_at INTEGER NOT NULL,before_state TEXT NOT NULL,after_state TEXT NOT NULL,undone_at INTEGER);
    CREATE INDEX study_session_operations ON study_operations(session_id,reviewed_at);
  `);
  const orphans=Number(db.prepare(`SELECT count(*) n FROM nodes n WHERE kind!='folder' AND deleted_at IS NULL
    AND (parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM nodes p WHERE p.id=n.parent_id AND p.deleted_at IS NULL))`).get()!.n);
  let fallback:string|null=null;
  if(orphans){
    fallback=repository.ensureDefaultFolder();
    db.prepare(`UPDATE nodes AS n SET parent_id=? WHERE kind!='folder' AND deleted_at IS NULL
      AND(parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM nodes p WHERE p.id=n.parent_id AND p.deleted_at IS NULL))`).run(fallback);
  }
  // Materialize ownership once: a correlated recursive CTE would rebuild the
  // entire tree for each updated row when upgrading a large existing library.
  db.exec(`CREATE TEMP TABLE migration_ownership(id TEXT PRIMARY KEY,folder_id TEXT NOT NULL);
    WITH RECURSIVE ownership(id,folder_id) AS (
    SELECT id,id FROM nodes WHERE kind='folder' AND deleted_at IS NULL
    UNION ALL SELECT child.id,parent.folder_id FROM nodes child JOIN ownership parent ON child.parent_id=parent.id
      WHERE child.kind!='folder' AND child.deleted_at IS NULL
    ) INSERT INTO migration_ownership SELECT id,folder_id FROM ownership;
    UPDATE nodes SET folder_id=(SELECT o.folder_id FROM migration_ownership o WHERE o.id=nodes.id)
      WHERE kind!='folder' AND deleted_at IS NULL;
    DROP TABLE migration_ownership;
    UPDATE nodes SET study_ready=CASE WHEN trim(content)!='' AND(kind!='cloze' OR trim(answer)!='') THEN 1 ELSE 0 END;
    UPDATE review_cards SET stage=COALESCE(json_extract(state,'$.state'),0);
  `);
  const unresolved=Number(db.prepare("SELECT count(*) n FROM nodes WHERE kind!='folder' AND deleted_at IS NULL AND folder_id IS NULL").get()!.n);
  if(unresolved){fallback??=repository.ensureDefaultFolder();db.prepare("UPDATE nodes SET parent_id=?,folder_id=? WHERE kind!='folder' AND deleted_at IS NULL AND folder_id IS NULL").run(fallback,fallback);}
  db.prepare(`INSERT OR IGNORE INTO reading_state(node_id,due_at)
    SELECT id,? FROM nodes WHERE kind IN('topic','material') AND deleted_at IS NULL`).run(now);
  db.prepare(`INSERT OR IGNORE INTO review_cards(node_id,algorithm,algorithm_version,state,due_at,updated_at,stage)
    SELECT id,'fsrs','ts-fsrs/6.0.0:FSRS-7',json_object('cardId',id,'stability',0,'stabilityFast',0,'difficulty',0,
      'state',0,'scheduleStatus','new','dueAt',?,'lastReviewAt',NULL,'reps',0,'lapses',0,'scheduledDays',0,'learningStep',0),?,?,0
    FROM nodes WHERE kind='cloze' AND deleted_at IS NULL`).run(iso,now,now);
  db.exec(`
    CREATE TRIGGER node_requires_folder_insert BEFORE INSERT ON nodes
      WHEN NEW.kind!='folder' AND(NEW.parent_id IS NULL OR NEW.folder_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'卡片必须归属文件夹'); END;
    CREATE TRIGGER node_requires_folder_update BEFORE UPDATE OF parent_id,folder_id ON nodes
      WHEN NEW.kind!='folder' AND NEW.deleted_at IS NULL AND(NEW.parent_id IS NULL OR NEW.folder_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'卡片必须归属文件夹'); END;
    PRAGMA user_version=3;
  `);
}
