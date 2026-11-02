import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openStore } from '../store'
import { createLiveLanes } from '../live'
import { createHostLiveLanes } from '../live-host'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

/** A temp folder inside a checkout (TMPDIR set into one) has no plain folder to test. */
function insideRepository(path: string): boolean {
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function folders() {
  const dir = mkdtempSync(join(tmpdir(), 'host-repo-git-'))
  const plain = join(dir, 'plain')
  const repo = join(dir, 'repo')
  mkdirSync(plain)
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  const store = await openStore(join(dir, 'state'), process.getuid?.(), {})
  cleanups.push(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  store.syncRepositories([plain, repo])
  return store
}
const base = { epoch: '0123456789abcdef', runtime: { command: vi.fn() }, now: Date.now }

it.skipIf(insideRepository(tmpdir()))(
  'the Host lists whether git tracks each folder, asked at startup',
  async () => {
    const store = await folders()
    const { live } = createHostLiveLanes({ ...base, store, log: vi.fn(), sessionsRoot: '/none' })
    await vi.waitFor(() => expect(live.repositories()[0]?.git).toBe(false), { timeout: 5000 })
    expect(live.repositories().map((r) => [r.name, r.git])).toStrictEqual([
      ['plain', false],
      ['repo', true],
    ])
    expect(live.lanesTopic.snapshot().repositories.map((r) => r.git)).toStrictEqual([false, true])
  },
)

it('live lanes without a probe list repositories without the field', async () => {
  const store = await folders()
  const live = createLiveLanes({ ...base, store, log: vi.fn() })
  expect(live.repositories().map((r) => r.git)).toStrictEqual([undefined, undefined])
})
