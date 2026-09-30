import { DEFAULT_AGENT_PREFS, normalizeAgentPrefs, type AgentPrefs } from '@shared/models'

/**
 * The agent new sessions run on (Settings → Advanced → Agent), as the main
 * process currently believes it.
 *
 * Module state rather than a prefs read per call: the readers — session-dir
 * paths, health, every spawn — sit below `electron/store.ts`, which needs a
 * running Electron app. Keeping them free of it is what lets the unit tests
 * and `scripts/omp-compat.ts` drive the same code in plain Node. main installs
 * the stored choice before it registers IPC, and `app:setAgent` replaces it.
 *
 * Until then it is pi with no binary override — exactly the behaviour every
 * build had before the choice existed.
 */
let active: AgentPrefs = DEFAULT_AGENT_PREFS

export function activeAgent(): AgentPrefs {
  return active
}

/** Install a (possibly hand-edited) stored choice; returns what took effect. */
export function setActiveAgent(prefs: unknown): AgentPrefs {
  active = normalizeAgentPrefs(prefs)
  return active
}
