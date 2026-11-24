import { expect, it, vi } from 'vitest'
import { startInstalledService } from './start-service'

it('starts only, with no install, restart or force, on an existing user job', async () => {
  const run = vi.fn(async () => {})
  const names = { agent: 'com.example.test', unit: 'example-test.service' }
  await startInstalledService('darwin', 42, run, names)
  await startInstalledService('linux', 42, run, names)
  await expect(startInstalledService('darwin', undefined, run, names)).rejects.toThrow()
  expect(run.mock.calls).toEqual([
    ['/bin/launchctl', ['kickstart', 'gui/42/com.example.test']],
    ['/usr/bin/systemctl', ['--user', 'start', 'example-test.service']],
  ])
})
