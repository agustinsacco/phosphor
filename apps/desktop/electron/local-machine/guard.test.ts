import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TitleRun from '@phosphor/session-runtime/pi/title-run'
import type * as McpInspection from '@phosphor/session-runtime/pi/mcp-inspection'
import type { LocalDaemonAccess } from './mode'

/**
 * The guards the boundary test lists, at runtime: in daemon mode each refuses
 * before anything is spawned or written; in-app, nothing changes.
 */
const lib = vi.hoisted(() => ({
  print: vi.fn(async () => ({ stdout: 'ran' })),
  writer: vi.fn(async () => {}),
  title: vi.fn(),
  list: vi.fn(),
  // A pi client that never starts a process.
  rpc: vi.fn(function () {
    return { spawn() {}, killNow() {}, async dispose() {} }
  }),
}))
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent/m2a-guard' } }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({
  runPrintMode: lib.print,
  OWN_GROUP: process.platform !== 'win32',
  killProcessTree: vi.fn(),
}))
vi.mock('@phosphor/session-runtime/pi/session-writer', () => ({
  appendLabel: lib.writer,
  appendBranchJump: lib.writer,
  forkSessionAt: lib.writer,
}))
vi.mock('@phosphor/session-runtime/pi/title-run', async (original) => ({
  ...(await original<typeof TitleRun>()),
  runTitleAttempts: lib.title,
}))
vi.mock('@phosphor/session-runtime/pi/mcp-inspection', async (original) => ({
  ...(await original<typeof McpInspection>()),
  runMcpList: lib.list,
}))
vi.mock('../pi/desktop-rpc-client', () => ({ PiRpcClient: lib.rpc }))

const access: LocalDaemonAccess = {
  location: { kind: 'dev', socket: '/tmp/m2a/s.sock', configDir: '/tmp/m2a/config' },
  ownerKey: () => Promise.reject(new Error('unused')),
}

async function daemonMode() {
  const mode = await import('./mode')
  mode.decideLocalRuntimeMode('daemon', access)
  return mode
}

beforeEach(() => {
  vi.resetModules()
  for (const fn of Object.values(lib)) fn.mockClear()
})

describe('in daemon mode', () => {
  it('the registry refuses before it builds a pi client', async () => {
    const { InAppRuntimeRefused } = await daemonMode()
    const { registry } = await import('../registry')
    expect(() => registry.create('/tmp/m2a/workspace', {})).toThrow(InAppRuntimeRefused)
    expect(lib.rpc).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
  })

  it('print mode answers the refusal as its error and never runs pi', async () => {
    const { IN_APP_RUNTIME_REFUSED } = await daemonMode()
    const { runPrintMode } = await import('../pi/print-mode')
    await expect(runPrintMode('pi', ['-p'], { cwd: '/tmp/m2a', env: {} })).resolves.toEqual({
      stdout: '',
      error: IN_APP_RUNTIME_REFUSED,
    })
    expect(lib.print).not.toHaveBeenCalled()
  })

  it('session edits and forks refuse before the writer', async () => {
    const { InAppRuntimeRefused } = await daemonMode()
    const mutation = await import('../pi/session-mutation')
    const path = '/tmp/m2a/missing.jsonl'
    await expect(mutation.appendLabel(path, 'entry', 'x')).rejects.toThrow(InAppRuntimeRefused)
    await expect(mutation.appendBranchJump(path, 'entry')).rejects.toThrow(InAppRuntimeRefused)
    await expect(mutation.forkSessionAt(path, 'entry')).rejects.toThrow(InAppRuntimeRefused)
    expect(lib.writer).not.toHaveBeenCalled()
  })

  it('lane naming and connector checks refuse before pi', async () => {
    const { InAppRuntimeRefused } = await daemonMode()
    const { generateSessionTitle } = await import('../pi/session-title')
    await expect(generateSessionTitle('/tmp/m2a', 'hello', [])).rejects.toThrow(InAppRuntimeRefused)
    const { checkMcpServer } = await import('../pi/mcp-inspection')
    await expect(checkMcpServer(1, 'server', undefined, 'request')).rejects.toThrow(
      InAppRuntimeRefused,
    )
    expect(lib.title).not.toHaveBeenCalled()
    expect(lib.list).not.toHaveBeenCalled()
  })
})

describe('in-app (the default; nothing decides daemon mode yet)', () => {
  it('print mode and the registry behave as before', async () => {
    const { runPrintMode } = await import('../pi/print-mode')
    await expect(runPrintMode('pi', ['-p'], { cwd: '/tmp/m2a', env: {} })).resolves.toEqual({
      stdout: 'ran',
    })
    expect(lib.print).toHaveBeenCalledOnce()
    const { registry } = await import('../registry')
    expect(registry.create('/tmp/m2a/workspace', {}).workspacePath).toBe('/tmp/m2a/workspace')
    expect(lib.rpc).toHaveBeenCalledOnce()
  })

  it('an explicit in-app decision keeps every guard open', async () => {
    const mode = await import('./mode')
    mode.decideLocalRuntimeMode('in-app')
    const mutation = await import('../pi/session-mutation')
    await expect(mutation.appendLabel('/tmp/m2a/missing.jsonl', 'e', 'x')).rejects.toThrow(
      'This session no longer exists. It may have been deleted.',
    )
    expect(mode.localRuntimeMode()).toBe('in-app')
  })
})
