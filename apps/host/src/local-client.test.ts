import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_SIDECARS, hostConfigDirectory, hostStateDirectory } from '@phosphor/shared/host-local'
import { parseOpArgv } from '@phosphor/shared/ops-cli'
import { createHarness } from '@phosphor/session-runtime/ops/__fixtures__/dispatcher-harness'
import { createOpsDispatcher } from '@phosphor/session-runtime/ops/dispatcher'
import { runCli, type CliContext } from './cli'
import { startLocalServer } from './api/local-server'
import { writeSidecar } from './config/sidecar'
import { writeLocalIdentity } from './owner/__fixtures__/local-identity'
import { hostLinks } from './api/server'

let home: string
let context: CliContext
let server: Awaited<ReturnType<typeof startLocalServer>> | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'l1-'))
  context = {
    home,
    hostname: 'test',
    nodeVersion: process.versions.node,
    defaultResourceRoot: join(home, 'resources'),
    uid: process.getuid?.(),
    platform: 'linux',
    env: {
      XDG_RUNTIME_DIR: home,
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CONFIG_HOME: join(home, 'config'),
      PI_SESSION_ID: 's1',
    },
  }
})
afterEach(async () => {
  try {
    await server?.stop()
  } finally {
    server = undefined
    await rm(home, { recursive: true, force: true })
  }
})
async function cli(argv: string[]) {
  const io = { stdout: vi.fn(), stderr: vi.fn() }
  const code = await runCli(argv, io, context)
  return {
    code,
    out: io.stdout.mock.calls.flat().join(''),
    err: io.stderr.mock.calls.flat().join(''),
  }
}

it('explains how to run ops on a headless Host without opening TCP', async () => {
  const { code, err } = await cli(['lanes'])
  expect(code).toBe(1)
  expect(err).toContain('phosphor tool in a lane on that Host')
})

async function serve() {
  const { uid, env } = context
  const config = hostConfigDirectory(env, home),
    state = hostStateDirectory(env, home)
  for (const dir of [config, state]) await mkdir(dir, { recursive: true, mode: 0o700 })
  const { machineId, machine } = await writeLocalIdentity(config, uid)
  const remote = {
    run: vi.fn(async () => ({ status: 'ok', text: 'remote answer', applies: 'now' }) as const),
  }
  const h = createHarness({ remote })
  const dispatcher = createOpsDispatcher(h.binding, {
    ...h.deps,
    parseArgv: (argv, content) => parseOpArgv(argv, undefined, { content }),
  })
  const path = join(home, 'phosphor-host/phosphor.sock')
  server = await startLocalServer({
    candidates: [path],
    uid,
    hostVersion: '1.0.0',
    auth: {
      machineId,
      key: machine.privateKey,
      ownerClients: () => null,
      readyFlags: () => new Set(['ops']),
    },
    links: hostLinks({ dispatcher }),
  })
  writeSidecar(
    state,
    HOST_SIDECARS.localRun,
    {
      version: 1,
      pid: process.pid,
      hostVersion: '1.0.0',
      machineId,
      socket: path,
      startedAt: 1,
      localReadyAt: 1,
    },
    { uid, known: [] },
  )
  return { h, remote }
}

it('uses an unattested local credential; the daemon parses aliases, flags and host selectors', async () => {
  const { h, remote } = await serve()
  const read = await cli(['lanes', '--folder', 'repo', '--json'])
  expect(read.code, read.err + read.out).toBe(0)
  expect(JSON.parse(read.out)).toMatchObject({ status: 'ok', text: 'lane.list done' })
  expect(h.calls.handled[0]).toMatchObject({
    op: 'lane.list',
    args: { folder: 'repo' },
    ctx: { principal: { kind: 'local', lane: 's1' } },
  })
  expect(await cli(['swarm', 'on'])).toEqual({
    code: 1,
    err: 'Use the phosphor tool for this lane.\n',
    out: '',
  })
  expect(await cli(['lanes', '--host', 'bee'])).toEqual({
    code: 0,
    err: '',
    out: 'remote answer\n',
  })
  expect(remote.run).toHaveBeenCalledWith(
    'bee',
    expect.objectContaining({ op: 'lane.list', actor: { kind: 'agent', lane: 's1' } }),
  )
})
