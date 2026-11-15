import { t } from '../core/i18n';
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {Repository} from './database';
import {importAsset} from './import-vault';
import {normalizeReviewOverrides} from '../core/settings';
type Row=Record<string,any>;
export interface AnkiImportReport {sourceKey:string;cards:number;decks:number;history:number;linkedHistory:number;unlinkedHistory:number;media:number;missingMedia:string[];reconstructedMemoryStates:number;skipped:boolean}
export function importAnkiExport(repository:Repository,bundle:string,mediaRoot:string,incremental=false):AnkiImportReport {
 const objects=JSON.parse(readFileSync(join(bundle,'objects.json'),'utf8')),manifest=JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8'));
 const sourceKey='anki:'+objects.collectionCreatedAt+':'+objects.profile;
 const previous=repository.query('SELECT details FROM anki_sources WHERE source_key=?').get(sourceKey);
 const prior=previous?JSON.parse(String(previous.details)):null;
 if(prior&&!incremental)return {...prior.report,skipped:true};
 const existing=new Map(repository.query('SELECT external_id,node_id FROM external_links WHERE system=?').all(sourceKey)
   .map(row=>[String(row.external_id),String(row.node_id)]));
 const cards=readFileSync(join(bundle,'cards.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 if(cards.length!==manifest.cards)throw Error(t('Anki 导出卡片数量不一致。'));
 const reviews=readFileSync(join(bundle,'reviews.jsonl'),'utf8').split('\n').filter(Boolean);
 if(reviews.length!==manifest.reviews)throw Error(t('Anki 导出历史数量不一致。'));
 const root=realpathSync(mediaRoot),media=new Map<string,string>(),missingMedia:string[]=[];
 for(const name of manifest.mediaNames as string[]){
   let decoded=name;try{decoded=decodeURIComponent(name);}catch{}
   const candidate=resolve(root,decoded),rel=relative(root,candidate);
   if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw Error(t('Anki 媒体路径超出了媒体目录。'));
   if(!existsSync(candidate)){missingMedia.push(name);continue;}
   const actual=realpathSync(candidate),actualRelative=relative(root,actual);
   if(isAbsolute(actualRelative)||actualRelative==='..'||actualRelative.startsWith('..\\')||actualRelative.startsWith('../'))throw Error(t('Anki 媒体链接超出了媒体目录。'));
   media.set(name,importAsset(repository,actual).id);
 }
 const rewrite=(value:string)=>value.replace(/!\[\[anki-media:([A-Za-z0-9_-]+)\]\]/g,(_,token:string)=>{
   const name=Buffer.from(token,'base64url').toString('utf8'),id=media.get(name);return id?'![[asset:'+id+']]':t('[缺失附件：{0}]',name);
 });
 const now=Date.now(),iso=new Date(now).toISOString(),dayStart=(Number(objects.dayCutoff)-86400)*1000,today=Number(objects.today);
 const lastReview=new Map<string,number>();
 for(const line of reviews){const row=JSON.parse(line);if(row.ease>=1&&row.ease<=4&&row.type!==4)lastReview.set(String(row.cid),Number(row.id));}
 const configs=new Map<string,Row>(objects.deckConfigs.map((c:Row)=>[String(c.id),c])),decks:Row[]=objects.decks;
 const folderIds=new Map<string,string>(),deckNames=new Map<string,Row>();
 for(const deck of decks){folderIds.set(String(deck.id),existing.get('deck:'+deck.id)||'810'+String(deck.id));deckNames.set(deck.name,deck);}
 const report:AnkiImportReport={sourceKey,cards:cards.length,decks:decks.length,history:reviews.length,linkedHistory:0,unlinkedHistory:0,media:new Set(media.values()).size,missingMedia,reconstructedMemoryStates:manifest.reconstructedMemoryStates,skipped:false};
 let position=Number(repository.query('SELECT COALESCE(MAX(position),0) p FROM nodes').get()!.p)+1;
 const add=repository.query(`INSERT INTO nodes(id,parent_id,source_id,kind,title,content,answer,anchor,position,metadata,created_at,updated_at,folder_id,priority,study_ready)
  VALUES(?,?,NULL,?,?,?,?,NULL,?,?,?,?,?,NULL,?)`);
 const link=repository.query('INSERT INTO external_links(node_id,system,external_id,details) VALUES(?,?,?,?)');
 const cardIds=new Map<string,string>();
 repository.transaction(()=>{
   if(!prior)repository.query('INSERT INTO anki_sources(source_key,imported_at,details) VALUES(?,?,?)').run(sourceKey,now,JSON.stringify({objects,report}));
   const ordered=decks.slice().sort((a,b)=>a.name.split('::').length-b.name.split('::').length||a.name.localeCompare(b.name));
   for(const deck of ordered){
     if(existing.has('deck:'+deck.id))continue;
     const id=folderIds.get(String(deck.id))!,parts=deck.name.split('::'),title=parts.pop(),parent=parts.length?deckNames.get(parts.join('::')):null;
     if(parts.length&&!parent)throw Error(t('Anki 子牌组缺少父级。'));
     add.run(id,parent?folderIds.get(String(parent.id))!:null,'folder',title,'','',position++,JSON.stringify({anki:{sourceKey,deck}}),iso,iso,null,0);
     link.run(id,sourceKey,'deck:'+deck.id,JSON.stringify({deckId:String(deck.id)}));
     const config=configs.get(String(deck.conf))||configs.get('1');if(!config)throw Error(t('Anki 牌组缺少选项预设。'));
     const learning=config.new?.delays||[],relearning=config.lapse?.delays||[];
     const effective=normalizeReviewOverrides({desiredRetention:Number(Number(deck.desiredRetention??config.desiredRetention??.9).toFixed(4)),maximumInterval:config.rev?.maxIvl||36500,
       enableShortTerm:false,leechThreshold:config.lapse?.leechFails??8,leechAction:config.lapse?.leechAction===1?'tag':'suspend',fsrsVersion:'FSRS-6',fsrsWeights:config.fsrsParams6?.length?config.fsrsParams6:config.fsrsParams5||[],
       learningSteps:learning.map((minutes:number)=>minutes+'m'),relearningSteps:relearning.map((minutes:number)=>minutes+'m')});
     repository.query('INSERT INTO deck_settings(folder_id,overrides,updated_at) VALUES(?,?,?)').run(id,JSON.stringify(effective),now);
   }
   for(const item of cards){
     const mapped=existing.get('card:'+item.card.id);
     if(mapped){
       cardIds.set(String(item.card.id),mapped);
       const note=repository.getNode(mapped);
       if(!note||note.kind==='folder')continue;
       const repair=(text:string)=>text.replace(/\[缺失附件：([^\]\r\n]+)\]/g,(marker,name:string)=>{
         const asset=media.get(name);return asset?'![[asset:'+asset+']]':marker;
       });
       const content=repair(note.content),answer=repair(note.answer);
       if(content!==note.content||answer!==note.answer)repository.save({id:mapped,revision:note.revision,content,answer});
       continue;
     }
     const c=item.card,id='820'+String(c.id),folderId=folderIds.get(String(c.odid||c.did));if(!folderId)throw Error(t('Anki 卡片缺少牌组。'));
     cardIds.set(String(c.id),id);const content=rewrite(item.question),answer=rewrite(item.answer),stage=Number(c.type);
     add.run(id,folderId,'cloze',item.title,content,answer,position++,JSON.stringify({anki:{sourceKey,card:c,noteId:String(item.noteId),modelId:String(item.modelId),fields:item.fields,tags:item.tags,originalQuestion:item.rawQuestion,originalAnswer:item.rawAnswer}}),new Date(Number(c.id)).toISOString(),new Date(Number(c.mod)*1000).toISOString(),folderId,content.trim()&&answer.trim()?1:0);
     const conf=JSON.parse(String(repository.query('SELECT overrides FROM deck_settings WHERE folder_id=?').get(folderId)!.overrides));
     const due=c.odid?Number(c.odue):Number(c.due);
     const dueAt=stage===0?now:stage===2||c.queue===3||due<1000000000?dayStart+(due-today)*86400000:due*1000;
     let data:Row={};try{data=JSON.parse(c.data||'{}');}catch{}
     const last=stage===0?null:Number(data.lrt)*1000||lastReview.get(String(c.id))||Math.min(now,dueAt-Number(c.ivl)*86400000);
     const remaining=Number(c.left)%1000,steps=stage===3?conf.relearningSteps:conf.learningSteps;
     const state={cardId:id,stability:Number(item.memory?.stability||0),difficulty:Number(item.memory?.difficulty||0),state:stage,
       scheduleStatus:stage===0?'new':stage===2?'review':'learning',dueAt:new Date(dueAt).toISOString(),lastReviewAt:last?new Date(last).toISOString():null,
       reps:Number(c.reps),lapses:Number(c.lapses),scheduledDays:Number(c.ivl),learningStep:stage===1||stage===3?Math.max(0,steps.length-remaining):0};
     if(stage!==0&&(!state.stability||!state.difficulty))throw Error(t('Anki 已学卡片缺少可恢复的记忆状态：{0}',c.id));
     repository.query("INSERT INTO review_cards(node_id,algorithm,algorithm_version,state,due_at,enabled,revision,updated_at,stage) VALUES(?,'fsrs','ts-fsrs/6.0.0:FSRS-6',?,?,?,0,?,?)")
       .run(id,JSON.stringify(state),dueAt,c.queue===-1?0:1,now,stage);
     link.run(id,sourceKey,'card:'+c.id,JSON.stringify({noteId:String(item.noteId),cardId:String(c.id),templateOrdinal:c.ord}));
   }
   const rawLog=repository.query('INSERT INTO anki_review_log(source_key,review_id,card_id,node_id,reviewed_at,raw) VALUES(?,?,?,?,?,?) ON CONFLICT(source_key,review_id) DO UPDATE SET node_id=COALESCE(anki_review_log.node_id,excluded.node_id)');
   const log=repository.query('INSERT OR IGNORE INTO review_log(event_id,node_id,reviewed_at,rating,algorithm_version,before_state,after_state,details) VALUES(?,?,?,?,?,?,?,?)');
   for(const line of reviews){
     const row=JSON.parse(line),nodeId=cardIds.get(String(row.cid))||existing.get('card:'+row.cid)||null;
     rawLog.run(sourceKey,String(row.id),String(row.cid),nodeId,Number(row.id),line);
     if(nodeId){report.linkedHistory++;if(row.ease>=1&&row.ease<=4)log.run('anki:'+createHash('sha256').update(sourceKey+':'+row.id).digest('hex'),nodeId,Number(row.id),row.ease,'anki:historical','null','null',JSON.stringify({sourceKey,anki:row}));}
     else report.unlinkedHistory++;
   }
   repository.query("UPDATE nodes SET push_ready=CASE WHEN trim(content)!='' OR trim(answer)!='' THEN 1 ELSE 0 END WHERE id IN(SELECT node_id FROM external_links WHERE system=?)").run(sourceKey);
   repository.query("INSERT OR IGNORE INTO node_tags SELECT n.id,j.value FROM nodes n,json_each(n.metadata,'$.anki.tags') j WHERE j.type='text' AND n.id IN(SELECT node_id FROM external_links WHERE system=?)").run(sourceKey);
   repository.query("INSERT OR IGNORE INTO reading_state(node_id,due_at,enabled) SELECT r.node_id,?,CASE WHEN r.enabled=0 THEN 1 ELSE 0 END FROM review_cards r JOIN external_links e ON e.node_id=r.node_id WHERE e.system=?").run(now,sourceKey);
   repository.query('UPDATE anki_sources SET details=? WHERE source_key=?').run(JSON.stringify({objects,report,mediaNames:{...prior?.mediaNames,...Object.fromEntries(media)}}),sourceKey);
   repository.setSetting('studySeededV3',true);
 });
 return report;
}
