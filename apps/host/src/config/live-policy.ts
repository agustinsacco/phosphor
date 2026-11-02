import { normalizeAgentDirectives, type AgentDirectivePrefs } from '@phosphor/shared/models'
import { settingsFile } from '../settings/files'
import { validateHostConfig, type HostConfigV1 } from './schema'

/** The config as it is on disk now, or null while it cannot be read or is invalid. */
function currentConfig(configPath: string): HostConfigV1 | null {
  try {
    const current = validateHostConfig(settingsFile(configPath).raw)
    if (current.ok) return current.config
  } catch {
    // Unreadable now (mid-edit, or replaced by something unsafe).
  }
  return null
}

/**
 * The directive toggles as the config holds them now, read at each lane start
 * so a change in Settings applies to the next lane without a service restart.
 * A config that cannot be read keeps the toggles the Host started with.
 */
export function hostDirectives(
  configPath: string,
  started: Pick<HostConfigV1, 'agentDirectives'>,
): () => AgentDirectivePrefs {
  return () => normalizeAgentDirectives((currentConfig(configPath) ?? started).agentDirectives)
}

/**
 * The context budget as the config holds it now, in Desktop's grammar ('' is
 * the 200k default). Read at each lane start and each settled turn, so a change
 * in Settings applies to the next lane, and to a running lane's next check,
 * without a service restart. An unreadable config keeps the starting budget.
 */
export function hostContextBudget(
  configPath: string,
  started: Pick<HostConfigV1, 'contextBudget'>,
): () => string {
  return () => (currentConfig(configPath) ?? started).contextBudget ?? ''
}

/** The runtime's per-lane readers of the Host config's policy. */
export function hostLivePolicy(configPath: string, started: HostConfigV1) {
  return {
    agentDirectives: hostDirectives(configPath, started),
    contextBudget: hostContextBudget(configPath, started),
  }
}
