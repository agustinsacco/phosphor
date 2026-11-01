import { realpathSync } from 'node:fs'
import { claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'
import { DEFAULT_AGENT_DIRECTIVES, type SessionPush } from '@phosphor/shared/models'
import { errorText } from '@phosphor/shared/errors'
import type { ExtensionUIRequest } from '@phosphor/shared/rpc'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { claudeProviderSpawnEnv } from '@phosphor/session-runtime/pi/provider-detect'
import { createSessionDeletion } from '@phosphor/session-runtime/pi/session-deletion'
import { prepareSessionLaunch } from '@phosphor/session-runtime/pi/session-launch'
import { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import { isInside } from '../fs-safety'
import { unlinkTranscript } from './transcript-removal'
import type { Delivery, RuntimeState } from './runtime-state'

const ignore: Delivery = () => {}
/** The extension UI requests that wait for an answer. */
const DIALOGS = new Set<ExtensionUIRequest['method']>(['select', 'confirm', 'input', 'editor'])
const NO_ROUTINES = {
  owns: () => false,
  sessionForPath: () => undefined,
  observe: () => {},
  cancel: async () => {},
}

export function wireRuntimeStartup(state: RuntimeState) {
  const { machine, options, roots, machineContext, registry, budget, agentDir, accounts } = state
  return createSessionStartup({
    registry,
    log: machine.log.write,
    // The parser resolved it already. This holds for a caller that skipped it, too.
    resolveWorkspace: (workspace) => {
      const real = realpathSync.native(workspace)
      if (roots.some((root) => isInside(root, real))) return real
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
      // Read per lane: Settings saves the toggles to the Host config.
      preferences: () => ({
        agentDirectives: options.agentDirectives?.() ?? DEFAULT_AGENT_DIRECTIVES,
        agentDirectivesByProject: {},
      }),
      defaultProvider: async (cwd) => (await readAgentSettings(cwd, agentDir)).defaultProvider,
      packages: (cwd) => listPackages(cwd, agentDir),
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
    accounts,
    recordWorkspace: () => {},
  })
}

/** Acceptance cancels dialogs; remote wiring opts into forwarding instead. */
function cancelDialog(state: RuntimeState, sessionId: string, request: ExtensionUIRequest): void {
  if (!DIALOGS.has(request.method)) return
  state.machine.log.write('host', 'dialog cancelled', {
    sessionId,
    method: request.method,
    title: 'title' in request ? request.title : undefined,
  })
  state.registry.get(sessionId)?.client.respondToExtensionUI({
    type: 'extension_ui_response',
    id: request.id,
    cancelled: true,
  })
}

function deliverySink(state: RuntimeState, sessionId: string, delivery: Delivery) {
  const {
    options,
    machine: { log },
  } = state
  // A push arrives inside pi's output handler: a delivery must not take the Host down.
  return (push: SessionPush) => {
    if (push.kind === 'extension-ui' && DIALOGS.has(push.request.method)) {
      if (options.dialogs === 'forward')
        log.write('host', 'dialog forwarded', { method: push.request.method })
      else cancelDialog(state, sessionId, push.request)
    }
    try {
      delivery(push)
    } catch (error) {
      log.write('host', 'delivery failed', { sessionId, kind: push.kind, error: errorText(error) })
    }
  }
}

export function wireRuntimeService(
  state: RuntimeState,
  spawn: ReturnType<typeof wireRuntimeStartup>,
) {
  const { registry, paths, budget, machine, options, started } = state
  return createSessionService<Delivery>({
    registry,
    paths,
    spawn: (spawnOptions, delivery = ignore, execution) => {
      if (state.authorization.getStore()?.() === false) throw new Error('Lane control changed.')
      // A resumed session handed back without spawning must be refused by start.
      started.add(delivery)
      return spawn(spawnOptions, (id) => deliverySink(state, id, delivery), execution)
    },
    isStub: () => false,
    packages: (cwd) => listPackages(cwd, state.agentDir),
    readBudget: () => machine.contextBudget,
    withBudgetCompaction: budget.withBudgetCompaction,
    forgetAccount: () => {},
    routines: options.routines ?? NO_ROUTINES,
  })
}

export function wireRuntimeDeletion(state: RuntimeState) {
  const { registry, paths, options } = state
  return createSessionDeletion({
    registry,
    paths,
    ownsRoutine: options.routines?.owns ?? NO_ROUTINES.owns,
    cancelRoutine: options.routines?.cancel ?? NO_ROUTINES.cancel,
    forgetAccount: () => {},
    deleteTranscript: (path) => unlinkTranscript(path, options.trashTranscript),
    deleteDraft: async () => {},
    // Cancel pending starts, but refuse an already running session instead of stopping it.
    assertDeletable: (id) => {
      if (registry.get(id)?.client.alive) throw new Error('the session is running: stop it first')
    },
  })
}

export type RuntimeService = ReturnType<typeof wireRuntimeService>
export type RuntimeDeletion = ReturnType<typeof wireRuntimeDeletion>
