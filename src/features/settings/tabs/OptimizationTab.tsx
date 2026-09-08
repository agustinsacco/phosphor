import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import type { AdvisorFinding, HeadroomStatus, OptimizationStats } from '@shared/models'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { StatTile } from '@/components/StatTile'
import { formatTokens } from '@/lib/format'
import { sessionTitle } from '@/lib/sessionTitle'
import { useActiveWorkspace } from '@/stores/workspaces'
import { useSettingsUiStore, type SettingsTab } from '../settingsUiStore'
import { usePackageJob } from '../usePackageJob'

/**
 * Settings → Optimization: manage Headroom (tool-result compression), show
 * what it has saved per lane, and surface the Advisor's recommendations.
 *
 * Read-only by construction except the explicit buttons: opening this tab
 * probes /health but never spawns or installs anything.
 */
export function OptimizationTab(): React.JSX.Element {
  const workspacePath = useActiveWorkspace()
  const [status, setStatus] = useState<HeadroomStatus | null>(null)
  const [stats, setStats] = useState<OptimizationStats | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.phosphor.invoke('headroom:status').catch(() => null)
    setStatus(next)
    if (workspacePath) {
      setStats(await window.phosphor.invoke('optimization:stats', workspacePath).catch(() => null))
    }
  }, [workspacePath])

  const install = usePackageJob(() => void refresh())

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Run one lifecycle action, then re-read both status and stats. */
  const act = async (action: () => Promise<HeadroomStatus>): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await action())
    } catch {
      // Status stays what it was; the next refresh corrects it.
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  return (
    <div>
      <SectionTitle>Optimization</SectionTitle>

      <HeadroomManager
        status={status}
        busy={busy || install.running}
        onToggle={(enabled) => void act(() => window.phosphor.invoke('headroom:setEnabled', enabled))}
        onStart={() => void act(() => window.phosphor.invoke('headroom:start'))}
        onStop={() => void act(() => window.phosphor.invoke('headroom:stop'))}
        onInstall={() => void install.start(() => window.phosphor.invoke('headroom:install'))}
      />

      {(install.running || install.output) && (
        <pre className="bg-bg-secondary border-border text-text-secondary mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-xs">
          {install.output || 'Starting install…'}
          {install.exitCode !== null &&
            `\n— exited ${install.exitCode}${install.exitCode === 0 ? ' (installed)' : ''}`}
        </pre>
      )}

      <SectionTitle small>Savings · {workspaceLabel(workspacePath)}</SectionTitle>
      {stats === null ? (
        <div className="text-text-tertiary text-sm">Reading session files…</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Saved" value={formatTokens(stats.savedTokens)} />
            <StatTile
              label="Lanes with savings"
              value={`${stats.sessionsWithSavings} / ${stats.sessionCount}`}
            />
            <StatTile label="Advisor" value={String(stats.advisor.length)} />
          </div>
          {stats.lanes.length > 0 && (
            <div className="mt-4">
              <div className="text-text-tertiary mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider">
                Saved by lane
              </div>
              {stats.lanes.map((lane) => (
                <div key={lane.path} className="flex items-center gap-2 py-0.5 text-xs">
                  <span className="text-text-secondary w-44 shrink-0 truncate">
                    {sessionTitle({ explicitName: lane.name, firstUserText: lane.firstUserText }) ??
                      'Untitled'}
                  </span>
                  <span className="bg-bg-secondary h-2 min-w-0 flex-1 rounded-full">
                    <span
                      className="bg-accent block h-full rounded-full"
                      style={{
                        width: `${Math.round(
                          (lane.savedTokens / (stats.lanes[0]?.savedTokens || 1)) * 100,
                        )}%`,
                      }}
                    />
                  </span>
                  <span className="text-success w-16 shrink-0 text-right font-mono tabular-nums">
                    −{formatTokens(lane.savedTokens)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <SectionTitle small>Advisor</SectionTitle>
      {stats === null || stats.advisor.length === 0 ? (
        <div className="text-text-tertiary text-sm">
          Nothing to recommend right now. Checks run over your session files and current
          configuration — never a model call, never an action taken for you.
        </div>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          {stats.advisor.map((finding) => (
            <AdvisorRow key={finding.id} finding={finding} />
          ))}
        </div>
      )}
    </div>
  )
}

function HeadroomManager({
  status,
  busy,
  onToggle,
  onStart,
  onStop,
  onInstall,
}: {
  status: HeadroomStatus | null
  busy: boolean
  onToggle: (enabled: boolean) => void
  onStart: () => void
  onStop: () => void
  onInstall: () => void
}): React.JSX.Element {
  if (status === null) {
    return <div className="text-text-tertiary text-sm">Checking Headroom…</div>
  }

  return (
    <div>
      <div className="bg-surface border-border flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3.5 py-2.5 text-sm">
        <StateDot ok={status.installed} />
        <span className="text-text-secondary">
          {status.installed ? (
            <>
              <span className="text-text font-medium">Headroom {status.version ?? ''}</span>
              {' · '}
              {status.proxy.running
                ? `proxy running on ${status.proxy.url.replace('http://', '')}${
                    status.proxy.owned ? '' : ' · adopted'
                  }`
                : 'proxy stopped'}
            </>
          ) : (
            <span className="text-text font-medium">Headroom is not installed</span>
          )}
        </span>
        <span className="min-w-0 flex-1" />
        {status.installed ? (
          status.proxy.running ? (
            // Stop only offers itself for a proxy Phosphor owns — an adopted one
            // belongs to whoever started it.
            status.proxy.owned && (
              <Button size="sm" disabled={busy} onClick={onStop}>
                Stop proxy
              </Button>
            )
          ) : (
            <Button size="sm" disabled={busy} onClick={onStart}>
              Start proxy
            </Button>
          )
        ) : (
          <Button size="sm" variant="primary" disabled={busy} onClick={onInstall}>
            Install with uv…
          </Button>
        )}
      </div>
      {status.error && !status.proxy.running && (
        <div className="text-warning mt-1.5 text-xs">{status.error}</div>
      )}
      {!status.installed && (
        <div className="text-text-tertiary mt-1.5 text-xs">
          A local Python service (~500 MB). The install streams below; Phosphor never installs it in
          the background. Manual alternative:{' '}
          <code className="font-mono">uv tool install --python 3.13 "headroom-ai[proxy]"</code>
        </div>
      )}

      <div className="mt-2">
        <Row
          title="Compress tool results"
          description="Large JSON tool results are restructured losslessly before entering the context — or left untouched, never summarized. The proxy runs on loopback only, with telemetry off, and stops with Phosphor. Applies to new sessions."
        >
          <Toggle on={status.enabled} onChange={onToggle} />
        </Row>
        <Row
          title="Compress search & log output"
          description="Not yet available: plain-text compression is reversible only through Headroom's retrieval store, which needs a Phosphor retrieve tool first. Until then grep and log output pass through untouched, by design."
        >
          <Toggle on={false} onChange={() => undefined} />
        </Row>
      </div>
    </div>
  )
}

const SEVERITY_STYLE: Record<AdvisorFinding['severity'], string> = {
  serious: 'text-danger',
  warning: 'text-warning',
  tip: 'text-success',
}

function AdvisorRow({ finding }: { finding: AdvisorFinding }): React.JSX.Element {
  return (
    <div className="bg-surface border-border flex items-baseline gap-3 border-b px-3.5 py-2.5 text-sm last:border-b-0">
      <span
        className={clsx(
          'w-16 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide',
          SEVERITY_STYLE[finding.severity],
        )}
      >
        {finding.severity === 'tip' ? '● tip' : `▲ ${finding.severity}`}
      </span>
      <span className="text-text-secondary min-w-0 flex-1">
        <span className="text-text font-medium">{finding.title}.</span> {finding.detail}
      </span>
      {finding.settingsTab && finding.settingsTab !== 'optimization' && (
        <button
          className="text-accent shrink-0 font-mono text-xs hover:underline"
          onClick={() => useSettingsUiStore.getState().setTab(finding.settingsTab as SettingsTab)}
        >
          Open →
        </button>
      )}
    </div>
  )
}

function StateDot({ ok }: { ok: boolean }): React.JSX.Element {
  return (
    <span
      className={clsx('h-2 w-2 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-warning')}
      aria-hidden
    />
  )
}

function workspaceLabel(path: string | null): string {
  if (!path) return 'no workspace'
  return path.split('/').filter(Boolean).pop() ?? path
}
