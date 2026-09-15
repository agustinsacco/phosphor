import { useEffect, useState } from 'react'
import { DateTime } from 'luxon'
import {
  activeRun,
  newRoutine,
  routinePeriod,
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
import { Markdown } from '@/components/markdown/Markdown'
import { presentText } from '@/stores/prompt'
import { useRoutinesStore } from '@/stores/routines'
import { useSessionsStore } from '@/stores/sessions'
import { RoutineEditor } from './RoutineEditor'

function time(at: number | null, zone: string): string {
  return at === null ? '—' : DateTime.fromMillis(at, { zone }).toFormat('ccc, dd LLL · HH:mm ZZZZ')
}

function scheduleLabel(r: Routine): string {
  if (r.archived) return 'Archived'
  if (r.attention) return 'Needs attention'
  if (!r.enabled) return 'Paused'
  if (r.schedule.kind === 'manual') return 'Manual only'
  if (r.nextAt === null) return 'Schedule complete'
  return `Next ${time(r.nextAt, r.timezone)}`
}

export function RoutinesPage({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const snapshot = useRoutinesStore((s) => s.snapshot)
  const loadError = useRoutinesStore((s) => s.error)
  const draft = useRoutinesStore((s) => s.draft)
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ input: RoutineInput; existing?: Routine } | null>(null)
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<RoutineRun[]>([])
  const [loaded, setLoaded] = useState(50)
  const [importing, setImporting] = useState(false)
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

  // Context-menu drafts are consumed once; no hidden schedule is created.
  useEffect(() => {
    if (draft) {
      setEditor({ input: draft })
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
  const list = (snapshot?.routines ?? [])
    .filter(
      (r) =>
        r.archived === archived &&
        `${r.name} ${r.workspacePath}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => {
      const rank = (r: Routine): number =>
        r.attention
          ? 0
          : snapshot?.runs.some((run) => run.routineId === r.id && activeRun(run))
            ? 1
            : r.enabled
              ? 2
              : 3
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })

  const openRun = async (run: RoutineRun): Promise<void> => {
    const store = useSessionsStore.getState()
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
            onClick={() => setEditor({ input: newRoutine(workspacePath) })}
          >
            New routine
          </Button>
        </>
      }
    >
      <div className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-5 pb-8">
        <div className="border-border text-text-secondary mb-5 rounded-lg border p-3">
          <p>
            Local routines run while Phosphor is running and this computer is awake. Sleep,
            shutdown, and lost connectivity can delay execution. There is no cloud runner.
          </p>
          <label className="mt-2 flex items-center gap-2">
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
        </div>
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
          <>
            <Button
              size="sm"
              onClick={() => {
                setSelected(null)
                setHistory([])
              }}
            >
              ← All routines
            </Button>
            <div className="mb-5 mt-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold">{routine.name}</h1>
                <p className="text-text-secondary mt-1">{scheduleLabel(routine)}</p>
                <p className="text-text-tertiary mt-1 break-all">{routine.workspacePath}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!routine.archived && (
                  <>
                    <Button
                      disabled={busy || !routine.trusted || !!routine.attention}
                      variant="primary"
                      onClick={() =>
                        void act(() =>
                          window.phosphor.invoke('routines:run', routine.id, crypto.randomUUID()),
                        )
                      }
                    >
                      {snapshot?.runs.some((r) => r.routineId === routine.id && activeRun(r))
                        ? 'Run already active'
                        : 'Run now'}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        routine.enabled
                          ? void act(() =>
                              window.phosphor.invoke(
                                'routines:save',
                                { ...routine, enabled: false },
                                routine.id,
                                routine.revision,
                              ),
                            )
                          : setEditor({ input: { ...routine, trusted: false }, existing: routine })
                      }
                    >
                      {routine.enabled ? 'Pause' : 'Review and enable'}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => setEditor({ input: routine, existing: routine })}
                    >
                      Edit
                    </Button>
                  </>
                )}
                <Button
                  onClick={() =>
                    setEditor({
                      input: {
                        ...routine,
                        name: `${routine.name} copy`.slice(0, 100),
                        enabled: false,
                        trusted: false,
                      },
                    })
                  }
                >
                  Duplicate
                </Button>
              </div>
            </div>
            {routine.attention && (
              <p role="alert" className="border-warning text-warning mb-4 rounded-lg border p-3">
                {routine.attention}
              </p>
            )}
            <div className="bg-bg-secondary mb-5 rounded-lg p-4">
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                <span>
                  {routine.provider} / {routine.model}
                </span>
                <span>
                  {routine.isolated ? 'Fresh worktree' : 'Folder task'} · {routine.intent}
                </span>
                <span>Revision {routine.revision}</span>
              </div>
              <p className="text-text-secondary mt-2">
                {routine.schedule.kind === 'cron'
                  ? `Cron ${routine.schedule.expression} · ${routine.timezone}`
                  : routine.schedule.kind === 'once'
                    ? `Once · ${time(routine.schedule.at, routine.timezone)}`
                    : 'Run manually'}{' '}
                · Catch up latest within {routine.catchUpHours}h · Limit {routine.maxRuntimeMinutes}
                m
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer">Instructions</summary>
                <p className="mt-2 whitespace-pre-wrap">{routine.instructions}</p>
              </details>
              <div className="mt-3 flex flex-wrap gap-2">
                {routine.nextAt !== null && (
                  <Button
                    disabled={busy}
                    size="sm"
                    onClick={() =>
                      void act(() => window.phosphor.invoke('routines:skipNext', routine.id))
                    }
                  >
                    Skip next run
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() =>
                    void presentText({
                      title: 'Export routine · copy this JSON (instructions included)',
                      text: JSON.stringify(
                        validateRoutine({ ...routine, enabled: false, trusted: false }),
                        null,
                        2,
                      ),
                    })
                  }
                >
                  Export
                </Button>
                {!routine.archived && (
                  <Button
                    disabled={busy}
                    size="sm"
                    onClick={() =>
                      void act(() => window.phosphor.invoke('routines:archive', routine.id))
                    }
                  >
                    Archive · keep history
                  </Button>
                )}
              </div>
            </div>
            <h2 className="mb-3 text-lg font-semibold">Run history</h2>
            <p className="text-text-secondary mb-3">
              Finished means the agent returned a written result—not that its claims or external
              deliveries were verified. A retry can repeat external changes.
            </p>
            {!history.length && (
              <p className="text-text-secondary">
                No runs yet. Save with unattended access acknowledged, then use Run now for a real
                test.
              </p>
            )}
            {history.map((run) => (
              <div
                key={run.id}
                data-testid="routine-run"
                className="border-border mb-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <strong>{RUN_LABELS[run.status]}</strong>
                    <p className="text-text-secondary mt-1">
                      Scheduled {time(run.scheduledAt, run.definition.timezone)} · {run.trigger}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy || (!run.sessionId && !run.sessionPath)}
                      onClick={() => void act(() => openRun(run))}
                    >
                      Open lane
                    </Button>
                    {activeRun(run) && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(() => window.phosphor.invoke('routines:cancel', run.id))
                        }
                      >
                        Cancel run
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-2">
                  {run.reason ||
                    (run.status === 'queued'
                      ? 'Waiting for an available routine worker.'
                      : 'Executing saved instructions…')}
                </p>
                <details className="mt-2">
                  <summary className="text-text-secondary cursor-pointer">
                    Run details and result
                  </summary>
                  <div className="mt-3 space-y-2">
                    <p>
                      Started {time(run.startedAt, run.definition.timezone)} · Ended{' '}
                      {time(run.endedAt, run.definition.timezone)}
                    </p>
                    <p>
                      Reporting period:{' '}
                      {(() => {
                        const p = routinePeriod(run.definition, run.scheduledAt)
                        return p ? `${p.start} → ${p.end} (end exclusive)` : 'From instructions'
                      })()}
                    </p>
                    <p className="break-all">
                      Run {run.id} · Revision {run.definition.revision}
                      <br />
                      {run.workspacePath}
                      <br />
                      {run.branch && `Branch ${run.branch}`}
                      {run.baseCommit && ` · Base ${run.baseCommit}`}
                    </p>
                    <p>
                      Model {run.definition.provider}/{run.definition.model}
                      {run.accountId ? ` · Account ${run.accountId}` : ''}
                    </p>
                    <details>
                      <summary className="cursor-pointer">Instructions used for this run</summary>
                      <p className="mt-2 whitespace-pre-wrap">{run.definition.instructions}</p>
                    </details>
                    {run.summary && <Markdown text={run.summary} />}
                  </div>
                </details>
              </div>
            ))}
            {history.length >= loaded && (
              <Button disabled={busy} onClick={() => setLoaded((n) => n + 50)}>
                Load older runs
              </Button>
            )}
          </>
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
                        setEditor({
                          input: {
                            ...newRoutine(workspacePath),
                            name: name!,
                            instructions: instructions!,
                            intent: intent as RoutineInput['intent'],
                            period: period as RoutineInput['period'],
                            isolated: intent === 'code',
                            schedule: { kind: 'cron', expression: '0 9 * * 1' },
                          },
                        })
                      }
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {list.map((r) => {
              const last = snapshot?.runs.find((run) => run.routineId === r.id)
              return (
                <button
                  key={r.id}
                  data-testid="routine-row"
                  className="border-border hover:bg-bg-secondary mb-2 flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-left"
                  onClick={() => {
                    setSelected(r.id)
                    setHistory([])
                    setLoaded(50)
                  }}
                >
                  <div>
                    <strong>{r.name}</strong>
                    <p className="text-text-tertiary mt-1 max-w-lg truncate">{r.workspacePath}</p>
                    <p className="text-text-secondary mt-1">
                      {last ? RUN_LABELS[last.status] : 'Not run yet'}
                    </p>
                  </div>
                  <span className={r.attention ? 'text-warning' : 'text-text-secondary'}>
                    {scheduleLabel(r)}
                  </span>
                </button>
              )
            })}
          </>
        )}
      </div>
      {editor && (
        <RoutineEditor
          initial={editor.input}
          existing={editor.existing}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            void useRoutinesStore.getState().refresh()
          }}
        />
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
                    setEditor({ input })
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
