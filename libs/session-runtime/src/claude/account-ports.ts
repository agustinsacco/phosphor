import type {
  ClaudeAccountPrefs,
  ClaudeStatus,
  ClaudeUsageSnapshot,
  ClaudeUsageSnapshotResult,
} from '@shared/models'

export interface ClaudeAccountPorts {
  root: string
  read(): ClaudeAccountPrefs
  write(prefs: ClaudeAccountPrefs): void
  status(override?: string, env?: Record<string, string>): Promise<ClaudeStatus>
  logout(override?: string, env?: Record<string, string>): Promise<void>
  cachedUsage(id: string, now: number): ClaudeUsageSnapshot | null
  clearUsage(id: string): void
  fetchUsage(options: {
    cacheKey: string
    extraEnv: Record<string, string>
    claudeOverride?: string
  }): Promise<ClaudeUsageSnapshotResult>
}
