import type { WorkspaceLeases } from '../owner/lease'
import { join } from 'node:path'
import { HostArchives } from '../lanes/archive'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import type { HostAttachments } from '../features/attachments'
import type { RunContext } from './run'
import type { HostMachine, HostRuntime } from '../session/runtime'
import type { HostStore } from '../lanes/store'
import type { createRuntimeLanes } from '../lanes/runtime-host'
import type { createLiveLanes } from '../lanes/live'
import type { HostRoutines } from '../routines/service'
import type { HostTerminals } from '../terminals/service'
import type { createRepositories } from '../features/repositories'
import type { FeatureContext } from '../features/feature'
import { createHostClaudeAccounts, type HostClaudeAccounts } from '../providers/accounts'
import { createLaneUsage } from '../providers/lane-usage'
import { createProviderLogins } from '../providers/login'
import { createAccountMoves } from '../settings/account-moves'
import { createMachineSettings } from '../settings/service'
import { createHeadlessTasks } from '../settings/headless-tasks'
import { createMachineTasks } from '../settings/tasks'
import { createWrites } from '../features/writes'
import { createFilesFeature } from '../features/files'
import { createGitFeature } from '../features/git'
import { githubRunner } from '../features/git/github'
import { createLaneDeletion } from '../lanes/delete'
import { createArtifactsFeature } from '../features/artifacts'
import { createSkillsFeature } from '../features/skills'
import { createSkillInstallFeature } from '../features/skill-install'
import { createLaneTransferFeatures } from '../features/lane-transfer'
import { hostTransferRuntime } from '../features/lane-transfer/runtime'
import { checkReadiness, readinessPorts } from '../machine/readiness'
import { hostUpdateProgram } from '../update/handoff'
import { loadHostPty } from '../terminals/native'
import { createTerminals } from '../terminals/service'
import { terminalState } from '../terminals/state'
import { hostStateDirectory } from '@phosphor/shared/host-local'
import { identityDirectory, type HostIdentity } from '../control/identity'
import { startHostWebPush, type WebPushOptions } from '../push/web-push'

interface AdministrationOptions {
  leases?: WorkspaceLeases
  context: RunContext
  configPath: string
  env: Record<string, string>
  pi: HostMachine['pi']
  store: HostStore
  runtime: HostRuntime
  accounts: HostClaudeAccounts
  terminals?: HostTerminals
  attachments?: HostAttachments
  binding: ReturnType<typeof createRuntimeLanes>
  live: ReturnType<typeof createLiveLanes>
  repositories: ReturnType<typeof createRepositories>
  routines: HostRoutines
  hide: HostMachine['log']['hide']
  log: HostMachine['log']['write']
}

export function createRunAccounts(
  context: RunContext,
  directory: string,
  env: Record<string, string>,
) {
  return createHostClaudeAccounts({ directory, home: context.home, env })
}

function features(
  options: AdministrationOptions,
  context: FeatureContext,
  settings: ReturnType<typeof createMachineSettings>,
  archives: HostArchives,
) {
  return [
    settings.feature,
    archives.feature,
    options.repositories.feature,
    ...(options.terminals ? [options.terminals.feature] : []),
    options.routines.feature,
    createFilesFeature(context),
    createGitFeature(context),
    // Inspect this Host's effective config and selected private account.
    createSkillsFeature(context, {
      configPath: options.configPath,
      claudeAuthentication: options.accounts.authenticationReady,
      claudeUsage: createLaneUsage({
        accounts: options.accounts,
        accountForLane: (laneId, prefs) => {
          const sessionId = options.live.sessionFor(laneId)
          if (sessionId) return options.runtime.accountForSession(sessionId)
          const file = options.store.getLane(laneId)?.sessionFile
          return file ? prefs.bindings[file] : undefined
        },
      }),
    }),
    createArtifactsFeature({ ...context, store: options.store }),
    // Shared skills land where this Host's pi reads global skills.
    createSkillInstallFeature(context, {
      configPath: options.configPath,
      skillsRoot: join(settings.agentDir, 'skills'),
    }),
    ...createLaneTransferFeatures(context, options.store, {
      runtime: hostTransferRuntime(context, options.configPath),
      sessionFor: options.live.sessionFor,
      announce: (laneId) => {
        const summary = options.live.summaryFor(laneId)
        if (summary) options.live.lanesTopic.delta([summary])
      },
    }),
  ]
}

/** Bind administration to this run's existing runtime, path locks and terminal owner. */
export function createRunAdministration(options: AdministrationOptions) {
  const { context, terminals, accounts } = options
  const featureContext: FeatureContext = {
    store: options.store,
    env: context.env,
    home: context.home,
    log: (event, fields) => options.log('host', event, fields),
  }
  const providerLogins = terminals
    ? createProviderLogins(context, terminals, undefined, accounts)
    : undefined
  const settings = createMachineSettings({
    context: featureContext,
    configPath: options.configPath,
    env: options.env,
    store: options.store,
    runtime: options.runtime,
    accounts,
    pi: options.pi,
    authenticating: () => providerLogins?.active() ?? false,
    sessionFor: options.live.sessionFor,
  })
  const archives = new HostArchives({
    leases: options.leases,
    directory: hostStateDirectory(context.env, context.home),
    sessionsRoot: piSessionsRoot(context.env, context.home),
    store: options.store,
    runtime: options.runtime,
    stop: options.binding.deleteStop,
    sessions: options.binding.sessions,
    forget: options.live.forget,
    terminals,
    attachments: options.attachments,
    announce: (id) => {
      const summary = options.live.summaryFor(id)
      if (summary) options.live.lanesTopic.delta([summary])
    },
  })
  const moveClaudeAccount = createAccountMoves({
    accounts,
    runtime: options.runtime,
    store: options.store,
    binding: options.binding,
  })
  const programs = { settings, home: context.home, env: options.env, pi: options.pi }
  const machineTasks = terminals
    ? createMachineTasks({
        ...programs,
        terminals,
        hostUpdater: () => hostUpdateProgram(context.home, context.env, process.platform),
        headlessActive: () => task.active(),
      })
    : undefined
  const task: ReturnType<typeof createHeadlessTasks> = createHeadlessTasks(
    programs,
    options.hide,
    () => machineTasks?.active() ?? false,
  )
  return {
    archives,
    providerLogins,
    moveClaudeAccount,
    machineTasks,
    settingsOps: {
      settings,
      moveClaudeAccount,
      task,
      refreshDirectives: options.runtime.refreshDirectives,
    },
    writes: createWrites(featureContext),
    deleteLane: createLaneDeletion({
      archiveOwnsCwd: (cwd) => archives.ownsCwd(cwd),
      store: options.store,
      stop: options.binding.deleteStop,
      remove: options.runtime.remove,
      forget: options.live.forget,
      // The merged-PR proof asks gh with the same environment as the PR reads.
      github: githubRunner(context.env),
    }),
    features: () => features(options, featureContext, settings, archives),
  }
}

/** This run's Host terminals, when node-pty loads; their state lives beside the lanes'. */
export function createRunTerminals(
  context: RunContext,
  options: {
    epoch: string
    store: HostStore
    log: HostMachine['log']
    env: Record<string, string>
  },
) {
  const native = loadHostPty()
  if (!native) return undefined
  return createTerminals({
    native,
    epoch: options.epoch,
    env: options.env,
    context: {
      store: options.store,
      env: context.env,
      home: context.home,
      log: (event, fields) => options.log.write('host', event, fields),
    },
    ...terminalState(hostStateDirectory(context.env, context.home)),
  })
}

/** Web Push for this run: its key beside the identity, subscriptions in the private state. */
export function startRunWebPush(
  context: RunContext,
  options: Pick<WebPushOptions, 'authority' | 'lanesTopic' | 'receipt'> & {
    identity: HostIdentity
    controlUrl: string
    hide: HostMachine['log']['hide']
    log: HostMachine['log']['write']
  },
) {
  return startHostWebPush({
    identityDirectory: identityDirectory(context.configPath),
    subscriptionsPath: join(hostStateDirectory(context.env, context.home), 'web-push.json'),
    uid: context.uid,
    hostId: options.identity.hostId,
    machine: options.identity.label,
    subject: options.controlUrl,
    authority: options.authority,
    lanesTopic: options.lanesTopic,
    receipt: options.receipt,
    log: (event, fields) => options.log('host', event, fields),
  })
}

export function createRunControllerPresence(
  store: Pick<HostStore, 'listLanes'>,
  live: Pick<ReturnType<typeof createLiveLanes>, 'publish'>,
) {
  return (clientId: string): void => {
    for (const lane of store.listLanes())
      if (lane.control.controller?.clientId === clientId)
        live.publish(lane.laneId, { kind: 'control', control: lane.control })
  }
}

export function runReadiness(
  config: Parameters<typeof checkReadiness>[0],
  context: RunContext,
  accounts: HostClaudeAccounts | undefined,
  found: Parameters<typeof checkReadiness>[4],
) {
  return checkReadiness(
    config,
    context.env,
    context.platform,
    {
      ...(context.heartbeat?.readinessPorts ?? readinessPorts),
      ...(accounts ? { claudeAuthentication: accounts.authenticationReady } : {}),
    },
    found,
  )
}
