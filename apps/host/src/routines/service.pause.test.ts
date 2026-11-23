import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PAUSED_MESSAGE } from '../lanes/pause'
import type { HostRuntime } from '../session/runtime'
import { createHostRoutines } from './service'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'host-routines-pause-'))
  let paused = true
  const changed = vi.fn()
  const runtime = { life: { assertReady: () => {} } } as unknown as HostRuntime
  const routines = createHostRoutines({
    directory,
    uid: process.getuid?.(),
    store: { listRepositories: () => [] },
    runtime,
    changed,
    paused: () => paused,
  })
  cleanups.push(async () => {
    await routines.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { routines, changed, resume: () => (paused = false) }
}

it('starts no routine run while a service pause holds, and ticks again once it ends', () => {
  const { routines, changed, resume } = setup()
  expect(() => routines.scheduler.runNow(crypto.randomUUID(), crypto.randomUUID())).toThrow(
    PAUSED_MESSAGE,
  )
  routines.scheduler.tick()
  expect(changed).not.toHaveBeenCalled()
  expect(routines.running()).toBe(0)
  resume()
  routines.resume()
  expect(changed).toHaveBeenCalledTimes(1)
  expect(() => routines.scheduler.runNow(crypto.randomUUID(), crypto.randomUUID())).not.toThrow(
    PAUSED_MESSAGE,
  )
})
