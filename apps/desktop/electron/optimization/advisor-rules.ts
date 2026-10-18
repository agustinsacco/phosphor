import type { AdvisorFinding, SessionMeta } from '@shared/models'
import type { AdvisorInput } from './advisor'

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

export function cacheChurn(sessions: SessionMeta[]): AdvisorFinding | undefined {
  // Cache churn: a lane that re-writes more of its cached context than it
  // reads back is paying for the same tokens repeatedly — the signature of the
  // pre-0.7.0 pi-claude-cli restart bug, or of anything else invalidating the
  // prefix cache.
  const churner = sessions
    .filter(
      (s) =>
        cachedTokens(s) >= CACHE_CHURN_MIN_TOKENS &&
        s.cacheWriteTokens > cachedTokens(s) * CACHE_CHURN_RATIO,
    )
    .sort((a, b) => b.cacheWriteTokens - a.cacheWriteTokens)[0]
  if (churner) {
    return {
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
    }
  }
}

export function headroomCoverage(headroom: AdvisorInput['headroom']): AdvisorFinding | undefined {
  // Headroom coverage: only when the user is not already covered, and phrased
  // by which step is missing.
  if (!headroom.enabled) {
    return {
      id: 'headroom-off',
      severity: 'tip',
      title: 'Tool-result compression is off',
      detail:
        'Headroom compresses large JSON tool results losslessly before they enter the ' +
        'context — measured 38–53% on uniform connector payloads. Enable it below.',
      settingsTab: 'optimization',
    }
  } else if (!headroom.installed) {
    return {
      id: 'headroom-missing',
      severity: 'warning',
      title: 'Compression is enabled but Headroom is not installed',
      detail: 'Sessions run uncompressed until it is. Install it below.',
      settingsTab: 'optimization',
    }
  } else if (!headroom.proxyRunning) {
    return {
      id: 'headroom-down',
      severity: 'warning',
      title: 'The Headroom proxy is not running',
      detail:
        'Compression fails open, so sessions still work — but nothing is being saved. ' +
        'Start the proxy below.',
      settingsTab: 'optimization',
    }
  }
}

export function mcpWeight(mcpServerCount: number): AdvisorFinding | undefined {
  // MCP schema weight: a direct tool's schema rides on every request
  // (measured ~13k tokens/request at 30 tools).
  if (mcpServerCount >= MCP_WEIGHT_THRESHOLD) {
    return {
      id: 'mcp-weight',
      severity: 'tip',
      title: `${mcpServerCount} MCP servers expose tools directly`,
      detail:
        'A direct tool adds its schema to every request. Put the ones this project does ' +
        'not call on every turn back on codemode, where scripts can return only the ' +
        'fields they need: a 5-field projection measured 14× smaller, then compressed ' +
        'a further 44%.',
      settingsTab: 'connectors',
    }
  }
}

export function longSession(sessions: SessionMeta[]): AdvisorFinding | undefined {
  // Long-session drag: past a point, continuing a lane costs more than
  // forking it from a bookmark. Points at primitives that already exist.
  const dragger = sessions
    .filter((s) => s.totalTokens >= LONG_SESSION_TOKENS)
    .sort((a, b) => b.totalTokens - a.totalTokens)[0]
  if (dragger) {
    return {
      id: 'long-session',
      severity: 'tip',
      title: 'A lane is carrying a very long history',
      detail:
        `"${laneLabel(dragger)}" has consumed ${Math.round(dragger.totalTokens / 1_000_000)}M ` +
        'tokens. Forking from a bookmark starts a lane that keeps the conclusions and drops ' +
        'the transcript.',
    }
  }
}

/** Cached-context traffic: what was written into the cache plus what was read. */
function cachedTokens(meta: SessionMeta): number {
  return meta.cacheWriteTokens + meta.cacheReadTokens
}

function laneLabel(meta: SessionMeta): string {
  const text = meta.name ?? meta.firstUserText ?? 'untitled lane'
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
}
