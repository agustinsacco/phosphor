import { normalizeAgentDirectives, type AgentDirectivePrefs } from '@phosphor/shared/models'
import { settingsFile } from '../settings/files'
import { validateHostConfig, type HostConfigV1 } from './schema'

/**
 * The directive toggles as the config holds them now, read at each lane start
 * so a change in Settings applies to the next lane without a service restart.
 * A config that cannot be read keeps the toggles the Host started with.
 */
export function hostDirectives(
  configPath: string,
  started: Pick<HostConfigV1, 'agentDirectives'>,
): () => AgentDirectivePrefs {
  return () => {
    try {
      const current = validateHostConfig(settingsFile(configPath).raw)
      if (current.ok) return normalizeAgentDirectives(current.config.agentDirectives)
    } catch {
      // Unreadable now (mid-edit, or replaced by something unsafe).
    }
    return normalizeAgentDirectives(started.agentDirectives)
  }
}
