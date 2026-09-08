import { Button } from '@/components/form'
import { PACKAGE_CATALOGUE, isCatalogueEntryInstalled } from './catalogue'

/**
 * Curated package cards shared by Settings → Extensions and the first-run
 * getting-started screen.
 */
export function CatalogueCards({
  installedSpecs,
  claudeDetected,
  busy,
  onInstall,
}: {
  installedSpecs: string[]
  /** null while detection is still in flight. */
  claudeDetected: boolean | null
  busy: boolean
  onInstall: (spec: string) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {PACKAGE_CATALOGUE.map((entry) => {
        const installed = isCatalogueEntryInstalled(entry.spec, installedSpecs)
        const missingBinary = entry.requiresBinary === 'claude' && claudeDetected === false
        return (
          <div key={entry.spec} className="border-border bg-surface rounded-xl border p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-lg font-semibold">{entry.name}</span>
              {installed ? (
                <span className="text-success text-sm font-medium">Added</span>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onInstall(entry.spec)}
                  disabled={busy}
                >
                  Add
                </Button>
              )}
            </div>
            <p className="text-text-secondary mt-1.5 text-base leading-snug">{entry.description}</p>
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={() => void window.phosphor.invoke('app:openExternal', entry.docsUrl)}
                className="text-text-tertiary hover:text-text text-sm underline"
              >
                Docs
              </button>
              {missingBinary && (
                <span className="text-warning text-sm">Needs the `claude` CLI on your PATH</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
