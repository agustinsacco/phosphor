import { useEffect, useRef, useState } from 'react'
import type { McpMigrationPlan } from '@shared/mcp'
import type { PiPackageEntry } from '@shared/models'
import { errorText } from '@shared/errors'
import { Button } from '@/components/form'
import { usePackageJob } from '@/features/settings/usePackageJob'
import { JobOutput } from '@/features/settings/JobOutput'

/** Installed copies of pi-mcp-adapter, in either scope. */
export function adapterPackages(packages: readonly PiPackageEntry[]): PiPackageEntry[] {
  return packages.filter(
    (entry) => entry.name === 'pi-mcp-adapter' || entry.spec.includes('pi-mcp-adapter'),
  )
}

/**
 * Move from pi-mcp-adapter to pi's built-in MCP, after showing exactly what
 * will happen. Phosphor manages only the built-in, so while the adapter or its
 * config is still there this card is all Settings → Connectors shows.
 *
 * Two steps, in this order: main moves the config (`mcp:migrate`), then pi
 * removes the adapter package. Moving the config first means a failed removal
 * leaves a working setup behind once the package goes, rather than the reverse.
 */
export function MigrationCard({
  workspacePath,
  adapters,
  onDone,
}: {
  workspacePath: string | undefined
  adapters: PiPackageEntry[]
  onDone: () => void
}): React.JSX.Element {
  const [plan, setPlan] = useState<McpMigrationPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [moved, setMoved] = useState(false)
  // Resolves the removal the loop below is waiting on; usePackageJob owns the listeners.
  const removed = useRef<(() => void) | null>(null)
  const removal = usePackageJob(() => {
    removed.current?.()
    removed.current = null
  })

  useEffect(() => {
    void window.phosphor
      .invoke('mcp:migrationPlan', workspacePath)
      .then(setPlan, (err: unknown) => setError(errorText(err)))
  }, [workspacePath])

  const run = async (): Promise<void> => {
    setError(null)
    setMoving(true)
    try {
      await window.phosphor.invoke('mcp:migrate', workspacePath)
      setMoved(true)
      for (const adapter of adapters) {
        await new Promise<void>((resolve) => {
          removed.current = resolve
          void removal.start(async () => {
            try {
              return await window.phosphor.invoke(
                'packages:run',
                'remove',
                adapter.spec,
                adapter.scope,
                workspacePath,
              )
            } catch (err) {
              // The job never started, so no exit will come to resolve this.
              resolve()
              throw err
            }
          })
        })
      }
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setMoving(false)
    }
  }

  const blocked = (plan?.blocked.length ?? 0) > 0
  const signIns = plan?.servers.filter((s) => s.config.url && !s.config.headers?.Authorization)

  return (
    <div className="border-warning/30 bg-warning/10 mt-4 rounded-xl border px-4 py-3 text-base">
      <div className="font-semibold">Move your connectors to pi’s built-in MCP</div>
      <p className="text-text-secondary mt-1">
        pi now connects MCP servers itself, and Phosphor manages connectors through it. Your servers
        are still set up for the pi-mcp-adapter package, which turns pi’s own support off. This
        moves them over and removes the adapter.
      </p>

      {plan && (
        <ul className="text-text-secondary mt-3 space-y-1.5 text-sm">
          {plan.servers.map((server) => (
            <li key={`${server.scope}/${server.name}`}>
              <span className="text-text font-mono">{server.name}</span>
              {' → '}
              {server.scope === 'global' ? '~/.pi/agent/mcp.json' : '.pi/mcp.json'}
              {server.notes.map((note) => (
                <div key={note} className="text-text-tertiary ml-4">
                  {note}
                </div>
              ))}
            </li>
          ))}
          {plan.skipped.map((skip) => (
            <li key={`${skip.source}/${skip.name}`} className="text-warning">
              <span className="font-mono">{skip.name}</span> is not moved: {skip.reason}
            </li>
          ))}
          {plan.retire.map((path) => (
            <li key={path}>
              <span className="font-mono break-all">{path}</span> is renamed to a backup.
            </li>
          ))}
          {plan.builtinDisabled && <li>pi’s built-in MCP is turned back on.</li>}
          {adapters.map((adapter) => (
            <li key={`${adapter.scope}/${adapter.spec}`}>
              <span className="font-mono">{adapter.spec}</span> is removed from pi ({adapter.scope}
              ).
            </li>
          ))}
          {plan.servers.length === 0 && plan.skipped.length === 0 && <li>No servers to move.</li>}
        </ul>
      )}

      {signIns && signIns.length > 0 && (
        <p className="text-text-secondary mt-3 text-sm">
          Sign in again afterwards to {signIns.map((s) => s.name).join(', ')}: pi keeps its own
          tokens, and the adapter’s stay in your OS credential store. Open sessions switch over
          before their next message.
        </p>
      )}

      {blocked && (
        <p className="text-danger mt-3 text-sm">
          Fix these files first, they are not valid JSON: {plan?.blocked.join(', ')}
        </p>
      )}
      {error && <p className="text-danger mt-3 text-sm">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!plan || blocked || moving}
          onClick={() => void run()}
        >
          {moving ? 'Moving…' : moved ? 'Retry removing the adapter' : 'Move to pi’s MCP'}
        </Button>
        <span className="text-text-tertiary text-sm">
          Every file it changes is backed up first.
        </span>
      </div>
      <JobOutput running={removal.running} output={removal.output} exitCode={removal.exitCode} />
    </div>
  )
}
