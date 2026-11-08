import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createStaging } from './staging'

it('counts completed exports with unreleased bytes against admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-staging-'))
  const staging = createStaging(root)
  try {
    const reserved = staging.create(1)!
    writeFileSync(reserved.entry.path, 'retained bytes')
    staging.track(reserved.entry, Promise.resolve({ size: 14 }), () => ['failed'])
    await Promise.resolve()
    expect(reserved.entry.status).toMatchObject({ state: 'done' })
    expect(staging.create(1)).toBeNull()
    staging.release(reserved.id)
    expect(existsSync(reserved.entry.path)).toBe(false)
    expect(staging.create(1)).not.toBeNull()
  } finally {
    staging.close()
    rmSync(root, { recursive: true, force: true })
  }
})
