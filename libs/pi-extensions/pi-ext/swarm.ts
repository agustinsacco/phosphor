/** Lane authorization, not an agent runner. Loaded by context-breakdown.ts. */
export const SWARM_COMMAND = 'phosphor-swarm'
export const SWARM_STATUS_KEY = 'phosphor-swarm'
export const SWARM_SECTION = 'phosphor_swarm'
export const SWARM_PROMPT =
  'Swarm is enabled for this lane. Proactive delegation and orchestration are authorized when useful. Follow pi-subagents guidance. Existing task scope and permissions still apply.'

export interface SwarmStatus {
  version: 1
  available: boolean
  enabled: boolean
  requested: boolean
}

export function parseSwarmStatus(text: string | undefined): SwarmStatus | null {
  try {
    const value = JSON.parse(text ?? '') as SwarmStatus | null
    return value?.version === 1 &&
      typeof value.available === 'boolean' &&
      typeof value.enabled === 'boolean' &&
      typeof value.requested === 'boolean'
      ? value
      : null
  } catch {
    return null
  }
}

interface SwarmContext {
  isIdle(): boolean
  sessionManager: { getSessionId(): string; getBranch(): unknown[] }
  ui: { setStatus(key: string, text: string): void }
}
interface SwarmApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  getAllTools?(): unknown
  getActiveTools?(): unknown
  appendEntry?(type: string, data: unknown): void
  registerCommand?(
    name: string,
    command: { description: string; handler(args: string, ctx: unknown): Promise<void> },
  ): void
}

/** Only this branch AND this session can grant authority; forks/clones start off. */
export function savedSwarm(branch: unknown[], sessionId: string): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as
      | { type?: string; customType?: string; data?: { sessionId?: string; enabled?: unknown } }
      | undefined
    if (entry?.type === 'custom' && entry.customType === SWARM_COMMAND)
      return entry.data?.sessionId === sessionId && entry.data.enabled === true
  }
  return false
}

/** Request-local: never persist authorization in the conversation's system messages. */
export function applySwarmContext(messages: unknown[], enabled: boolean): void {
  let first = true
  for (const message of messages) {
    const m = message as { role?: string; sections?: Record<string, string | null> } | null
    if (m?.role !== 'system') continue
    // Also remove an old declaration/patch if one arrives from a recorded fork.
    if (m.sections) delete m.sections[SWARM_SECTION]
    if (first && enabled) {
      m.sections ??= {}
      m.sections[SWARM_SECTION] = `<${SWARM_SECTION}>\n${SWARM_PROMPT}\n</${SWARM_SECTION}>`
    }
    first = false
  }
}

export default function swarm(
  pi: SwarmApi,
  onChange: (ctx: unknown) => void = () => undefined,
): { tokens: () => number } {
  let requested = false
  let enabled = false
  function available(): boolean {
    const all = pi.getAllTools?.()
    const active = pi.getActiveTools?.()
    return (
      Array.isArray(all) &&
      all.some((t) => t?.name === 'subagent') &&
      Array.isArray(active) &&
      (active.includes('subagent') || active.includes('subagents_enable'))
    )
  }
  function publish(ctx: SwarmContext): void {
    const status: SwarmStatus = { version: 1, available: available(), enabled, requested }
    ctx.ui.setStatus(SWARM_STATUS_KEY, JSON.stringify(status))
    onChange(ctx)
  }
  function apply(ctx: SwarmContext): void {
    enabled = requested && available()
    publish(ctx)
  }
  const restore = (_event: unknown, context: unknown): void => {
    const ctx = context as SwarmContext
    requested = savedSwarm(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
    apply(ctx)
  }
  pi.on('session_start', restore)
  pi.on('session_tree', restore)
  pi.registerCommand?.(SWARM_COMMAND, {
    description: 'Host control: toggle lane Swarm authorization without running a model',
    async handler(args, context) {
      const ctx = context as SwarmContext
      if (args !== 'on' && args !== 'off') throw new Error('Expected swarm on or off.')
      if (args === 'on' && !available())
        throw new Error('Swarm requires pi-subagents loaded and available in this session.')
      if (!pi.appendEntry) throw new Error('This Pi version cannot persist Swarm authorization.')
      const next = args === 'on'
      pi.appendEntry(SWARM_COMMAND, { enabled: next, sessionId: ctx.sessionManager.getSessionId() })
      requested = next
      if (ctx.isIdle()) apply(ctx)
      else publish(ctx) // Do not change authorization beneath an in-flight turn.
    },
  })
  pi.on('agent_end', (_event, ctx) => apply(ctx as SwarmContext))
  pi.on('context_with_system', (event, ctx) => {
    // Recheck after tool/provider changes without granting new authority.
    if (enabled && !available()) {
      enabled = false
      publish(ctx as SwarmContext)
    }
    const messages = (event as { messages: unknown[] }).messages
    applySwarmContext(messages, enabled)
    return { messages }
  })
  return {
    tokens: () =>
      enabled ? Math.ceil((SWARM_PROMPT.length + SWARM_SECTION.length * 2 + 7) / 4) : 0,
  }
}
