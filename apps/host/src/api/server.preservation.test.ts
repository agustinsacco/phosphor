import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { expect, it, vi } from 'vitest'
import { encodeGrant } from '@phosphor/shared/host-grant'
import { parseHostFrame } from '@phosphor/shared/host-protocol'
import { newRoutine } from '@phosphor/shared/routines'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { piSessionsRoot, sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { fakeMachine, EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { controlMachine, hostId, oldId } from '../control/__fixtures__/machine'
import { hostStateDirectory } from '../lanes/state-dir'
import { openStore } from '../lanes/store'
import type { HostMachine } from '../session/runtime'
import type { Drainable } from '../shutdown'
import { runLogin } from '../commands/login'
import { runSetup } from '../commands/setup'
import { runHost } from '../commands/run'

const hooks = vi.hoisted(
  (): {
    machine?: Omit<HostMachine, 'log'>
  } => ({}),
)
vi.mock('../commands/doctor', () => ({
  inspectHost: async () => ({ machine: hooks.machine, secrets: [] }),
}))

function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
      .map(({ name }) => {
        if (typeof name !== 'string' || !/^[a-z_]+$/.test(name)) throw new Error('unexpected table')
        return { name, rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }
      })
  } finally {
    db.close()
  }
}

it('keeps Host data on removal and serves it after enrollment under a new identity', async () => {
  const control = await controlMachine()
  const pi = fakeMachine({ rpc: true })
  const signer = generateKeyPairSync('ed25519')
  const ownerId = randomUUID()
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  const port = address.port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const env = {
    XDG_STATE_HOME: join(control.root, 'state'),
    PI_CODING_AGENT_DIR: pi.agentDir,
    HOME: pi.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  }
  const directory = hostStateDirectory(env, pi.home)
  const config = { ...control.config, repositories: [pi.repository], api: { port } }
  writeFileSync(control.configPath, JSON.stringify(config))
  const originalConfig = readFileSync(control.configPath)
  vi.stubEnv('PI_CODING_AGENT_DIR', pi.agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  hooks.machine = {
    pi: { binaryPath: process.execPath, prefixArgs: [pi.cli] },
    env,
    roots: [pi.repository],
    resourceRoot: EXTENSIONS_ROOT,
    contextBudget: '',
  }
  let target: Drainable | undefined
  try {
    await control.enrollOld()
    const identity = await control.store.load()
    if (!identity) throw new Error('missing identity')
    const oldKey = identity.key.export({ type: 'pkcs8', format: 'pem' })
    execFileSync(
      'git',
      [
        '-C',
        pi.repository,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'seed',
      ],
      { stdio: 'pipe' },
    )
    const worktree = join(pi.dir, 'worktree')
    execFileSync('git', ['-C', pi.repository, 'worktree', 'add', '-b', 'preserved', worktree], {
      stdio: 'pipe',
    })
    const tracked = join(worktree, 'keep.txt')
    writeFileSync(tracked, 'uncommitted work')
    const store = await openStore(directory, control.context.uid)
    const repository = store.syncRepositories([pi.repository])[0]
    if (!repository) throw new Error('missing repository')
    const laneIds: string[] = []
    const files = [tracked, control.configPath]
    for (const cwd of [pi.repository, worktree]) {
      const sessions = sessionDirForCwd(cwd, piSessionsRoot(env, pi.home))
      mkdirSync(sessions, { recursive: true })
      const sessionFile = join(sessions, `${randomUUID()}.jsonl`)
      const entries = [
        { type: 'session', version: 3, id: randomUUID(), cwd },
        {
          type: 'message',
          id: '1',
          parentId: null,
          message: { role: 'user', content: 'Keep this transcript', timestamp: 1 },
        },
        {
          type: 'message',
          id: '2',
          parentId: '1',
          message: {
            role: 'toolResult',
            toolName: 'artifact_create',
            toolCallId: 'call',
            content: [{ type: 'text', text: 'created' }],
            isError: false,
            timestamp: 2,
            details: {
              id: 'guide',
              version: 1,
              title: 'Guide',
              type: 'html',
              content: '<p>Keep this artifact</p>',
            },
          },
        },
      ]
      writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      laneIds.push(
        store.ensureLane({
          repositoryId: repository.id,
          cwd,
          sessionFile,
          worktree: cwd === worktree,
        }).laneId,
      )
      files.push(sessionFile)
    }
    store.close()
    const routinesDirectory = join(directory, 'routines')
    mkdirSync(routinesDirectory, { mode: 0o700 })
    const routines = new RoutineRepository(join(routinesDirectory, 'state.sqlite'))
    const routine = routines.save(
      {
        ...newRoutine(pi.repository),
        name: 'Keep routine',
        instructions: 'Keep history',
        schedule: { kind: 'manual' },
        enabled: true,
        trusted: true,
      },
      Date.now(),
    )
    const run = routines.manual(routine.id, randomUUID(), Date.now())
    routines.patchRun(run.id, { status: 'finished', endedAt: Date.now(), summary: 'Kept output' })
    routines.close()
    chmodSync(join(routinesDirectory, 'state.sqlite'), 0o600)
    const attachment = join(directory, 'attachments', laneIds[0] ?? 'missing', 'keep.txt')
    mkdirSync(join(attachment, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(attachment, 'attachment')
    files.push(attachment)
    const bytes = files.map((path) => readFileSync(path))
    const preserved = async () => {
      files.forEach((path, i) => expect(readFileSync(path)).toEqual(bytes[i]))
      const db = await openStore(directory, control.context.uid)
      try {
        expect(
          db
            .listLanes()
            .map((lane) => lane.laneId)
            .sort(),
        ).toEqual([...laneIds].sort())
        expect(db.listRepositories()).toEqual([repository])
      } finally {
        db.close()
      }
      const history = new RoutineRepository(join(routinesDirectory, 'state.sqlite'))
      try {
        expect(history.routines()).toEqual([routine])
        expect(history.history(routine.id)).toMatchObject([
          { id: run.id, status: 'finished', summary: 'Kept output' },
        ])
      } finally {
        history.close()
      }
      expect(
        execFileSync('git', ['-C', pi.repository, 'rev-parse', 'preserved'], {
          encoding: 'utf8',
        }).trim(),
      ).not.toBe('')
    }
    const epochs: string[] = []
    let beforeRemoval: unknown
    const durableRows = () => [
      rows(join(directory, 'state.sqlite')),
      rows(join(routinesDirectory, 'state.sqlite')),
    ]
    let artifacts: { path: string; bytes: Buffer }[] = []
    async function inspectApi(id: string) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`)
      await once(ws, 'open')
      async function exchange(frame: unknown) {
        const answer = once(ws, 'message')
        ws.send(JSON.stringify(frame))
        const parsed = parseHostFrame(String((await answer)[0]))
        if (!parsed.ok) throw new Error('invalid frame')
        return parsed.value
      }
      try {
        const now = Math.floor(Date.now() / 1000)
        const grant = encodeGrant(
          {
            v: 1,
            iss: 'https://example.com',
            kid: 'test',
            sub: ownerId,
            sid: randomUUID(),
            hostId: id,
            epoch: 1,
            client: { id: randomUUID(), label: 'Test' },
            caps: ['sessions.read', 'routines', 'artifacts.read'],
            iat: now,
            exp: now + 300,
            jti: '0123456789abcdef',
          },
          (bytes) => sign(null, bytes, signer.privateKey),
        )
        const ready = await exchange({
          type: 'auth',
          grant,
          challenge: 'a'.repeat(64),
          trace: '0123456789abcdef',
        })
        expect(ready.type).toBe('ready')
        if (ready.type !== 'ready') throw new Error('not ready')
        expect(ready.hello.hostId).toBe(id)
        epochs.push(ready.hello.runtimeEpoch)
        const lanes = await exchange({ type: 'subscribe', id: 'lanes', topic: 'lanes' })
        expect(lanes).toMatchObject({
          type: 'lanes',
          lanes: expect.arrayContaining(
            laneIds.map((laneId) => expect.objectContaining({ laneId })),
          ),
        })
        async function call(method: string, params: unknown = {}) {
          const response = await exchange({ type: 'call', id: 'query', method, params })
          expect(response.type).toBe('result')
          if (response.type !== 'result') throw new Error('missing result')
          return response
        }
        expect(await call('host.repositories')).toMatchObject({ data: [repository] })
        for (const laneId of laneIds) {
          expect(await call('lane.messages', { laneId })).toMatchObject({
            data: {
              messages: expect.arrayContaining([
                expect.objectContaining({ role: 'user', content: 'Keep this transcript' }),
              ]),
            },
          })
          expect(await call('artifacts.read', { laneId, slug: 'guide' })).toMatchObject({
            data: { content: '<p>Keep this artifact</p>', version: 1 },
          })
        }
        expect(await call('routines.list')).toMatchObject({
          data: [expect.objectContaining({ id: routine.id })],
        })
        expect(await call('routines.history', { routineId: routine.id })).toMatchObject({
          data: [expect.objectContaining({ id: run.id, status: 'finished' })],
        })
        expect(await call('artifacts.list')).toMatchObject({
          data: expect.arrayContaining(
            laneIds.map((laneId) => expect.objectContaining({ laneId, slug: 'guide' })),
          ),
        })
      } finally {
        ws.terminate()
      }
    }
    for (const id of [oldId, hostId]) {
      let inspected = false
      let removed = false
      let inspectionError: unknown
      const result = await runHost({
        ...control.context,
        now: Date.now,
        env,
        home: pi.home,
        nodeVersion: process.versions.node,
        defaultResourceRoot: EXTENSIONS_ROOT,
        attach: (drain) => {
          target = drain
          return () => {}
        },
        heartbeat: {
          readiness: async () => ({ pi: 'ok', claude: 'ok', tailscale: 'ok' }),
          random: () => 0,
        },
        fetch: async (url) => {
          if (String(url).includes('keys'))
            return Response.json({
              keys: [{ kid: 'test', publicKey: signer.publicKey.export({ format: 'jwk' }).x }],
            })
          if (removed) return new Response(null, { status: 410 })
          return Response.json({ accepted: true, nextInSec: 30, ownerId, epoch: 1 })
        },
        wait: async (_ms, signal) => {
          if (signal?.aborted || inspected) return new Promise(() => {})
          inspected = true
          try {
            await inspectApi(id)
            if (id === oldId) {
              beforeRemoval = durableRows()
              const root = join(directory, 'artifacts')
              artifacts = readdirSync(root, { recursive: true, withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) => {
                  const path = join(entry.parentPath, entry.name)
                  return { path, bytes: readFileSync(path) }
                })
              expect(artifacts.length).toBeGreaterThan(0)
              removed = true
            } else void target?.drain('SIGTERM')
          } catch (error) {
            inspectionError = error
            void target?.drain('SIGTERM')
          }
        },
      })
      if (inspectionError) throw inspectionError
      expect(result, control.output.join('\n')).toBe(id === oldId ? 77 : 0)
      expect(inspected).toBe(true)
      expect(durableRows()).toEqual(beforeRemoval)
      for (const artifact of artifacts) expect(readFileSync(artifact.path)).toEqual(artifact.bytes)
      await preserved()
      if (id === oldId) {
        expect(await control.store.load()).toEqual(identity)
        expect((await control.store.load())?.key.export({ type: 'pkcs8', format: 'pem' })).toEqual(
          oldKey,
        )
        control.setMode('gone')
        expect(
          (
            await runSetup({
              ...control.context,
              env,
              home: pi.home,
              cwd: pi.repository,
              nodeVersion: process.versions.node,
              defaultResourceRoot: EXTENSIONS_ROOT,
            })
          ).exitCode,
        ).toBe(0)
        expect(readFileSync(control.configPath)).toEqual(originalConfig)
        expect((await runLogin(control.context)).exitCode).toBe(0)
        expect((await control.store.load())?.identity.hostId).toBe(hostId)
      }
    }
    expect(epochs[0]).not.toBe(epochs[1])
    expect(piSessionsRoot(env, pi.home)).toContain(pi.agentDir)
  } finally {
    hooks.machine = undefined
    vi.unstubAllEnvs()
    await control.cleanup()
    pi.cleanup()
  }
}, 20000)
