import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { buildBenchmark, clusteredVector } from '../benchmark-fixture'
import { openBrainStore } from '../store'
import type { BrainStore, ClaimProbe } from '../types'

/** Every synthetic record is named by this many memories: a full entity window. */
export const WINDOW = 128

/**
 * A store of synthetic records (`entity-1` … `entity-N`, `entity-1` a hub), each the subject
 * of 128 memories with vectors; every seventh memory is superseded. `onWindow` runs just before
 * each entity window (a mentions query that loads memory vectors) is read.
 */
export function windowsFixture(
  entities: number,
  onWindow?: () => void,
): { store: BrainStore; db: DatabaseSync } {
  const databases: DatabaseSync[] = []
  class Database extends DatabaseSync {
    constructor(path: string, options?: { timeout?: number }) {
      super(path, options ?? {})
      databases.push(this)
    }
    override prepare(sql: string): StatementSync {
      const statement = super.prepare(sql)
      if (!onWindow || !sql.includes('FROM mentions') || !sql.includes('memory_vectors'))
        return statement
      const read = statement.all.bind(statement)
      statement.all = ((...args: SQLInputValue[]) => {
        onWindow()
        return read(...args)
      }) as StatementSync['all']
      return statement
    }
  }
  const store = openBrainStore({ path: ':memory:', Database })
  const db = databases[0]!
  buildBenchmark(db, entities, entities * WINDOW)
  db.exec("UPDATE memories SET state='superseded' WHERE n % 7 = 0")
  return { store, db }
}

/**
 * Claims naming one or two records, the hub, or a ref Brain does not have; some state a link to
 * the hub and some have no vector. Vectors share a cluster with some of their records' memories,
 * so entity, link and replaced matches all occur.
 */
export function windowProbes(entities: number, count: number): ClaimProbe[] {
  return Array.from({ length: count }, (_, i) => {
    const a = ((i * 7) % entities) + 1
    const b = ((i * 13) % entities) + 1
    return {
      entityIds:
        i % 5 === 0 ? [`entity-${a}`, 'entity-1', 'new-ref'] : [`entity-${a}`, `entity-${b}`],
      links:
        i % 4 === 0
          ? [{ subjectId: `entity-${a}`, predicate: 'part_of' as const, objectId: 'entity-1' }]
          : [],
      ...(i % 9 === 0 ? {} : { vector: clusteredVector(a + 64 * (i % 3)) }),
    }
  })
}
