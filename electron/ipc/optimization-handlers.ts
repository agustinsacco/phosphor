import type { LaneSavings, OptimizationStats } from '@shared/models'
import { handle } from './handle'
import { headroomSupervisor } from '../headroom/proxy'
import { runHeadroomInstall } from '../headroom/install'
import { listSessions } from '../pi/session-scanner'
import { readMcpConfigs } from '../pi/mcp-config'
import { adviseOptimization } from '../optimization/advisor'
import { getPrefs } from '../store'

/** How many per-lane savings rows the tab shows. */
const MAX_LANES = 8

/**
 * The Optimization surface: Headroom lifecycle plus read-only savings and
 * Advisor stats. Everything in `optimization:stats` is a projection of the
 * disk scan and current config — opening the tab never starts the proxy and
 * never installs anything (it does resolve `headroom` on the login-shell
 * PATH, which is one short-lived `sh`, cached either way).
 */
export function registerOptimizationHandlers(): void {
  const supervisor = headroomSupervisor()

  handle('headroom:status', () => supervisor.status())
  handle('headroom:setEnabled', (_event, enabled) => supervisor.setEnabled(enabled))
  handle('headroom:start', () => supervisor.start())
  handle('headroom:stop', () => supervisor.stop())
  handle('headroom:install', (event) => runHeadroomInstall(event.sender))

  handle('optimization:stats', async (_event, workspacePath): Promise<OptimizationStats> => {
    const [sessions, status, mcp] = await Promise.all([
      listSessions(workspacePath),
      supervisor.status(),
      readMcpConfigs(workspacePath).catch(() => ({ servers: [] })),
    ])

    const lanes: LaneSavings[] = sessions
      .filter((s) => s.headroomSavedTokens > 0)
      .sort((a, b) => b.headroomSavedTokens - a.headroomSavedTokens)
      .slice(0, MAX_LANES)
      .map((s) => ({
        path: s.path,
        ...(s.name ? { name: s.name } : {}),
        ...(s.firstUserText ? { firstUserText: s.firstUserText } : {}),
        savedTokens: s.headroomSavedTokens,
        totalTokens: s.totalTokens,
      }))

    return {
      savedTokens: sessions.reduce((sum, s) => sum + s.headroomSavedTokens, 0),
      sessionsWithSavings: sessions.filter((s) => s.headroomSavedTokens > 0).length,
      sessionCount: sessions.length,
      lanes,
      advisor: adviseOptimization({
        headroom: {
          enabled: status.enabled,
          installed: status.installed,
          proxyRunning: status.proxy.running,
        },
        sessions,
        mcpServerCount: mcp.servers.filter((s) => !s.config.disabled).length,
      }),
    }
  })

  // Enabled from a previous run: bring the proxy up now rather than on the
  // first session spawn, so the first compression does not race the startup.
  if (getPrefs().headroom.enabled) {
    void supervisor.ensure().catch(() => undefined)
  }
}
