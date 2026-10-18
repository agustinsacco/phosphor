import type { AdvisorFinding, SessionMeta } from '@shared/models'
import { cacheChurn, headroomCoverage, longSession, mcpWeight } from './advisor-rules'

/**
 * The Optimization tab's Advisor: a rules engine over data Phosphor already
 * holds. Every rule is a pure function of its inputs, every finding is advice
 * with a pointer at the surface that owns the fix, and nothing here ever
 * acts — the 2026-09-03 orchestration removal stays removed, and a rules
 * engine that acted would grow back the derived state that made it too
 * expensive to keep.
 *
 * Thresholds are deliberately conservative first ships; tune from real
 * fleets, not intuition.
 */

export interface AdvisorInput {
  headroom: { enabled: boolean; installed: boolean; proxyRunning: boolean }
  sessions: SessionMeta[]
  /**
   * Enabled MCP servers for this workspace that expose tools directly. A
   * codemode or deferred server sends no schemas until a tool is used.
   */
  mcpServerCount: number
}

export function adviseOptimization(input: AdvisorInput): AdvisorFinding[] {
  const findings = [
    cacheChurn(input.sessions),
    headroomCoverage(input.headroom),
    mcpWeight(input.mcpServerCount),
    longSession(input.sessions),
  ].filter((finding): finding is AdvisorFinding => finding !== undefined)

  const rank: Record<AdvisorFinding['severity'], number> = { serious: 0, warning: 1, tip: 2 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}
