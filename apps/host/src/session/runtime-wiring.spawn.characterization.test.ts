import type * as StartupModule from '@phosphor/session-runtime/pi/session-startup'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { createRuntimeState } from './runtime-state'
import { wireRuntimeStartup } from './runtime-wiring'

vi.mock('@phosphor/session-runtime/pi/session-startup', async (original) => {
  const actual = await original<typeof StartupModule>()
  return { ...actual, createSessionStartup: vi.fn(actual.createSessionStartup) }
})

const PINNED = join(import.meta.dirname, '__fixtures__', 'spawn-options.host.json')
let dir: string
let repo: string
beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-spawn-pin-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  mkdirSync(join(dir, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** Spawn options decide pi's argv and env; paths are written relative so the pin is portable. */
function portable(options: Record<string, unknown>) {
  const text = JSON.stringify(options)
    .replaceAll(EXTENSIONS_ROOT, '<resources>')
    .replaceAll(repo, '<repo>')
  return JSON.parse(text) as Record<string, unknown>
}

it('spawns one Host lane with exactly the argv and env inputs it had before contributions', async () => {
  const state = createRuntimeState(
    {
      pi: { binaryPath: '/trusted/node', prefixArgs: ['/trusted/pi/cli.js'] },
      env: { PATH: '/usr/bin:/bin', HOME: '/home/owner' },
      roots: [repo],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      machineContext: { kind: 'host', label: 'pinned', os: 'Linux', repositories: [] },
      log: { addSecrets: vi.fn(), write: vi.fn(), hide: (text) => text, path: () => null },
    },
    {},
  )
  wireRuntimeStartup(state)
  const runtime = vi.mocked(createSessionStartup).mock.calls[0]![0]
  const captured: Record<string, unknown>[] = []
  const stop = new Error('captured')
  const spawn = vi.mocked(createSessionStartup).getMockImplementation()!({
    ...runtime,
    registry: {
      create: (_workspace, options) => {
        captured.push(options as Record<string, unknown>)
        throw stop
      },
      dispose: async () => {},
    },
  })
  await expect(spawn({ workspacePath: repo, name: 'Pinned' }, () => () => {})).rejects.toBe(stop)
  expect(captured).toHaveLength(1)
  const pinned = JSON.parse(readFileSync(PINNED, 'utf8')) as Record<string, unknown>
  Object.assign(pinned.env as object, {
    PHOSPHOR_DIRECTIVES_BASE: Buffer.from(pinned.appendSystemPrompt as string).toString('base64'),
  })
  expect(portable(captured[0]!)).toEqual(pinned)
})
