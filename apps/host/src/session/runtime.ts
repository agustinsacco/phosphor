import { hostname, type as osType } from 'node:os'
import type { MachineContext } from '@phosphor/shared/machine-prompt'
import { existsSync, realpathSync } from 'node:fs'
import { lstat, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_AGENT_DIRECTIVES,
  type LiveSessionInfo,
  type SessionPush,
} from '@phosphor/shared/models'
import { errorText } from '@phosphor/shared/errors'
import type {
  ExtensionUIRequest,
  ExtensionUIResponse,
  RpcCommand,
  RpcCommandType,
} from '@phosphor/shared/rpc'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { createContextBudgetRuntime } from '@phosphor/session-runtime/pi/context-budget'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { claudeProviderSpawnEnv } from '@phosphor/session-runtime/pi/provider-detect'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { createSessionDeletion } from '@phosphor/session-runtime/pi/session-deletion'
import { prepareSessionLaunch } from '@phosphor/session-runtime/pi/session-launch'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import type { ConfigError } from '../config/schema'
import type { HostLog } from '../machine/log'
import { isInsideRoot } from '../machine/repositories'
import {
  DRAIN,
  createDrain,
  createLifecycle,
  stopSession,
  trackProcessGroups,
  type DrainTimings,
  type Lifecycle,
} from './lifecycle'
import type { SessionServiceRuntime } from '@phosphor/session-runtime/pi/session-service'
import type { SessionExecution } from '@phosphor/session-runtime/pi/session-policy'
import { parseSessionRequest } from './request'
import { claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'
import type { HostClaudeAccounts } from '../providers/accounts'

/** What a validated Host knows about its machine. 05-D assembles it from doctor's checks. */
export interface HostMachine {
  /** pi as doctor resolved it: node and pi's cli, or pi alone. Never a stub. */
  pi: { binaryPath: string; prefixArgs: string[] }
  /** All of pi's environment, PATH included: what buildPiEnvironment built. */
  env: Record<string, string>
  /** Real paths of the configured repositories. */
  roots: readonly string[]
  /** The folder holding pi-ext/. */
  resourceRoot: string
  /** In Desktop's grammar; '' is the 200k default. */
  contextBudget: string
  machineContext?: Extract<MachineContext, { kind: 'host' }>
  log: HostLog
}

/** Where a session's pushes go. 07 replaces it with the projection. */
export type Delivery = (push: SessionPush) => void

/** A request the parser refused, with every problem at its JSON pointer. */
export class RequestError extends Error {
  constructor(readonly errors: ConfigError[]) {
    super(`invalid request: ${errors.map((e) => `${e.pointer || '/'} ${e.message}`).join('; ')}`)
    this.name = 'RequestError'
  }
}

const ignore: Delivery = () => {}
/** The extension UI requests that wait for an answer. */
const DIALOGS = new Set<ExtensionUIRequest['method']>(['select', 'confirm', 'input', 'editor'])
const NO_ROUTINES = {
  owns: () => false,
  sessionForPath: () => undefined,
  observe: () => {},
  cancel: async () => {},
}

/**
 * The session runtime bound to this machine (spec section 7): one registry,
 * one path-lock domain shared by the service and deletion, pi's built
 * environment and nothing inherited. Every start and deletion goes through
 * the request parser. The lifecycle starts in `booting`; the caller moves
 * it to `ready` once the machine is validated.
 */
export function createHostRuntime(
  machine: HostMachine,
  options: {
    trashTranscript?: (path: string) => Promise<void>
    claudeAccounts?: HostClaudeAccounts
    life?: Lifecycle
    timings?: Partial<DrainTimings>
    dialogs?: 'cancel' | 'forward'
    routines?: SessionServiceRuntime<Delivery>['routines']
  } = {},
) {
  const { log } = machine
  const roots = [...machine.roots]
  const machineContext: Extract<MachineContext, { kind: 'host' }> = {
    kind: 'host',
    label: machine.machineContext?.label ?? hostname(),
    os: machine.machineContext?.os ?? osType(),
    repositories: machine.machineContext?.repositories ?? [],
  }
  const timings: DrainTimings = { ...DRAIN, ...options.timings }
  const life = options.life ?? createLifecycle(log.write)
  const path = machine.env.PATH
  if (!path) throw new Error("pi's environment has no PATH")
  // gitInfo runs git from this process's PATH: make it pi's, so both find the same git.
  process.env.PATH = path

  const registry = new SessionRegistry({
    createClient: (spawn) =>
      new PiRpcClient(
        { ...spawn, inheritEnv: false },
        { log: log.write, isClosing: life.isDraining },
      ),
    assertCanStart: life.assertReady,
  })
  // Chosen once per process. Persist the binding when pi learns its file, including routines.
  const accountIds = new Map<string, string>()
  const boundFiles = new Map<string, string>()
  function bindAccount(sessionId: string, path?: string): void {
    const accountId = accountIds.get(sessionId)
    if (!accountId || !path || !existsSync(path) || boundFiles.get(sessionId) === path) return
    boundFiles.set(sessionId, path)
    void options.claudeAccounts?.bindSession(path, accountId).catch(() => {
      boundFiles.delete(sessionId)
      log.write('host', 'account.binding-failed', { sessionId })
    })
  }
  registry.on('created', (session) => {
    session.client.on('session-file', (path) => bindAccount(session.sessionId, path))
    // get_state can name a file before pi creates it on the first prompt.
    session.client.on('event', () => bindAccount(session.sessionId, session.client.sessionFile))
  })
  registry.on('disposed', ({ sessionId }) => {
    accountIds.delete(sessionId)
    boundFiles.delete(sessionId)
  })
  const groups = trackProcessGroups(registry)
  const paths = createSessionPathRuntime()
  const budget = createContextBudgetRuntime(log.write)
  const spawn = createSessionStartup({
    registry,
    log: log.write,
    // The parser resolved it already. This holds for a caller that skipped it, too.
    resolveWorkspace: (workspace) => {
      const real = realpathSync.native(workspace)
      if (roots.some((root) => isInsideRoot(real, root))) return real
      throw new Error('the folder is outside the configured repositories')
    },
    launch: () =>
      prepareSessionLaunch({
        resolveExecutable: async () => ({ stub: false, ...machine.pi }),
        readEnvironment: async () => ({ ...machine.env, ...claudeProviderSpawnEnv() }),
        resourceRoot: () => machine.resourceRoot,
      }),
    policy: {
      git: gitInfo,
      machineContext: () => machineContext,
      preferences: () => ({
        agentDirectives: DEFAULT_AGENT_DIRECTIVES,
        agentDirectivesByProject: {},
      }),
      defaultProvider: async (cwd) => (await readAgentSettings(cwd)).defaultProvider,
      packages: listPackages,
      account: async (selection) => {
        const account = await options.claudeAccounts?.accountForSpawn(selection)
        return account ? { id: account.id, env: claudeAccountEnv(account) } : null
      },
      strictAccountSelection: true,
      compressionEnvironment: () => ({}),
      resetCompaction: async () => {},
    },
    budget: {
      watch: budget.watchContextBudget,
      read: () => machine.contextBudget,
      paused: (id) => options.routines?.owns(id) ?? false,
    },
    accounts: {
      remember: (id, accountId) => {
        accountIds.set(id, accountId)
        bindAccount(id, registry.get(id)?.client.sessionFile)
      },
      forget: (id) => {
        accountIds.delete(id)
        boundFiles.delete(id)
      },
      hold: async (id, until) => {
        await options.claudeAccounts?.holdAccount(id, until)
      },
    },
    recordWorkspace: () => {},
  })
  // The deliveries a pi was started for. The service hands back a session
  // already running on a file without calling spawn, and that is refused.
  const started = new WeakSet<Delivery>()
  const service = createSessionService<Delivery>({
    registry,
    paths,
    spawn: (spawnOptions, delivery = ignore, execution) => {
      started.add(delivery)
      // A push arrives inside pi's output handler: a delivery that throws must not take the Host down.
      const sink = (sessionId: string) => (push: SessionPush) => {
        if (push.kind === 'extension-ui' && DIALOGS.has(push.request.method)) {
          if (options.dialogs === 'forward')
            log.write('host', 'dialog forwarded', { method: push.request.method })
          else cancelDialog(sessionId, push.request)
        }
        try {
          delivery(push)
        } catch (error) {
          log.write('host', 'delivery failed', {
            sessionId,
            kind: push.kind,
            error: errorText(error),
          })
        }
      }
      return spawn(spawnOptions, sink, execution)
    },
    isStub: () => false,
    packages: listPackages,
    readBudget: () => machine.contextBudget,
    withBudgetCompaction: budget.withBudgetCompaction,
    forgetAccount: () => {},
    routines: options.routines ?? NO_ROUTINES,
  })
  const deleteLane = createSessionDeletion({
    registry,
    paths,
    ownsRoutine: options.routines?.owns ?? NO_ROUTINES.owns,
    cancelRoutine: options.routines?.cancel ?? NO_ROUTINES.cancel,
    forgetAccount: () => {},
    deleteTranscript: (path) => unlinkTranscript(path, options.trashTranscript),
    deleteDraft: async () => {},
    // As on Desktop, a deletion first cancels a start of the same file still
    // under way. A session already running is refused instead of stopped.
    assertDeletable: (id) => {
      if (registry.get(id)?.client.alive) throw new Error('the session is running: stop it first')
    },
  })
  const drain = createDrain({ life, registry, groups, log: log.write, timings })

  /**
   * Acceptance runs cancel dialogs by default. Remote wiring opts into
   * forwarding and answers through extensionUiResponse instead.
   */
  function cancelDialog(sessionId: string, request: ExtensionUIRequest): void {
    if (!DIALOGS.has(request.method)) return
    log.write('host', 'dialog cancelled', {
      sessionId,
      method: request.method,
      title: 'title' in request ? request.title : undefined,
    })
    registry.get(sessionId)?.client.respondToExtensionUI({
      type: 'extension_ui_response',
      id: request.id,
      cancelled: true,
    })
  }
  log.write('host', 'runtime', {
    pi: [machine.pi.binaryPath, ...machine.pi.prefixArgs],
    names: Object.keys(machine.env).sort(),
    path: path.split(':'),
    roots,
    resourceRoot: machine.resourceRoot,
  })

  // Prompts that may be moving pi to another file: from sending one until
  // pi has said again which file it writes.
  let moving = 0
  // Sessions that may have moved, whose pi then did not say which file it
  // writes. Each counts until a later answer does, or until it is disposed.
  const lost = new Set<string>()

  /**
   * A resume or a deletion trusts the Host's record of which file each pi
   * writes, which a prompt in flight, or one pi did not answer for, may have
   * made stale.
   */
  function assertFilesKnown(): void {
    if (moving > 0) throw new Error(MOVING)
    for (const id of lost) {
      // A disposed session writes nothing, and its id is never used again.
      if (!registry.get(id)) lost.delete(id)
      else throw new Error(`session ${id} ${LOST}`)
    }
  }

  /**
   * Ask pi which file it writes: the client keeps what get_state says. An
   * error, an answer without a file, or no answer at all leaves the record
   * possibly stale, so the session counts as lost until it is disposed.
   */
  async function relearnFile(id: string): Promise<void> {
    const client = registry.get(id)?.client
    if (!client) return
    try {
      const state = await client.request({ type: 'get_state' })
      if (state.success && typeof state.data?.sessionFile === 'string') {
        lost.delete(id)
        return
      }
    } catch {
      // pi has exited, or its input is closed: it says nothing either.
    }
    lost.add(id)
  }

  async function parse(request: unknown, deleting = false) {
    life.assertReady()
    const parsed = await parseSessionRequest(request, roots, { deleting })
    if (!parsed.ok) throw new RequestError(parsed.errors)
    return parsed.options
  }

  return {
    replaceRoots(next: readonly string[]) {
      roots.splice(0, roots.length, ...next)
      machineContext.repositories = next.map((repository) => basename(repository))
    },
    life,
    drain,
    /** Internal runner only: still uses the shared service and path-lock domain. */
    async startRoutine(request: unknown, deliver: Delivery, execution: SessionExecution) {
      return service.create(await parse(request), deliver, { ...execution, unattended: true })
    },
    routineClient(id: string) {
      if (!options.routines?.owns(id)) throw new Error('not a routine session')
      const session = registry.get(id)
      if (!session) throw new Error('routine session unavailable')
      return session.client
    },
    async stopRoutine(id: string) {
      if (!options.routines?.owns(id)) throw new Error('not a routine session')
      const session = registry.get(id)
      if (session) await stopSession(session, registry, timings)
    },
    list: (): LiveSessionInfo[] => registry.list(),
    accountForSession: (sessionId: string) => accountIds.get(sessionId),
    /** Start a session, or resume one from its file. One already running is refused. */
    async start(request: unknown, deliver: Delivery = ignore): Promise<LiveSessionInfo> {
      const options = await parse(request)
      // A new session's file is new. Resuming one trusts the Host's records.
      if (options.sessionPath !== undefined) assertFilesKnown()
      // pi's stderr may hold a secret, so each line leaves the Host redacted.
      const delivery: Delivery = (push) =>
        deliver(push.kind === 'stderr' ? { ...push, text: log.hide(push.text) } : push)
      const session = await service.create(options, delivery)
      if (!started.has(delivery)) throw new Error('the session is already running')
      return session
    },
    /** A pi RPC command, unless `commandRefusal` refuses it. */
    async command(id: string, command: RpcCommand) {
      const refusal = commandRefusal(command)
      if (refusal) throw new Error(refusal)
      if (!mayRunExtensionCommand(command)) return service.command(id, command)
      // An extension command can move pi to another file. pi answers its
      // prompt only once the command has finished, failed or not, and
      // get_state then names the file pi writes. Until the Host has asked,
      // its record may be stale, so it admits no resume and no deletion.
      moving++
      try {
        return await service.command(id, command)
      } finally {
        await relearnFile(id)
        moving--
      }
    },
    /** Send a controller's answer without treating it as an RPC command. */
    extensionUiResponse(id: string, response: ExtensionUIResponse): void {
      life.assertReady()
      const session = registry.get(id)
      if (!session || !session.client.alive) throw new Error('the session is not running')
      service.respond(id, response)
    },
    /** Let a turn in flight end and be saved, then stop pi and its process group. */
    async stop(id: string): Promise<void> {
      if (options.routines?.owns(id)) throw new Error('routine owns this session')
      const session = registry.get(id)
      if (!session) throw new Error(`Unknown session: ${id}`)
      await stopSession(session, registry, timings)
    },
    /** Delete a stopped session's file. A running session is refused. */
    async remove(request: unknown): Promise<void> {
      const { sessionPath } = await parse(request, true)
      assertFilesKnown()
      await deleteLane(sessionPath)
    },
  }
}

export type HostRuntime = ReturnType<typeof createHostRuntime>

/** What the Host does with a command: pass it (null), refuse it (why), or decide from it. */
type CommandRule<K extends RpcCommandType> =
  null | string | ((command: Extract<RpcCommand, { type: K }>) => string | null)

const MOVES_FILE = 'moves pi to another session file: start or resume one with a request instead'

const MOVING =
  'a session is running a command that may move it to another file: try again once it ends'

const LOST = 'may have moved to another file, and pi could not say which: stop that session first'

/** pi tries a prompt as an extension command only when it starts with "/". */
function mayRunExtensionCommand(command: RpcCommand): boolean {
  return (
    command.type === 'prompt' &&
    (typeof command.message !== 'string' || command.message.startsWith('/'))
  )
}

/**
 * Every pi command, so one added to the protocol does not compile until it
 * is placed here. A session file reaches pi only through the request parser,
 * so the Host always knows which file each pi writes: that is what refuses a
 * second start of a file and the deletion of a running one. A command that
 * moves pi to another file would leave the Host believing the old one.
 */
const COMMANDS: { [K in RpcCommandType]: CommandRule<K> } = {
  prompt: null,
  steer: null,
  follow_up: null,
  abort: null,
  clear_queue: null,
  get_state: null,
  get_messages: null,
  set_model: null,
  cycle_model: null,
  get_available_models: null,
  set_thinking_level: null,
  cycle_thinking_level: null,
  get_available_thinking_levels: null,
  set_steering_mode: null,
  set_follow_up_mode: null,
  compact: null,
  set_auto_compaction: null,
  set_auto_retry: null,
  abort_retry: null,
  bash: null,
  abort_bash: null,
  get_session_stats: null,
  get_fork_messages: null,
  get_entries: null,
  get_tree: null,
  get_last_assistant_text: null,
  set_session_name: null,
  get_commands: null,
  new_session: MOVES_FILE,
  switch_session: MOVES_FILE,
  fork: MOVES_FILE,
  clone: MOVES_FILE,
  // An export goes where pi puts it.
  export_html: (command) =>
    command.outputPath === undefined ? null : 'takes no output path on a Host',
}

/** Why a command is refused, or null. A type that is not one of pi's is refused too. */
export function commandRefusal(command: RpcCommand): string | null {
  const type: unknown = (command as { type?: unknown }).type
  if (typeof type !== 'string' || !Object.hasOwn(COMMANDS, type)) return 'not a pi command'
  const rule = COMMANDS[type as RpcCommandType] as CommandRule<RpcCommandType>
  const reason = typeof rule === 'function' ? rule(command) : rule
  return reason === null ? null : `${type} ${reason}`
}

/**
 * Unlink a transcript only when it is one of pi's: a regular `.jsonl`, not a
 * link, directly in a folder of pi's session root. The parser confined the
 * file a request names; this also holds for a file pi reported for a
 * session. A file whose folder is gone is gone too. Without a session root,
 * nothing is one of pi's files.
 */
export async function unlinkTranscript(
  path: string,
  remove: (path: string) => Promise<void> = unlink,
): Promise<void> {
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  let folder: string
  try {
    folder = await realpath(dirname(path))
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  const root = await realpath(piSessionsRoot()).catch(() => null)
  if (root === null || dirname(folder) !== root) {
    throw new Error(`refusing to delete ${path}: not a pi session`)
  }
  const file = join(folder, basename(path))
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  // lstat describes a link itself, and a link is not a regular file.
  if (!/.\.jsonl$/.test(basename(file)) || !info.isFile()) {
    throw new Error(`refusing to delete ${path}: not a pi session file`)
  }
  await remove(file).catch((error: unknown) => {
    if (!missing(error)) throw error
  })
}
