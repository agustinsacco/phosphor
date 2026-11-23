import type { DatabaseSync } from 'node:sqlite'
import { encodeBits } from '../bits'
import { encodeVector } from '../vectors'
import { vector } from '../test-support'

/** Real rows and indexes, invented people and evidence only. */
export function seed(db: DatabaseSync, count = 4, same = false): void {
  for (let n = 1; n <= count; n++) {
    const summary = same ? 'Rina leads Ledger.' : `Rina leads Ledger area ${n}.`
    db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?)').run(
      n,
      `rina-${n}`,
      'Rina Okafor',
      'person',
      `Ledger lead ${n}`,
      n,
      1,
      0,
    )
    db.prepare('INSERT INTO entity_names VALUES (?,?,?,?)').run(n, n, 'Rina Okafor', 'rina okafor')
    db.prepare('INSERT INTO entity_keys VALUES (?,?,?)').run('ledger', `rina-${n}`, n)
    db.prepare('INSERT INTO entity_words(rowid,text) VALUES (?,?)').run(
      n,
      `Rina Okafor Ledger lead ${n}`,
    )
    db.prepare('INSERT INTO entity_grams(rowid,name) VALUES (?,?)').run(n, 'Rina Okafor')
    db.prepare('INSERT INTO entity_vectors VALUES (?,?)').run(n, encodeVector(vector(1, n / 10)))
    db.prepare('INSERT INTO entity_bits VALUES (?,?)').run(n, encodeBits(vector(1, n / 10)))
    db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      n,
      `memory-${n}`,
      summary,
      'fact',
      'reported',
      '/Harbor',
      null,
      null,
      null,
      n,
      n,
      'active',
      `lane-${n}`,
      'Ledger',
      null,
    )
    db.prepare('INSERT INTO mentions VALUES (?,?)').run(n, n)
    db.prepare('INSERT INTO memory_vectors VALUES (?,?)').run(n, encodeVector(vector(1, n / 100)))
    db.prepare('INSERT INTO memory_bits VALUES (?,?)').run(n, encodeBits(vector(1, n / 100)))
    db.prepare('INSERT INTO memory_words(rowid,summary) VALUES (?,?)').run(n, summary)
    db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?)').run(
      n,
      `lane-${n}`,
      `entry-${n}`,
      'user',
      'Ledger evidence',
      n,
      summary,
    )
    db.prepare('INSERT INTO citations VALUES (?,?,?)').run(n, n, summary)
  }
  db.prepare("UPDATE meta SET value=? WHERE key IN ('entities','memories')").run(String(count))
}
export function dump(db: DatabaseSync): Record<string, unknown[]> {
  const tables = [
    'entities',
    'entity_names',
    'entity_keys',
    'entity_vectors',
    'entity_bits',
    'entity_words',
    'entity_grams',
    'merges',
    'memories',
    'mentions',
    'relations',
    'relation_support',
    'citations',
    'evidence',
    'memory_links',
    'memory_vectors',
    'memory_bits',
    'memory_words',
  ]
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare(
          `SELECT ${table.endsWith('_words') || table === 'entity_grams' ? 'rowid,*' : '*'} FROM ${table}`,
        )
        .all()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]),
  )
}
/** A sparse vector per memory so the hub raises no near repeats; only the planted pair matches. */
export function spread(n: number): Float32Array {
  const result = new Float32Array(768)
  result[n % 768] = 1
  result[(n * 7 + 3) % 768] = 1
  return result
}
/** Entities 1 and 2 are two "Rina Okafor" records; the hub's memories all mention entity 1. */
export function hub(db: DatabaseSync, size: number): void {
  seed(db, 2)
  const memory = db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const mention = db.prepare('INSERT INTO mentions VALUES (?,?)')
  const vectors = db.prepare('INSERT INTO memory_vectors VALUES (?,?)')
  const bits = db.prepare('INSERT INTO memory_bits VALUES (?,?)')
  const words = db.prepare('INSERT INTO memory_words(rowid,summary) VALUES (?,?)')
  db.exec('BEGIN')
  for (let i = 1; i <= size; i++) {
    const n = i + 2
    // The last two become exact repeats once entity 2 is merged into entity 1.
    const planted = i > size - 2
    const summary = planted ? 'Rina reviews Kestrel releases.' : `Rina reviews Harbor change ${i}.`
    memory.run(
      n,
      `hub-${String(i).padStart(5, '0')}`,
      summary,
      'fact',
      'reported',
      '/Harbor',
      null,
      null,
      null,
      n,
      n,
      'active',
      `lane-${n}`,
      'Ledger',
      null,
    )
    mention.run(n, planted && i === size ? 2 : 1)
    vectors.run(n, encodeVector(spread(n)))
    bits.run(n, encodeBits(spread(n)))
    words.run(n, summary)
  }
  db.exec('COMMIT')
  db.prepare("UPDATE meta SET value=? WHERE key='memories'").run(String(size + 2))
}

/** Historical verdict metadata remains readable after the model-check writer was removed. */
export function seedHistoricalVerdict(
  db: DatabaseSync,
  id: string,
  verdict: { kind: 'same' | 'different' | 'conflict'; reason: string },
): void {
  db.prepare(
    `UPDATE tidy_suggestions SET source='check',kind=CASE WHEN ?='conflict' THEN 'conflict' ELSE kind END,
    verdict=?,verdict_reason=?,reason=?,model='example/reader' WHERE id=?`,
  ).run(verdict.kind, verdict.kind, verdict.reason, verdict.reason, id)
  db.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")
}
