import { memo, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTerminalStore, sessionTerminals } from '@/stores/terminal'
import { PaneIconButton, PaneShell, PaneTitle } from '@/components/PaneShell'
import { TerminalView } from './TerminalView'
import { CloseIcon } from '@/components/icons'

/**
 * Terminal pane: tab strip in the shell title, "+" as a pane action.
 *
 * Terminals are scoped per session (tabs shown belong to `sessionId`), but
 * every session's TerminalViews stay mounted (hidden) so switching sessions
 * keeps each shell's scrollback — the same idiom the tab strip already uses
 * for its own inactive tabs.
 */
export const TerminalPane = memo(function TerminalPane({
  sessionId,
  workspacePath,
}: {
  sessionId: string
  workspacePath: string
}): React.JSX.Element {
  const bySession = useTerminalStore((s) => s.bySession)
  const tabs = useTerminalStore((s) => sessionTerminals(s, sessionId).tabs)
  const activeId = useTerminalStore((s) => sessionTerminals(s, sessionId).activeId)
  const error = useTerminalStore((s) => sessionTerminals(s, sessionId).error)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // First open per session: spawn a shell automatically.
  //
  // createTab is async, so a plain `tabs.length === 0` guard is not enough:
  // StrictMode double-invokes this effect and both passes observe the empty
  // list before the first spawn resolves, producing two shells. A synchronous
  // ref latch (per session) makes the check race-free.
  //
  // The latch is RELEASED when the spawn fails. Latching unconditionally is
  // how this pane used to wedge on "Starting shell…" forever: a rejected
  // pty:create left no tab, no error, and no way to ask again.
  const spawnRequested = useRef(new Set<string>())
  useEffect(() => {
    if (spawnRequested.current.has(sessionId)) return
    const current = sessionTerminals(useTerminalStore.getState(), sessionId)
    if (current.tabs.length > 0 || current.error !== null) return
    spawnRequested.current.add(sessionId)
    void useTerminalStore
      .getState()
      .createTab(sessionId, workspacePath)
      .then((ptyId) => {
        if (ptyId === null) spawnRequested.current.delete(sessionId)
      })
  }, [sessionId, workspacePath, error])

  // Clearing the error re-arms the first-open effect above (it lists `error`
  // as a dep). With tabs already open that effect is a no-op, so a failed "+"
  // has to ask again directly.
  const retry = (): void => {
    spawnRequested.current.delete(sessionId)
    useTerminalStore.getState().clearError(sessionId)
    if (tabs.length > 0) void useTerminalStore.getState().createTab(sessionId, workspacePath)
  }

  return (
    <PaneShell
      title={
        <>
          <PaneTitle label="Terminal" />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.ptyId}
                className={clsx(
                  'group flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-2 py-0.5 text-sm transition-colors',
                  tab.ptyId === activeId
                    ? 'bg-bg-secondary text-text'
                    : 'text-text-tertiary hover:text-text',
                  tab.exited && 'opacity-60',
                )}
                onClick={() => useTerminalStore.getState().setActive(sessionId, tab.ptyId)}
                onDoubleClick={() => {
                  setRenaming(tab.ptyId)
                  setRenameValue(tab.title)
                }}
              >
                {tab.running && !tab.exited && (
                  <span
                    className="bg-success h-1.5 w-1.5 shrink-0 rounded-full"
                    title="Process running"
                  />
                )}
                {renaming === tab.ptyId ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => {
                      if (renameValue.trim())
                        useTerminalStore
                          .getState()
                          .renameTab(sessionId, tab.ptyId, renameValue.trim())
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    className="border-border w-24 rounded border bg-transparent px-1 text-sm outline-none"
                  />
                ) : (
                  <span>{tab.title}</span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void useTerminalStore.getState().closeTab(sessionId, tab.ptyId)
                  }}
                  className="text-text-tertiary hover:text-text hidden group-hover:block"
                >
                  <CloseIcon size={9} strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
        </>
      }
      actions={
        <PaneIconButton
          title="New terminal"
          onClick={() => void useTerminalStore.getState().createTab(sessionId, workspacePath)}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </PaneIconButton>
      }
    >
      <div className="terminal-surface min-h-0 flex-1 p-1.5">
        {Object.entries(bySession).flatMap(([owner, terminals]) =>
          terminals.tabs.map((tab) => (
            <TerminalView
              key={tab.ptyId}
              ptyId={tab.ptyId}
              visible={owner === sessionId && tab.ptyId === activeId}
            />
          )),
        )}
        {tabs.length === 0 && error === null && (
          <div className="text-text-tertiary flex h-full items-center justify-center text-base">
            Starting shell…
          </div>
        )}
        {error !== null && <SpawnError message={error} onRetry={retry} inline={tabs.length > 0} />}
      </div>
    </PaneShell>
  )
})

/**
 * Spawn failure, shown where the shell would have been. `inline` keeps it a
 * strip above existing terminals (a failed "+") instead of taking the pane.
 */
function SpawnError({
  message,
  onRetry,
  inline,
}: {
  message: string
  onRetry: () => void
  inline: boolean
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'flex px-4',
        inline
          ? 'border-danger/30 bg-danger/5 mb-1.5 items-start gap-2 rounded-md border py-2'
          : 'h-full items-center justify-center',
      )}
    >
      <div className={inline ? 'min-w-0 flex-1' : 'max-w-sm text-center'}>
        <div className="text-danger text-base font-medium">Could not start a shell</div>
        <div className="text-text-tertiary mt-1 whitespace-pre-wrap text-sm">{message}</div>
        <button
          onClick={onRetry}
          className="border-border text-text-secondary hover:text-text mt-2.5 rounded-md border px-2.5 py-1 text-base transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
