import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { BUNDLED_EXTENSION_FILES } from '../bundled-extensions'
import { prepareSessionLaunch, type SessionLaunchRuntime } from './session-launch'

vi.mock('electron', () => {
  throw new Error('Launch preparation imported Electron')
})
function ports() {
  return {
    resolveExecutable: vi.fn<SessionLaunchRuntime['resolveExecutable']>().mockResolvedValue({
      binaryPath: '/tools/node',
      prefixArgs: ['/tools/pi.js'],
      stub: false,
    }),
    readEnvironment: vi.fn(async () => ({ PATH: '/tools', CONFIG: 'host-local' })),
    resourceRoot: vi.fn(() => '/host/resources'),
  }
}

it('preserves executable, prefix arguments, environment and extension paths', async () => {
  const runtime = ports()
  const executable = { binaryPath: '/tools/node', prefixArgs: ['/tools/pi.js'], stub: false }
  const launch = await prepareSessionLaunch(runtime)
  expect(launch).toEqual({
    ...executable,
    env: { PATH: '/tools', CONFIG: 'host-local' },
    extensions: BUNDLED_EXTENSION_FILES.map((file) => join('/host/resources', 'pi-ext', file)),
  })
  expect(runtime.readEnvironment).toHaveBeenCalledExactlyOnceWith(executable)
})

it('reads dependencies anew and does not share mutable launch environments', async () => {
  const runtime = ports()
  const cachedEnv = { PATH: '/tools', CONFIG: 'host-local' }
  runtime.readEnvironment.mockResolvedValue(cachedEnv)
  const first = await prepareSessionLaunch(runtime)
  first.env.ACCOUNT = 'first-session-only'
  runtime.resourceRoot.mockReturnValue('/new/resources')
  const second = await prepareSessionLaunch(runtime)
  expect(second.env).not.toHaveProperty('ACCOUNT')
  expect(cachedEnv).not.toHaveProperty('ACCOUNT')
  expect(second.extensions[0]).toBe(join('/new/resources', 'pi-ext', 'artifacts.ts'))
  expect(runtime.resolveExecutable).toHaveBeenCalledTimes(2)
  expect(runtime.readEnvironment).toHaveBeenCalledTimes(2)
})

it('does not read environment/resources when executable discovery fails', async () => {
  const runtime = ports()
  runtime.resolveExecutable.mockRejectedValue(new Error('Unavailable'))
  await expect(prepareSessionLaunch(runtime)).rejects.toThrow('Unavailable')
  expect(runtime.readEnvironment).not.toHaveBeenCalled()
  expect(runtime.resourceRoot).not.toHaveBeenCalled()
})

it('propagates environment failures without resolving resources', async () => {
  const runtime = ports()
  runtime.readEnvironment.mockRejectedValue(new Error('Environment failed'))
  await expect(prepareSessionLaunch(runtime)).rejects.toThrow('Environment failed')
  expect(runtime.resourceRoot).not.toHaveBeenCalled()
})
