import { verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { helloProofMessage } from '@phosphor/shared/host-protocol'
import type * as Runtime from '../session/runtime'
import { socketHello } from '../api/__fixtures__/local-client'
import { writeLocalIdentity } from '../owner/__fixtures__/local-identity'
import { createLocalSocketStarter } from '../owner/socket'
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

/** A short temporary socket path: never the real state folder or `/tmp/phosphor-<uid>`. */
async function socketPath() {
  const folder = await mkdtemp(join(tmpdir(), 'd3-'))
  folders.push(folder)
  return join(folder, 'run', 'phosphor.sock')
}

describe('run with the local-mode marker serves the owner socket', () => {
  it('R1: a marker without a control identity serves the socket and writes local.json', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      const local = await writeLocalIdentity(
        dirname(host.control.configPath),
        host.control.context.uid,
      )
      const path = await socketPath()
      const context = host.context()
      const run = runHost({
        ...context,
        startLocalSocket: createLocalSocketStarter(context, { candidates: [path] }),
      })
      await vi.waitFor(
        () => expect(existsSync(join(host.state, HOST_SIDECARS.localRun))).toBe(true),
        {
          timeout: 10_000,
        },
      )
      const runFile: unknown = JSON.parse(
        await readFile(join(host.state, HOST_SIDECARS.localRun), 'utf8'),
      )
      expect(runFile).toMatchObject({
        version: 1,
        machineId: local.machineId,
        socket: path,
        pid: process.pid,
      })
      const answer = await socketHello(path)
      expect(answer.status).toBe(200)
      const body = answer.body as {
        hello: { hostId: string; runtimeEpoch: string }
        proof: string
        nonce: string
      }
      expect(body.hello.hostId).toBe(local.machineId)
      expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
      expect(
        verify(
          null,
          Buffer.from(
            helloProofMessage(local.machineId, body.hello.runtimeEpoch, answer.challenge),
          ),
          local.machine.publicKey,
          Buffer.from(body.proof, 'base64url'),
        ),
      ).toBe(true)
      expect(host.beats).toEqual([])
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
      expect(existsSync(path)).toBe(false)
    } finally {
      await host.cleanup()
    }
  }, 30_000)
})
