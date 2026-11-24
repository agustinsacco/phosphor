import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Runtime from '../session/runtime'
import { socketHello, socketStream } from '../api/__fixtures__/local-client'
import { localCredential, writeLocalIdentity } from '../owner/__fixtures__/local-identity'
import { createLocalSocketStarter } from '../owner/socket'
import type { OpsAdapterPorts } from '../ops/adapter'
import { runHost } from './run'
import { localRunMachine } from './__fixtures__/run-local'

const hooks = vi.hoisted(() => ({
  machine: null as Omit<Runtime.HostMachine, 'log'> | null,
}))
vi.mock('./doctor', () => ({
  inspectHost: vi.fn(async () => ({ machine: hooks.machine, secrets: [] })),
}))

const folders: string[] = []
afterEach(async () => {
  hooks.machine = null
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

type Identity = Awaited<ReturnType<typeof writeLocalIdentity>>

/** Desktop on the socket: a fresh nonce and a signed owner credential. */
async function ownerConnection(path: string, local: Identity, now: () => number) {
  const { body } = await socketHello(path)
  const stream = socketStream(path)
  await stream.opened
  const nonce = (body as { nonce: string }).nonce
  const grant = localCredential(
    {
      kind: 'owner',
      machineId: local.machineId,
      client: local.ownerClient,
      nonce,
      iat: Math.floor(now() / 1000),
    },
    local.owner.privateKey,
  )
  stream.send({ type: 'auth', grant, challenge: 'c'.repeat(64) })
  await vi.waitFor(() => expect(stream.frames[0]).toMatchObject({ type: 'ready' }))
  return stream
}

it('binds the dispatcher once the lanes start: the socket announces ready.ops and answers ops.run', async () => {
  const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
  try {
    hooks.machine = host.machine
    const local = await writeLocalIdentity(
      dirname(host.control.configPath),
      host.control.context.uid,
    )
    const folder = await mkdtemp(join(tmpdir(), 'b1-'))
    folders.push(folder)
    const path = join(folder, 'run', 'phosphor.sock')
    const context = host.context()
    const ops: OpsAdapterPorts = {}
    const run = runHost({
      ...context,
      ops,
      startLocalSocket: createLocalSocketStarter(context, { candidates: [path], ops }),
    })
    await vi.waitFor(() => expect(ops.dispatcher).toBeDefined(), { timeout: 10_000 })
    // Connections made before the lanes started are closed with 1001; a new one gets ops.
    const owner = await vi.waitFor(
      async () => {
        const stream = await ownerConnection(path, local, context.now ?? Date.now)
        expect(stream.frames[0]).toMatchObject({ type: 'ready', ops: true, ownerLocal: true })
        return stream
      },
      { timeout: 10_000 },
    )
    owner.send({ type: 'call', id: 'who', method: 'ops.run', params: { op: 'whoami', args: {} } })
    await vi.waitFor(() => expect(owner.frames.some((f) => f.type === 'result')).toBe(true))
    expect(owner.frames.find((f) => f.type === 'result')).toMatchObject({
      ok: true,
      data: { status: 'ok', data: { principal: { kind: 'surface', via: 'owner' } } },
    })
    const shown = owner.frames.find((f) => f.type === 'result')
    expect(JSON.stringify(shown)).not.toContain('"caps"')
    await host.target()?.drain('SIGTERM')
    expect(await run).toBe(0)
  } finally {
    await host.cleanup()
  }
}, 30_000)
