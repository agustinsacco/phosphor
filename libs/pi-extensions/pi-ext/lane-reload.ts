/**
 * `/phosphor-reload <token>`: rebuild this lane's extensions between turns so
 * configuration they read at startup (MCP servers above all) reaches a lane
 * that is already running.
 *
 * pi's reload keeps the process, the transcript, the model and the thinking
 * level, and starts every extension again from its module (verified on pi
 * 1.2.0's built-in MCP: a disabled server's tools are gone and a newly
 * enabled one is back, with its exposure, on the next request). Phosphor main sends this right
 * before a prompt, only when the lane's MCP config changed since it loaded it
 * (`libs/session-runtime/src/pi/lane-reload.ts`).
 *
 * It is refused, never forced, when:
 * - the lane is mid-run (pi would rebuild tools under a running turn);
 * - sub-agent work is live. pi-subagents keeps background children across a
 *   reload, but stops a running async workflow and any detached foreground
 *   child, and a completion waiting to be delivered must reach the parent
 *   first. It reports this through the versioned liveness registry pi-web
 *   defines, which this extension provides when no host has.
 *
 * The outcome is a status (`LANE_RELOAD_STATUS_KEY`, JSON `{ token, outcome }`)
 * rather than an error: a thrown command error becomes a red line in the
 * transcript, and a refusal is routine. "applied" is published by the NEW
 * runtime's `session_start`, so it also proves the rebuild finished.
 *
 * Self-contained because pi loads this file on its own, outside Phosphor's
 * module graph.
 */

export const LANE_RELOAD_COMMAND = 'phosphor-reload'
export const LANE_RELOAD_STATUS_KEY = 'phosphor-reload'

export type LaneReloadOutcome = 'applied' | 'busy' | 'subagents' | 'failed'

const LIVENESS_REGISTRY = Symbol.for('@agegr/pi-web/session-liveness/v1')
/** Survives the module reload (pi loads extensions with no module cache). */
const PENDING = Symbol.for('phosphor/lane-reload/pending/v1')
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/

interface LivenessProvider {
  name?: string
  sessionId?: string
  isActive?: () => boolean
}

interface LivenessRegistry {
  version: 1
  register(provider: LivenessProvider): () => void
  /** Ours only: the registered providers, so the command can ask them. */
  phosphorProviders?: Set<LivenessProvider>
}

type GlobalSlots = { [LIVENESS_REGISTRY]?: unknown; [PENDING]?: string }

/**
 * The liveness registry pi-subagents looks for on `globalThis`. Created at
 * load, before any `session_start`, so pi-subagents registers with it. Returns
 * null when another host owns one this extension cannot read.
 */
export function ensureLivenessRegistry(slots: object = globalThis): LivenessRegistry | null {
  const g = slots as GlobalSlots
  const existing = g[LIVENESS_REGISTRY] as LivenessRegistry | undefined
  if (existing) return existing.phosphorProviders ? existing : null
  const providers = new Set<LivenessProvider>()
  const registry: LivenessRegistry = {
    version: 1,
    phosphorProviders: providers,
    register(provider) {
      providers.add(provider)
      return () => void providers.delete(provider)
    },
  }
  g[LIVENESS_REGISTRY] = registry
  return registry
}

/** Whether any provider says this session still has work that a reload would cut. */
export function hasLiveWork(registry: LivenessRegistry | null, sessionId: string): boolean {
  // A registry we cannot read cannot clear the lane.
  if (!registry?.phosphorProviders) return true
  for (const provider of registry.phosphorProviders) {
    if (provider.sessionId !== sessionId) continue
    try {
      if (provider.isActive?.() !== false) return true
    } catch {
      return true
    }
  }
  return false
}

interface ReloadContext {
  isIdle(): boolean
  reload(): Promise<void>
  sessionManager: { getSessionId(): string }
  ui: { setStatus(key: string, text: string | undefined): void }
}

interface LaneReloadApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  registerCommand?(
    name: string,
    command: { description: string; handler(args: string, ctx: ReloadContext): Promise<void> },
  ): void
}

function report(
  ui: ReloadContext['ui'] | undefined,
  token: string,
  outcome: LaneReloadOutcome,
): void {
  try {
    ui?.setStatus(LANE_RELOAD_STATUS_KEY, JSON.stringify({ token, outcome }))
  } catch {
    // A context made stale by a failed reload has nowhere left to report.
  }
}

export default function laneReload(pi: LaneReloadApi, slots: object = globalThis): void {
  const registry = ensureLivenessRegistry(slots)
  const g = slots as GlobalSlots

  pi.registerCommand?.(LANE_RELOAD_COMMAND, {
    description: 'Host control: reload extensions between turns to pick up changed configuration',
    async handler(args, ctx) {
      const token = args.trim()
      if (!TOKEN.test(token)) throw new Error('Invalid reload request.')
      if (!ctx.isIdle()) return report(ctx.ui, token, 'busy')
      if (hasLiveWork(registry, ctx.sessionManager.getSessionId()))
        return report(ctx.ui, token, 'subagents')
      g[PENDING] = token
      const ui = ctx.ui
      try {
        // Nothing from this runtime may be used after this resolves.
        await ctx.reload()
      } catch {
        if (g[PENDING] === token) {
          delete g[PENDING]
          report(ui, token, 'failed')
        }
      }
    },
  })

  pi.on('session_start', (event, ctx) => {
    const token = g[PENDING]
    if (!token || (event as { reason?: string } | undefined)?.reason !== 'reload') return
    delete g[PENDING]
    report((ctx as ReloadContext | undefined)?.ui, token, 'applied')
  })
}
