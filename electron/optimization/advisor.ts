import type { AdvisorFinding, SessionMeta } from '@shared/models'

/**
 * The Optimization tab's Advisor: a rules engine over data Phosphor already
 * holds. Every rule is a pure function of its inputs, every finding is advice
 * with a pointer at the surface that owns the fix, and nothing here ever
 * acts — the 2026-09-03 orchestration removal stays removed
 * (docs/specs/optimization-surface.md).
 *
 * Thresholds are deliberately conservative first ships; tune from real
 * fleets, not intuition.
 */

export interface AdvisorInput {
  headroom: { enabled: boolean; installed: boolean; proxyRunning: boolean }
  sessions: SessionMeta[]
  /** Enabled MCP servers resolved for this workspace. */
  mcpServerCount: number
}

/**
 * Share of a lane's CACHED traffic that had to be re-written rather than read.
 *
 * Deliberately not a share of `totalTokens`. pi's per-message
 * `usage.totalTokens` is the provider's own number — on pi-claude-cli it
 * tracks the request's context size and excludes `cacheRead` — so summing it
 * across turns produces a quantity that a cumulative `cacheWrite` cannot
 * meaningfully be divided by. Measured on a real lane: 528k written against
 * 13.4M read (healthy reuse) read as "96% cache writes" against a 549k
 * totalTokens sum, and the rule fired SERIOUS on a lane doing nothing wrong.
 * `cacheWrite ÷ (cacheWrite + cacheRead)` is the fraction the rule means.
 */
const CACHE_CHURN_RATIO = 0.5
/** Below this much cached traffic the ratio is noise. */
const CACHE_CHURN_MIN_TOKENS = 200_000

/** Servers whose schemas ride on every request before the tip fires. */
const MCP_WEIGHT_THRESHOLD = 3

/** A single session this deep into re-reads is cheaper forked than continued. */
const LONG_SESSION_TOKENS = 5_000_000

export function adviseOptimization(input: AdvisorInput): AdvisorFinding[] {
  const findings: AdvisorFinding[] = []

  // Cache churn: a lane that re-writes more of its cached context than it
  // reads back is paying for the same tokens repeatedly — the signature of the
  // pre-0.7.0 pi-claude-cli restart bug, or of anything else invalidating the
  // prefix cache.
  const churner = input.sessions
    .filter(
      (s) =>
        cachedTokens(s) >= CACHE_CHURN_MIN_TOKENS &&
        s.cacheWriteTokens > cachedTokens(s) * CACHE_CHURN_RATIO,
    )
    .sort((a, b) => b.cacheWriteTokens - a.cacheWriteTokens)[0]
  if (churner) {
    findings.push({
      id: 'cache-churn',
      severity: 'serious',
      title: 'A lane is re-writing its context cache',
      detail:
        `"${laneLabel(churner)}" re-wrote ${Math.round(
          (churner.cacheWriteTokens / cachedTokens(churner)) * 100,
        )}% of its cached context instead of reading it back. Two known causes: a ` +
        'pi-claude-cli older than 0.7.0 restarts the CLI on every turn and every tool call, ' +
        'and long gaps between turns let the provider’s prompt cache expire.',
      settingsTab: 'claude-provider',
    })
  }

  // Headroom coverage: only when the user is not already covered, and phrased
  // by which step is missing.
  if (!input.headroom.enabled) {
    findings.push({
      id: 'headroom-off',
      severity: 'tip',
      title: 'Tool-result compression is off',
      detail:
        'Headroom compresses large JSON tool results losslessly before they enter the ' +
        'context — measured 38–53% on uniform connector payloads. Enable it below.',
      settingsTab: 'optimization',
    })
  } else if (!input.headroom.installed) {
    findings.push({
      id: 'headroom-missing',
      severity: 'warning',
      title: 'Compression is enabled but Headroom is not installed',
      detail: 'Sessions run uncompressed until it is. Install it below.',
      settingsTab: 'optimization',
    })
  } else if (!input.headroom.proxyRunning) {
    findings.push({
      id: 'headroom-down',
      severity: 'warning',
      title: 'The Headroom proxy is not running',
      detail:
        'Compression fails open, so sessions still work — but nothing is being saved. ' +
        'Start the proxy below.',
      settingsTab: 'optimization',
    })
  }

  // MCP schema weight: every connected server's tool schemas ride on every
  // request of a Claude session (measured ~13k tokens/request at 30 tools).
  if (input.mcpServerCount >= MCP_WEIGHT_THRESHOLD) {
    findings.push({
      id: 'mcp-weight',
      severity: 'tip',
      title: `${input.mcpServerCount} MCP servers are connected`,
      detail:
        'Each server adds its tool schemas to every request. Disconnect the ones this ' +
        'project does not use, and prefer field-projected mcpScript calls over raw list ' +
        'tools — a 5-field projection measured 14× smaller, then compressed a further 44%.',
      settingsTab: 'connectors',
    })
  }

  // Long-session drag: past a point, continuing a lane costs more than
  // forking it from a bookmark. Points at primitives that already exist.
  const dragger = input.sessions
    .filter((s) => s.totalTokens >= LONG_SESSION_TOKENS)
    .sort((a, b) => b.totalTokens - a.totalTokens)[0]
  if (dragger) {
    findings.push({
      id: 'long-session',
      severity: 'tip',
      title: 'A lane is carrying a very long history',
      detail:
        `"${laneLabel(dragger)}" has consumed ${Math.round(dragger.totalTokens / 1_000_000)}M ` +
        'tokens. Forking from a bookmark starts a lane that keeps the conclusions and drops ' +
        'the transcript.',
    })
  }

  const rank: Record<AdvisorFinding['severity'], number> = { serious: 0, warning: 1, tip: 2 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/** Cached-context traffic: what was written into the cache plus what was read. */
function cachedTokens(meta: SessionMeta): number {
  return meta.cacheWriteTokens + meta.cacheReadTokens
}

function laneLabel(meta: SessionMeta): string {
  const text = meta.name ?? meta.firstUserText ?? 'untitled lane'
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
}
