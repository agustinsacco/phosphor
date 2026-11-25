import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openBrainStore } from './store'
import { tidySchema } from './tidy/schema'

it('upgrades v6 through v7 to v8 in place without losing the read or its checkpoints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-v7-'))
  const path = join(directory, 'brain.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec(readFileSync(new URL('./__fixtures__/schema-v4.sql', import.meta.url), 'utf8'))
    old.exec(`ALTER TABLE jobs ADD COLUMN replaces TEXT;
      CREATE INDEX memories_origin ON memories(origin_session);
      CREATE INDEX jobs_finished ON jobs(state, finished_at DESC);`)
    old.exec(tidySchema)
    old.exec(`INSERT INTO jobs VALUES ('job','lane','/Harbor/lane.jsonl','Harbor','/Harbor',NULL,'fake/model','done',1,'leaf',NULL,1,2,3,NULL,5,NULL,NULL,NULL);
      INSERT INTO job_parts VALUES ('job','earlier','hash','done','Harbor');`)
    old.close()
    const store = openBrainStore({ path, Database: DatabaseSync })
    try {
      const inspect = new DatabaseSync(path)
      expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
      inspect.close()
      expect(store.job('job')).toMatchObject({
        state: 'done',
        leafId: 'leaf',
        startedAt: 2,
        fromLeafId: null,
        runStartedAt: null,
      })
      expect(store.part('job', 'earlier', 'hash')?.output).toBe('Harbor')
    } finally {
      store.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rolls back both nullable columns and the version if a v6 upgrade is interrupted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-v7-rollback-'))
  const path = join(directory, 'brain.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec(readFileSync(new URL('./__fixtures__/schema-v4.sql', import.meta.url), 'utf8'))
    old.exec(
      'ALTER TABLE jobs ADD COLUMN replaces TEXT; CREATE INDEX memories_origin ON memories(origin_session); CREATE INDEX jobs_finished ON jobs(state, finished_at DESC);',
    )
    old.exec(tidySchema)
    old.close()
    class Interrupted extends DatabaseSync {
      override exec(sql: string): void {
        if (sql.includes('run_started_at')) {
          super.exec('ALTER TABLE jobs ADD COLUMN from_leaf TEXT')
          throw new Error('Interrupted read metadata upgrade')
        }
        super.exec(sql)
      }
    }
    expect(() => openBrainStore({ path, Database: Interrupted })).toThrow(
      'Interrupted read metadata upgrade',
    )
    const inspect = new DatabaseSync(path)
    try {
      expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 })
      expect(
        inspect
          .prepare('PRAGMA table_info(jobs)')
          .all()
          .map((row) => row.name),
      ).not.toContain('from_leaf')
    } finally {
      inspect.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
