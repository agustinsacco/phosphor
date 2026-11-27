import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { answerFor } from '@phosphor/brain-runtime/__fixtures__/pipeline'
import { LANE_ENTRIES } from '@phosphor/brain-runtime/__fixtures__/lane'
import type { ModelCallInput } from '@phosphor/brain-runtime/model-call'
import { inProcessSearch } from '@phosphor/brain-runtime/search/in-process'
import { createHostConnection } from '@phosphor/host-client/connection'
import { hostBrain } from '@phosphor/host-client/brain'
import { opsRun } from '@phosphor/host-client/ops'
import { openBrainSearch } from '@phosphor/memory-engine/search'
import { fetchSocketHello, openLocalSocket } from '@phosphor/session-runtime/host-local/transport'
import { nodeIdentity } from '@phosphor/session-runtime/pi/node-identity'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { BRAIN_ACCESS } from '@phosphor/shared/brain-access'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import {
  BRAIN_APPROVAL,
  BRAIN_SURFACE,
  type HostBrainMap,
  type HostBrainMethod,
} from '@phosphor/shared/host-brain'
import type { HostBrainRequest } from '@phosphor/shared/host-brain-request'
import {
  HOST_SIDECARS,
  LOCAL_LIMITS,
  hostConfigDirectory,
  hostStateDirectory,
  localEndpoint,
  localGrantIssueResponse,
} from '@phosphor/shared/host-local'
import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type * as RunBrain from '../brain/run'
import {
  ACTIVE,
  BEGIN,
  PINNED_MODEL,
  stageBrain,
} from '../brain-handover/__fixtures__/staged-brain'
import { hostBrainAdmission } from '../brain-handover/gate'
import { createBrainHandoverHandlers } from '../brain-handover/handlers'
import { handoverPaths, readHandover } from '../brain-handover/layout'
import { publishSealed } from '../brain-handover/publish'
import { runCli, type CliContext } from '../cli'
import { writeSidecar } from '../config/sidecar'
import { createLocalSocketStarter, localSocketPaths } from '../owner/socket'
import { localCredential, writeLocalIdentity } from '../owner/__fixtures__/local-identity'
import { selectLocalBrainOwner } from '@phosphor/session-runtime/brain/local-owner'
import { HOST_BRAIN_OFF_GENERATION } from '../brain/surface-runtime'
import type { HostMachine } from '../session/runtime'
import type { Drainable } from '../shutdown'
import { runHost, type RunContext } from './run'

const hooks = vi.hoisted(() => ({
  machine: null as Omit<HostMachine, 'log'> | null,
  reader: undefined as RunBrain.RunBrainPorts['runModelCall'],
}))
vi.mock('./doctor', () => ({
  inspectHost: async () => ({ machine: hooks.machine, secrets: [] }),
}))

// Substitute only the offline qualification/model ports. The run machine still owns the
// real runtime, search/service lifecycle, surface binding and Unix listener.
vi.mock('../brain/run', async (original) => {
  const native = await original<typeof RunBrain>()
  return {
    ...native,
    qualifiedRunBrain(
      resourceRoot: string,
      ports: Parameters<typeof RunBrain.qualifiedRunBrain>[1],
    ) {
      if (!hooks.reader) return native.qualifiedRunBrain(resourceRoot, ports)
      return native.createRunBrain({
        ...ports,
        resourceRoot,
        packaged: { searchWorker: '/unused/search.js', embeddingWorker: '/unused/embedding.js' },
        runModelCall: hooks.reader,
        openSearch: inProcessSearch((path) => openBrainSearch({ path, Database: DatabaseSync })),
        embeddings: () => ({
          status: () => ({
            phase: 'ready',
            receivedBytes: 0,
            totalBytes: 0,
            modelId: 'offline',
            dimensions: 768,
          }),
          setEnabled: async () => {},
          download: async () => {},
          remove: async () => {},
          embed: async (texts) => texts.map(() => [1, ...Array<number>(767).fill(0)]),
          dispose() {},
        }),
      })
    },
  }
})

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  try {
    const errors: unknown[] = []
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Scratch Host teardown failed')
  } finally {
    hooks.machine = null
    hooks.reader = undefined
    vi.unstubAllEnvs()
  }
})

/** Every home, config, state and provider folder the Host may read lives under `root`. */
function scratchEnvironment(root: string) {
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'cfg'),
    XDG_STATE_HOME: join(root, 'state'),
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    PATH: dirname(process.execPath),
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.stubEnv('TMPDIR', root)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PI_CLAUDE_CLI_STATE_DIR', join(root, 'claude-state'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'))
  return env
}

async function scratchHost(selectedOwner?: 'host') {
  // Keep the state-derived socket within sun_path without falling back to a shared run folder.
  const root = await realpath(await mkdtemp('/tmp/hb-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = scratchEnvironment(root)
  const agentDir = env.PI_CODING_AGENT_DIR
  const cli: CliContext = {
    env,
    uid: process.getuid?.(),
    home: root,
    platform: process.platform,
    hostname: 'Harbor',
    nodeVersion: process.versions.node,
    defaultResourceRoot: join(root, 'resources'),
  }
  const artifactSkill = join(cli.defaultResourceRoot, 'skills/visual-artifacts')
  await mkdir(artifactSkill, { recursive: true })
  await writeFile(join(artifactSkill, 'SKILL.md'), '# Offline fixture\n')
  // The bundle's Brain Agent tool guard; the fake pi lists its command once loaded with it.
  await mkdir(join(cli.defaultResourceRoot, 'brain-ext'), { recursive: true })
  await writeFile(join(cli.defaultResourceRoot, 'brain-ext/brain-agent-guard.mjs'), '// fixture\n')
  const configs = hostConfigDirectory(env, root)
  const configPath = join(configs, 'config.json')
  const repository = join(root, 'Harbor')
  await mkdir(configs, { recursive: true, mode: 0o700 })
  await mkdir(repository)
  await mkdir(agentDir)
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      repositories: [repository],
      pi: { executable: process.execPath },
      control: { url: 'https://example.com' },
    }),
    { mode: 0o600 },
  )
  const identity = await writeLocalIdentity(configs, cli.uid)
  writeSidecar(
    configs,
    HOST_SIDECARS.localMode,
    { version: 1, enabledAt: new Date(0).toISOString(), shellEnvironment: false },
    { uid: cli.uid, known: [] },
  )
  hooks.machine = {
    pi: {
      binaryPath: process.execPath,
      prefixArgs: [join(import.meta.dirname, '../__fixtures__/fake-pi.cjs')],
    },
    env,
    roots: [repository],
    resourceRoot: cli.defaultResourceRoot,
    contextBudget: '',
  }
  if (selectedOwner) {
    // These scenarios start after This Mac selected its Host. Keep the admission fence real.
    const state = hostStateDirectory(env, root)
    await mkdir(state, { recursive: true, mode: 0o700 })
    expect(selectLocalBrainOwner(state, selectedOwner)).toBe(true)
  }
  const path = localSocketPaths(cli)[0]!
  return {
    root,
    cli,
    identity,
    path,
    repository,
    agentDir,
    start: () => start(cli, configPath, path),
  }
}

async function start(cli: CliContext, configPath: string, path: string) {
  let drain: Drainable | undefined
  const output: string[] = []
  const context: RunContext = {
    ...cli,
    configPath,
    arch: process.arch,
    // Use real credentials only for the ephemeral local keys above. No Control or network I/O.
    fetch: async () => {
      throw new Error('Unexpected Control request')
    },
    attach: (target) => {
      drain = target
      return () => {
        drain = undefined
      }
    },
    print: (line) => output.push(line),
  }
  let serving = false
  const starter = createLocalSocketStarter(context, { candidates: [path] })
  const running = runHost({
    ...context,
    startLocalSocket: async (daemon, store) => {
      const socket = await starter(daemon, store)
      return {
        ...socket,
        serveLanes(lanes) {
          const active = socket.serveLanes!(lanes)
          serving = true
          return active
        },
      }
    },
  })
  const stop = async () => {
    await drain?.drain('SIGTERM')
    return running
  }
  cleanup.push(stop)
  await Promise.race([
    vi.waitFor(() => expect(serving).toBe(true), { timeout: 5000 }),
    running.then((code) => {
      throw new Error(`Host stopped before serving: ${code}\n${output.join('\n')}`)
    }),
  ])
  return { stop }
}

function call(cli: CliContext, args: string[]) {
  const stdout = vi.fn<(text: string) => void>()
  const stderr = vi.fn<(text: string) => void>()
  const exit = runCli(['brain', ...args, '--host', 'local', '--json'], { stdout, stderr }, cli)
  return { stdout, stderr, exit }
}

it.skipIf(process.platform === 'win32')(
  'distinguishes a serving socket without Brain from an unconfirmed operation',
  async () => {
    const host = await scratchHost()
    await host.start()
    const status = call(host.cli, ['status'])
    expect(await status.exit).toBe(1)
    expect(status.stdout).not.toHaveBeenCalled()
    expect(status.stderr).toHaveBeenCalledExactlyOnceWith(
      'The local Host is not serving Brain. No other Host was contacted.\n',
    )
  },
)

type ScratchHost = Awaited<ReturnType<typeof scratchHost>>

/** The same typed client used by the page, with either signed owner or unsigned local auth. */
async function connect(host: ScratchHost, owner: boolean, clientId = randomUUID()) {
  const { path, identity } = host
  const hostId = identity.machineId
  const endpoint = localEndpoint(hostId)
  const conn = createHostConnection({
    identity: nodeIdentity,
    hostId,
    endpoint,
    local: true,
    lanes: owner,
    endpointAllowed: (value) => value === endpoint,
    socket: () => openLocalSocket(path),
    changed: () => {},
    clearGrant: () => {},
    grant: async () => {
      const now = Date.now()
      const { nonce } = await fetchSocketHello(path, nodeIdentity.randomHex(32))
      return localGrantIssueResponse({
        machineId: hostId,
        credential: localCredential(
          {
            kind: owner ? 'owner' : 'local',
            machineId: hostId,
            nonce,
            client: owner ? identity.ownerClient : { id: clientId, label: 'Phosphor command line' },
          },
          owner ? identity.owner.privateKey : undefined,
        ),
        publicKey: identity.machine.raw,
        expiresAt: new Date(now + LOCAL_LIMITS.grantTtlSec * 1000).toISOString(),
      })
    },
  })
  cleanup.push(conn.close)
  await vi.waitFor(() =>
    expect(conn.snapshot()).toMatchObject({
      state: 'ready',
      brain: true,
      ownerLocal: owner,
      brainAccess: owner ? BRAIN_ACCESS : [],
    }),
  )
  const page = hostBrain((id) => (id === hostId ? conn : undefined))
  const target = { hostId, connectionToken: conn.snapshot().connectionToken }
  return {
    conn,
    clientId,
    invoke: <K extends HostBrainMethod>(request: HostBrainRequest<K>) =>
      page.invoke(target, request),
    list: () => page.listApprovals(hostId),
    answer: (id: string, approved: boolean) => page.answerApproval(hostId, id, approved),
    wire: (request: OpsRunRequest, write = false) => opsRun(conn, request, { write }),
  }
}

type Surface = Awaited<ReturnType<typeof connect>>

async function approvedCli(owner: Surface, host: ScratchHost, args: string[]) {
  const cli = call(host.cli, args)
  const approval = await vi.waitFor(async () => {
    const list = await owner.list()
    expect(list).toHaveLength(1)
    expect(cli.stderr.mock.calls[0]?.[0]).toContain(list[0]!.confirmId.slice(0, 8))
    return list[0]!
  })
  expect(cli.stdout).not.toHaveBeenCalled()
  await owner.answer(approval.confirmId, true)
  return {
    code: await cli.exit,
    lines: cli.stdout.mock.calls,
    errors: cli.stderr.mock.calls.flat().join(''),
  }
}

async function json<K extends HostBrainMethod>(
  owner: Surface,
  host: ScratchHost,
  _method: K,
  args: string[],
) {
  const result = await approvedCli(owner, host, args)
  expect(result.code, result.errors).toBe(0)
  expect(result.lines).toHaveLength(1)
  return JSON.parse(result.lines[0]![0]) as HostBrainMap[K]['result']
}

const args = (...values: unknown[]) => ['--args', JSON.stringify(values)]
const stamp = ({ generation, revision }: { generation: string; revision: number }) => [
  '--expected',
  `${generation}:${revision}`,
]
const statusRequest = { op: BRAIN_SURFACE, args: { method: 'brain:status', args: [] } }
function confirmOf(result: OpsRunResult) {
  if (result.status !== 'confirm') throw new Error(`Expected approval, got ${result.status}`)
  return { confirmId: result.confirmId, digest: result.digest }
}

async function seedHarbor(host: ScratchHost) {
  const dir = sessionDirForCwd(host.repository, join(host.agentDir, 'sessions'))
  await mkdir(dir, { recursive: true })
  const sessionId = randomUUID()
  const entries = LANE_ENTRIES.map((entry) =>
    entry.type === 'session' ? { ...entry, cwd: host.repository, id: sessionId } : entry,
  )
  await writeFile(
    join(dir, `2026-11-06T12-47-00-000Z_${sessionId}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  )
}

function useOfflineReader() {
  const read = vi.fn(async (input: ModelCallInput) => ({
    text: answerFor(input),
    usage: { tokens: 10, cost: 0 },
  }))
  hooks.reader = read
  return read
}

it.skipIf(process.platform === 'win32')(
  'scopes approved operations to the original socket and spends them once',
  async () => {
    const host = await scratchHost('host')
    useOfflineReader()
    const run = await host.start()
    const owner = await connect(host, true)
    const local = await connect(host, false)
    const other = await connect(host, false, local.clientId)
    await expect(local.invoke({ method: 'brain:status', args: [] })).rejects.toMatchObject({
      code: 'forbidden',
    })
    const ref = confirmOf(await local.wire(statusRequest))
    const redeem = { ...statusRequest, confirm: ref }
    expect(await local.wire(redeem)).toMatchObject({ status: 'denied' })
    expect(
      await other.wire(
        { op: BRAIN_APPROVAL, args: { action: 'answer', id: ref.confirmId, approved: true } },
        true,
      ),
    ).toMatchObject({ status: 'denied', code: 'forbidden' })
    await owner.answer(ref.confirmId, true)
    expect(await other.wire(redeem)).toMatchObject({ status: 'denied' })
    expect(
      await local.wire({ ...redeem, args: { method: 'brain:prefs', args: [] } }),
    ).toMatchObject({ status: 'denied' })
    expect(await local.wire(redeem)).toMatchObject({
      status: 'ok',
      data: { prefs: { enabled: false } },
    })
    expect(await local.wire(redeem)).toMatchObject({ status: 'denied' })

    const preRestart = confirmOf(await local.wire(statusRequest))
    await owner.answer(preRestart.confirmId, true)
    // Close the clients first: there is no live CLI connection across a Host restart.
    for (const surface of [owner, local, other]) surface.conn.close()
    expect(await run.stop()).toBe(0)
    await host.start()
    const again = await connect(host, false, local.clientId)
    expect(await again.wire({ ...statusRequest, confirm: preRestart })).toMatchObject({
      status: 'denied',
    })
  },
  30_000,
)

it.skipIf(process.platform === 'win32')(
  'reads Harbor, recalls its relationship across restart and undoes the saved read through the CLI',
  async () => {
    const host = await scratchHost('host')
    const reader = useOfflineReader()
    await seedHarbor(host)
    const run = await host.start()
    const owner = await connect(host, true)
    const lane = await vi.waitFor(() => {
      expect(owner.conn.snapshot().lanes).toHaveLength(1)
      return owner.conn.snapshot().lanes[0]!
    })
    const off = await json(owner, host, 'brain:status', ['status'])
    expect(off).toMatchObject({
      generation: HOST_BRAIN_OFF_GENERATION,
      revision: 0,
      prefs: { enabled: false },
    })
    await expect(
      access(join(hostStateDirectory(host.cli.env, host.root), 'brain')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const enabled = await json(owner, host, 'brain:setPrefs', [
      'set-prefs',
      ...stamp(off),
      ...args({ ...DEFAULT_BRAIN_PREFS, enabled: true, agentAuto: false }),
    ])
    expect(enabled.prefs.enabled).toBe(true)
    await json(owner, host, 'brain:queue', ['queue', ...stamp(enabled), ...args(lane.laneId)])
    const saved = await vi.waitFor(
      async () => {
        const state = await owner.invoke({ method: 'brain:laneState', args: [lane.laneId] })
        expect(state).toMatchObject({ activeJob: null, lastRead: { memories: 1 } })
        return state.lastRead!
      },
      { timeout: 5000 },
    )
    expect(reader).toHaveBeenCalled()
    const recall = await json(owner, host, 'brain:ask', [
      'ask',
      ...args('Rina Okafor owns Harbor billing'),
    ])
    expect(recall.hits[0]?.memory.summary).toBe('Rina Okafor owns Harbor billing.')
    const person = recall.entities.find((entry) => entry.label === 'Rina Okafor')!
    const project = recall.entities.find((entry) => entry.label === 'Harbor')!
    const pathArgs = ['path', ...args(person.id, project.id)]
    const relation = await json(owner, host, 'brain:path', pathArgs)
    expect(relation.routes[0]).toEqual([
      expect.objectContaining({
        kind: 'relation',
        link: expect.objectContaining({ predicate: 'owns' }),
      }),
    ])
    const change = (
      await json(owner, host, 'brain:tidyChanges', ['changes', ...args(10)])
    ).items.find((item) => item.kind === 'read' && item.jobId === saved.jobId)
    expect(change).toMatchObject({ undoable: true })
    const calls = reader.mock.calls.length
    const epoch = owner.conn.incarnation().runtimeEpoch
    owner.conn.close()
    expect(await run.stop()).toBe(0)
    await host.start()
    const restarted = await connect(host, true)
    expect(restarted.conn.incarnation().runtimeEpoch).not.toBe(epoch)
    expect(await json(restarted, host, 'brain:path', pathArgs)).toEqual(relation)
    const before = await json(restarted, host, 'brain:status', ['status'])
    expect(before).toMatchObject({ generation: enabled.generation, counts: { memories: 1 } })
    expect(reader).toHaveBeenCalledTimes(calls)
    const undo = ['undo', ...stamp(before), ...args(change!.id, before.revision)]
    expect(await json(restarted, host, 'brain:tidyUndo', undo)).toMatchObject({
      counts: { memories: 0 },
    })
    const stale = await approvedCli(restarted, host, undo)
    expect(stale).toMatchObject({ code: 1, lines: [] })
    expect(stale.errors).toContain('Brain changed. Reload this Host before trying again.')
    expect((await restarted.invoke({ method: 'brain:ask', args: ['Rina Okafor'] })).hits).toEqual(
      [],
    )
  },
  60_000,
)

it.skipIf(process.platform === 'win32')(
  'refuses messages to the reserved Brain Agent before pi starts and shares its page with the approved CLI',
  async () => {
    const host = await scratchHost('host')
    useOfflineReader()
    await host.start()
    const owner = await connect(host, true)
    const local = await connect(host, false)
    const off = await owner.invoke({ method: 'brain:status', args: [] })
    await owner.invoke({
      method: 'brain:setPrefs',
      args: [{ ...DEFAULT_BRAIN_PREFS, enabled: true, agentAuto: false }],
      expected: { generation: off.generation, revision: off.revision },
    })
    await expect(local.invoke({ method: 'brain:laneShow', args: [] })).rejects.toMatchObject({
      code: 'forbidden',
    })

    const show = () => owner.invoke({ method: 'brain:laneShow', args: [] })
    const page = await show()
    // No interactive launch qualifies in production: a person's message is refused before pi
    // starts, control changes or a transcript binds, and the saved page stays readable.
    expect(page).toMatchObject({
      controller: null,
      running: false,
      turn: null,
      messaging: false,
      entries: [],
      dialogs: [],
    })
    await expect(
      owner.invoke({ method: 'brain:tell', args: ['Who owns Harbor? PHX-Harbor'] }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      owner.invoke({ method: 'brain:laneSend', args: ['PHX-Northwind', page.fence] }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    const send = await approvedCli(owner, host, ['lane', 'send', ...args('PHX-Ledger', page.fence)])
    expect(send).toMatchObject({ code: 1, lines: [] })
    expect(send.errors).toContain('Brain is temporarily unavailable on this Host.')
    expect(await json(owner, host, 'brain:laneWatch', ['lane', 'watch'])).toEqual(page)
    // No transcript and no binding: pi never started on the reserved lane.
    const brainDir = join(hostStateDirectory(host.cli.env, host.root), 'brain')
    const bound = join(brainDir, 'agent-lane.json')
    if (existsSync(bound))
      expect(JSON.parse(await readFile(bound, 'utf8'))).toMatchObject({ sessionFile: null })
    const transcripts = await readdir(join(host.agentDir, 'sessions')).catch(() => [])
    expect(transcripts.filter((name) => name.includes('Brain'))).toEqual([])
    // Control is separate from messaging and still changes by the fence.
    await owner.invoke({ method: 'brain:laneTake', args: [page.fence] })
    expect(await show()).toMatchObject({ controller: { self: true }, fence: page.fence + 1 })
    expect(owner.conn.snapshot().lanes).toEqual([])
  },
  30_000,
)

it.skipIf(process.platform === 'win32')(
  'finishes a Desktop move that published before the Host stopped, with no Desktop call',
  async () => {
    const host = await scratchHost()
    useOfflineReader()
    const stateDir = hostStateDirectory(host.cli.env, host.root)
    const id = randomUUID()
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const desktop = createBrainHandoverHandlers({
      stateDir,
      uid: host.cli.uid,
      laneForSessionFile: () => false,
      readerReadiness: () => Promise.resolve('qualified'),
      embeddingModel: PINNED_MODEL,
      probeModel: () => Promise.resolve(true),
      importAgentTranscripts: () => Promise.reject(new Error('The Host stopped first.')),
    })
    const { staging } = await desktop['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })
    const files = stageBrain(staging)
    await desktop['owner.brainHandover.verify']({
      migrationId: id,
      files,
      activeTranscript: ACTIVE,
    })
    const verified = readHandover(stateDir, id)!
    await publishSealed(stateDir, verified)
    // The Host stopped after the rename, before its record: the marker alone says published.
    await writeFile(handoverPaths(stateDir, id).record, JSON.stringify(verified))

    await host.start()
    const paths = handoverPaths(stateDir, id)
    expect(readHandover(stateDir, id)?.state).toBe('committed')
    expect(hostBrainAdmission(stateDir)).toEqual({ state: 'imported', migrationId: id })
    const laneFolder = await realpath(join(paths.target, 'Brain'))
    const bound = join(
      sessionDirForCwd(laneFolder, join(host.agentDir, 'sessions')),
      'brain-agent-1.jsonl',
    )
    const binding = JSON.parse(await readFile(join(paths.target, 'agent-lane.json'), 'utf8')) as {
      sessionFile: string
    }
    expect(binding.sessionFile).toBe(bound)
    expect(JSON.parse((await readFile(bound, 'utf8')).split('\n')[0]!)).toMatchObject({
      id: 'brain-agent-1',
      cwd: laneFolder,
    })
    for (const leftover of [paths.claim, paths.stage, paths.sealed])
      await expect(access(leftover)).rejects.toMatchObject({ code: 'ENOENT' })
  },
  30_000,
)
