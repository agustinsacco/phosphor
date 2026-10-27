import { beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_RESOURCES } from '@phosphor/session-runtime/pi/package-resources'
import type { PiPackageEntry } from '@phosphor/shared/models'
import { HOST_DEFAULT_PACKAGES } from '@phosphor/shared/host-default-packages'
import { loadHostConfig } from '../config/load'
import { installDefaultPackages } from './default-packages'
vi.mock('../config/load', () => ({ loadHostConfig: vi.fn() }))
const installed: PiPackageEntry[] = []
const packages = vi.fn(async () => installed)
const run = vi.fn(async () => 0)
const confirm = vi.fn(async () => true)
const context = {
  configPath: '/host.json',
  uid: 1000,
  env: { HOME: '/home/host', PI_CODING_AGENT_DIR: '/private/pi' },
  platform: 'linux' as const,
  home: '/home/host',
  print: vi.fn(),
  packages,
  setupTerminal: { confirm, run },
}
beforeEach(() => {
  vi.clearAllMocks()
  installed.length = 0
  confirm.mockResolvedValue(true)
  run.mockResolvedValue(0)
  vi.mocked(loadHostConfig).mockResolvedValue({
    ok: true,
    path: '/host.json',
    config: {
      version: 1,
      pi: { executable: '/trusted/pi.js', node: '/trusted/node' },
      repositories: [],
    },
  })
})
it('provisions all headless-safe defaults through the configured pi with explicit consent', async () => {
  await installDefaultPackages(context)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(packages).toHaveBeenCalledWith(undefined, '/private/pi')
  expect(run.mock.calls).toEqual(
    HOST_DEFAULT_PACKAGES.map((p) => ['/trusted/node', ['/trusted/pi.js', 'install', p.spec]]),
  )
  expect(JSON.stringify(run.mock.calls)).not.toMatch(/computer-use|logout|auth/)
})
it('is idempotent and leaves installed package versions and resource filters alone', async () => {
  installed.push(
    ...HOST_DEFAULT_PACKAGES.map((p) => ({
      name: p.name,
      spec: `${p.spec}@1.2.3`,
      scope: 'global' as const,
      kind: 'npm' as const,
      filtered: true,
      installed: true,
      resources: EMPTY_RESOURCES,
    })),
  )
  await installDefaultPackages(context)
  expect(confirm).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
it('repairs a missing installation at its existing pinned version, without touching other packages', async () => {
  installed.push(
    ...HOST_DEFAULT_PACKAGES.map((p) => ({
      name: p.name,
      spec: `${p.spec}@1.2.3`,
      scope: 'global' as const,
      kind: 'npm' as const,
      filtered: false,
      installed: p.name !== 'pi-subagents',
      resources: EMPTY_RESOURCES,
    })),
  )
  await installDefaultPackages(context)
  expect(run).toHaveBeenCalledExactlyOnceWith('/trusted/node', [
    '/trusted/pi.js',
    'install',
    'npm:pi-subagents@1.2.3',
  ])
})
it('does not run anything when consent is declined', async () => {
  confirm.mockResolvedValue(false)
  await installDefaultPackages(context)
  expect(run).not.toHaveBeenCalled()
  expect(context.print).toHaveBeenCalledWith(expect.stringContaining('skipped'))
})
it('surfaces an installation failure and stops before attempting subsequent packages', async () => {
  run.mockResolvedValue(1)
  await expect(installDefaultPackages(context)).rejects.toThrow(
    'Retry: pi install npm:@saccolabs/pi-claude-cli',
  )
  expect(run).toHaveBeenCalledTimes(1)
})
it('stops on cancellation without invoking pi', async () => {
  const signal = AbortSignal.abort()
  await expect(installDefaultPackages({ ...context, signal })).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
})
