import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { prepareStateDirectory } from '../lanes/state-dir'
import { createLocalDaemon, ReleaseRefused } from './run-local'
import { localRunMachine } from './__fixtures__/run-local'

const MODE = { version: 1, enabledAt: new Date(0).toISOString(), shellEnvironment: false } as const
const hosts: Awaited<ReturnType<typeof localRunMachine>>[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.cleanup()
})

describe('machine.owner release', () => {
  it('is refused while a lane runs, writes the marker once none does, and is a no-op in standby', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    hosts.push(host)
    prepareStateDirectory(host.state, host.control.context.uid)
    let live = 2
    const { daemon } = createLocalDaemon(host.context(), MODE, { liveLanes: () => live })
    const marker = join(host.state, HOST_SIDECARS.standby)

    await expect(daemon.release()).rejects.toThrow(ReleaseRefused)
    await expect(daemon.release()).rejects.toThrow("Stop this machine's 2 running lanes first.")
    expect(existsSync(marker)).toBe(false)
    expect(daemon.standby()).toBe(false)

    live = 0
    expect(await daemon.release()).toBe(true)
    expect(existsSync(marker)).toBe(true)
    expect(daemon.standby()).toBe(true)
    expect(await daemon.release()).toBe(false)
  })
})
