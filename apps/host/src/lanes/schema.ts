export const SCHEMA_VERSION = 1
export const SCHEMA = `
CREATE TABLE repositories (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=16 AND id NOT GLOB '*[^0-9a-f]*'),
  path TEXT UNIQUE NOT NULL CHECK(path GLOB '/*' AND length(path) BETWEEN 1 AND 4096),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 4096),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  added_at INTEGER NOT NULL CHECK(added_at>=0)
) STRICT;
CREATE INDEX repositories_active ON repositories(added_at,id) WHERE active=1;
CREATE TABLE lanes (
  lane_id TEXT PRIMARY KEY NOT NULL CHECK(length(lane_id)=36 AND lane_id NOT GLOB '*[^0-9a-f-]*' AND length(replace(lane_id,'-',''))=32 AND substr(lane_id,9,1)='-' AND substr(lane_id,14,1)='-' AND substr(lane_id,19,1)='-' AND substr(lane_id,24,1)='-' AND substr(lane_id,15,1) ='4' AND substr(lane_id,20,1) IN ('8','9','a','b')),
  repository_id TEXT NOT NULL REFERENCES repositories(id) CHECK(length(repository_id)=16),
  cwd TEXT NOT NULL CHECK(cwd GLOB '/*' AND length(cwd) BETWEEN 1 AND 4096),
  session_file TEXT UNIQUE CHECK(session_file IS NULL OR (session_file GLOB '/*' AND length(session_file) BETWEEN 1 AND 4096)),
  title TEXT CHECK(title IS NULL OR length(title)<=80),
  branch TEXT CHECK(branch IS NULL OR length(branch)<=256),
  worktree INTEGER NOT NULL CHECK(worktree IN (0,1)),
  provider TEXT CHECK(provider IS NULL OR length(provider) BETWEEN 1 AND 64),
  model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  fence INTEGER NOT NULL CHECK(fence BETWEEN 1 AND 9007199254740991),
  controller_client_id TEXT CHECK(controller_client_id IS NULL OR length(controller_client_id)=36 AND controller_client_id NOT GLOB '*[^0-9a-f-]*' AND length(replace(controller_client_id,'-',''))=32 AND substr(controller_client_id,9,1)='-' AND substr(controller_client_id,14,1)='-' AND substr(controller_client_id,19,1)='-' AND substr(controller_client_id,24,1)='-' AND substr(controller_client_id,15,1) BETWEEN '1' AND '8' AND substr(controller_client_id,20,1) IN ('8','9','a','b')),
  controller_label TEXT CHECK(controller_label IS NULL OR length(controller_label) BETWEEN 1 AND 80),
  attention INTEGER NOT NULL CHECK(attention BETWEEN 0 AND 9007199254740991),
  read INTEGER NOT NULL CHECK(read BETWEEN 0 AND attention),
  removed_at INTEGER CHECK(removed_at IS NULL OR removed_at>=0),
  CHECK((controller_client_id IS NULL)=(controller_label IS NULL)),
  CHECK((provider IS NULL)=(model IS NULL))
) STRICT;
CREATE INDEX lanes_removed ON lanes(removed_at,lane_id) WHERE removed_at IS NOT NULL;
CREATE TABLE receipts (
  request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND request_id NOT GLOB '*[^0-9a-f-]*' AND length(replace(request_id,'-',''))=32 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND substr(request_id,15,1) BETWEEN '1' AND '8' AND substr(request_id,20,1) IN ('8','9','a','b')),
  client_id TEXT NOT NULL CHECK(length(client_id)=36 AND client_id NOT GLOB '*[^0-9a-f-]*' AND length(replace(client_id,'-',''))=32 AND substr(client_id,9,1)='-' AND substr(client_id,14,1)='-' AND substr(client_id,19,1)='-' AND substr(client_id,24,1)='-' AND substr(client_id,15,1) BETWEEN '1' AND '8' AND substr(client_id,20,1) IN ('8','9','a','b')),
  op_hash TEXT NOT NULL CHECK(length(op_hash)=64 AND op_hash NOT GLOB '*[^0-9a-f]*'),
  lane_id TEXT CHECK(lane_id IS NULL OR (length(lane_id)=36 AND lane_id NOT GLOB '*[^0-9a-f-]*' AND length(replace(lane_id,'-',''))=32 AND substr(lane_id,9,1)='-' AND substr(lane_id,14,1)='-' AND substr(lane_id,19,1)='-' AND substr(lane_id,24,1)='-' AND substr(lane_id,15,1)='4' AND substr(lane_id,20,1) IN ('8','9','a','b'))),
  status TEXT NOT NULL CHECK(status IN ('started','done','failed','rejected','unknown')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=524288)),
  started_at INTEGER NOT NULL CHECK(started_at>=0),
  finished_at INTEGER CHECK(finished_at IS NULL OR finished_at>=started_at),
  CHECK((status='started')=(finished_at IS NULL)),
  CHECK((status='started')=(receipt_json IS NULL)),
  CHECK(receipt_json IS NULL OR (json_type(receipt_json,'$.requestId') IS 'text' AND json_type(receipt_json,'$.status') IS 'text' AND json_extract(receipt_json,'$.requestId')=request_id AND json_extract(receipt_json,'$.status')=status))
) STRICT;
CREATE INDEX receipts_finished ON receipts(finished_at,request_id) WHERE finished_at IS NOT NULL;
CREATE INDEX receipts_started ON receipts(request_id) WHERE status='started';
PRAGMA user_version=1;
`
