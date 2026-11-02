import { normalizeAgentDirectives, type AgentDirectivePrefs } from '@phosphor/shared/models'
import { settingsFile, HOST_FILE_POLICY } from '@phosphor/session-runtime/pi/settings-file'
import { validateHostConfig, type HostConfigV1 } from './schema'

/** The config as it is on disk now, or null while it cannot be read or is invalid. */
function currentConfig(configPath: string): HostConfigV1 | null {
  try {
    const current = validateHostConfig(settingsFile(configPath, HOST_FILE_POLICY).raw)
    if (current.ok) return current.config
  } catch {
    // Unreadable now (mid-edit, or replaced by something unsafe).
  }
  return null
}

/** The config now, or the last valid one read: at first, the one the Host started with. */
function lastValidConfig<T extends Partial<HostConfigV1>>(configPath: string, started: T) {
  let last: T | HostConfigV1 = started
  return () => (last = currentConfig(configPath) ?? last)
}

/**
 * The directive toggles as the config holds them now, read at each lane start
 * so a change in Settings applies to the next lane without a service restart.
 * A config that cannot be read keeps the last valid toggles.
 */
export function hostDirectives(
  configPath: string,
  started: Pick<HostConfigV1, 'agentDirectives'>,
): () => AgentDirectivePrefs {
  const read = lastValidConfig(configPath, started)
  return () => normalizeAgentDirectives(read().agentDirectives)
}

/**
 * The context budget as the config holds it now, in Desktop's grammar ('' is
 * the 200k default). Read at each lane start, prompt and settled turn, so a
 * change in Settings applies to the next lane, and to a running lane's next
 * check, without a service restart. An unreadable config keeps the last valid budget.
 */
export function hostContextBudget(
  configPath: string,
  started: Pick<HostConfigV1, 'contextBudget'>,
): () => string {
  const read = lastValidConfig(configPath, started)
  return () => read().contextBudget ?? ''
}

/**
 * Whether new lanes are named automatically, as the config holds it now. Read
 * at each lane's first prompt, so the switch in Settings applies to the next
 * lane without a service restart. An unreadable config keeps the last valid value.
 */
export function hostAutoNameLanes(
  configPath: string,
  started: Pick<HostConfigV1, 'autoNameLanes'>,
): () => boolean {
  const read = lastValidConfig(configPath, started)
  return () => read().autoNameLanes !== false
}

/** The runtime's per-lane readers of the Host config's policy. */
export function hostLivePolicy(configPath: string, started: HostConfigV1) {
  return {
    agentDirectives: hostDirectives(configPath, started),
    contextBudget: hostContextBudget(configPath, started),
  }
}
