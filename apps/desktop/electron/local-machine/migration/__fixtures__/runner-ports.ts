import { join } from 'node:path'
import { vi } from 'vitest'
import type { GateRunnerPorts } from '../gate'
import { MIGRATION_DIR } from '../journal'
import type { PostCommitSteps } from '../post-commit'
import { planFacts } from './plan-facts'

/**
 * Runner ports over `planFacts()` with a scratch userData: the scan returns
 * the fixture Mac, the verify ports agree with the fake service, and the
 * post-commit table holds only `device`, so `quarantine` stays pending.
 */
export function runnerPorts(userData: string, over: Partial<GateRunnerPorts> = {}) {
  let ids = 0
  const localRuntime = vi.fn()
  const log = vi.fn()
  const device = vi.fn(async () => {})
  const postCommit: PostCommitSteps = { device }
  const ports: GateRunnerPorts = {
    userData,
    migrationDir: join(userData, MIGRATION_DIR),
    now: () => Date.parse('2026-11-23T10:00:00.000Z'),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    desktopVersion: '2.0.0',
    routinesFile: 'routines.sqlite',
    scan: async ({ migrationId, machineId }) => ({
      ...planFacts({ migrationId, machineId }),
      routines: null,
    }),
    archives: async () => planFacts().archives.map((a) => a.record),
    verify: {
      readTranscript: async () => [],
      identity: (path) => ({ real: path, dev: 1, ino: 1, size: 1, isFile: true }),
      hash: async () => 'h',
      exists: (path) => !path.endsWith('routines.sqlite'),
      accounts: () => 0,
    },
    desktop: { agentDir: '/fixture/.pi/agent', sessionsRoot: '/fixture/.pi/agent/sessions' },
    postCommit,
    writeLocalRuntime: localRuntime,
    log,
    ...over,
  }
  return { ports, localRuntime, log, device }
}
