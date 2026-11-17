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
