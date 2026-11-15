import { useArchiveMutation } from './useArchiveMutation'
import { TooltipButton } from '@/components/Tooltip'
import { useArchiveInventory, loadArchives } from '@/stores/archives'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import {
  ARCHIVE_WARNING_BYTES,
  type LaneArchiveEntry,
  type LaneArchiveList,
} from '@phosphor/shared/lane-archive'
import { PurgeArchiveModal } from './PurgeArchiveModal'

export function ArchiveMachine({ machine }: { machine: string }): React.JSX.Element {
  const host = useRemoteLanesStore((state) => state.hosts[machine])
  const available =
    machine === 'local' ||
    (host?.state === 'ready' &&
      host.laneArchive === true &&
      host.capabilities.includes('sessions.read'))
  const writable =
    available &&
    (machine === 'local' ||
      (host?.capabilities.includes('sessions.control') &&
        host.capabilities.includes('workspaces.write')))
  const view = useArchiveInventory(machine, available)
  const { busy, error, purging, setError, setPurging, mutate } = useArchiveMutation(
    machine,
    writable,
  )
  return (
    <section className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">
          {machine === 'local' ? 'This computer' : machineLabel(machine)}
        </h2>
        <TooltipButton
          disabled={!available || view.loading || busy !== null}
          onClick={() => {
            void loadArchives(machine)
          }}
        >
          Refresh
        </TooltipButton>
      </div>
      {!available ? (
        <p className="text-text-secondary text-sm">
          {host?.state === 'ready' && !host.laneArchive
            ? 'Update this Host to use recoverable archives.'
            : 'Archive unavailable. Connect this machine with session read access. Storage is unknown, not zero.'}
        </p>
      ) : (
        <>
          <ArchiveStorage data={view.data} />
          {(error || view.error) && (
            <p role="alert" className="text-danger text-sm">
              {error || view.error}
            </p>
          )}
          {!view.data && view.loading && <p role="status">Loading archives…</p>}
          {view.data?.entries.length === 0 && (
            <p className="text-text-secondary text-sm">No archived lanes.</p>
          )}
          {view.data?.entries.map((entry) => (
            <ArchiveRow
              key={entry.id}
              entry={entry}
              disabled={!writable || busy !== null}
              restore={() => {
                void mutate(entry, false)
              }}
              purge={() => {
                setError(null)
                setPurging(entry)
              }}
            />
          ))}
        </>
      )}
      {purging && (
        <PurgeArchiveModal
          entry={purging}
          busy={busy !== null}
          error={error}
          onClose={() => setPurging(null)}
          onConfirm={(remove) => {
            void mutate(purging, true, remove)
          }}
        />
      )}
    </section>
  )
}
function ArchiveStorage({ data }: { data?: LaneArchiveList }): React.JSX.Element {
  return (
    <div className="text-text-secondary text-sm">
      <p>
        {data?.bytes === undefined || data.bytes === null
          ? 'Storage unknown'
          : `${(data.bytes / 1e9).toFixed(2)} GB retained`}{' '}
        {data?.measuring && '· measuring in background'}
      </p>
      <p>
        Shared folders count once. This includes retained project files, not just reclaimable
        storage.
      </p>
      {data?.bytes !== null && data?.bytes !== undefined && data.bytes > ARCHIVE_WARNING_BYTES && (
        <p role="status" className="text-warning">
          Archived lanes exceed 1 GB on this machine. Review them below. Nothing is removed
          automatically.
        </p>
      )}
      {data?.truncated && (
        <p role="alert">
          Listing is incomplete. Cleanup of shared worktrees is blocked until all owners can be
          checked.
        </p>
      )}
    </div>
  )
}
function ArchiveRow({
  entry,
  disabled,
  restore,
  purge,
}: {
  entry: LaneArchiveEntry
  disabled: boolean
  restore: () => void
  purge: () => void
}): React.JSX.Element {
  return (
    <div className="border-border flex flex-wrap items-center gap-3 border-t py-3">
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-medium">{entry.title}</h3>
        <p className="text-text-secondary break-all text-xs">{entry.cwd}</p>
        <p className="text-text-secondary text-xs">
          {new Date(entry.archivedAt).toLocaleString()} · {entry.state}
        </p>
      </div>
      <TooltipButton disabled={disabled || entry.state === 'purging'} onClick={restore}>
        Restore
      </TooltipButton>
      <TooltipButton
        disabled={disabled || !['archived', 'purging', 'restoring'].includes(entry.state)}
        onClick={purge}
        className="text-danger"
      >
        {entry.state === 'purging' ? 'Retry cleanup…' : 'Clean up…'}
      </TooltipButton>
    </div>
  )
}
