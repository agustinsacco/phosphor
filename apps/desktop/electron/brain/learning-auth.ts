import { isAbsolute } from 'node:path'
import type { ClaudeAccountPrefs } from '@phosphor/shared/models'
import { compareVersions } from '@phosphor/shared/version'
import { claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'

/** Current explicit host assignment only. Never allocate, rotate, refresh, bind or infer history. */
export function selectLearningClaudeAccount(
  prefs: ClaudeAccountPrefs,
  sessionPath: string,
  liveAccountId?: string,
) {
  const saved = prefs.bindings[sessionPath]
  if (saved && liveAccountId && saved !== liveAccountId)
    throw new Error('Learning Claude account assignment is conflicting')
  const id = liveAccountId ?? saved
  const account = id ? prefs.accounts.find((account) => account.id === id) : undefined
  if (!account) throw new Error('Learning Claude requires an explicit existing account assignment')
  if (account.credentialDir && !isAbsolute(account.credentialDir))
    throw new Error('Learning Claude credential route is invalid')
  return { accountId: account.id, env: claudeAccountEnv(account) }
}
export function qualifyLearningClaudePackage(
  packages: Array<{
    name?: string
    version?: string
    installed: boolean
    installPath?: string
    resources?: { extensions: string[] }
  }>,
) {
  const providers = packages.filter(
    (pkg) => pkg.installed && pkg.name === '@saccolabs/pi-claude-cli',
  )
  const provider = providers[0]
  if (
    providers.length !== 1 ||
    !provider?.version ||
    !/^\d+\.\d+\.\d+$/.test(provider.version) ||
    compareVersions(provider.version, '0.11.0') < 0 ||
    !provider.installPath ||
    provider.resources?.extensions.length !== 1
  )
    throw new Error(
      'Learning requires exactly one installed qualified pi-claude-cli >=0.11.0 piSingleResponse:1 provider',
    )
  const extension = provider.resources.extensions[0]!
  if (!isAbsolute(extension)) throw new Error('Learning Claude provider resource is invalid')
  return { providerExtension: extension, claudeVersion: provider.version }
}
