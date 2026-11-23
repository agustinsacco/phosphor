import type { SwarmFacts } from '@phosphor/shared/ops'
import type { LaneControl } from './types/lane-control'

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
  source?: 'agent'
  reason?: string
}

export function parseSwarmStatus(text: string | undefined): SwarmStatus | null {
  try {
    const value = JSON.parse(text ?? '') as SwarmStatus | null
    if (
      value?.version !== 1 ||
      typeof value.available !== 'boolean' ||
      typeof value.enabled !== 'boolean' ||
      typeof value.requested !== 'boolean'
    )
      return null
    const { source, reason, ...status } = value
    return {
      ...status,
      ...(source === 'agent' && { source }),
      ...(typeof reason === 'string' && { reason: reason.slice(0, 200) }),
    }
  } catch {
    return null
  }
}

interface SwarmContext {
  isIdle(): boolean
  sessionManager: {
    getSessionId(): string
    getBranch(): unknown[]
    getHeader?(): { parentSession?: string } | null
  }
  ui: { setStatus(key: string, text: string): void; notify(message: string): void }
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

interface SwarmDecision {
  enabled: boolean
  by: 'user' | 'agent'
  reason?: string
}

function lastSwarm(branch: unknown[], sessionId: string, inherit = false): SwarmDecision | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as
      | {
          type?: string
          customType?: string
          data?: Partial<Record<'sessionId' | 'enabled' | 'by' | 'reason', unknown>>
        }
      | undefined
    if (entry?.type !== 'custom' || entry.customType !== SWARM_COMMAND) continue
    const data = entry.data
    if ((!inherit && data?.sessionId !== sessionId) || typeof data?.enabled !== 'boolean')
      return null
    return {
      enabled: data.enabled,
      by: data.by === 'agent' ? 'agent' : 'user',
      ...(typeof data.reason === 'string' && { reason: data.reason }),
    }
  }
  return null
}

/** Inheritance is explicit at startup; ordinary restoration remains identity-scoped. */
export function savedSwarm(branch: unknown[], sessionId: string, inherit = false): boolean {
  return lastSwarm(branch, sessionId, inherit)?.enabled === true
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

function persist(pi: SwarmApi, ctx: SwarmContext, decision: SwarmDecision): void {
  if (!pi.appendEntry) throw new Error('This Pi version cannot persist Swarm authorization.')
  pi.appendEntry(SWARM_COMMAND, { ...decision, sessionId: ctx.sessionManager.getSessionId() })
}

function available(pi: SwarmApi): boolean {
  const all = pi.getAllTools?.()
  const active = pi.getActiveTools?.()
  return (
    Array.isArray(all) &&
    all.some((t) => t?.name === 'subagent') &&
    Array.isArray(active) &&
    (active.includes('subagent') || active.includes('subagents_enable'))
  )
}

const UNAVAILABLE = 'Swarm requires pi-subagents loaded and available in this session.'

function swarmPolicy(pi: SwarmApi, onChange: (ctx: unknown) => void) {
  let last: SwarmDecision | null = null
  let enabled = false
  function facts(): SwarmFacts {
    return {
      available: available(pi),
      requested: last?.enabled === true,
      enabled,
      lastBy: last?.by ?? 'user',
      userOff: last?.by === 'user' && !last.enabled,
    }
  }
  function publish(ctx: SwarmContext): void {
    const status: SwarmStatus = {
      version: 1,
      available: available(pi),
      enabled,
      requested: last?.enabled === true,
    }
    if (last?.by === 'agent' && last.enabled) {
      status.source = 'agent'
      if (last.reason) status.reason = last.reason
    }
    ctx.ui.setStatus(SWARM_STATUS_KEY, JSON.stringify(status))
    onChange(ctx)
  }
  function apply(ctx: SwarmContext): void {
    enabled = last?.enabled === true && available(pi)
    publish(ctx)
  }
  function restore(ctx: SwarmContext, inherit: boolean): void {
    const branch = ctx.sessionManager.getBranch()
    const id = ctx.sessionManager.getSessionId()
    last = lastSwarm(branch, id)
    if (!last && inherit && ctx.sessionManager.getHeader?.()?.parentSession) {
      const inherited = lastSwarm(branch, id, true)
      if (inherited) {
        persist(pi, ctx, inherited)
        last = inherited
      }
    }
    apply(ctx)
  }
  function write(ctx: SwarmContext, decision: SwarmDecision): void {
    persist(pi, ctx, decision)
    last = decision
    if (decision.by === 'agent' || ctx.isIdle()) apply(ctx)
    else publish(ctx) // Only the user's toggle waits for a turn boundary.
  }
  return { facts, apply, restore, write, enabled: () => enabled }
}

export function createSwarmLaneControl(
  deps: Pick<ReturnType<typeof swarmPolicy>, 'facts' | 'write'>,
): LaneControl<SwarmFacts> {
  return {
    facts: deps.facts,
    agentSet(next, reason, context) {
      const ctx = context as SwarmContext
      const facts = deps.facts()
      if (next && !facts.available) throw new Error(UNAVAILABLE)
      if (!reason.trim()) throw new Error('Changing Swarm requires a reason.')
      if (facts.userOff) {
        if (next)
          throw new Error('The user turned Swarm off for this lane. Ask them to turn it on.')
        return // A redundant agent off must not overwrite the user's veto.
      }
      deps.write(ctx, { enabled: next, by: 'agent', reason: reason.trim() })
      ctx.ui.notify(`Agent turned ${next ? 'on' : 'off'} Swarm: ${reason.trim()}.`)
    },
  }
}

export default function swarm(
  pi: SwarmApi,
  onChange: (ctx: unknown) => void = () => undefined,
): { tokens: () => number; control: LaneControl<SwarmFacts> } {
  const policy = swarmPolicy(pi, onChange)
  pi.on('session_start', (_event, ctx) => policy.restore(ctx as SwarmContext, true))
  pi.on('session_tree', (_event, ctx) => policy.restore(ctx as SwarmContext, false))
  pi.registerCommand?.(SWARM_COMMAND, {
    description: 'Host control: toggle lane Swarm authorization without running a model',
    async handler(args, context) {
      if (args !== 'on' && args !== 'off') throw new Error('Expected swarm on or off.')
      if (args === 'on' && !available(pi)) throw new Error(UNAVAILABLE)
      policy.write(context as SwarmContext, { enabled: args === 'on', by: 'user' })
    },
  })
  // A user toggle after agent_end applies on settlement or the next run's start.
  for (const boundary of ['agent_end', 'agent_settled', 'agent_start']) {
    pi.on(boundary, (_event, ctx) => policy.apply(ctx as SwarmContext))
  }
  pi.on('context_with_system', (event, ctx) => {
    // Recheck after tool/provider changes without granting new authority.
    if (policy.enabled() && !available(pi)) policy.apply(ctx as SwarmContext)
    const messages = (event as { messages: unknown[] }).messages
    applySwarmContext(messages, policy.enabled())
    return { messages }
  })
  return {
    control: createSwarmLaneControl(policy),
    tokens: () =>
      policy.enabled() ? Math.ceil((SWARM_PROMPT.length + SWARM_SECTION.length * 2 + 7) / 4) : 0,
  }
}
