import type { MachineSettings } from '@phosphor/shared/machine-settings'
import { parseSettingsPatch } from '@phosphor/shared/machine-settings'
import { type SettingsContext, settingsHash } from './context'
import { SettingsFailure } from './files'
import { changeAgentSettings } from './agent-settings'
import { changeConnectorSettings } from './connector-settings'
import { changeProviderSettings } from './provider-settings'
import type { SettingsSnapshot } from './snapshot'

export async function applySettings(
  state: SettingsContext,
  snapshot: SettingsSnapshot,
  raw: unknown,
  authorized: () => boolean,
): Promise<MachineSettings> {
  const input = parseSettingsPatch(raw)
  if (!input) throw new SettingsFailure('bad-request', 'Invalid settings change.')
  if (!authorized()) throw new SettingsFailure('forbidden', 'Configuration access is not granted.')
  const cwd = state.workspace(input.repositoryId)
  const change = input.change
  const before: MachineSettings =
    input.section === 'providers'
      ? {
          section: input.section,
          revision: settingsHash(await state.options.accounts.loadAccounts()),
        }
      : await snapshot(input.section, input.repositoryId)
  if (before.revision !== input.revision)
    throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
  if (!authorized()) throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
  const commitAllowed = () => {
    if (!authorized()) return false
    if (state.revision(input.section, cwd) !== input.revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    return true
  }
  switch (change.type) {
    case 'claude.routing':
    case 'claude.remove':
    case 'claude.reorder':
    case 'claude.refreshUsage':
    case 'claude.usage':
      await changeProviderSettings(state, change)
      break
    case 'agent.patch':
      await changeAgentSettings(state, input, change.patch, cwd, commitAllowed)
      break
    default:
      await changeConnectorSettings(state, change, before, cwd, input.revision, commitAllowed)
  }
  return snapshot(input.section, input.repositoryId, true)
}
