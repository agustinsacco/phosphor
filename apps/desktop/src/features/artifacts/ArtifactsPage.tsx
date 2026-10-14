import { TooltipButton } from '@/components/Tooltip'
import { memo, useEffect, useMemo, useState } from 'react'
import type { ArtifactListing } from '@shared/artifacts'
import { ipcErrorText } from '@shared/errors'
import {
  normalizeArtifactType,
  openArtifact,
  useArtifactsStore,
  type Artifact,
} from '@/stores/artifacts'
import { useRemoteLanesStore, machineLabel, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { PageShell } from '@/components/PageShell'
import { PaneTitle } from '@/components/PaneShell'
import { sessionTitle } from '@/lib/sessionTitle'
import { projectName } from '@/lib/path'
import { relativeTimeShort } from '@/lib/time'
import { artifactGlyph } from './artifactKinds'
import { ArtifactWorkspace } from './ArtifactsPane'
import {
  mergeGlobalArtifacts,
  canViewStoredArtifact,
  type GlobalArtifactRow,
} from './globalArtifacts'

/**
 * Global Artifacts page (sidebar → Artifacts): every artifact Phosphor's
 * artifact store holds, from every session, open, closed or deleted, newest
 * first. The store lives in the main process and outlives compaction,
 * restarts and the session itself.
 *
 * Opening a row lands in that artifact's own session, with the pane on it,
 * resuming the session first when it is closed: viewing an artifact next to
 * its chat is the point of it. An artifact whose session cannot be resumed
 * (deleted, or its folder gone) opens here instead, read-only; a deleted
 * session's can also be removed.
 */
export const ArtifactsPage = memo(function ArtifactsPage(): React.JSX.Element {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const bySession = useArtifactsStore((s) => s.bySession)
  const live = useSessionsStore((s) => s.live)
  // Reload when a session opens, closes or changes on disk, so a session
  // deleted while this page is open shows as deleted instead of going stale.
  const liveIds = useSessionsStore((s) => Object.keys(s.live).join('\n'))
  const disk = useSessionsStore((s) => s.disk)
  const [stored, setStored] = useState<ArtifactListing[] | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [removals, setRemovals] = useState(0)

  useEffect(() => {
    // Only the latest answer lands: an earlier, slower one must not win.
    let current = true
    const paths = Object.values(useSessionsStore.getState().live).flatMap((l) =>
      l.target?.kind !== 'remote' && l.diskPath ? [l.diskPath] : [],
    )
    window.phosphor
      .invoke('artifacts:list', paths)
      .then((listings) => current && setStored(listings))
      .catch(() => current && setStored([]))
    return () => {
      current = false
    }
  }, [liveIds, disk, removals, hosts])

  const rows = useMemo(
    () =>
      mergeGlobalArtifacts(
        (stored ?? []).filter((row) => canViewStoredArtifact(row.key, hosts)),
        Object.values(live)
          .filter((l) => {
            if (l.target?.kind !== 'remote') return true
            const host = hosts[l.target.hostId]
            return host?.state === 'ready' && host.capabilities.includes('artifacts.read')
          })
          .map((l) => ({
            machine: l.target?.kind === 'remote' ? machineLabel(l.target.hostId) : undefined,
            phosphorId: l.phosphorId,
            diskPath:
              l.target?.kind === 'remote' && l.laneId
                ? `host:${l.target.hostId}/lane:${l.laneId}`
                : l.diskPath,
            workspacePath: l.workspacePath,
            artifacts: bySession[l.phosphorId] ?? {},
          })),
      ),
    [stored, live, bySession, hosts],
  )

  if (viewing) {
    if (!canViewStoredArtifact(viewing, hosts))
      return (
        <PageShell
          title={<TooltipButton onClick={() => setViewing(null)}>← All artifacts</TooltipButton>}
        >
          <p className="p-4">{REMOTE_UNAVAILABLE}</p>
        </PageShell>
      )
    return (
      <StoredArtifactView
        key={viewing}
        artifactKey={viewing}
        onBack={() => setViewing(null)}
        onRemoved={() => {
          setViewing(null)
          setRemovals((n) => n + 1)
        }}
      />
    )
  }

  return (
    <PageShell
      title={<PaneTitle label="Artifacts" meta={rows.length ? `${rows.length}` : undefined} />}
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md text-center">
              <div className="text-text-tertiary text-lg">
                {stored === null ? 'Loading artifacts…' : 'No artifacts yet'}
              </div>
              {stored !== null && (
                <div className="text-text-tertiary mt-1 text-sm">
                  Ask a session for a dashboard mockup, diagram or report: substantial deliverables
                  land here, from every session, and stay after the session is gone.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <div className="text-text-tertiary pb-2 text-sm">
              Everything your sessions have produced. Opening one jumps to its session.
            </div>
            {rows.map((row) => (
              <ArtifactRow key={row.key} row={row} onView={setViewing} />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  )
})

function ArtifactRow({
  row,
  onView,
}: {
  row: GlobalArtifactRow
  onView: (key: string) => void
}): React.JSX.Element {
  // A live session's own name beats the scanned one (the disk scan lags a
  // rename by its debounce), same rule as the sidebar rows.
  const liveName = useChatStore((s) =>
    row.phosphorId ? s.sessions[row.phosphorId]?.meta?.sessionName : undefined,
  )
  const git = useSessionsStore((s) => s.gitByCwd[row.cwd])
  const title =
    sessionTitle({
      explicitName: liveName ?? row.sessionName,
      firstUserText: row.firstUserText,
    }) ?? 'Untitled session'

  const open = async (): Promise<void> => {
    if (!row.phosphorId && (row.sessionDeleted || !row.workspaceExists)) {
      onView(row.key)
      return
    }
    try {
      let phosphorId = row.phosphorId
      if (!phosphorId) {
        // A closed session: resume it, then land on the artifact.
        const sessions = useSessionsStore.getState()
        await sessions.refreshDisk(row.cwd)
        const meta = useSessionsStore
          .getState()
          .disk[row.cwd]?.find((m) => m.path === row.sessionFile)
        // Gone since the list was read: the stored copy is still viewable.
        if (!meta) {
          onView(row.key)
          return
        }
        phosphorId = await sessions.openDiskSession(row.cwd, meta)
      } else {
        // activate() closes this page.
        useSessionsStore.getState().activate(phosphorId)
      }
      if (!openArtifact(phosphorId, row.id)) {
        throw new Error('That artifact is not on the session’s current branch.')
      }
    } catch (error) {
      useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error')
    }
  }

  return (
    <TooltipButton
      tooltip={row.title}
      onClick={() => void open()}
      className="hover:bg-bg-secondary flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left"
    >
      <span className="shrink-0 pt-0.5 text-base leading-none">{artifactGlyph(row.type)}</span>
      {row.machine && <span className="text-text-secondary shrink-0 text-xs">{row.machine}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-base font-medium">{row.title}</span>
          <span className="text-text-tertiary shrink-0 text-sm">
            v{row.version} · {relativeTimeShort(row.updatedAt)}
          </span>
        </span>
        <span className="text-text-tertiary block truncate text-sm">
          <StatusTag row={row} />
          {title}
          {row.cwd ? ` · ${projectName(row.cwd, git)}` : ''}
          {row.copies > 0 ? ` · also in ${row.copies} fork${row.copies === 1 ? '' : 's'}` : ''}
        </span>
      </span>
    </TooltipButton>
  )
}

/** Why a row cannot open in its session, if it cannot. */
function StatusTag({
  row,
}: {
  row: Pick<GlobalArtifactRow, 'sessionDeleted' | 'workspaceExists'>
}): React.JSX.Element | null {
  const label = row.sessionDeleted
    ? 'Session deleted'
    : !row.workspaceExists
      ? 'Folder missing'
      : null
  if (!label) return null
  return (
    <span className="border-border text-text-secondary mr-1.5 rounded-sm border px-1 py-px text-xs">
      {label}
    </span>
  )
}

/**
 * An artifact whose session cannot be resumed, read-only, with a way back and,
 * when its session was deleted, a way to remove it.
 */
function StoredArtifactView({
  artifactKey,
  onBack,
  onRemoved,
}: {
  artifactKey: string
  onBack: () => void
  onRemoved: () => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<
    { artifact: Artifact; listing: ArtifactListing } | null | undefined
  >(undefined)

  useEffect(() => {
    window.phosphor
      .invoke('artifacts:read', artifactKey)
      .then((found) =>
        setLoaded(
          found
            ? {
                listing: found.listing,
                artifact: {
                  id: found.artifact.id,
                  title: found.artifact.title,
                  type: normalizeArtifactType(found.artifact.type),
                  language: found.artifact.language,
                  versions: found.artifact.versions,
                  updatedAt: found.listing.updatedAt,
                },
              }
            : null,
        ),
      )
      .catch(() => setLoaded(null))
  }, [artifactKey])

  const remove = async (): Promise<void> => {
    try {
      if (await window.phosphor.invoke('artifacts:remove', artifactKey)) onRemoved()
    } catch (error) {
      useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error')
    }
  }

  const back = (
    <TooltipButton
      onClick={onBack}
      title="All artifacts"
      className="text-text-secondary hover:text-text hover:bg-bg-secondary shrink-0 rounded-sm px-1.5 py-0.5 text-sm"
    >
      ← All
    </TooltipButton>
  )

  if (!loaded) {
    return (
      <PageShell title={back}>
        <div className="text-text-tertiary flex h-full items-center justify-center text-sm">
          {loaded === undefined ? 'Loading…' : 'This artifact is no longer in the store.'}
        </div>
      </PageShell>
    )
  }

  return (
    <ArtifactWorkspace
      artifact={loaded.artifact}
      list={[loaded.artifact]}
      workspacePath={loaded.listing.cwd}
      onSelect={() => undefined}
      page={{
        leading: (
          <>
            {back}
            <StatusTag row={loaded.listing} />
            {loaded.listing.sessionDeleted && (
              <TooltipButton
                onClick={() => void remove()}
                title="Remove this artifact for good"
                className="text-text-secondary hover:text-text hover:bg-bg-secondary shrink-0 rounded-sm px-1.5 py-0.5 text-sm"
              >
                Remove
              </TooltipButton>
            )}
          </>
        ),
      }}
    />
  )
}
