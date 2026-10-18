import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlContext } from '../command'
import { createIdentityStore, identityDirectory, type HostIdentity } from '../identity'
import { freshKey } from '../signer'
import {
  controlTransport,
  controlTransportState,
  hostId,
  serverView,
  timestamp,
  type ControlMode,
} from './machine-transport'

export { hostId, serverView, timestamp }
export const oldId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d01'
export const oldIdentity: HostIdentity = {
  version: 1,
  hostId: oldId,
  label: 'earlier',
  ownerLogin: 'me',
  controlUrl: 'https://example.com',
  savedAt: timestamp,
}

export async function controlMachine() {
  const root = await mkdtemp(join(tmpdir(), 'host-control-'))
  const configPath = join(root, 'conf', 'config.json')
  await mkdir(join(root, 'conf'), { mode: 0o700 })
  const config = {
    version: 1,
    pi: { executable: '/usr/bin/pi' },
    repositories: ['/srv/a'],
    control: { url: 'https://example.com' },
  }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const store = createIdentityStore(identityDirectory(configPath), process.getuid?.())
  const transport = controlTransportState(Date.parse(timestamp))
  const output: string[] = []
  const waits: number[] = []
  const abort = new AbortController()
  let onWait: (() => Promise<void> | void) | undefined
  const context: ControlContext = {
    configPath,
    uid: process.getuid?.(),
    hostname: 'bee1',
    platform: 'linux',
    arch: 'x64',
    store,
    signal: abort.signal,
    now: () => transport.clock,
    print: (line) => {
      output.push(line)
    },
    wait: async (ms) => {
      waits.push(ms)
      transport.clock += ms
      await onWait?.()
    },
    fetch: controlTransport(transport),
  }
  return {
    root,
    configPath,
    config,
    store,
    context,
    calls: transport.calls,
    output,
    waits,
    abort,
    setMode: (value: ControlMode) => {
      transport.mode = value
    },
    setFinalMode: (value: ControlMode) => {
      transport.finalMode = value
    },
    setAnswer: (value: unknown) => {
      transport.answer = value
    },
    setCreation: (value: Record<string, unknown>) => {
      transport.creation = value
    },
    onWait: (value: typeof onWait) => {
      onWait = value
    },
    polls: () => transport.polls,
    enrollOld: () => store.save(oldIdentity, freshKey()),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
export type ControlMachine = Awaited<ReturnType<typeof controlMachine>>
