import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, type ClaudeAccountPrefs } from '@shared/models'
import type * as Store from '../../store'
import type * as DesktopPorts from './desktop-ports'

const userData = mkdtempSync(join(tmpdir(), 'desktop-ports-'))
afterAll(() => rmSync(userData, { recursive: true, force: true }))
const accounts: ClaudeAccountPrefs = {
  accounts: [
    { id: 'default', label: 'Terminal', credentialDir: null, addedAt: 0 },
    {
      id: '6c842430-50a7-40c1-91a8-5400ae7e3685',
      label: 'Work',
      credentialDir: join(userData, 'claude-accounts', '6c842430-50a7-40c1-91a8-5400ae7e3685'),
      addedAt: 1,
    },
  ],
  mode: 'round-robin',
  cursor: 1,
  cooldowns: {},
  bindings: {},
}
vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: true, getVersion: () => '2.0.0' },
}))
// Claude accounts live beside the app prefs, not in them: getPrefs() never carries them.
vi.mock('../../store', async (original) => ({
  ...(await original<typeof Store>()),
  getPrefs: () => ({ ...DEFAULT_APP_PREFS, claudeAccounts: undefined }),
  getClaudeAccountPrefs: () => accounts,
}))
const scan = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('./scan', () => ({ scanPlanFacts: scan }))

// Loading the gate's module graph alone can approach the default per-test timeout.
let desktopGatePorts: typeof DesktopPorts.desktopGatePorts
beforeAll(async () => {
  ;({ desktopGatePorts } = await import('./desktop-ports'))
}, 30_000)

it('plans and verifies Claude accounts from the account prefs, not the app prefs', async () => {
  const { runner } = desktopGatePorts({})
  await runner.scan({ migrationId: 'm', machineId: 'h', backupDir: userData, routinesCopy: null })
  expect(scan).toHaveBeenCalledWith(
    expect.objectContaining({ prefs: expect.objectContaining({ claudeAccounts: accounts }) }),
  )
  expect(runner.verify.accounts()).toBe(2)
})
