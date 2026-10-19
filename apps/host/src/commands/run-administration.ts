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
import { createProviderLogins } from '../providers/login'
import { createAccountMoves } from '../settings/account-moves'
import { createMachineSettings } from '../settings/service'
import { createMachineTasks } from '../settings/tasks'
import { createWrites } from '../features/writes'
import { createFilesFeature } from '../features/files'
import { createGitFeature } from '../features/git'
import { createArtifactsFeature } from '../features/artifacts'
import { createSkillsFeature } from '../features/skills'
import { checkReadiness, readinessPorts } from '../machine/readiness'

interface AdministrationOptions {
  context: RunContext
  configPath: string
  env: Record<string, string>
  pi: HostMachine['pi']
  store: HostStore
  runtime: HostRuntime
  accounts: HostClaudeAccounts
  terminals?: HostTerminals
  binding: ReturnType<typeof createRuntimeLanes>
  live: ReturnType<typeof createLiveLanes>
  repositories: ReturnType<typeof createRepositories>
  routines: HostRoutines
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
) {
  return [
    settings.feature,
    options.repositories.feature,
    ...(options.terminals ? [options.terminals.feature] : []),
    options.routines.feature,
    createFilesFeature(context),
    createGitFeature(context),
    // Inspect this Host's effective config and selected private account.
    createSkillsFeature(context, {
      configPath: options.configPath,
      claudeAuthentication: options.accounts.authenticationReady,
    }),
    createArtifactsFeature({ ...context, store: options.store }),
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
  return {
    providerLogins,
    moveClaudeAccount: createAccountMoves({
      accounts,
      runtime: options.runtime,
      store: options.store,
      binding: options.binding,
    }),
    machineTasks: terminals
      ? createMachineTasks({
          terminals,
          settings,
          home: context.home,
          env: options.env,
          pi: options.pi,
        })
      : undefined,
    writes: createWrites(featureContext),
    features: () => features(options, featureContext, settings),
  }
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
