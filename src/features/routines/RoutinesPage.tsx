import { useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  activeRun,
  newRoutine,
  RUN_LABELS,
  validateRoutine,
  type Routine,
  type RoutineInput,
  type RoutineRun,
} from '@shared/routines'
import { PageShell } from '@/components/PageShell'
import { PaneTitle } from '@/components/PaneShell'
import { Button, TextInput } from '@/components/form'
import { ModalOverlay } from '@/components/Modal'
import { presentText } from '@/stores/prompt'
import { editorDraft, keepEditorDraft, NEW_ROUTINE, useRoutinesStore } from '@/stores/routines'
import { useSessionsStore } from '@/stores/sessions'
import { ActivityAccordion } from './ActivityAccordion'
import { RoutineDetail, routineTone, scheduleLabel } from './RoutineDetail'
import { RoutineEditor } from './RoutineEditor'

/** What the editor opens with, and what its Reset button returns to. */
interface EditorState {
  key: string
  input: RoutineInput
  pristine: RoutineInput
  existing?: Routine
}

export function RoutinesPage({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const snapshot = useRoutinesStore((s) => s.snapshot)
  const loadError = useRoutinesStore((s) => s.error)
  const draft = useRoutinesStore((s) => s.draft)
  const unsaved = useRoutinesStore((s) => !!s.editorDrafts[NEW_ROUTINE])
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleting, setDeleting] = useState<Routine | null>(null)
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<RoutineRun[]>([])
  const [loaded, setLoaded] = useState(50)
  const [importing, setImporting] = useState(false)
  const [continuing, setContinuing] = useState<RoutineRun | null>(null)
  const [json, setJson] = useState('')

  useEffect(() => {
    const refresh = (): void => {
      void useRoutinesStore.getState().refresh()
    }
    const off = window.phosphor.onRoutinesChanged(refresh)
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [])

  /**
   * Open the editor on a routine that is not saved yet. With no `input` it
   * resumes whatever was left in it last time; a starter, duplicate, import or
   * context-menu draft replaces that. Reset always returns to a blank routine.
   */
  const create = (input?: RoutineInput): void => {
    const blank = newRoutine(workspacePath)
    setEditor({
      key: NEW_ROUTINE,
      input: input ?? editorDraft(NEW_ROUTINE, null) ?? blank,
      pristine: blank,
    })
  }
  /** Edit a saved routine, resuming unsaved changes made to this revision. */
  const edit = (routine: Routine, start: RoutineInput): void =>
    setEditor({
      key: routine.id,
      input: editorDraft(routine.id, routine.revision) ?? start,
      pristine: start,
      existing: routine,
    })

  // Context-menu drafts are consumed once; no hidden schedule is created.
  useEffect(() => {
    if (draft) {
      setEditor({ key: NEW_ROUTINE, input: draft, pristine: newRoutine(draft.workspacePath) })
      useRoutinesStore.setState({ draft: null })
    }
  }, [draft])

  useEffect(() => {
    if (!selected) return
    let stale = false
    void Promise.all(
      Array.from({ length: loaded / 50 }, (_, page) =>
        window.phosphor.invoke('routines:history', selected, page * 50),
      ),
    )
      .then((pages) => {
        if (!stale) setHistory([...new Map(pages.flat().map((r) => [r.id, r])).values()])
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause))
      })
    return () => {
      stale = true
    }
  }, [selected, snapshot, loaded])

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await operation()
      await useRoutinesStore.getState().refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  const routine = snapshot?.routines.find((r) => r.id === selected)
  const running = (id: string): boolean =>
    !!snapshot?.runs.some((run) => run.routineId === id && activeRun(run))
  const list = (snapshot?.routines ?? [])
    .filter(
      (r) =>
        r.archived === archived &&
        `${r.name} ${r.workspacePath}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => {
      const rank = (r: Routine): number => (r.attention ? 0 : running(r.id) ? 1 : r.enabled ? 2 : 3)
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })

  /**
   * Hand this run's lane back to its workspace, then open it.
   *
   * Opening is the promotion: there is no read-only transcript view in
   * Phosphor — reopening a session file spawns a real pi process — so a lane
   * you have opened is one you own, and it has to be reachable from the
   * sidebar rather than only from this page.
   */
  const openRun = async (run: RoutineRun): Promise<void> => {
    const store = useSessionsStore.getState()
    if (run.sessionPath) await window.phosphor.invoke('routines:promoteRun', run.id)
    const live = (await window.phosphor.invoke('pi:listLiveSessions')).find(
      (s) => s.sessionId === run.sessionId,
    )
    if (live) {
      await store.adoptSession(live.sessionId, live.workspacePath, run.sessionPath ?? undefined)
      store.activate(live.sessionId)
    } else if (run.sessionPath && run.workspacePath) {
      // A live view may have watched this routine finish and be disposed.
      if (run.sessionId && store.live[run.sessionId]) await store.disposeSession(run.sessionId)
      const sessionId = await store.createSession(run.workspacePath, {
        sessionPath: run.sessionPath,
      })
      store.activate(sessionId)
    } else
      throw new Error(
        'No transcript is available yet. The run may have stopped before pi wrote its first turn.',
      )
  }

  return (
    <PageShell
      title={
        <PaneTitle
          label="Routines"
          meta={snapshot ? `${snapshot.routines.filter((r) => !r.archived).length}` : undefined}
        />
      }
      actions={
        <>
          <Button size="sm" onClick={() => setImporting(true)}>
            Import
          </Button>
          <Button
            size="sm"
            variant="primary"
            title={unsaved ? 'Pick up the routine you were writing' : undefined}
            onClick={() => create()}
          >
            {unsaved ? 'Resume draft' : 'New routine'}
          </Button>
        </>
      }
    >
      <div className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-5 pb-8">
        {(error || loadError) && (
          <div role="alert" className="border-danger text-danger mb-4 rounded-lg border p-3">
            <p>{error || loadError}</p>
            <Button size="sm" onClick={() => void useRoutinesStore.getState().refresh()}>
              Refresh
            </Button>
          </div>
        )}
        {!snapshot && !loadError && <p role="status">Loading routines…</p>}
        {routine ? (
          <RoutineDetail
            routine={routine}
            history={history}
            running={running(routine.id)}
            busy={busy}
            more={history.length >= loaded}
            onBack={() => {
              setSelected(null)
              setHistory([])
            }}
            onRun={() =>
              void act(() =>
                window.phosphor.invoke('routines:run', routine.id, crypto.randomUUID()),
              )
            }
            onPause={() =>
              void act(() =>
                window.phosphor.invoke(
                  'routines:save',
                  { ...routine, enabled: false },
                  routine.id,
                  routine.revision,
                ),
              )
            }
            onReview={() => edit(routine, { ...routine, trusted: false })}
            onEdit={() => edit(routine, routine)}
            onSkipNext={() =>
              void act(() => window.phosphor.invoke('routines:skipNext', routine.id))
            }
            onDuplicate={() =>
              create({
                ...routine,
                name: `${routine.name} copy`.slice(0, 100),
                enabled: false,
                trusted: false,
              })
            }
            onExport={() =>
              void presentText({
                title: 'Export routine · copy this JSON (instructions included)',
                text: JSON.stringify(
                  validateRoutine({ ...routine, enabled: false, trusted: false }),
                  null,
                  2,
                ),
              })
            }
            onArchive={() => void act(() => window.phosphor.invoke('routines:archive', routine.id))}
            onDelete={() => setDeleting(routine)}
            onContinue={setContinuing}
            onCancel={(run) => void act(() => window.phosphor.invoke('routines:cancel', run.id))}
            onLoadMore={() => setLoaded((n) => n + 50)}
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <TextInput
                aria-label="Search routines"
                className="min-w-0 flex-1"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search routines or workspaces"
              />
              <Button size="sm" onClick={() => setArchived(!archived)}>
                {archived ? 'Show active list' : 'Show archived'}
              </Button>
              <Button
                disabled={busy}
                size="sm"
                onClick={() => void act(() => window.phosphor.invoke('routines:pauseAll'))}
              >
                Pause all
              </Button>
            </div>
            {!list.length && (
              <div className="border-border rounded-xl border p-6">
                <h2 className="text-xl font-semibold">Save a task. Give it a schedule.</h2>
                <p className="text-text-secondary mb-4 mt-2">
                  Each run creates a fresh lane with its own transcript. Start from scratch or adapt
                  a starter:
                </p>
                <div className="flex flex-wrap gap-2">
                  {[
                    [
                      'Weekly analysis',
                      'Read the linked runbook and analyze the previous complete week. Compare it with the week before, cite sources, flag missing data, and create a report. Do not publish externally.',
                      'report',
                      'previous-week',
                    ],
                    [
                      'Dependency audit',
                      'Review dependencies for security and maintenance issues. Make a small, tested fix on this lane when appropriate and open a pull request. Report blockers honestly.',
                      'code',
                      'none',
                    ],
                    [
                      'Cycle retro',
                      'Review completed and unfinished work for the previous complete week. Cite the underlying issues and pull requests. Create a concise retro with outcomes and follow-up actions.',
                      'report',
                      'previous-week',
                    ],
                  ].map(([name, instructions, intent, period]) => (
                    <Button
                      key={name}
                      onClick={() =>
                        create({
                          ...newRoutine(workspacePath),
                          name: name!,
                          instructions: instructions!,
                          intent: intent as RoutineInput['intent'],
                          period: period as RoutineInput['period'],
                          isolated: intent === 'code',
                          schedule: { kind: 'cron', expression: '0 9 * * 1' },
                        })
                      }
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {!!list.length && (
              <ul className="border-border bg-surface divide-border divide-y rounded-lg border">
                {list.map((r) => {
                  const last = snapshot?.runs.find((run) => run.routineId === r.id)
                  return (
                    <li key={r.id}>
                      <button
                        data-testid="routine-row"
                        className="hover:bg-bg-secondary flex w-full items-center gap-3 px-4 py-3 text-left"
                        onClick={() => {
                          setSelected(r.id)
                          setHistory([])
                          setLoaded(50)
                        }}
                      >
                        <span
                          aria-hidden
                          className={clsx(
                            'size-2 shrink-0 rounded-full',
                            routineTone(r, running(r.id)),
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate font-medium">{r.name}</strong>
                          <span className="text-text-tertiary block truncate text-sm">
                            {r.workspacePath}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-sm">
                          <span
                            className={clsx(
                              'block',
                              r.attention ? 'text-warning' : 'text-text-secondary',
                            )}
                          >
                            {scheduleLabel(r)}
                          </span>
                          <span className="text-text-tertiary block">
                            {last ? `Last: ${RUN_LABELS[last.status]}` : 'Not run yet'}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {!!snapshot?.runs.length && (
              <div className="mt-8">
                <ActivityAccordion
                  heading={
                    <>
                      <h2 className="text-lg font-semibold">Activity</h2>
                      <p className="text-text-tertiary text-sm">
                        Recent lanes from every routine. Open a routine for its full history.
                      </p>
                    </>
                  }
                  runs={snapshot.runs}
                  routines={snapshot.routines}
                  busy={busy}
                  onContinue={setContinuing}
                  onCancel={(run) =>
                    void act(() => window.phosphor.invoke('routines:cancel', run.id))
                  }
                />
              </div>
            )}
            <footer className="border-border text-text-tertiary mt-8 border-t pt-3 text-sm">
              <p>
                Routines run on this computer while Phosphor is open and awake. Sleep, shutdown and
                lost connectivity delay them; there is no cloud runner.
              </p>
              <label className="text-text-secondary mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={busy || !snapshot || !!snapshot.error}
                  checked={snapshot?.background ?? false}
                  onChange={(e) =>
                    void act(() => window.phosphor.invoke('routines:background', e.target.checked))
                  }
                />
                Keep Phosphor running after closing its windows · tray/menu-bar controls
              </label>
            </footer>
          </>
        )}
      </div>
      {editor && (
        <RoutineEditor
          key={editor.key}
          initial={editor.input}
          pristine={editor.pristine}
          draftKey={editor.key}
          existing={editor.existing}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            void useRoutinesStore.getState().refresh()
          }}
        />
      )}
      {continuing && (
        <ModalOverlay onClose={() => setContinuing(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Continue routine lane"
            className="bg-bg border-border w-[min(540px,90vw)] rounded-xl border p-5"
          >
            <h2 className="text-xl font-semibold">
              {activeRun(continuing) ? 'Open this running lane?' : 'Continue this routine lane?'}
            </h2>
            <p className="text-text-secondary my-3">
              {activeRun(continuing)
                ? 'The routine keeps control until this run finishes. The lane appears in the workspace list so you can watch it, and stays there afterwards.'
                : 'This transcript becomes an ordinary interactive session in the workspace list. The routine will not use it again.'}
            </p>
            <p className="border-border text-text-secondary mb-3 break-all border-l-2 pl-3">
              {continuing.workspacePath ?? continuing.definition.workspacePath}
              <br />
              {continuing.branch
                ? `Branch ${continuing.branch}`
                : 'Folder task · it reopens in this checkout on whatever branch it is on now.'}
            </p>
            <p className="text-text-tertiary mb-4">
              This run and its output stay in the routine&apos;s history either way.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setContinuing(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  const run = continuing
                  setContinuing(null)
                  void act(() => openRun(run))
                }}
              >
                {activeRun(continuing) ? 'Open lane' : 'Continue'}
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}
      {deleting && (
        <ModalOverlay onClose={() => !busy && setDeleting(null)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Delete routine"
            className="bg-bg border-border w-[min(520px,90vw)] rounded-xl border p-5"
          >
            <h2 className="text-xl font-semibold">Delete “{deleting.name}”?</h2>
            <p className="text-text-secondary my-3">
              The routine and its run history are removed. Lanes it ran that you never continued go
              to the trash with it; lanes you continued stay in their workspace.
            </p>
            <p className="text-text-tertiary mb-4">
              Worktrees are left for maintenance to reclaim, so nothing uncommitted is lost. To keep
              the history instead, archive it.
            </p>
            <div className="flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  const id = deleting.id
                  void act(async () => {
                    await window.phosphor.invoke('routines:delete', id)
                    keepEditorDraft(id, null)
                    setSelected(null)
                    setHistory([])
                  }).finally(() => setDeleting(null))
                }}
              >
                Delete routine
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}
      {importing && (
        <ModalOverlay onClose={() => setImporting(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Import routine"
            className="bg-bg border-border w-[min(600px,90vw)] rounded-xl border p-5"
          >
            <h2 className="text-xl font-semibold">Import routine</h2>
            <p className="text-text-secondary my-3">
              Paste an exported definition. Imports are always paused and untrusted. Review
              instructions, workspace, and account access before enabling.
            </p>
            <textarea
              aria-label="Routine JSON"
              className="border-border bg-surface min-h-48 w-full rounded-lg border p-3 font-mono"
              maxLength={50000}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button onClick={() => setImporting(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  try {
                    const input = validateRoutine({
                      ...JSON.parse(json),
                      enabled: false,
                      trusted: false,
                    })
                    create(input)
                    setImporting(false)
                    setError('')
                  } catch (cause) {
                    setError(String(cause))
                    setImporting(false)
                  }
                }}
              >
                Review import
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </PageShell>
  )
}
