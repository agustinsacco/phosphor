import type { MachineSettings, MachineSettingsChange } from '@phosphor/shared/machine-settings'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { cooldownFromUsage, selectAccount } from '@phosphor/session-runtime/claude/routing'
import { featureInspection } from '../features/machine'
import { inspectClaude } from '../machine/claude'
import { type SettingsContext, settingsHash } from './context'
import { SettingsFailure } from './files'

type AccountState = Awaited<ReturnType<SettingsContext['options']['accounts']['accountViews']>>
type ProviderChange = Extract<MachineSettingsChange, { type: `claude.${string}` }>

async function catalogue(state: SettingsContext, quick: boolean) {
  if (quick && state.providerCatalogue && Date.now() - state.providerCatalogue.at < 60_000)
    return state.providerCatalogue.providers
  const report = await featureInspection(state.options.context, {
    configPath: state.options.configPath,
  })
  const providers = (report.report.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
  }))
  state.providerCatalogue = { at: Date.now(), providers }
  return providers
}

function accountViews(state: SettingsContext, accounts: AccountState) {
  const { options } = state
  const lanes = options.store.listLanes().filter((lane) => lane.removedAt === null)
  return accounts.views.map((view) => ({
    id: view.account.id,
    label: view.account.label,
    email: view.account.email,
    plan: view.account.plan,
    organization: view.account.organization,
    loggedIn: view.auth.ok ? view.auth.loggedIn === true : null,
    cooldownUntil: view.cooldownUntil,
    usage: view.usage ? { ...view.usage, contributing: null } : null,
    lanes: lanes.flatMap((lane) => {
      const sessionId = options.sessionFor(lane.laneId)
      const id = sessionId
        ? options.runtime.accountForSession(sessionId)
        : lane.sessionFile
          ? accounts.prefs.bindings[lane.sessionFile]
          : undefined
      return id === view.account.id
        ? [{ id: lane.laneId, title: lane.title ?? 'Untitled lane', active: sessionId !== null }]
        : []
    }),
  }))
}

export async function readProviderSettings(
  state: SettingsContext,
  quick: boolean,
): Promise<Pick<MachineSettings, 'revision' | 'providers'>> {
  const { options } = state
  const [providers, accounts, packages] = await Promise.all([
    catalogue(state, quick),
    options.accounts.accountViews(),
    listPackages(undefined, state.agentDir),
  ])
  const claude = await inspectClaude(packages, { env: options.env, secrets: [] })
  const selectedId = selectAccount(accounts.prefs, { nowMs: Date.now() }).account?.id
  const selected = accounts.views.find((view) => view.account.id === selectedId)
  if (claude.cli === 'ok' && selected)
    claude.auth = selected.auth.ok ? (selected.auth.loggedIn ? 'ok' : 'signed-out') : 'unknown'
  return {
    revision: settingsHash(accounts.prefs),
    providers: {
      providers,
      claude,
      mode: accounts.prefs.mode,
      pinnedId: accounts.prefs.pinnedId,
      authenticating: options.authenticating(),
      accounts: accountViews(state, accounts),
    },
  }
}

export async function changeProviderSettings(state: SettingsContext, change: ProviderChange) {
  const { options } = state
  const { accounts } = options
  if (change.type === 'claude.routing') {
    if (
      change.pinnedId &&
      !(await accounts.loadAccounts()).accounts.some((account) => account.id === change.pinnedId)
    )
      throw new SettingsFailure('bad-request', 'Unknown Claude account.')
    await accounts.setRouting(change.mode, change.pinnedId)
  } else if (change.type === 'claude.remove') {
    // Do not sign an account out under active lanes. Moving/restarting them is explicit.
    if (
      options.store.listLanes().some((lane) => {
        const sessionId = options.sessionFor(lane.laneId)
        return (
          sessionId !== null && options.runtime.accountForSession(sessionId) === change.accountId
        )
      })
    )
      throw new SettingsFailure(
        'bad-request',
        'Stop or move this account’s active lanes before signing it out.',
      )
    await accounts.removeAccount(change.accountId)
  } else if (change.type === 'claude.reorder') await accounts.reorderAccounts(change.ids)
  else if (change.type === 'claude.refreshUsage') await accounts.refreshCooldowns()
  else {
    const account = (await accounts.loadAccounts()).accounts.find((a) => a.id === change.accountId)
    if (!account) throw new SettingsFailure('bad-request', 'Unknown Claude account.')
    const usage = await accounts.usage.fetchUsageSnapshot({
      cacheKey: account.id,
      extraEnv: accounts.accountUsageEnv(account),
      force: true,
    })
    if (usage.ok) {
      const until = cooldownFromUsage(usage.snapshot.windows, Date.now())
      if (until !== null) await accounts.holdAccount(account.id, until)
    }
  }
}
