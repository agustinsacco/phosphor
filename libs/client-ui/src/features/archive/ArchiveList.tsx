import { useState } from 'react'
import { ArchiveRow } from './ArchiveRow'
import { BulkPurgeModal } from './BulkPurgeModal'
import { PurgeArchiveModal } from './PurgeArchiveModal'
import type { useArchiveMutation } from './useArchiveMutation'
import { LaneBulkBar, type LaneSelect } from '../sessions/LaneSelect'
import {
  clearLaneSelection,
  selectLanes,
  toggleLane,
  useGroupSelection,
  useSelectedKeys,
  useSelectionOwner,
} from '../sessions/laneSelection'
import { Button } from '@/components/form'
import type { LaneArchiveEntry } from '@phosphor/shared/lane-archive'

/** The states a cleanup can act on. `archiving` is still being written. */
const PURGEABLE = ['archived', 'purging', 'restoring']

const canPurge = (entry: LaneArchiveEntry, writable: boolean): boolean =>
  writable && PURGEABLE.includes(entry.state)

/** The row checkbox's contract, built the way the sidebar builds it. */
function selectOf(
  entry: LaneArchiveEntry,
  keys: readonly string[],
  order: readonly string[],
  selecting: boolean,
  writable: boolean,
  key: string,
): LaneSelect {
  return {
    title: entry.title,
    selected: keys.includes(entry.id),
    selecting,
    onToggle: (shiftKey) => toggleLane(key, order, entry.id, shiftKey),
    // `blocked` is the reason a row cannot join the selection, so a selectable
    // row must leave it undefined: any string disables the box entirely.
    blocked: !writable
      ? 'This machine does not let this device clean up archives.'
      : canPurge(entry, writable)
        ? undefined
        : `Not until this archive settles (${entry.state}).`,
  }
}

/**
 * One machine's archives, and the selection over them.
 *
 * Selection is the sidebar's, so the row checkbox, the bulk bar and shift-click
 * behave the way they already do elsewhere; only the operation differs.
 */
export function ArchiveList({
  machine,
  writable,
  entries,
  shown,
  actions,
}: {
  machine: string
  writable: boolean
  entries: readonly LaneArchiveEntry[]
  shown: readonly LaneArchiveEntry[]
  actions: ReturnType<typeof useArchiveMutation>
}): React.JSX.Element {
  const { running, busyFor, setError, setPurging, mutate } = actions
  const [confirming, setConfirming] = useState(false)
  const selection = useGroupSelection(`archive:${machine}`)
  const owner = useSelectionOwner([selection.key], confirming || running)
  const keys = useSelectedKeys(owner)
  const chosen = entries.filter((entry) => keys.includes(entry.id) && canPurge(entry, writable))
  const order = shown.map((entry) => entry.id)
  return (
    <>
      <SelectAll
        selecting={selection.selecting}
        disabled={!writable || running}
        onToggle={() =>
          selection.selecting
            ? clearLaneSelection()
            : selectLanes(
                selection.key,
                shown.filter((entry) => canPurge(entry, writable)).map((entry) => entry.id),
              )
        }
      />
      <ul className="border-border divide-border divide-y">
        {shown.map((entry) => (
          <ArchiveRow
            key={entry.id}
            entry={entry}
            select={selectOf(entry, keys, order, selection.selecting, writable, selection.key)}
            busy={busyFor(entry.id)}
            canRestore={writable && !running && entry.state !== 'purging'}
            canPurge={canPurge(entry, writable) && !running}
            onRestore={() => {
              void mutate(entry, false)
            }}
            onPurge={() => {
              setError(null)
              setPurging(entry)
            }}
          />
        ))}
      </ul>
      {selection.selecting && (
        <LaneBulkBar
          count={chosen.length}
          running={running}
          label="Clean up…"
          runningLabel={
            actions.bulkCount ? `Cleaning up ${actions.bulkCount}…` : 'Cleanup in progress'
          }
          className="sticky bottom-2"
          onDelete={() => setConfirming(true)}
          onCancel={clearLaneSelection}
        />
      )}
      <ArchiveModals
        chosen={chosen}
        confirming={confirming}
        actions={actions}
        onCloseBulk={() => setConfirming(false)}
      />
    </>
  )
}

/** Select mode is the sidebar's, so the toolbar word changes with it, not the row. */
function SelectAll({
  selecting,
  disabled,
  onToggle,
}: {
  selecting: boolean
  disabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Button size="sm" disabled={disabled} onClick={onToggle}>
      {selecting ? 'Clear selection' : 'Select all'}
    </Button>
  )
}

/**
 * The two confirmations, which share one entry point: a row's own Clean up opens
 * the single dialog, the bulk bar opens the list. A bulk cleanup that took
 * nothing leaves the selection alone, so the failures stay visible.
 */
function ArchiveModals({
  chosen,
  confirming,
  actions,
  onCloseBulk,
}: {
  chosen: readonly LaneArchiveEntry[]
  confirming: boolean
  actions: ReturnType<typeof useArchiveMutation>
  onCloseBulk: () => void
}): React.JSX.Element {
  const { running, error, purging, setPurging, mutate, purgeMany } = actions
  return (
    <>
      {purging && (
        <PurgeArchiveModal
          entry={purging}
          busy={running}
          error={error}
          onClose={() => setPurging(null)}
          onConfirm={(remove) => {
            void mutate(purging, true, remove)
          }}
        />
      )}
      {confirming && (
        <BulkPurgeModal
          entries={chosen}
          busy={running}
          error={error}
          onClose={onCloseBulk}
          onConfirm={(remove) => {
            void purgeMany(chosen, remove).then((cleaned) => {
              onCloseBulk()
              if (cleaned) clearLaneSelection()
            })
          }}
        />
      )}
    </>
  )
}
