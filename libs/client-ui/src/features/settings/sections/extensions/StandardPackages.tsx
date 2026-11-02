import { TooltipButton } from '@/components/Tooltip'
import { Button } from '@/components/form'
import {
  HEADLESS_STANDARD_PACKAGES,
  STANDARD_PACKAGES,
  standardPackageState,
  type StandardPackage,
} from '@shared/standard-packages'

/**
 * The recommended packages as cards: Add, Repair (declared in pi's settings
 * but missing), or Added. Settings → Extensions on every machine and the
 * first-run getting-started screen.
 */
export function StandardPackages({
  packages,
  claudeCli,
  headless = false,
  busy,
  onInstall,
}: {
  packages: readonly { spec: string; name: string; installed: boolean }[]
  /** Whether the `claude` CLI is on PATH; null while unknown. */
  claudeCli: boolean | null
  /** Only the packages that run without a desktop session. */
  headless?: boolean
  busy: boolean
  onInstall: (spec: string) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(headless ? HEADLESS_STANDARD_PACKAGES : STANDARD_PACKAGES).map((entry) => (
        <StandardPackageCard
          key={entry.name}
          entry={entry}
          packages={packages}
          missingBinary={entry.requiresBinary === 'claude' && claudeCli === false}
          busy={busy}
          onInstall={onInstall}
        />
      ))}
    </div>
  )
}

function StandardPackageCard({
  entry,
  packages,
  missingBinary,
  busy,
  onInstall,
}: {
  entry: StandardPackage
  packages: readonly { spec: string; name: string; installed: boolean }[]
  missingBinary: boolean
  busy: boolean
  onInstall: (spec: string) => void
}): React.JSX.Element {
  const state = standardPackageState(entry.name, packages)
  // A repair keeps the version the settings pin.
  const declared = packages.find((pkg) => pkg.name === entry.name)?.spec
  const spec = declared?.startsWith('npm:') ? declared : entry.spec
  return (
    <div className="border-border bg-surface rounded-xl border p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-lg font-semibold">{entry.title}</span>
        {state === 'installed' ? (
          <span className="text-success text-sm font-medium">Added</span>
        ) : (
          <Button
            variant="primary"
            size="sm"
            aria-label={`${state === 'declared' ? 'Repair' : 'Add'} ${entry.title}`}
            onClick={() => onInstall(spec)}
            disabled={busy}
          >
            {state === 'declared' ? 'Repair' : 'Add'}
          </Button>
        )}
      </div>
      <p className="text-text-secondary mt-1.5 text-base leading-snug">{entry.description}</p>
      <div className="mt-2 flex items-center gap-3">
        <TooltipButton
          onClick={() => void window.phosphor.invoke('app:openExternal', entry.docsUrl)}
          className="text-text-tertiary hover:text-text text-sm underline"
        >
          Docs
        </TooltipButton>
        {missingBinary && (
          <span className="text-warning text-sm">Needs the `claude` CLI on your PATH</span>
        )}
      </div>
    </div>
  )
}
