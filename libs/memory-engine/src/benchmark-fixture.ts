import type { DatabaseSync } from 'node:sqlite'
import { encodeBits } from './bits'
import { encodeVector } from './vectors'

/** Deterministic clustered fake embeddings. These are a throughput fixture, not a model-quality gate. */
export function clusteredVector(index: number): Float32Array {
  const cluster = index % 64
  let state = cluster + 17
  let jitter = index + 991
  const result = new Float32Array(768)
  for (let i = 0; i < result.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0
    jitter = (Math.imul(jitter, 22695477) + 1) | 0
    result[i] = state / 0x80000000 + 0.2 * (jitter / 0x80000000)
  }
  return result
}
export function buildBenchmark(db: DatabaseSync, entities: number, memories: number): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    buildEntities(db, entities)
    buildMemories(db, entities, memories)
    db.prepare("UPDATE meta SET value=? WHERE key='entities'").run(String(entities))
    db.prepare("UPDATE meta SET value=? WHERE key='memories'").run(String(memories))
    db.exec("UPDATE meta SET value='1' WHERE key='revision'; COMMIT")
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
function buildEntities(db: DatabaseSync, count: number): void {
  const insert = db.prepare(
    "INSERT INTO entities(n,id,label,kind,description,created_at) VALUES (?,?,?,'project','',1)",
  )
  const names = db.prepare('INSERT INTO entity_names(n,entity,name,folded) VALUES (?,?,?,?)')
  const words = db.prepare('INSERT INTO entity_words(rowid,text) VALUES (?,?)')
  const grams = db.prepare('INSERT INTO entity_grams(rowid,name) VALUES (?,?)')
  const vector = db.prepare('INSERT INTO entity_vectors VALUES (?,?)')
  const bits = db.prepare('INSERT INTO entity_bits VALUES (?,?)')
  for (let n = 1; n <= count; n++) {
    const label = `Ledger ${n}`
    const embedding = clusteredVector(n)
    insert.run(n, `entity-${n}`, label)
    names.run(n, n, label, label.toLowerCase())
    words.run(n, label)
    grams.run(n, label)
    vector.run(n, encodeVector(embedding))
    bits.run(n, encodeBits(embedding))
  }
}
function buildMemories(db: DatabaseSync, entities: number, count: number): void {
  const insert = db.prepare(
    "INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state) VALUES (?,?,?,'fact','reported','/made-up/ledger',?,1,'active')",
  )
  const words = db.prepare('INSERT INTO memory_words(rowid,summary) VALUES (?,?)')
  const mentions = db.prepare('INSERT OR IGNORE INTO mentions VALUES (?,?)')
  const relations = db.prepare(
    "INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (?,?,'part_of',?,1,?)",
  )
  const vector = db.prepare('INSERT INTO memory_vectors VALUES (?,?)')
  const bits = db.prepare('INSERT INTO memory_bits VALUES (?,?)')
  const degree = new Uint32Array(entities + 1)
  const mentioned = new Uint32Array(entities + 1)
  for (let n = 1; n <= count; n++) {
    const subject = (n % entities) + 1
    // Half the links point to one hub; the other half form small clusters.
    const object = subject === 1 ? 2 : n % 2 ? 1 : Math.max(1, subject - (subject % 16))
    const summary = `Ledger ${subject} has synthetic fact ${n}.`
    const embedding = clusteredVector(n)
    insert.run(n, `memory-${n}`, summary, n)
    words.run(n, summary)
    mentions.run(n, subject)
    mentioned[subject]!++
    if (subject !== object) {
      mentions.run(n, object)
      mentioned[object]!++
      relations.run(n, subject, object, n)
      degree[subject]!++
      degree[object]!++
    }
    vector.run(n, encodeVector(embedding))
    bits.run(n, encodeBits(embedding))
  }
  const update = db.prepare('UPDATE entities SET memories=?,connections=? WHERE n=?')
  for (let n = 1; n <= entities; n++) update.run(mentioned[n]!, degree[n]!, n)
}
