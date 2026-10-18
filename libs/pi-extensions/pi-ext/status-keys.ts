/** Case-sensitive wire literals; safe to import in a browser or inside pi. */
export const SWARM_STATUS_KEY = 'phosphor-swarm'
export const CONTEXT_BREAKDOWN_STATUS_KEY = 'phosphor-context-breakdown'
export const LANE_RELOAD_STATUS_KEY = 'phosphor-reload'
export const HEADROOM_STATUS_KEY = 'phosphor-headroom'
export const RATE_LIMIT_STATUS_KEY = 'claude-rate-limit'
/** Compatibility with Claude provider sessions recorded before 0.9.0. */
export const SUBAGENTS_STATUS_KEY = 'claude-subagents'

export const SUBAGENT_ASYNC_WIDGET_KEY = 'subagent-async'
export const SUBAGENT_INSPECT_WIDGET_KEY = 'subagent-inspect'
export const SUBAGENT_ASYNC_WIDGET_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
export const SUBAGENT_INSPECT_WIDGET_PREFIX = 'PI_SUBAGENT_INSPECT_JSON:'
export const SNAPSHOT_WIDGET = 'phosphor-subagent-save'
export const SNAPSHOT_PREFIX = 'PHOSPHOR_SUBAGENT_SAVE:'

// Commands are a distinct channel, even when their names also identify statuses.
// The context budget has a command only, not a status key.
export const CONTEXT_BUDGET_COMMAND = 'phosphor-context-budget'
export const CONTEXT_FILES_COMMAND = 'phosphor-context-files'
export const SNAPSHOT_COMMAND = 'phosphor-save-subagent-snapshot'
export const SWARM_COMMAND = 'phosphor-swarm'
export const LANE_RELOAD_COMMAND = 'phosphor-reload'
