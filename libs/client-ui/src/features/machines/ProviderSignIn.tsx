import { Button } from '@/components/form'
import { Skeleton } from './MachineUi'

import { ProviderReadinessList, ProviderSignInDialog } from './ProviderSignInSections'
import { useProviderSignIn } from './useProviderSignIn'

/** Provider contents and credentials stay on the authenticated Host terminal connection. */
export function ProviderSignIn({
  hostId,
  refresh = 0,
  onConfigure,
}: {
  hostId: string
  refresh?: number
  onConfigure?: () => void
}): React.JSX.Element {
  const state = useProviderSignIn(hostId, refresh)
  const { loadFailed, setReload, readable, providers, error, terminal } = state
  return (
    <div className="space-y-2">
      {loadFailed ? (
        <div role="alert" className="flex items-center justify-between gap-3 py-1 text-base">
          <span>Could not load this machine's providers.</span>
          <Button size="xs" onClick={() => setReload((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : !readable ? (
        <p className="text-text-secondary text-base">
          Providers appear once this computer is connected to the machine.
        </p>
      ) : providers === null ? (
        <div role="status" aria-label="Loading providers" className="space-y-3 py-1">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="ml-auto h-4 w-20 rounded-full" />
            </div>
          ))}
        </div>
      ) : providers.length === 0 ? (
        <p className="text-text-secondary text-base">No providers reported by this machine.</p>
      ) : (
        <ProviderReadinessList state={state} onConfigure={onConfigure} />
      )}
      {onConfigure && (
        <Button size="sm" onClick={onConfigure}>
          Provider settings
        </Button>
      )}
      {error && (
        <p role="alert" className="text-danger text-base">
          {error}
        </p>
      )}
      {terminal && <ProviderSignInDialog state={state} />}
    </div>
  )
}
