import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import { once } from 'node:events'
import { createContextBudgetRuntime } from '../context-budget'
import { PiRpcClient } from '../rpc-client'
import { SessionRegistry } from '../session-registry'
import { createSessionStartup } from '../session-startup'
import { createSessionService } from '../session-service'
import { createSessionDeletion } from '../session-deletion'
import { createSessionPathRuntime } from '../session-path-lock'

// This entry is bundled and executed by an ordinary Node process, not Vitest/Electron.
const [fakePi, cwd, sessionPath] = process.argv.slice(1)
assert(fakePi && cwd && sessionPath)
const log = () => {}
let closing = false
let owned = false
const registry = new SessionRegistry({
  createClient: (options) => new PiRpcClient(options, { log, isClosing: () => closing }),
  assertCanStart: () => {
    if (closing) throw new Error('closing')
  },
})
const paths = createSessionPathRuntime()
const budget = createContextBudgetRuntime(log)
const events: string[] = []
let ended: (() => void) | undefined
const spawn = createSessionStartup({
  registry,
  log,
  resolveWorkspace: (path) => path,
  launch: async () => ({
    stub: false,
    binaryPath: process.execPath,
    prefixArgs: [fakePi],
    extensions: [],
    env: { FAKE_PI_SESSION_FILE: sessionPath },
  }),
  policy: {
    machineContext: () => ({ kind: 'desktop', signedIn: false }),
    git: async () => ({ isRepo: false }),
    preferences: () => ({
      agentDirectives: {
        machineAwareness: true,
        worktreeGuard: false,
        laneCharter: false,
        subagentPolicy: false,
      },
      agentDirectivesByProject: {},
    }),
    defaultProvider: async () => 'native',
    packages: async () => [],
    account: async () => null,
    compressionEnvironment: () => ({}),
    resetCompaction: async () => {},
  },
  budget: { watch: budget.watchContextBudget, read: () => '200k', paused: () => owned },
  accounts: { remember: () => {}, forget: () => {}, hold: async () => {} },
  recordWorkspace: () => {},
})
const service = createSessionService({
  registry,
  paths,
  spawn: (options, _delivery, execution) =>
    spawn(
      options,
      () => (push) => {
        if (push.kind === 'event') {
          events.push(push.event.type)
          if (push.event.type === 'agent_end') ended?.()
        }
      },
      execution,
    ),
  isStub: () => false,
  packages: async () => [],
  readBudget: () => '200k',
  withBudgetCompaction: budget.withBudgetCompaction,
  forgetAccount: () => {},
  routines: {
    owns: () => owned,
    sessionForPath: () => undefined,
    observe: () => {},
    cancel: async () => {
      owned = false
    },
  },
})
const remove = createSessionDeletion({
  registry,
  paths,
  ownsRoutine: () => owned,
  cancelRoutine: async () => {
    owned = false
  },
  forgetAccount: () => {},
  deleteTranscript: unlink,
  deleteDraft: async () => {},
})
try {
  const [first, attached] = await Promise.all(
    [1, 2].map(() => service.create({ workspacePath: cwd, sessionPath })),
  )
  assert(first && attached)
  assert.equal(first.sessionId, attached.sessionId)
  assert.equal(registry.list().length, 1)
  const finished = new Promise<void>((resolve) => {
    ended = resolve
  })
  assert.equal(
    (await service.command(first.sessionId, { type: 'prompt', message: 'hello' })).success,
    true,
  )
  await finished
  assert(events.includes('message_update'))
  owned = true
  await assert.rejects(
    service.command(first.sessionId, { type: 'prompt', message: 'no' }),
    /owned by a running routine/,
  )
  assert.equal((await service.command(first.sessionId, { type: 'get_state' })).success, true)
  owned = false
  await assert.rejects(
    service.command(first.sessionId, {
      type: 'set_model',
      provider: 'pi-claude-cli',
      modelId: 'missing',
    }),
    /not installed/,
  )
  const compact = service.command(first.sessionId, { type: 'compact' })
  await new Promise(setImmediate)
  const queued = assert.rejects(
    service.command(first.sessionId, { type: 'prompt', message: 'cancelled' }),
    /Queued command cancelled/,
  )
  await service.command(first.sessionId, { type: 'abort' })
  assert.equal((await compact).success, true)
  await queued
  const exited = once(registry.get(first.sessionId)!.client, 'exit')
  await assert.rejects(service.command(first.sessionId, { type: 'bash', command: 'CRASH' }))
  await exited
  assert(registry.get(first.sessionId), 'crashed handle is retained for inspection')
  const resumed = await service.create({ workspacePath: cwd, sessionPath })
  assert.notEqual(resumed.sessionId, first.sessionId)
  assert.equal(registry.list().length, 1)
  assert.deepEqual(await remove(sessionPath), [resumed.sessionId])
  assert.equal(registry.list().length, 0)
  await assert.rejects(service.create({ workspacePath: cwd, sessionPath }), /ENOENT/)
  closing = true
  await assert.rejects(service.create({ workspacePath: cwd }), /closing/)
  console.log(
    JSON.stringify({
      plainNode: true,
      resumeReuse: true,
      streamed: true,
      routineGuard: true,
      providerGuard: true,
      interruptBypass: true,
      crashResume: true,
      deletion: true,
      shutdownAdmission: true,
      remaining: registry.list().length,
    }),
  )
} finally {
  await registry.disposeAll()
}
