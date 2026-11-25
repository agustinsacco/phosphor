-- A version 7 Brain built by the v7 engine: every journal kind, one read in review
-- with its proposal, one read refreshing, and prefs stored with review. Invented names only.
PRAGMA foreign_keys = OFF;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entities(n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, kind TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  memories INTEGER NOT NULL DEFAULT 0, connections INTEGER NOT NULL DEFAULT 0);
CREATE TABLE entity_names(n INTEGER PRIMARY KEY, entity INTEGER NOT NULL REFERENCES entities(n) ON DELETE CASCADE,
  name TEXT NOT NULL, folded TEXT NOT NULL, UNIQUE(entity, folded));
CREATE TABLE entity_keys(namespace TEXT NOT NULL, value TEXT NOT NULL,
  entity INTEGER NOT NULL REFERENCES entities(n) ON DELETE CASCADE, PRIMARY KEY(namespace, value)) WITHOUT ROWID;
CREATE TABLE merges(n INTEGER PRIMARY KEY, source_id TEXT NOT NULL, target INTEGER NOT NULL REFERENCES entities(n) ON DELETE CASCADE,
  label TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL);
CREATE TABLE memories(n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, summary TEXT NOT NULL, type TEXT NOT NULL,
  epistemic TEXT NOT NULL, scope TEXT NOT NULL, branch TEXT, valid_from INTEGER, valid_to INTEGER,
  observed_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','superseded','disputed')),
  origin_session TEXT, origin_title TEXT, job_id TEXT);
CREATE TABLE mentions(memory INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  entity INTEGER NOT NULL REFERENCES entities(n), PRIMARY KEY(memory, entity)) WITHOUT ROWID;
CREATE TABLE relations(n INTEGER PRIMARY KEY, memory INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  subject INTEGER NOT NULL REFERENCES entities(n), predicate TEXT NOT NULL, object INTEGER NOT NULL REFERENCES entities(n),
  live INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  UNIQUE(memory, subject, predicate, object), CHECK(subject <> object));
CREATE TABLE evidence(n INTEGER PRIMARY KEY, session_id TEXT, entry_id TEXT NOT NULL, role TEXT NOT NULL,
  label TEXT NOT NULL, observed_at INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE citations(memory INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  evidence INTEGER NOT NULL REFERENCES evidence(n), quote TEXT NOT NULL, PRIMARY KEY(memory, evidence, quote)) WITHOUT ROWID;
CREATE TABLE relation_support(relation INTEGER NOT NULL REFERENCES relations(n) ON DELETE CASCADE,
  evidence INTEGER NOT NULL REFERENCES evidence(n), quote TEXT NOT NULL, PRIMARY KEY(relation, evidence, quote)) WITHOUT ROWID;
CREATE TABLE memory_links(source INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  target INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('supersedes','conflicts','resolves')), recorded_at INTEGER NOT NULL,
  PRIMARY KEY(source, target, kind)) WITHOUT ROWID;
CREATE TABLE memory_vectors(memory INTEGER PRIMARY KEY REFERENCES memories(n) ON DELETE CASCADE, vector BLOB NOT NULL);
CREATE TABLE memory_bits(memory INTEGER PRIMARY KEY REFERENCES memories(n) ON DELETE CASCADE, bits BLOB NOT NULL);
CREATE TABLE entity_vectors(entity INTEGER PRIMARY KEY REFERENCES entities(n) ON DELETE CASCADE, vector BLOB NOT NULL);
CREATE TABLE entity_bits(entity INTEGER PRIMARY KEY REFERENCES entities(n) ON DELETE CASCADE, bits BLOB NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_path TEXT NOT NULL, title TEXT NOT NULL,
  scope TEXT NOT NULL, branch TEXT, model TEXT NOT NULL, state TEXT NOT NULL, memories INTEGER NOT NULL,
  leaf_id TEXT, error TEXT, queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, usage TEXT,
  extractor INTEGER NOT NULL, progress TEXT, computed_revision INTEGER, replaces TEXT, from_leaf TEXT, run_started_at INTEGER);
CREATE TABLE job_parts(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, part TEXT NOT NULL,
  input_hash TEXT NOT NULL, state TEXT NOT NULL, output TEXT, PRIMARY KEY(job_id, part, input_hash)) WITHOUT ROWID;
CREATE TABLE proposals(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, payload TEXT NOT NULL);
CREATE TABLE proposal_vectors(job_id TEXT NOT NULL REFERENCES proposals(job_id) ON DELETE CASCADE, kind TEXT NOT NULL,
  idx INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(job_id, kind, idx)) WITHOUT ROWID;
CREATE TABLE extractions(job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_path TEXT NOT NULL, title TEXT NOT NULL,
  leaf_id TEXT, model TEXT NOT NULL, thinking TEXT NOT NULL, calls TEXT NOT NULL, outcomes TEXT NOT NULL, error TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL);
CREATE TABLE tidy_suggestions(id TEXT PRIMARY KEY, pair_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, source TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','applied','dismissed','cleared')),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('entity','memory')), first_id TEXT NOT NULL, second_id TEXT,
  reason TEXT NOT NULL, verdict TEXT CHECK(verdict IN ('same','different','conflict','replaces')),
  verdict_reason TEXT, newer_id TEXT, model TEXT, problem TEXT, session_id TEXT, title TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE tidy_operations(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  automatic INTEGER NOT NULL CHECK(automatic IN (0,1)), summary TEXT NOT NULL,
  created_at INTEGER NOT NULL, undone_at INTEGER,
  suggestion_id TEXT REFERENCES tidy_suggestions(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('entity','memory')), first_id TEXT NOT NULL, second_id TEXT NOT NULL);
CREATE TABLE tidy_operation_rows(operation_id TEXT NOT NULL REFERENCES tidy_operations(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL, row_key TEXT NOT NULL,
  before_image TEXT NOT NULL CHECK(json_valid(before_image) AND json_extract(before_image,'$.version')=1),
  after_hash TEXT, PRIMARY KEY(operation_id,table_name,row_key)) WITHOUT ROWID;
CREATE TABLE tidy_operation_memories(operation_id TEXT NOT NULL REFERENCES tidy_operations(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL, memory_n INTEGER NOT NULL, PRIMARY KEY(operation_id,memory_id)) WITHOUT ROWID;
CREATE TABLE tidy_memory_keys(memory INTEGER PRIMARY KEY REFERENCES memories(n) ON DELETE CASCADE, fingerprint TEXT NOT NULL);
CREATE TABLE tidy_sweep(singleton INTEGER PRIMARY KEY CHECK(singleton=1), phase TEXT NOT NULL,
  cursor INTEGER NOT NULL, entities INTEGER NOT NULL, memories INTEGER NOT NULL,
  total_entities INTEGER NOT NULL, total_memories INTEGER NOT NULL, entity_max INTEGER NOT NULL,
  memory_max INTEGER NOT NULL, limited_checks INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE TABLE tidy_run(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL,
  done INTEGER NOT NULL, total INTEGER NOT NULL, found INTEGER NOT NULL, error TEXT, model TEXT,
  started_at INTEGER, finished_at INTEGER, folded INTEGER NOT NULL DEFAULT 0, message TEXT);
CREATE TABLE agent_notes(operation_id TEXT NOT NULL REFERENCES tidy_operations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('made','undid')), run_id TEXT, reason TEXT NOT NULL,
  job_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(operation_id,role)) WITHOUT ROWID;
CREATE TABLE agent_runs(id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN
  ('queued','running','done','stopped','failed')), total INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT,
  session_path TEXT, rules_changed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX entities_connections ON entities(connections DESC);
CREATE INDEX entity_names_folded ON entity_names(folded, entity);
CREATE INDEX entity_keys_entity ON entity_keys(entity);
CREATE INDEX merges_target ON merges(target);
CREATE INDEX memories_recent ON memories(state, observed_at DESC);
CREATE INDEX memories_job ON memories(job_id);
CREATE INDEX memories_origin ON memories(origin_session);
CREATE INDEX mentions_entity ON mentions(entity, memory);
CREATE INDEX relations_out ON relations(subject, live, predicate, observed_at DESC);
CREATE INDEX relations_in ON relations(object, live, predicate, observed_at DESC);
CREATE INDEX citations_evidence ON citations(evidence);
CREATE INDEX relation_support_evidence ON relation_support(evidence);
CREATE INDEX memory_links_target ON memory_links(target, kind);
CREATE INDEX jobs_session ON jobs(session_id, state);
CREATE INDEX jobs_finished ON jobs(state, finished_at DESC);
CREATE INDEX tidy_suggestions_page ON tidy_suggestions(state,created_at DESC,id);
CREATE INDEX tidy_suggestions_kind ON tidy_suggestions(state,kind,created_at DESC,id);
CREATE INDEX tidy_suggestions_pending ON tidy_suggestions(state,verdict,created_at,id);
CREATE INDEX tidy_suggestions_first ON tidy_suggestions(subject_type,first_id);
CREATE INDEX tidy_suggestions_second ON tidy_suggestions(subject_type,second_id);
CREATE INDEX tidy_suggestions_lane ON tidy_suggestions(session_id,state);
CREATE INDEX tidy_operations_recent ON tidy_operations(created_at DESC,id);
CREATE INDEX tidy_operations_automatic ON tidy_operations(automatic,created_at DESC);
CREATE INDEX tidy_operation_memories_memory ON tidy_operation_memories(memory_id,operation_id);
CREATE INDEX tidy_memory_keys_fingerprint ON tidy_memory_keys(fingerprint,memory);
CREATE INDEX agent_notes_run ON agent_notes(run_id);
CREATE VIRTUAL TABLE entity_words USING fts5(text);
CREATE VIRTUAL TABLE entity_words_vocab USING fts5vocab(entity_words, 'row');
CREATE VIRTUAL TABLE entity_grams USING fts5(name, tokenize='trigram');
CREATE VIRTUAL TABLE memory_words USING fts5(summary);
CREATE VIRTUAL TABLE memory_words_vocab USING fts5vocab(memory_words, 'row');
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (1,'rina-1','Rina Okafor','person','Ledger lead 1',1,3,1);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (3,'rina-3','Ledger team','team','Ledger lead 3',3,2,1);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (4,'rina-4','Harbor','project','Ledger lead 4',4,1,1);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (5,'rina-5','Tom Lee','person','Ledger lead 5',5,0,0);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (6,'rina-6','Northwind','organization','Ledger lead 6',6,1,0);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (7,'rina-7','Rina Okafor','person','Ledger billing lead',7,1,0);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (9,'id-39','Rina Okafor (Kestrel)','person','',1065,1,0);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (10,'id-52','Rina Okafor','person','',1087,1,1);
INSERT INTO entities(n,id,label,kind,description,created_at,memories,connections) VALUES (11,'id-53','Harbor','component','',1088,1,1);
INSERT INTO entity_names(n,entity,name,folded) VALUES (1,1,'Rina Okafor','rina okafor');
INSERT INTO entity_names(n,entity,name,folded) VALUES (3,3,'Ledger team','ledger team');
INSERT INTO entity_names(n,entity,name,folded) VALUES (4,4,'Harbor','harbor');
INSERT INTO entity_names(n,entity,name,folded) VALUES (5,5,'Tom Lee','tom lee');
INSERT INTO entity_names(n,entity,name,folded) VALUES (6,6,'Northwind','northwind');
INSERT INTO entity_names(n,entity,name,folded) VALUES (7,7,'Rina Okafor','rina okafor');
INSERT INTO entity_names(n,entity,name,folded) VALUES (9,9,'Rina Okafor (Kestrel)','rina okafor (kestrel)');
INSERT INTO entity_names(n,entity,name,folded) VALUES (10,10,'Rina Okafor','rina okafor');
INSERT INTO entity_names(n,entity,name,folded) VALUES (11,10,'Rina','rina');
INSERT INTO entity_names(n,entity,name,folded) VALUES (12,11,'Harbor','harbor');
INSERT INTO entity_names(n,entity,name,folded) VALUES (13,11,'Harbor billing service','harbor billing service');
INSERT INTO entity_keys(namespace,value,entity) VALUES ('ledger','rina-1',1);
INSERT INTO entity_keys(namespace,value,entity) VALUES ('ledger','rina-2',1);
INSERT INTO entity_keys(namespace,value,entity) VALUES ('ledger','rina-3',3);
INSERT INTO entity_keys(namespace,value,entity) VALUES ('ledger','rina-4',4);
INSERT INTO entity_keys(namespace,value,entity) VALUES ('ledger','rina-5',5);
INSERT INTO entity_keys(namespace,value,entity) VALUES ('ledger','rina-6',6);
INSERT INTO entity_keys(namespace,value,entity) VALUES ('ledger','rina-7',7);
INSERT INTO merges(n,source_id,target,label,reason,recorded_at) VALUES (1,'rina-2',1,'Rina Okafor','Merged by you',1001);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (2,'memory-2','Rina leads Ledger area 2.','fact','reported','/Harbor',NULL,NULL,NULL,100,2,'active','lane-2','Ledger',NULL);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (3,'memory-3','Rina leads Ledger area 3.','fact','reported','/Harbor',NULL,NULL,NULL,100,3,'disputed','lane-3','Ledger',NULL);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (4,'memory-4','Rina leads Ledger area 4.','fact','reported','/Harbor',NULL,NULL,NULL,100,4,'disputed','lane-4','Ledger',NULL);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (5,'memory-5','Rina leads Ledger area 5.','fact','reported','/Harbor',NULL,NULL,1049,100,5,'superseded','lane-5','Ledger',NULL);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (6,'memory-6','Rina leads Ledger area 6.','fact','reported','/Harbor',NULL,NULL,NULL,100,6,'active','lane-6','Ledger',NULL);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (7,'memory-7','Rina leads Ledger area 7.','fact','reported','/Harbor',NULL,NULL,1072,100,7,'superseded','lane-7','Ledger',NULL);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (9,'id-44','Rina leads the Ledger API team.','fact','reported','/Harbor',NULL,NULL,NULL,1072,1072,'active',NULL,NULL,NULL);
INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (10,'id-51','Rina Okafor owns the Northwind billing export.','fact','reported','/projects/harbor',NULL,NULL,NULL,10,1086,'active','northwind-lane','Northwind export','id-50');
INSERT INTO mentions(memory,entity) VALUES (2,1);
INSERT INTO mentions(memory,entity) VALUES (3,1);
INSERT INTO mentions(memory,entity) VALUES (5,1);
INSERT INTO mentions(memory,entity) VALUES (6,1);
INSERT INTO mentions(memory,entity) VALUES (2,3);
INSERT INTO mentions(memory,entity) VALUES (3,3);
INSERT INTO mentions(memory,entity) VALUES (4,4);
INSERT INTO mentions(memory,entity) VALUES (5,5);
INSERT INTO mentions(memory,entity) VALUES (6,6);
INSERT INTO mentions(memory,entity) VALUES (7,7);
INSERT INTO mentions(memory,entity) VALUES (9,7);
INSERT INTO mentions(memory,entity) VALUES (4,9);
INSERT INTO mentions(memory,entity) VALUES (10,10);
INSERT INTO mentions(memory,entity) VALUES (10,11);
INSERT INTO relations(n,memory,subject,predicate,object,live,observed_at) VALUES (2,5,1,'works_on',4,0,100);
INSERT INTO relations(n,memory,subject,predicate,object,live,observed_at) VALUES (3,2,1,'member_of',3,1,100);
INSERT INTO relations(n,memory,subject,predicate,object,live,observed_at) VALUES (4,10,10,'owns',11,1,10);
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (1,'lane-1','entry-1','user','Ledger evidence',1,'Rina leads Ledger area 1.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (2,'lane-2','entry-2','user','Ledger evidence',2,'Rina leads Ledger area 2.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (3,'lane-3','entry-3','user','Ledger evidence',3,'Rina leads Ledger area 3.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (4,'lane-4','entry-4','user','Ledger evidence',4,'Rina leads Ledger area 4.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (5,'lane-5','entry-5','user','Ledger evidence',5,'Rina leads Ledger area 5.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (6,'lane-6','entry-6','user','Ledger evidence',6,'Rina leads Ledger area 6.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (7,'lane-7','entry-7','user','Ledger evidence',7,'Rina leads Ledger area 7.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (9,NULL,'agent:id-43','user','Brain Agent, from Linear KES-12',1072,'Rina leads the API team.');
INSERT INTO evidence(n,session_id,entry_id,role,label,observed_at,text) VALUES (10,'northwind-lane','entry-1','user','You · Nov 6, 12:47',10,'Before the meeting. Rina owns Harbor. After the meeting.');
INSERT INTO citations(memory,evidence,quote) VALUES (2,1,'Rina leads Ledger area 1.');
INSERT INTO citations(memory,evidence,quote) VALUES (2,2,'Rina leads Ledger area 2.');
INSERT INTO citations(memory,evidence,quote) VALUES (3,3,'Rina leads Ledger area 3.');
INSERT INTO citations(memory,evidence,quote) VALUES (4,4,'Rina leads Ledger area 4.');
INSERT INTO citations(memory,evidence,quote) VALUES (5,5,'Rina leads Ledger area 5.');
INSERT INTO citations(memory,evidence,quote) VALUES (6,6,'Rina leads Ledger area 6.');
INSERT INTO citations(memory,evidence,quote) VALUES (7,7,'Rina leads Ledger area 7.');
INSERT INTO citations(memory,evidence,quote) VALUES (9,9,'Rina leads the API team.');
INSERT INTO citations(memory,evidence,quote) VALUES (10,10,'Rina owns Harbor.');
INSERT INTO relation_support(relation,evidence,quote) VALUES (3,1,'Rina leads Ledger area 1.');
INSERT INTO relation_support(relation,evidence,quote) VALUES (2,5,'Rina leads Ledger area 5.');
INSERT INTO relation_support(relation,evidence,quote) VALUES (4,10,'Rina owns Harbor.');
INSERT INTO memory_links(source,target,kind,recorded_at) VALUES (3,4,'conflicts',1043);
INSERT INTO memory_links(source,target,kind,recorded_at) VALUES (6,5,'supersedes',1050);
INSERT INTO memory_links(source,target,kind,recorded_at) VALUES (9,7,'supersedes',1072);
INSERT INTO memory_vectors(memory,vector) VALUES (2,unhex('0000803f0ad7a33c' || hex(zeroblob(3064))));
INSERT INTO memory_vectors(memory,vector) VALUES (3,unhex('0000803f8fc2f53c' || hex(zeroblob(3064))));
INSERT INTO memory_vectors(memory,vector) VALUES (4,unhex('0000803f0ad7233d' || hex(zeroblob(3064))));
INSERT INTO memory_vectors(memory,vector) VALUES (5,unhex('0000803fcdcc4c3d' || hex(zeroblob(3064))));
INSERT INTO memory_vectors(memory,vector) VALUES (6,unhex('0000803f8fc2753d' || hex(zeroblob(3064))));
INSERT INTO memory_vectors(memory,vector) VALUES (7,unhex('0000803f295c8f3d' || hex(zeroblob(3064))));
INSERT INTO memory_vectors(memory,vector) VALUES (9,unhex('0000803f0000003f' || hex(zeroblob(3064))));
INSERT INTO memory_vectors(memory,vector) VALUES (10,unhex('cdcc4c3e6666663f' || hex(zeroblob(3064))));
INSERT INTO memory_bits(memory,bits) VALUES (2,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO memory_bits(memory,bits) VALUES (3,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO memory_bits(memory,bits) VALUES (4,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO memory_bits(memory,bits) VALUES (6,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO memory_bits(memory,bits) VALUES (9,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO memory_bits(memory,bits) VALUES (10,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_vectors(entity,vector) VALUES (1,unhex('0000803fcdcccc3d' || hex(zeroblob(3064))));
INSERT INTO entity_vectors(entity,vector) VALUES (3,unhex('0000803f9a99993e' || hex(zeroblob(3064))));
INSERT INTO entity_vectors(entity,vector) VALUES (4,unhex('0000803fcdcccc3e' || hex(zeroblob(3064))));
INSERT INTO entity_vectors(entity,vector) VALUES (5,unhex('0000803f0000003f' || hex(zeroblob(3064))));
INSERT INTO entity_vectors(entity,vector) VALUES (6,unhex('0000803f9a99193f' || hex(zeroblob(3064))));
INSERT INTO entity_vectors(entity,vector) VALUES (7,unhex('0000803f3333333f' || hex(zeroblob(3064))));
INSERT INTO entity_vectors(entity,vector) VALUES (10,unhex('000000000000803f' || hex(zeroblob(3064))));
INSERT INTO entity_vectors(entity,vector) VALUES (11,unhex('0000803f' || hex(zeroblob(3068))));
INSERT INTO entity_bits(entity,bits) VALUES (1,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_bits(entity,bits) VALUES (3,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_bits(entity,bits) VALUES (4,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_bits(entity,bits) VALUES (5,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_bits(entity,bits) VALUES (6,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_bits(entity,bits) VALUES (7,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_bits(entity,bits) VALUES (10,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO entity_bits(entity,bits) VALUES (11,unhex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
INSERT INTO jobs(id,session_id,session_path,title,scope,branch,model,state,memories,leaf_id,error,queued_at,started_at,finished_at,usage,extractor,progress,computed_revision,replaces,from_leaf,run_started_at) VALUES ('id-50','northwind-lane','/made-up/northwind-lane.jsonl','Northwind export','/projects/harbor','billing','made-up/model','done',1,'leaf-1',NULL,1085,5000,1089,NULL,6,NULL,9,NULL,NULL,NULL);
INSERT INTO jobs(id,session_id,session_path,title,scope,branch,model,state,memories,leaf_id,error,queued_at,started_at,finished_at,usage,extractor,progress,computed_revision,replaces,from_leaf,run_started_at) VALUES ('id-57','kestrel-lane','/made-up/kestrel-lane.jsonl','Kestrel launch','/projects/harbor','billing','made-up/model','rejected',0,'leaf-1',NULL,1095,5000,1096,NULL,6,NULL,10,NULL,NULL,NULL);
INSERT INTO jobs(id,session_id,session_path,title,scope,branch,model,state,memories,leaf_id,error,queued_at,started_at,finished_at,usage,extractor,progress,computed_revision,replaces,from_leaf,run_started_at) VALUES ('id-59','harbor-review','/made-up/harbor-review.jsonl','Harbor invoices','/projects/harbor','billing','made-up/model','review',1,'leaf-1',NULL,1100,5000,NULL,NULL,6,NULL,10,NULL,NULL,NULL);
INSERT INTO jobs(id,session_id,session_path,title,scope,branch,model,state,memories,leaf_id,error,queued_at,started_at,finished_at,usage,extractor,progress,computed_revision,replaces,from_leaf,run_started_at) VALUES ('id-60','harbor-refresh','/made-up/harbor-refresh.jsonl','Harbor refunds','/projects/harbor','billing','made-up/model','refreshing',1,'leaf-1',NULL,1101,5000,NULL,NULL,6,NULL,10,NULL,NULL,1102);
INSERT INTO proposals(job_id,payload) VALUES ('id-59','{"jobId":"id-59","origin":{"sessionId":"harbor-review","title":"Harbor invoices"},"scope":"/projects/harbor","branch":"billing","computedRevision":10,"entities":[{"ref":"harbor","label":"Harbor","kind":"component","aliases":["Harbor billing service"],"description":"","keys":[],"decision":"new","entityId":null,"candidates":[],"reason":"","auto":false},{"ref":"rina","label":"Rina Okafor","kind":"person","aliases":["Rina"],"description":"","keys":[],"decision":"new","entityId":null,"candidates":[],"reason":"","auto":false}],"memories":[{"summary":"Mara Voss reviews Harbor invoices weekly.","kind":"reported","type":"fact","entities":["rina","harbor"],"links":[{"subject":"rina","predicate":"owns","object":"harbor","citation":{"evidence":0,"quote":"Rina owns Harbor."}}],"branch":false,"validFrom":null,"validTo":null,"action":"add","target":null,"reason":"","citations":[{"evidence":0,"quote":"Rina owns Harbor."}]}],"evidence":[{"sessionId":"harbor-review","entryId":"entry-1","role":"user","label":"You · Nov 6, 12:47","observedAt":10,"text":"Before the meeting. Rina owns Harbor. After the meeting."},{"sessionId":"harbor-review","entryId":"entry-2","role":"toolResult","label":"Tool output · cat","observedAt":11,"text":"Tom maintains the archive."}],"memoryVectors":[],"entityVectors":[],"groups":[],"confirmations":[],"held":0}');
INSERT INTO proposals(job_id,payload) VALUES ('id-60','{"jobId":"id-60","origin":{"sessionId":"harbor-refresh","title":"Harbor refunds"},"scope":"/projects/harbor","branch":"billing","computedRevision":10,"entities":[{"ref":"harbor","label":"Harbor","kind":"component","aliases":["Harbor billing service"],"description":"","keys":[],"decision":"new","entityId":null,"candidates":[],"reason":"","auto":false},{"ref":"rina","label":"Rina Okafor","kind":"person","aliases":["Rina"],"description":"","keys":[],"decision":"new","entityId":null,"candidates":[],"reason":"","auto":false}],"memories":[{"summary":"Mara Voss signs off Harbor refunds.","kind":"reported","type":"fact","entities":["rina","harbor"],"links":[{"subject":"rina","predicate":"owns","object":"harbor","citation":{"evidence":0,"quote":"Rina owns Harbor."}}],"branch":false,"validFrom":null,"validTo":null,"action":"add","target":null,"reason":"","citations":[{"evidence":0,"quote":"Rina owns Harbor."}]}],"evidence":[{"sessionId":"harbor-refresh","entryId":"entry-1","role":"user","label":"You · Nov 6, 12:47","observedAt":10,"text":"Before the meeting. Rina owns Harbor. After the meeting."},{"sessionId":"harbor-refresh","entryId":"entry-2","role":"toolResult","label":"Tool output · cat","observedAt":11,"text":"Tom maintains the archive."}],"memoryVectors":[],"entityVectors":[],"groups":[],"confirmations":[],"held":0}');
INSERT INTO proposal_vectors(job_id,kind,idx,vector) VALUES ('id-59','entity',0,unhex('0000803f' || hex(zeroblob(3068))));
INSERT INTO proposal_vectors(job_id,kind,idx,vector) VALUES ('id-59','entity',1,unhex('000000000000803f' || hex(zeroblob(3064))));
INSERT INTO proposal_vectors(job_id,kind,idx,vector) VALUES ('id-59','memory',0,unhex('cdcc4c3e6666663f' || hex(zeroblob(3064))));
INSERT INTO proposal_vectors(job_id,kind,idx,vector) VALUES ('id-60','entity',0,unhex('0000803f' || hex(zeroblob(3068))));
INSERT INTO proposal_vectors(job_id,kind,idx,vector) VALUES ('id-60','entity',1,unhex('000000000000803f' || hex(zeroblob(3064))));
INSERT INTO proposal_vectors(job_id,kind,idx,vector) VALUES ('id-60','memory',0,unhex('cdcc4c3e6666663f' || hex(zeroblob(3064))));
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-3','entity:72696e612d31.72696e612d37','same_entity','sweep','dismissed','entity','rina-1','rina-7','Both are named "Rina Okafor".',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1006,1059);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-4','entity:72696e612d31.72696e612d38','same_entity','sweep','open','entity','rina-8','rina-1','Both are named "Rina Okafor".',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1007,1007);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-5','memory:6d656d6f72792d31.6d656d6f72792d32','same_memory','sweep','applied','memory','memory-1','memory-2','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1008,1041);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-6','memory:6d656d6f72792d31.6d656d6f72792d33','same_memory','sweep','cleared','memory','memory-1','memory-3','One of these was folded into another memory.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1009,1039);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-7','memory:6d656d6f72792d31.6d656d6f72792d34','same_memory','sweep','cleared','memory','memory-1','memory-4','One of these was folded into another memory.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1010,1039);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-8','memory:6d656d6f72792d31.6d656d6f72792d35','same_memory','sweep','cleared','memory','memory-1','memory-5','One of these was folded into another memory.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1011,1039);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-9','memory:6d656d6f72792d31.6d656d6f72792d36','same_memory','sweep','cleared','memory','memory-1','memory-6','One of these was folded into another memory.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1012,1039);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-10','memory:6d656d6f72792d31.6d656d6f72792d37','same_memory','sweep','cleared','memory','memory-1','memory-7','One of these was folded into another memory.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1013,1039);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-12','memory:6d656d6f72792d32.6d656d6f72792d33','same_memory','sweep','open','memory','memory-2','memory-3','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1015,1015);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-13','memory:6d656d6f72792d32.6d656d6f72792d34','same_memory','sweep','open','memory','memory-2','memory-4','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1016,1016);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-14','memory:6d656d6f72792d32.6d656d6f72792d35','same_memory','sweep','open','memory','memory-2','memory-5','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1017,1017);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-15','memory:6d656d6f72792d32.6d656d6f72792d36','same_memory','sweep','open','memory','memory-2','memory-6','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1018,1018);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-16','memory:6d656d6f72792d32.6d656d6f72792d37','same_memory','sweep','open','memory','memory-2','memory-7','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1019,1019);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-18','memory:6d656d6f72792d33.6d656d6f72792d34','same_memory','sweep','applied','memory','memory-3','memory-4','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1021,1047);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-19','memory:6d656d6f72792d33.6d656d6f72792d35','same_memory','sweep','open','memory','memory-3','memory-5','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1022,1022);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-20','memory:6d656d6f72792d33.6d656d6f72792d36','same_memory','sweep','open','memory','memory-3','memory-6','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1023,1023);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-21','memory:6d656d6f72792d33.6d656d6f72792d37','same_memory','sweep','open','memory','memory-3','memory-7','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1024,1024);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-23','memory:6d656d6f72792d34.6d656d6f72792d35','same_memory','sweep','open','memory','memory-4','memory-5','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1026,1026);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-24','memory:6d656d6f72792d34.6d656d6f72792d36','same_memory','sweep','open','memory','memory-4','memory-6','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1027,1027);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-25','memory:6d656d6f72792d34.6d656d6f72792d37','same_memory','sweep','open','memory','memory-4','memory-7','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1028,1028);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-27','memory:6d656d6f72792d35.6d656d6f72792d36','same_memory','sweep','applied','memory','memory-5','memory-6','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1030,1054);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-28','memory:6d656d6f72792d35.6d656d6f72792d37','same_memory','sweep','open','memory','memory-5','memory-7','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1031,1031);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-30','memory:6d656d6f72792d36.6d656d6f72792d37','same_memory','sweep','open','memory','memory-6','memory-7','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1033,1033);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-36','entity:72696e612d37.72696e612d38','same_entity','sweep','open','entity','rina-8','rina-7','Both are named "Rina Okafor".',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1060,1060);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-41','entity:69642d3339.72696e612d31','same_entity','sweep','dismissed','entity','rina-1','id-39','You split these apart; they stay separate.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1068,1069);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-46','memory:69642d3434.6d656d6f72792d36','same_memory','sweep','open','memory','id-44','memory-6','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1077,1077);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-47','memory:69642d3434.6d656d6f72792d33','same_memory','sweep','open','memory','id-44','memory-3','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1078,1078);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-48','memory:69642d3434.6d656d6f72792d32','same_memory','sweep','open','memory','id-44','memory-2','These two sentences say nearly the same thing.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1079,1079);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-55','entity:69642d3532.72696e612d31','same_entity','sweep','open','entity','id-52','rina-1','Both are named "Rina Okafor".',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1093,1093);
INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,verdict,verdict_reason,newer_id,model,problem,session_id,title,created_at,updated_at) VALUES ('id-56','entity:69642d3533.72696e612d34','same_entity','sweep','open','entity','id-53','rina-4','Same name, stored as a component and as a project.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1094,1094);
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-2','merge',0,'Merged Rina Okafor into Rina Okafor',1002,NULL,NULL,'entity','rina-2','rina-1');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-32','fold',0,'Folded two memories',1036,NULL,'id-5','memory','memory-1','memory-2');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-33','dispute',0,'Kept two memories as disputed',1044,NULL,'id-18','memory','memory-3','memory-4');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-34','replace',0,'Replaced one memory with another',1051,NULL,'id-27','memory','memory-6','memory-5');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-35','keep',0,'Not the same: Rina Okafor and Rina Okafor',1056,NULL,'id-3','entity','rina-1','rina-7');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-37','unname',0,'Removed the name "R. Okafor" from Rina Okafor',1061,NULL,NULL,'entity','rina-8','rina-8');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-38','describe',0,'Changed the description of Rina Okafor',1063,NULL,NULL,'entity','rina-7','rina-7');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-40','split',0,'Split Rina Okafor (Kestrel) from Rina Okafor',1066,NULL,NULL,'entity','rina-1','id-39');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-43','correct',0,'Corrected a memory about Rina Okafor',1073,NULL,NULL,'memory','memory-7','memory-7');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-49','erase',0,'Erased a memory',1081,NULL,NULL,'memory','memory-8','memory-8');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-54','approve',0,'Approved Northwind export, 1 of 1 memories',1090,NULL,NULL,'memory','id-50','id-50');
INSERT INTO tidy_operations(id,kind,automatic,summary,created_at,undone_at,suggestion_id,subject_type,first_id,second_id) VALUES ('id-58','reject',0,'Rejected Kestrel launch',1097,NULL,NULL,'memory','id-57','id-57');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','entities','32','{"version":1,"key":{"n":2},"row":{"created_at":2,"description":"Ledger lead 2","id":"rina-2","kind":"person","label":"Rina Okafor","n":2}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','entity_keys','6c6564676572.72696e612d32','{"version":1,"key":{"namespace":"ledger","value":"rina-2"},"row":{"entity":2,"namespace":"ledger","value":"rina-2"}}','866682a10eff8db3d2dd27ace0624322d2be0455c3e735f2bf7197288bd3ba91');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','entity_names','32','{"version":1,"key":{"n":2},"row":{"entity":2,"folded":"rina okafor","n":2,"name":"Rina Okafor"}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','entity_vectors','32','{"version":1,"key":{"entity":2},"row":{"entity":2,"vector":{"base64":"AACAP83MTD4' || 'A' || replace(hex(zeroblob(2042)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','mentions','31.31','{"version":1,"key":{"entity":1,"memory":1},"row":null,"guard":true}','d4d7bccb6981fc170671988f0d35edd4d2ca6729188351536f7873e1858def87');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','mentions','31.32','{"version":1,"key":{"entity":2,"memory":1},"row":{"entity":2,"memory":1}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','mentions','32.31','{"version":1,"key":{"entity":1,"memory":2},"row":null}','dda42dd068e093017269147da0f719c60cc2142df138b41890085be8c5f7d484');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','mentions','32.32','{"version":1,"key":{"entity":2,"memory":2},"row":{"entity":2,"memory":2}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','merges','31','{"version":1,"key":{"n":1},"row":null}','b138a1457bb72bd67112eaa72f23e58834714f6786344428f5bcd11223fad217');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-2','relations','31','{"version":1,"key":{"n":1},"row":null,"guard":true}','99a6fd5c71cafec696a2e59f42d24d5670b174b9906fc06b73b7f12944532179');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','citations','31.31.52696e61206c65616473204c6564676572206172656120312e','{"version":1,"key":{"evidence":1,"memory":1,"quote":"Rina leads Ledger area 1."},"row":{"evidence":1,"memory":1,"quote":"Rina leads Ledger area 1."}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','citations','32.31.52696e61206c65616473204c6564676572206172656120312e','{"version":1,"key":{"evidence":1,"memory":2,"quote":"Rina leads Ledger area 1."},"row":null}','69ab6c94fb2619ef3345da1bf41510d366702d90c09c53f925ae8fb65d905f38');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','citations','32.32.52696e61206c65616473204c6564676572206172656120322e','{"version":1,"key":{"evidence":2,"memory":2,"quote":"Rina leads Ledger area 2."},"row":null,"guard":true}','73bf5eeb5c4708337127062d28aa36515a457d53b7caf57958ce76f5b77e55ec');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','evidence','31','{"version":1,"key":{"n":1},"row":null,"guard":true}','e8d276cc38ab80c20b7bf7803b55e11dfccccd579a0c57936b27b28483a9d48a');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','evidence','32','{"version":1,"key":{"n":2},"row":null,"guard":true}','3a7801c4feb12f728672689c664cc967b28a779af818df883a5d7143d9a332c3');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','memories','31','{"version":1,"key":{"n":1},"row":{"branch":null,"epistemic":"reported","id":"memory-1","job_id":null,"n":1,"observed_at":100,"origin_session":"lane-1","origin_title":"Ledger","recorded_at":1,"scope":"/Harbor","state":"active","summary":"Rina leads Ledger area 1.","type":"fact","valid_from":null,"valid_to":null}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','memories','32','{"version":1,"key":{"n":2},"row":null,"guard":true}','537c954f74c85d565b022888bef6f80c0dcf602172a8025e5f6410fa27cc3fae');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','memory_vectors','31','{"version":1,"key":{"memory":1},"row":{"memory":1,"vector":{"base64":"AACAPwrXIzw' || 'A' || replace(hex(zeroblob(2042)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','mentions','31.31','{"version":1,"key":{"entity":1,"memory":1},"row":{"entity":1,"memory":1}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','mentions','31.33','{"version":1,"key":{"entity":3,"memory":1},"row":{"entity":3,"memory":1}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','mentions','32.31','{"version":1,"key":{"entity":1,"memory":2},"row":null,"guard":true}','dda42dd068e093017269147da0f719c60cc2142df138b41890085be8c5f7d484');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','mentions','32.33','{"version":1,"key":{"entity":3,"memory":2},"row":null}','50a0f80eba69f7f0e08e276ce5018eac9a55729d09fe64a983f433a471682b41');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','relation_support','31.31.52696e61206c65616473204c6564676572206172656120312e','{"version":1,"key":{"evidence":1,"quote":"Rina leads Ledger area 1.","relation":1},"row":{"evidence":1,"quote":"Rina leads Ledger area 1.","relation":1}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','relation_support','33.31.52696e61206c65616473204c6564676572206172656120312e','{"version":1,"key":{"evidence":1,"quote":"Rina leads Ledger area 1.","relation":3},"row":null}','3286f388c77bc575d316b9723f3feffd7822ae41fbffc06cc24432aef11c52e3');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','relations','31','{"version":1,"key":{"n":1},"row":{"live":1,"memory":1,"n":1,"object":3,"observed_at":100,"predicate":"member_of","subject":1}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-32','relations','33','{"version":1,"key":{"n":3},"row":null}','f3c9bc637419e0bf9e5c5fe8a9efdaeba551bbddb7436f1ae71a8b1efb81f70f');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-33','memories','33','{"version":1,"key":{"n":3},"row":{"branch":null,"epistemic":"reported","id":"memory-3","job_id":null,"n":3,"observed_at":100,"origin_session":"lane-3","origin_title":"Ledger","recorded_at":3,"scope":"/Harbor","state":"active","summary":"Rina leads Ledger area 3.","type":"fact","valid_from":null,"valid_to":null}}','67ef7b952fd3307851667aeccb1791785061bde95fc3f2401840f514a0637ae2');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-33','memories','34','{"version":1,"key":{"n":4},"row":{"branch":null,"epistemic":"reported","id":"memory-4","job_id":null,"n":4,"observed_at":100,"origin_session":"lane-4","origin_title":"Ledger","recorded_at":4,"scope":"/Harbor","state":"active","summary":"Rina leads Ledger area 4.","type":"fact","valid_from":null,"valid_to":null}}','386542ec7e17d29dfa90abbf09ecf327190be593350203ea02ed89dd37c5a85f');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-33','memory_links','33.34.636f6e666c69637473','{"version":1,"key":{"kind":"conflicts","source":3,"target":4},"row":null}','3ab70ee0e246abc5132d258462e839fdb616d9a8fc498d8f23092588740ed2d3');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-34','memories','35','{"version":1,"key":{"n":5},"row":{"branch":null,"epistemic":"reported","id":"memory-5","job_id":null,"n":5,"observed_at":100,"origin_session":"lane-5","origin_title":"Ledger","recorded_at":5,"scope":"/Harbor","state":"active","summary":"Rina leads Ledger area 5.","type":"fact","valid_from":null,"valid_to":null}}','229ee9d722748bc026b5214ee097dcd4da045bee81579da2f8e8c0bde190010a');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-34','memory_links','36.35.73757065727365646573','{"version":1,"key":{"kind":"supersedes","source":6,"target":5},"row":null}','d0a48abdc0c14c4a79695d2bc34a1f084a680dd3acfc8c79c68246d13818dd07');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-34','relations','32','{"version":1,"key":{"n":2},"row":{"live":1,"memory":5,"n":2,"object":4,"observed_at":100,"predicate":"works_on","subject":1}}','a1c80a581fe2c9a209eed89450762de974d77b0c87fc39ec87eb1ff4b7eef8b7');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-37','entity_names','313030','{"version":1,"key":{"n":100},"row":{"entity":8,"folded":"r. okafor","n":100,"name":"R. Okafor"}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-38','entities','37','{"version":1,"key":{"n":7},"row":{"created_at":7,"description":"Ledger lead 7","id":"rina-7","kind":"person","label":"Rina Okafor","n":7}}','5ac226b507582a4ad95f349a66efd363880862e3f671d388e17beb14fbc42c70');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-40','entities','39','{"version":1,"key":{"n":9},"row":null}','031780c5f30d6b72445583e9c6466da6b2dc48259c914134364beaf19e71fcfb');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-40','entity_names','39','{"version":1,"key":{"n":9},"row":null}','e0a5bfefab40245b5111293993bff936b920caa0415291cf58ae2adda7ed0b5d');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-40','mentions','34.31','{"version":1,"key":{"entity":1,"memory":4},"row":{"entity":1,"memory":4}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-40','mentions','34.39','{"version":1,"key":{"entity":9,"memory":4},"row":null}','b0e5ed4e6126a5c38873de5de4b2b57c59a56543ecf4ba072de1035bfc04352c');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-43','citations','39.39.52696e61206c656164732074686520415049207465616d2e','{"version":1,"key":{"evidence":9,"memory":9,"quote":"Rina leads the API team."},"row":null}','42011619fe9d44a0a8441719e41006954aaf291192829c2927f11c02712e0c2d');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-43','evidence','39','{"version":1,"key":{"n":9},"row":null}','4010b85b8f654056afe05e5d3300aa7462ab776055b4792f90d86b3ea28eef9d');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-43','memories','37','{"version":1,"key":{"n":7},"row":{"branch":null,"epistemic":"reported","id":"memory-7","job_id":null,"n":7,"observed_at":100,"origin_session":"lane-7","origin_title":"Ledger","recorded_at":7,"scope":"/Harbor","state":"active","summary":"Rina leads Ledger area 7.","type":"fact","valid_from":null,"valid_to":null}}','d0945d107c5b18683c3572bceef31730783186c12df1bb628924faf90e1433e9');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-43','memories','39','{"version":1,"key":{"n":9},"row":null}','8808c538e2b60823062783ee5c388f1d2d237e7009634b64b27194a5b5ab5803');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-43','memory_links','39.37.73757065727365646573','{"version":1,"key":{"kind":"supersedes","source":9,"target":7},"row":null}','dd53d8ce325acb04e8a56426c19cf449b2585f5cfb3f5124119b111548324b6e');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-43','memory_vectors','39','{"version":1,"key":{"memory":9},"row":null}','ecac79c915d48e2c1410234985a1425e704662a050dbed144e102d91ad701010');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-43','mentions','39.37','{"version":1,"key":{"entity":7,"memory":9},"row":null}','64e9d4ada95509cf28cc894c419d12e62d9a610478ffe737ff4c49803e8192c6');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','citations','3130.3130.52696e61206f776e7320486172626f722e','{"version":1,"key":{"evidence":10,"memory":10,"quote":"Rina owns Harbor."},"row":null}','79174363dda4f173f85668ef1d67a75320b73b238dda54257273fa2547529a34');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entities','3130','{"version":1,"key":{"n":10},"row":null}','b5776f0ce67887c2c7187df945e8b74980bb4388c0af7f057f06a6d916481a96');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entities','3131','{"version":1,"key":{"n":11},"row":null}','f870a36574597c64d7448498fde8363ad240c09071cd5d2354bb39022242c05b');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entity_names','3130','{"version":1,"key":{"n":10},"row":null}','78e204d66b9b777775f49d34c841bdd2f82ece59c145d11db3fe4556a29c9d6d');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entity_names','3131','{"version":1,"key":{"n":11},"row":null}','20985f73e99da7c5f6cf8f0e75cf1f74b8366fc8cae4a46ba994af482c753952');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entity_names','3132','{"version":1,"key":{"n":12},"row":null}','103e3cbe5514b66411d637df7e8844ba94a26d12c84261e68c66fcce7f2d47a1');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entity_names','3133','{"version":1,"key":{"n":13},"row":null}','5321c67da633e8b9d29d2f71b2a75b7b5ac58aa0bd51cd6de87acc747cf2ae1d');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entity_vectors','3130','{"version":1,"key":{"entity":10},"row":null}','4b35fcd64e61858252212ae30834efd74a3fd94b95e5c68ee3c6d2cb807d48fb');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','entity_vectors','3131','{"version":1,"key":{"entity":11},"row":null}','af3903ed879b43a06613e7fd9ecdf153cf0c3a8337886f22e9a5ae8b62f9f56d');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','evidence','3130','{"version":1,"key":{"n":10},"row":null}','b306acc1f915292418d016619d0c0cce7417b7ff8698488535d6ec6939ea4bcc');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','jobs','69642d3530','{"version":1,"key":{"id":"id-50"},"row":{"branch":"billing","computed_revision":9,"error":null,"extractor":6,"finished_at":null,"from_leaf":null,"id":"id-50","leaf_id":"leaf-1","memories":1,"model":"made-up/model","progress":null,"queued_at":1085,"replaces":null,"run_started_at":null,"scope":"/projects/harbor","session_id":"northwind-lane","session_path":"/made-up/northwind-lane.jsonl","started_at":5000,"state":"review","title":"Northwind export","usage":null}}','1c1b72bdbc3f827870e4300d423c796cd868b0b934d573b24474a93bbaa0890a');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','memories','3130','{"version":1,"key":{"n":10},"row":null}','28ad0012bcefca3499f0371029e989e29b299f1be1f48b14c7ed11d17e4c3299');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','memory_vectors','3130','{"version":1,"key":{"memory":10},"row":null}','2109aaf9ac17ea59b5c499e3f8d206496a3a10853eb9f0a48082caed00fd638b');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','mentions','3130.3130','{"version":1,"key":{"entity":10,"memory":10},"row":null}','d7b6a21fbb404d35fa718a5e54905c1f8ef4cd46af8c6e9fc3a228ef9e18ada6');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','mentions','3130.3131','{"version":1,"key":{"entity":11,"memory":10},"row":null}','f4032e94e59ca40188c7d3e7009f6c155facae6b703620284194a7d7e8a1cfa0');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','proposal_vectors','69642d3530.656e74697479.30','{"version":1,"key":{"idx":0,"job_id":"id-50","kind":"entity"},"row":{"idx":0,"job_id":"id-50","kind":"entity","vector":{"base64":"AACAPw' || replace(hex(zeroblob(2045)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','proposal_vectors','69642d3530.656e74697479.31','{"version":1,"key":{"idx":1,"job_id":"id-50","kind":"entity"},"row":{"idx":1,"job_id":"id-50","kind":"entity","vector":{"base64":"AAAAAAAAgD8' || 'A' || replace(hex(zeroblob(2042)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','proposal_vectors','69642d3530.6d656d6f7279.30','{"version":1,"key":{"idx":0,"job_id":"id-50","kind":"memory"},"row":{"idx":0,"job_id":"id-50","kind":"memory","vector":{"base64":"zcxMPmZmZj8' || 'A' || replace(hex(zeroblob(2042)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','proposals','69642d3530','{"version":1,"key":{"job_id":"id-50"},"row":{"job_id":"id-50","payload":"{\"jobId\":\"id-50\",\"origin\":{\"sessionId\":\"northwind-lane\",\"title\":\"Northwind export\"},\"scope\":\"/projects/harbor\",\"branch\":\"billing\",\"computedRevision\":9,\"entities\":[{\"ref\":\"harbor\",\"label\":\"Harbor\",\"kind\":\"component\",\"aliases\":[\"Harbor billing service\"],\"description\":\"\",\"keys\":[],\"decision\":\"new\",\"entityId\":null,\"candidates\":[],\"reason\":\"\",\"auto\":false},{\"ref\":\"rina\",\"label\":\"Rina Okafor\",\"kind\":\"person\",\"aliases\":[\"Rina\"],\"description\":\"\",\"keys\":[],\"decision\":\"new\",\"entityId\":null,\"candidates\":[],\"reason\":\"\",\"auto\":false}],\"memories\":[{\"summary\":\"Rina Okafor owns the Northwind billing export.\",\"kind\":\"reported\",\"type\":\"fact\",\"entities\":[\"rina\",\"harbor\"],\"links\":[{\"subject\":\"rina\",\"predicate\":\"owns\",\"object\":\"harbor\",\"citation\":{\"evidence\":0,\"quote\":\"Rina owns Harbor.\"}}],\"branch\":false,\"validFrom\":null,\"validTo\":null,\"action\":\"add\",\"target\":null,\"reason\":\"\",\"citations\":[{\"evidence\":0,\"quote\":\"Rina owns Harbor.\"}]}],\"evidence\":[{\"sessionId\":\"northwind-lane\",\"entryId\":\"entry-1\",\"role\":\"user\",\"label\":\"You · Nov 6, 12:47\",\"observedAt\":10,\"text\":\"Before the meeting. Rina owns Harbor. After the meeting.\"},{\"sessionId\":\"northwind-lane\",\"entryId\":\"entry-2\",\"role\":\"toolResult\",\"label\":\"Tool output · cat\",\"observedAt\":11,\"text\":\"Tom maintains the archive.\"}],\"memoryVectors\":[],\"entityVectors\":[],\"groups\":[],\"confirmations\":[],\"held\":0}"}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','relation_support','34.3130.52696e61206f776e7320486172626f722e','{"version":1,"key":{"evidence":10,"quote":"Rina owns Harbor.","relation":4},"row":null}','779a8f9038ec85e4a5b2f7d9117be70043b68e9105d8fedd010e504de43589dd');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-54','relations','34','{"version":1,"key":{"n":4},"row":null}','9d277a7dabc4c16e76e8ee7c202b5b9ead492d00609df7021992f901a6f15b3d');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-58','jobs','69642d3537','{"version":1,"key":{"id":"id-57"},"row":{"branch":"billing","computed_revision":10,"error":null,"extractor":6,"finished_at":null,"from_leaf":null,"id":"id-57","leaf_id":"leaf-1","memories":1,"model":"made-up/model","progress":null,"queued_at":1095,"replaces":null,"run_started_at":null,"scope":"/projects/harbor","session_id":"kestrel-lane","session_path":"/made-up/kestrel-lane.jsonl","started_at":5000,"state":"review","title":"Kestrel launch","usage":null}}','d5e2bcb329420276e96b016387a1d2a9130f8c7b7d7248ab24d7d72ff1edc007');
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-58','proposal_vectors','69642d3537.656e74697479.30','{"version":1,"key":{"idx":0,"job_id":"id-57","kind":"entity"},"row":{"idx":0,"job_id":"id-57","kind":"entity","vector":{"base64":"AACAPw' || replace(hex(zeroblob(2045)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-58','proposal_vectors','69642d3537.656e74697479.31','{"version":1,"key":{"idx":1,"job_id":"id-57","kind":"entity"},"row":{"idx":1,"job_id":"id-57","kind":"entity","vector":{"base64":"AAAAAAAAgD8' || 'A' || replace(hex(zeroblob(2042)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-58','proposal_vectors','69642d3537.6d656d6f7279.30','{"version":1,"key":{"idx":0,"job_id":"id-57","kind":"memory"},"row":{"idx":0,"job_id":"id-57","kind":"memory","vector":{"base64":"zcxMPmZmZj8' || 'A' || replace(hex(zeroblob(2042)),'0','A') || '"}}}',NULL);
INSERT INTO tidy_operation_rows(operation_id,table_name,row_key,before_image,after_hash) VALUES ('id-58','proposals','69642d3537','{"version":1,"key":{"job_id":"id-57"},"row":{"job_id":"id-57","payload":"{\"jobId\":\"id-57\",\"origin\":{\"sessionId\":\"kestrel-lane\",\"title\":\"Kestrel launch\"},\"scope\":\"/projects/harbor\",\"branch\":\"billing\",\"computedRevision\":10,\"entities\":[{\"ref\":\"harbor\",\"label\":\"Harbor\",\"kind\":\"component\",\"aliases\":[\"Harbor billing service\"],\"description\":\"\",\"keys\":[],\"decision\":\"new\",\"entityId\":null,\"candidates\":[],\"reason\":\"\",\"auto\":false},{\"ref\":\"rina\",\"label\":\"Rina Okafor\",\"kind\":\"person\",\"aliases\":[\"Rina\"],\"description\":\"\",\"keys\":[],\"decision\":\"new\",\"entityId\":null,\"candidates\":[],\"reason\":\"\",\"auto\":false}],\"memories\":[{\"summary\":\"Tom Lee drafts the Kestrel launch notes.\",\"kind\":\"reported\",\"type\":\"fact\",\"entities\":[\"rina\",\"harbor\"],\"links\":[{\"subject\":\"rina\",\"predicate\":\"owns\",\"object\":\"harbor\",\"citation\":{\"evidence\":0,\"quote\":\"Rina owns Harbor.\"}}],\"branch\":false,\"validFrom\":null,\"validTo\":null,\"action\":\"add\",\"target\":null,\"reason\":\"\",\"citations\":[{\"evidence\":0,\"quote\":\"Rina owns Harbor.\"}]}],\"evidence\":[{\"sessionId\":\"kestrel-lane\",\"entryId\":\"entry-1\",\"role\":\"user\",\"label\":\"You · Nov 6, 12:47\",\"observedAt\":10,\"text\":\"Before the meeting. Rina owns Harbor. After the meeting.\"},{\"sessionId\":\"kestrel-lane\",\"entryId\":\"entry-2\",\"role\":\"toolResult\",\"label\":\"Tool output · cat\",\"observedAt\":11,\"text\":\"Tom maintains the archive.\"}],\"memoryVectors\":[],\"entityVectors\":[],\"groups\":[],\"confirmations\":[],\"held\":0}"}}',NULL);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-2','memory-1',1);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-2','memory-2',2);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-2','memory-3',3);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-2','memory-4',4);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-2','memory-5',5);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-2','memory-6',6);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-32','memory-1',1);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-32','memory-2',2);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-33','memory-3',3);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-33','memory-4',4);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-34','memory-5',5);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-34','memory-6',6);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-40','memory-4',4);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-43','id-44',9);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-43','memory-7',7);
INSERT INTO tidy_operation_memories(operation_id,memory_id,memory_n) VALUES ('id-54','id-51',10);
INSERT INTO tidy_memory_keys(memory,fingerprint) VALUES (2,'41c70d38495fdb199a7b7912ece0df6e7f16610b7448fd8b29eeb605ccedd0a1');
INSERT INTO tidy_memory_keys(memory,fingerprint) VALUES (6,'462d39cd4e70cbefa77e0150f73caf92a79e97d435cdf7c6b326afb2b6a45eba');
INSERT INTO tidy_memory_keys(memory,fingerprint) VALUES (9,'c40a128c2bf1101af94050c6587f653daa6c577b3375591624a2004969bade78');
INSERT INTO tidy_memory_keys(memory,fingerprint) VALUES (10,'b2203843d28663feb4cb0f622a4fec006964cb1d147729175ea3c9316640d452');
INSERT INTO tidy_sweep(singleton,phase,cursor,entities,memories,total_entities,total_memories,entity_max,memory_max,limited_checks,started_at,finished_at) VALUES (1,'entities',0,0,0,0,0,0,0,0,NULL,NULL);
INSERT INTO tidy_run(singleton,state,done,total,found,error,model,started_at,finished_at,folded,message) VALUES (1,'idle',0,0,0,NULL,NULL,NULL,NULL,0,NULL);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-32','made',NULL,'Compared the two Ledger records.',NULL,1037);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-33','made',NULL,'Compared the two Ledger records.',NULL,1045);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-34','made',NULL,'Compared the two Ledger records.',NULL,1052);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-35','made',NULL,'Compared the two Ledger records.',NULL,1057);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-43','made','id-42','The ticket names the API team.',NULL,1074);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-49','made','id-42','Said by mistake.',NULL,1082);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-54','made',NULL,'Compared the two Ledger records.','id-50',1091);
INSERT INTO agent_notes(operation_id,role,run_id,reason,job_id,created_at) VALUES ('id-58','made',NULL,'Compared the two Ledger records.','id-57',1098);
INSERT INTO agent_runs(id,state,total,queued_at,started_at,finished_at,error,session_path,rules_changed) VALUES ('id-42','done',0,1070,1072,1085,NULL,NULL,0);
INSERT INTO entity_words(rowid,text) VALUES (1,'Rina Okafor Ledger lead 1');
INSERT INTO entity_words(rowid,text) VALUES (3,'Ledger team 3');
INSERT INTO entity_words(rowid,text) VALUES (4,'Harbor 4');
INSERT INTO entity_words(rowid,text) VALUES (5,'Tom Lee 5');
INSERT INTO entity_words(rowid,text) VALUES (6,'Northwind 6');
INSERT INTO entity_words(rowid,text) VALUES (7,'Rina Okafor Ledger billing lead');
INSERT INTO entity_words(rowid,text) VALUES (9,'Rina Okafor (Kestrel) ');
INSERT INTO entity_words(rowid,text) VALUES (10,'Rina Rina Okafor ');
INSERT INTO entity_words(rowid,text) VALUES (11,'Harbor Harbor billing service ');
INSERT INTO entity_grams(rowid,name) VALUES (1,'Rina Okafor');
INSERT INTO entity_grams(rowid,name) VALUES (3,'Ledger team');
INSERT INTO entity_grams(rowid,name) VALUES (4,'Harbor');
INSERT INTO entity_grams(rowid,name) VALUES (5,'Tom Lee');
INSERT INTO entity_grams(rowid,name) VALUES (6,'Northwind');
INSERT INTO entity_grams(rowid,name) VALUES (7,'Rina Okafor');
INSERT INTO entity_grams(rowid,name) VALUES (9,'Rina Okafor (Kestrel)');
INSERT INTO entity_grams(rowid,name) VALUES (10,'Rina Okafor');
INSERT INTO entity_grams(rowid,name) VALUES (11,'Rina');
INSERT INTO entity_grams(rowid,name) VALUES (12,'Harbor');
INSERT INTO entity_grams(rowid,name) VALUES (13,'Harbor billing service');
INSERT INTO memory_words(rowid,summary) VALUES (2,'Rina leads Ledger area 2.');
INSERT INTO memory_words(rowid,summary) VALUES (3,'Rina leads Ledger area 3.');
INSERT INTO memory_words(rowid,summary) VALUES (4,'Rina leads Ledger area 4.');
INSERT INTO memory_words(rowid,summary) VALUES (6,'Rina leads Ledger area 6.');
INSERT INTO memory_words(rowid,summary) VALUES (9,'Rina leads the Ledger API team.');
INSERT INTO memory_words(rowid,summary) VALUES (10,'Rina Okafor owns the Northwind billing export.');
INSERT INTO meta(key,value) VALUES ('revision','16');
INSERT INTO meta(key,value) VALUES ('generation','id-1');
INSERT INTO meta(key,value) VALUES ('memories','6.0');
INSERT INTO meta(key,value) VALUES ('entities','9.0');
INSERT INTO meta(key,value) VALUES ('entity_bits','8');
INSERT INTO meta(key,value) VALUES ('memory_bits','6');
INSERT INTO meta(key,value) VALUES ('prefs','{"enabled":true,"recall":true,"review":false,"model":null,"neverRead":{"titles":["1:1","1-1","one on one","1on1"],"sessionIds":[]}}');
INSERT INTO meta(key,value) VALUES ('vector_epoch','1');
INSERT INTO meta(key,value) VALUES ('memories_sequence','10');
INSERT INTO meta(key,value) VALUES ('entities_sequence','11');
INSERT INTO meta(key,value) VALUES ('knowledge_revision','10');
CREATE TRIGGER entity_bits_insert AFTER INSERT ON entity_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(1) WHERE key='entity_bits'; END;
CREATE TRIGGER entity_bits_delete AFTER DELETE ON entity_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(-1) WHERE key='entity_bits'; END;
CREATE TRIGGER memory_bits_insert AFTER INSERT ON memory_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(1) WHERE key='memory_bits'; END;
CREATE TRIGGER memory_bits_delete AFTER DELETE ON memory_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(-1) WHERE key='memory_bits'; END;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 7;
