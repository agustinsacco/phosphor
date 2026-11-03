import { Button } from '@/components/form'
import { providerRows } from '@/features/settings/sections/accounts/useHostProviders'
import { ProviderList } from '@/features/settings/sections/accounts/ProviderList'
import { CopyCommand } from './MachineControls'
import { Skeleton } from './MachineUi'
import { useMachineProviders } from './useMachineProviders'

/**
 * A machine's pi providers on the Machines page: Settings → Accounts' rows, read
 * only. Sign-in opens that page; a Host too old for it gets the CLI command.
 * `keepClaude` lists the Claude Code provider's row where no Claude Code check shows.
 */
export function MachineProviders({
  hostId,
  refresh = 0,
  onConfigure,
  keepClaude = false,
}: {
  hostId: string
  refresh?: number
  onConfigure?: () => void
  keepClaude?: boolean
}): React.JSX.Element {
  const { readable, providers, failed, retry } = useMachineProviders(hostId, refresh)
  return (
    <div className="space-y-2">
      {failed ? (
        <div role="alert" className="flex items-center justify-between gap-3 py-1 text-base">
          <span>Could not load this machine&apos;s providers.</span>
          <Button size="xs" onClick={retry}>
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
            <Skeleton key={row} className="h-4 w-full" />
          ))}
        </div>
      ) : providers.length === 0 ? (
        <p className="text-text-secondary text-base">No providers reported by this machine.</p>
      ) : (
        <ProviderList
          source={{ providers: providerRows(providers, keepClaude), flow: null, busy: false }}
        />
      )}
      {onConfigure ? (
        <Button size="sm" onClick={onConfigure}>
          Provider settings
        </Button>
      ) : (
        readable && <CopyCommand command="phosphor providers login PROVIDER" />
      )}
    </div>
  )
}
