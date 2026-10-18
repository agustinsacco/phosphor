import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadSqlite } from '../sqlite'
import { SCHEMA } from '../schema'
import { StateFailure } from '../state-dir'
import { openStoreDatabase } from './open'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-open-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('sets PRAGMAs, migrates once and recovers before pruning with the configured clock', async () => {
  const { DatabaseSync } = await loadSqlite()
  const events: string[] = []
  const exec = DatabaseSync.prototype.exec
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: InstanceType<typeof DatabaseSync>,
    sql,
  ) {
    events.push(sql)
    exec.call(this, sql)
  })
  const construct = (db: InstanceType<typeof DatabaseSync>) => ({
    db,
    migrate: () => {
      events.push('migrate')
      db.exec(SCHEMA)
    },
    markInterrupted: () => {
      events.push('interrupt')
    },
    pruneReceipts: (now: number) => {
      events.push(`prune:${now}`)
    },
  })
  const path = join(root, 'state')
  const store = await openStoreDatabase(path, process.getuid?.(), { now: () => 42 }, construct)
  try {
    expect(events).toEqual([
      'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
      'migrate',
      SCHEMA,
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
      'interrupt',
      'prune:42',
    ])
    expect(store.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
    expect(store.db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2)
    expect(store.db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(5000)
  } finally {
    store.db.close()
  }
  events.length = 0
  const reopened = await openStoreDatabase(path, process.getuid?.(), { now: () => 43 }, construct)
  try {
    expect(events).toEqual([
      'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
      'interrupt',
      'prune:43',
    ])
  } finally {
    reopened.db.close()
  }
})
it.each(['construct', 'migrate', 'interrupt', 'prune'])(
  'closes on %s failure and normalizes unexpected errors',
  async (stage) => {
    const { DatabaseSync } = await loadSqlite()
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    const fail = (current: string) => {
      if (stage === current) throw new Error('private detail')
    }
    await expect(
      openStoreDatabase(join(root, 'state'), process.getuid?.(), {}, () => {
        fail('construct')
        return {
          migrate: () => fail('migrate'),
          markInterrupted: () => fail('interrupt'),
          pruneReceipts: () => fail('prune'),
        }
      }),
    ).rejects.toMatchObject({
      exitCode: 70,
      message: expect.not.stringContaining('private detail'),
    })
    expect(close).toHaveBeenCalledTimes(1)
  },
)
it('preserves StateFailure identity after closing the handle', async () => {
  const failure = new StateFailure(root, 78, 'expected configuration failure')
  const { DatabaseSync } = await loadSqlite()
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  await expect(
    openStoreDatabase(join(root, 'state'), process.getuid?.(), {}, () => {
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(close).toHaveBeenCalledTimes(1)
})
