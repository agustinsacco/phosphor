import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostTerminals } from '../terminals/service'
import { which } from '../machine/executables'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { readMcpConfigs } from '@phosphor/session-runtime/pi/mcp-config'
import { createMachineTasks } from './tasks'
vi.mock('../machine/executables', () => ({ which: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/mcp-config', () => ({ readMcpConfigs: vi.fn() }))
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})
type HostUpdater = NonNullable<Parameters<typeof createMachineTasks>[0]['hostUpdater']>
function fixture(hostUpdater?: HostUpdater) {
  let finish!: () => void
  const runner = vi.fn<ReturnType<HostTerminals['loginRunner']>>()
  const terminals = {
    loginRunner: (_owner: string, started: (id: string) => void) => {
      runner.mockImplementation(async () => {
        started('private-pty')
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return { code: 0 }
      })
      return runner
    },
    machineOp: vi.fn<HostTerminals['machineOp']>(),
  }
  const settings = {
    workspace: vi.fn((id?: string) => (id ? '/host/repo' : undefined)),
    agentDir: '/host/pi-agent',
    invalidateConnectors: vi.fn(),
  }
  const tasks = createMachineTasks({
    terminals,
    settings,
    home: '/host/home',
    env: { HOME: '/host/home', PATH: '/trusted/bin' },
    pi: { binaryPath: '/trusted/node', prefixArgs: ['/trusted/pi.js'] },
    hostUpdater,
  })
  return { tasks, settings, terminals, runner, finish: () => finish() }
}
describe('fixed-purpose private machine programs', () => {
  it('installs the Claude provider through the pinned Host pi with no caller program/env', async () => {
    const f = fixture()
    expect(
      await f.tasks.execute(
        { type: 'machine.task', task: 'claude.installProvider' },
        'client',
        () => true,
      ),
    ).toEqual({ terminalId: 'private-pty' })
    expect(f.runner).toHaveBeenCalledWith(
      '/trusted/node',
      ['/trusted/pi.js', 'install', 'npm:@saccolabs/pi-claude-cli'],
      {
        cwd: '/host/home',
        env: { HOME: '/host/home', PATH: '/trusted/bin', TERM: 'xterm-256color' },
      },
    )
    await expect(
      f.tasks.execute(
        { type: 'machine.task', task: 'claude.installProvider' },
        'client',
        () => true,
      ),
    ).rejects.toThrow('busy')
    f.finish()
  })
  it('opens folder trust for review without automatically approving it', async () => {
    const f = fixture()
    await f.tasks.execute(
      { type: 'machine.task', task: 'folder.trust', repositoryId: '0123456789abcdef' },
      'client',
      () => true,
    )
    expect(f.runner.mock.calls[0]?.[1]).not.toContain('--approve')
    expect(f.runner.mock.calls[0]?.[2]?.cwd).toBe('/host/repo')
    f.finish()
  })
  it('refuses caller argv and authority revoked during an async target check', async () => {
    const f = fixture()
    await expect(
      f.tasks.execute(
        { type: 'machine.task', task: 'claude.installCli', command: '/bin/bash' },
        'client',
        () => true,
      ),
    ).rejects.toThrow('bad-request')
    vi.mocked(listPackages).mockResolvedValue([])
    await expect(
      f.tasks.execute(
        { type: 'machine.task', task: 'package.remove', name: 'npm:unknown' },
        'client',
        () => true,
      ),
    ).rejects.toThrow('unavailable')
    expect(f.runner).not.toHaveBeenCalled()
    const g = fixture()
    let authorized = true
    vi.mocked(readMcpConfigs).mockImplementation(async () => {
      authorized = false
      return {
        servers: [
          {
            name: 'github',
            config: { url: 'https://example.com' },
            defined: { url: 'https://example.com' },
            scope: 'global',
          },
        ],
        files: [],
        errors: [],
        legacy: false,
        projectTrust: null,
      }
    })
    await expect(
      g.tasks.execute(
        { type: 'machine.task', task: 'mcp.login', name: 'github' },
        'client',
        () => authorized,
      ),
    ).rejects.toThrow('unavailable')
    expect(g.runner).not.toHaveBeenCalled()
  })
  it('clears connector checks before auth and bounds interactive jobs', async () => {
    vi.useFakeTimers()
    const f = fixture()
    vi.mocked(readMcpConfigs).mockResolvedValue({
      servers: [
        {
          name: 'github',
          config: { url: 'https://example.com' },
          defined: { url: 'https://example.com' },
          scope: 'global',
        },
      ],
      files: [],
      errors: [],
      legacy: false,
      projectTrust: null,
    })
    await f.tasks.execute(
      { type: 'machine.task', task: 'mcp.login', name: 'github' },
      'owner',
      () => true,
    )
    expect(f.settings.invalidateConnectors).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(f.terminals.machineOp).toHaveBeenCalledWith('owner', {
      type: 'terminal.kill',
      terminalId: 'private-pty',
    })
    f.finish()
  })
  it('keeps the official installer private until the PTY completes and releases task state', async () => {
    const f = fixture()
    vi.mocked(which).mockImplementation(async (name) => `/trusted/${name}`)
    vi.mocked(runPrintMode).mockResolvedValue({ stdout: '' })
    await f.tasks.execute({ type: 'machine.task', task: 'claude.installCli' }, 'client', () => true)
    const download = vi.mocked(runPrintMode).mock.calls[0]!
    const script = download[1]!.at(-1)!
    expect(download[0]).toBe('/trusted/curl')
    expect(f.runner).toHaveBeenCalledWith('/trusted/bash', [script], {
      cwd: '/host/home',
      env: { HOME: '/host/home', PATH: '/trusted/bin', TERM: 'xterm-256color' },
    })
    expect(existsSync(dirname(script))).toBe(true)
    expect(f.tasks.active()).toBe(true)
    f.finish()
    await vi.waitFor(() => expect(f.tasks.active()).toBe(false))
    expect(existsSync(dirname(script))).toBe(false)
    expect(f.settings.invalidateConnectors).toHaveBeenCalledOnce()
  })
  it('updates the Host with its own release updater, the pi env and only the updater variables', async () => {
    const f = fixture(() => ({
      node: '/host/lib/versions/1.0.0/node/bin/node',
      bundle: '/host/lib/versions/1.0.0/lib/phosphor.mjs',
      env: { XDG_STATE_HOME: '/host/state' },
    }))
    expect(
      await f.tasks.execute({ type: 'machine.task', task: 'host.update' }, 'client', () => true),
    ).toEqual({ terminalId: 'private-pty' })
    expect(f.runner).toHaveBeenCalledWith(
      '/host/lib/versions/1.0.0/node/bin/node',
      ['/host/lib/versions/1.0.0/lib/phosphor.mjs', 'update'],
      {
        cwd: '/host/home',
        env: {
          HOME: '/host/home',
          PATH: '/trusted/bin',
          XDG_STATE_HOME: '/host/state',
          TERM: 'xterm-256color',
        },
      },
    )
    f.finish()
  })
  it('refuses a Host update where no release updater may run', async () => {
    for (const hostUpdater of [undefined, () => null]) {
      const f = fixture(hostUpdater)
      await expect(
        f.tasks.execute({ type: 'machine.task', task: 'host.update' }, 'client', () => true),
      ).rejects.toThrow('unavailable')
      expect(f.runner).not.toHaveBeenCalled()
    }
  })
  it('never executes a failed official installer download', async () => {
    const f = fixture()
    vi.mocked(which).mockResolvedValue('/trusted/curl-or-bash')
    vi.mocked(runPrintMode).mockResolvedValue({ stdout: '', error: 'network failure' })
    await expect(
      f.tasks.execute({ type: 'machine.task', task: 'claude.installCli' }, 'client', () => true),
    ).rejects.toThrow('unavailable')
    expect(f.runner).not.toHaveBeenCalled()
    const args = vi.mocked(runPrintMode).mock.calls[0]?.[1]
    expect(args).toContain('https://claude.ai/install.sh')
    expect(args).toContain('--proto-redir')
    expect(args).toContain('--max-filesize')
  })
})
