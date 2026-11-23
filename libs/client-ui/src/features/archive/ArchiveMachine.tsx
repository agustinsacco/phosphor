import { ArchiveList } from './ArchiveList'
import { useArchiveMutation } from './useArchiveMutation'
import { TooltipButton } from '@/components/Tooltip'
import { SettingsNotice, Tag } from '@/components/form'
import { WaitingNote } from '@/components/Waiting'
import { Spinner } from '@/components/icons'
import { localMachineLabel } from '@/lib/localMachine'
import { useArchiveInventory, loadArchives } from '@/stores/archives'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { laneHaystack, laneMatches, laneQueryTerms } from '../sessions/laneSearch'
import { ARCHIVE_WARNING_BYTES } from '@phosphor/shared/lane-archive'
import type { LaneArchiveEntry, LaneArchiveList } from '@phosphor/shared/lane-archive'

const NONE: readonly LaneArchiveEntry[] = Object.freeze([])

/**
 * One machine's archived lanes.
 *
 * The section decides only whether this machine can show its archives and what
 * they cost; the list and its actions live in `ArchiveList`.
 */
export function ArchiveMachine({
  machine,
  query,
}: {
  machine: string
  /** Case-insensitive match on title or path, from the page's search box. */
  query: string
}): React.JSX.Element {
  const host = useRemoteLanesStore((state) => state.hosts[machine])
  const ready = host?.state === 'ready' && host.laneArchive === true
  const available = machine === 'local' || (ready && !!host?.capabilities.includes('sessions.read'))
  const writable =
    available &&
    (machine === 'local' ||
      (!!host?.capabilities.includes('sessions.control') &&
        !!host?.capabilities.includes('workspaces.write')))
  const view = useArchiveInventory(machine, available)
  const actions = useArchiveMutation(machine, writable)
  const entries = view.data?.entries ?? NONE
  // The sidebar's matcher, so the same words find the same lane in both places.
  const terms = laneQueryTerms(query)
  const shown = terms.length
    ? entries.filter((entry) =>
        laneMatches(laneHaystack({ title: entry.title, cwd: entry.cwd }), terms),
      )
    : entries
  return (
    <section className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-semibold">
          {machine === 'local' ? localMachineLabel() : machineLabel(machine)}
        </h2>
        {!!entries.length && <Tag>{entries.length} archived</Tag>}
        <TooltipButton
          disabled={!available || view.loading || actions.running}
          onClick={() => {
            void loadArchives(machine)
          }}
        >
          Refresh
        </TooltipButton>
      </div>
      {!available ? (
        <ArchiveUnavailable host={host} />
      ) : (
        <>
          <ArchiveStorage data={view.data} count={entries.length} />
          <ArchiveErrors
            machine={machine}
            listError={view.error}
            actionError={actions.purging ? null : actions.error}
          />
          {!view.data && view.loading && <WaitingNote>Loading archives…</WaitingNote>}
          {!!view.data && !shown.length && (
            <p className="text-text-secondary text-sm">
              {entries.length ? `No archived lanes match “${query}”.` : 'No archived lanes.'}
            </p>
          )}
          {!!shown.length && (
            <ArchiveList
              machine={machine}
              writable={writable}
              entries={entries}
              shown={shown}
              actions={actions}
            />
          )}
        </>
      )}
    </section>
  )
}

/**
 * A list the machine refused and an operation it refused are different problems,
 * so they say so differently: only the list offers a reload, and an operation
 * still open in its own dialog reports the failure there instead.
 */
function ArchiveErrors({
  machine,
  listError,
  actionError,
}: {
  machine: string
  listError: string | null | undefined
  actionError: string | null
}): React.JSX.Element {
  return (
    <>
      {listError && (
        <SettingsNotice
          tone="danger"
          title="This machine refused the archive list."
          body={listError}
          action={{ label: 'Try again', onClick: () => void loadArchives(machine) }}
        />
      )}
      {actionError && (
        <SettingsNotice tone="danger" title="That archive operation failed." body={actionError} />
      )}
    </>
  )
}

/** A Host that predates archives says so; a machine that is simply not connected says that. */
function ArchiveUnavailable({
  host,
}: {
  host: ReturnType<typeof useRemoteLanesStore.getState>['hosts'][string] | undefined
}): React.JSX.Element {
  const stale = host?.state === 'ready' && !host.laneArchive
  return (
    <SettingsNotice
      tone="info"
      title={stale ? 'Update this Host to use recoverable archives.' : 'Archive unavailable'}
      body={
        stale
          ? undefined
          : 'Connect this machine with session read access. Storage is unknown, not zero.'
      }
    />
  )
}

/** One line: what is held, and how many. The caveats that do not fit sit on the size. */
function ArchiveStorage({
  data,
  count,
}: {
  data?: LaneArchiveList
  count: number
}): React.JSX.Element {
  const bytes = data?.bytes ?? null
  return (
    <>
      <p className="text-text-secondary flex flex-wrap items-center gap-2 text-sm">
        <span
          data-tooltip="Shared folders count once. This includes retained project files, not just reclaimable storage."
          data-testid="archive-retained"
        >
          {bytes === null ? 'Storage unknown' : `${(bytes / 1e9).toFixed(2)} GB retained`}
        </span>
        <span aria-hidden>·</span>
        <span>{count} archived</span>
        {data?.measuring && (
          <span className="text-text-tertiary flex items-center gap-1.5">
            <Spinner className="text-text-tertiary h-3 w-3" />
            measuring
          </span>
        )}
      </p>
      {bytes !== null && bytes > ARCHIVE_WARNING_BYTES && (
        <SettingsNotice
          tone="warning"
          title="Archived lanes exceed 1 GB on this machine."
          body="Review them below. Nothing is removed automatically."
        />
      )}
      {data?.truncated && (
        <SettingsNotice
          tone="danger"
          title="Listing is incomplete."
          body="Cleanup of shared worktrees is blocked until all owners can be checked."
        />
      )}
    </>
  )
}
