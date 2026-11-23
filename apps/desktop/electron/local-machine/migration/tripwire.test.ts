import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { world, ports } from './__fixtures__/post-commit-world'
import { baseRoutines } from './__fixtures__/base-desktop'
import { createPostCommitSteps } from './post-commit-steps'
import { withStep } from './journal'
import { checkMigrationTripwire } from './tripwire'

it.each(['lastSessionPath', 'recentWorkspaces', 'routines'])(
  'warns once on reappearance of %s, not an empty old database',
  async (fact) => {
    const w = world()
    try {
      const log = vi.fn()
      const warn = vi.fn()
      const rescan = vi.fn(async () => {})
      const input = { ...ports, userData: w.userData, warn, rescan, log }
      await createPostCommitSteps(ports).quarantine!({ ...w, log })
      w.writer.write(withStep(w.journal, 'quarantine', 'done', w.journal.updatedAt))
      baseRoutines(w.userData)
      await checkMigrationTripwire(input)
      expect(warn).not.toHaveBeenCalled()
      expect(rescan).not.toHaveBeenCalled()
      if (fact === 'routines') {
        const db = new (loadSqlite().DatabaseSync)(join(w.userData, ports.routinesFile))
        db.exec("INSERT INTO routines VALUES ('x','{}')")
        db.close()
      } else {
        w.write({ ...w.read(), [fact]: w.config[fact] })
      }
      await checkMigrationTripwire(input)
      await checkMigrationTripwire(input)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(rescan).toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('legacy-desktop-detected')
    } finally {
      rmSync(w.userData, { recursive: true, force: true })
    }
  },
)
