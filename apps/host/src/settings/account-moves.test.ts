import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from '@phosphor/shared/models'
import type { StoredLane } from '../lanes/store'
import type { HostClaudeAccounts } from '../providers/accounts'
import { createAccountMoves } from './account-moves'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'account-move-'))
  dirs.push(dir)
  const path = join(dir, 'session.jsonl')
  await writeFile(path, '{}')
  const account = {
    id: 'd8736746-ea12-452b-a492-411a74fba4f8',
    label: 'Work',
    credentialDir: join(dir, 'isolated'),
    addedAt: 1,
  }
  const lane = {
    laneId: 'lane',
    sessionFile: path,
    removedAt: null,
    model: { provider: 'pi-claude-cli', id: 'claude' },
  } as StoredLane
  const steps: string[] = []
  const accounts = {
    withAuthorization: async <T>(_allowed: () => boolean, run: () => Promise<T>) => run(),
    loadAccounts: vi
      .fn<HostClaudeAccounts['loadAccounts']>()
      .mockResolvedValue({ ...DEFAULT_CLAUDE_ACCOUNT_PREFS, accounts: [account] }),
    status: vi
      .fn<HostClaudeAccounts['status']>()
      .mockResolvedValue({ binary: { found: true }, auth: { ok: true, loggedIn: true } }),
    bindSession: vi.fn(async () => {
      steps.push('bind')
    }),
  }
  const binding = {
    stopLane: vi.fn(async () => {
      steps.push('stop')
    }),
    resumeLane: vi.fn(async () => {
      steps.push('resume')
    }),
  }
  const move = createAccountMoves({
    accounts,
    binding,
    store: { getLane: () => lane },
    runtime: { withAuthorization: async (_allowed, run) => run() },
  })
  return { move, lane, account, accounts, binding, steps }
}
describe('explicit fenced Claude lane account moves', () => {
  it('verifies the isolated target then stops, binds and resumes in order', async () => {
    const f = await fixture()
    await f.move('lane', f.account.id, () => true)
    expect(f.accounts.status).toHaveBeenCalledWith(undefined, {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: f.account.credentialDir,
    })
    expect(f.steps).toEqual(['stop', 'bind', 'resume'])
    expect(f.accounts.bindSession).toHaveBeenCalledWith(f.lane.sessionFile, f.account.id)
  })
  it('does not stop a lane for unknown, signed-out or wrong-provider targets', async () => {
    const f = await fixture()
    await expect(f.move('lane', 'missing', () => true)).rejects.toThrow('unknown-account')
    f.accounts.status.mockResolvedValue({
      binary: { found: true },
      auth: { ok: true, loggedIn: false },
    })
    await expect(f.move('lane', f.account.id, () => true)).rejects.toThrow('not-ready')
    f.accounts.status.mockResolvedValue({
      binary: { found: true },
      auth: { ok: true, loggedIn: true },
    })
    Object.assign(f.lane, { model: { provider: 'native', id: 'm' } })
    await expect(f.move('lane', f.account.id, () => true)).rejects.toThrow('unsupported')
    Object.assign(f.lane, { model: undefined })
    await expect(f.move('lane', f.account.id, () => true)).rejects.toThrow('unsupported')
    expect(f.steps).toEqual([])
  })
  it('requires a saved transcript and does not resurrect a revoked or removed lane', async () => {
    const f = await fixture()
    await rm(f.lane.sessionFile!)
    await expect(f.move('lane', f.account.id, () => true)).rejects.toThrow()
    expect(f.steps).toEqual([])
    await writeFile(f.lane.sessionFile!, '{}')
    let allowed = true
    f.binding.stopLane.mockImplementation(async () => {
      f.steps.push('stop')
      allowed = false
    })
    await expect(f.move('lane', f.account.id, () => allowed)).rejects.toThrow('unavailable')
    expect(f.steps).toEqual(['stop'])
    expect(f.accounts.bindSession).not.toHaveBeenCalled()
  })
  it('rechecks the model learned during stop before changing billing affinity', async () => {
    const f = await fixture()
    f.binding.stopLane.mockImplementation(async () => {
      Object.assign(f.lane, { model: { provider: 'native', id: 'm' } })
    })
    await expect(f.move('lane', f.account.id, () => true)).rejects.toThrow('unavailable')
    expect(f.accounts.bindSession).not.toHaveBeenCalled()
    expect(f.binding.resumeLane).not.toHaveBeenCalled()
  })
  it('does not resume on the previous account if binding fails', async () => {
    const f = await fixture()
    f.accounts.bindSession.mockRejectedValue(new Error('revoked'))
    await expect(f.move('lane', f.account.id, () => true)).rejects.toThrow('revoked')
    expect(f.binding.stopLane).toHaveBeenCalledOnce()
    expect(f.binding.resumeLane).not.toHaveBeenCalled()
  })
})
