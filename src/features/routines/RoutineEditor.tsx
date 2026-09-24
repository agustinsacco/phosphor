import { useEffect, useId, useState } from 'react'
import { DateTime } from 'luxon'
import clsx from 'clsx'
import {
  nextOccurrences,
  validateRoutine,
  type Routine,
  type RoutineCheck,
  type RoutineInput,
  type RoutineSchedule,
} from '@shared/routines'
import { ModalOverlay } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { CloseIcon } from '@/components/icons'
import { ModelMenu } from '@/features/chat/composer/ModelMenu'
import { catalogueEmptyText, useModelCatalogueStore } from '@/stores/modelCatalogue'
import { keepEditorDraft } from '@/stores/routines'

const SELECT = 'border-border bg-surface text-text w-full rounded-md border px-2.5 py-1.5'
const EYEBROW = 'text-text-tertiary font-mono text-xs uppercase tracking-wide'
const PRESETS = {
  Manual: null,
  Hourly: '0 * * * *',
  Daily: '0 9 * * *',
  Weekdays: '0 9 * * 1-5',
  Weekly: '0 9 * * 1',
  Monthly: '0 9 1 * *',
  Once: null,
  Custom: '*/15 * * * *',
} as const
type Preset = keyof typeof PRESETS
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function initialPreset(schedule: RoutineSchedule): Preset {
  if (schedule.kind === 'manual') return 'Manual'
  if (schedule.kind === 'once') return 'Once'
  return (
    (Object.keys(PRESETS) as Preset[]).find((p) => PRESETS[p] === schedule.expression) ?? 'Custom'
  )
}

const same = (a: RoutineInput, b: RoutineInput): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The same searchable picker the composer uses, over pi's catalogue.
 *
 * A routine names its model explicitly and never falls back, so a saved pair
 * that the catalogue no longer lists stays selected and says so, rather than
 * silently reading as "choose a model".
 */
function ModelField({
  provider,
  model,
  open,
  onOpenChange,
  onPick,
}: {
  provider: string
  model: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (provider: string, model: string) => void
}): React.JSX.Element {
  const status = useModelCatalogueStore((s) => s.status)
  const models = useModelCatalogueStore((s) => s.models)
  const providers = useModelCatalogueStore((s) => s.providers)
  const source = useModelCatalogueStore((s) => s.source)
  useEffect(() => {
    void useModelCatalogueStore.getState().hydrate()
  }, [])
  const current = models.find((m) => m.id === model && m.provider === provider)
  const loading = status === 'idle' || status === 'loading'
  const missing = !!model && !current && !loading && source === 'pi'
  const id = useId()
  return (
    <>
      <span id={`${id}-label`}>Model</span>
      <button
        id={id}
        type="button"
        data-testid="routine-model-picker"
        aria-haspopup="dialog"
        aria-labelledby={`${id}-label ${id}`}
        onClick={() => {
          onOpenChange(!open)
          if (source === 'config') void useModelCatalogueStore.getState().refresh()
        }}
        className={clsx(
          SELECT,
          'hover:bg-bg-secondary flex min-w-0 items-baseline gap-1.5 text-left',
        )}
      >
        {model ? (
          <>
            <span className={clsx('truncate', missing && 'text-warning')}>
              {current?.name ?? model}
            </span>
            <span className="text-text-tertiary min-w-0 shrink-[9999] truncate font-mono text-sm">
              {provider}
              {missing && ' · not in catalogue'}
            </span>
          </>
        ) : (
          <span className="text-text-tertiary">
            {loading ? 'Loading models…' : 'Choose a model…'}
          </span>
        )}
      </button>
      {open && (
        <ModelMenu
          models={models}
          isCurrent={(m) => m.id === model && m.provider === provider}
          onPick={(m) => {
            onPick(m.provider, m.id)
            onOpenChange(false)
          }}
          onClose={() => onOpenChange(false)}
          loading={loading}
          emptyText={catalogueEmptyText(status, providers)}
          className="w-[30rem] max-w-[92vw]"
        />
      )}
    </>
  )
}

/**
 * Create or edit a routine.
 *
 * Nothing here dismisses the dialog by accident: a click on the backdrop does
 * nothing, and whatever the form holds when it does close (✕, Close, Escape,
 * or leaving the page) is kept in `editorDrafts` and comes back next time.
 * Reset is the one way to throw it away.
 */
export function RoutineEditor({
  initial,
  pristine,
  draftKey,
  existing,
  onClose,
  onSaved,
}: {
  initial: RoutineInput
  /** What Reset returns to: a blank routine, or the saved one being edited. */
  pristine: RoutineInput
  /** `editorDrafts` key: the routine id, or NEW_ROUTINE. */
  draftKey: string
  existing?: Routine
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [preset, setPreset] = useState<Preset>(initialPreset(initial.schedule))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [check, setCheck] = useState<RoutineCheck | null>(null)
  const [picking, setPicking] = useState(false)
  const dirty = !same(draft, pristine)

  // Mirrored on every change rather than on close, so that unmounting with
  // the page (a sidebar click) keeps the work too.
  useEffect(() => {
    keepEditorDraft(draftKey, dirty ? { input: draft, revision: existing?.revision ?? null } : null)
  }, [draft, dirty, draftKey, existing?.revision])

  const update = (patch: Partial<RoutineInput>): void => {
    setDraft((r) => ({ ...r, ...patch, trusted: false }))
    setCheck(null)
  }
  const reset = (): void => {
    setDraft(pristine)
    setPreset(initialPreset(pristine.schedule))
    setCheck(null)
    setError('')
  }
  const normalized = (enabled: boolean): RoutineInput =>
    validateRoutine({
      ...draft,
      enabled,
      name: draft.name.trim() || draft.instructions.trim().split('\n')[0]!.slice(0, 80),
    })
  const save = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const input = normalized(enabled)
      if (enabled) await window.phosphor.invoke('routines:check', input)
      await window.phosphor.invoke('routines:save', input, existing?.id, existing?.revision)
      keepEditorDraft(draftKey, null)
      onSaved()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  const checkSetup = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setCheck(await window.phosphor.invoke('routines:check', normalized(false)))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  let preview: number[] = []
  let scheduleError = ''
  try {
    preview = nextOccurrences(draft.schedule, draft.timezone, Date.now())
  } catch (cause) {
    scheduleError = String(cause)
  }
  const changePreset = (p: Preset): void => {
    setPreset(p)
    update({
      schedule:
        p === 'Manual'
          ? { kind: 'manual' }
          : p === 'Once'
            ? { kind: 'once', at: Date.now() + 3600000 }
            : { kind: 'cron', expression: PRESETS[p]! },
    })
  }
  const fields = draft.schedule.kind === 'cron' ? draft.schedule.expression.split(' ') : []
  const setCronField = (index: number, value: string): void => {
    const next = [...fields]
    next[index] = value
    update({ schedule: { kind: 'cron', expression: next.join(' ') } })
  }

  return (
    <ModalOverlay
      onClose={onClose}
      closeOnBackdrop={false}
      // The model menu owns Escape while it is open; without this the same
      // keypress would close the whole editor behind it.
      closeOnEscape={!busy && !picking}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="routine-editor-title"
        className="bg-bg border-border flex max-h-[90vh] w-[min(720px,92vw)] flex-col overflow-hidden rounded-xl border shadow-xl"
      >
        <div className="border-border flex items-start gap-3 border-b px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="routine-editor-title" className="text-xl font-semibold">
              {existing ? 'Edit routine' : 'New routine'}
            </h2>
            <p className="text-text-secondary mt-1">
              Runs locally while Phosphor is open and this computer is awake.
            </p>
          </div>
          <button
            aria-label="Close"
            title="Close · your changes are kept"
            className="text-text-tertiary hover:text-text hover:bg-bg-secondary rounded-md p-1.5"
            onClick={onClose}
            disabled={busy}
          >
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {existing?.attention && (
            <p role="alert" className="border-warning text-warning mb-4 rounded-lg border p-3">
              {existing.attention}
            </p>
          )}
          <fieldset disabled={busy} className="space-y-6">
            <section className="space-y-3">
              <label className="block">
                What should happen?
                <textarea
                  autoFocus
                  className={`${SELECT} mt-1 min-h-32 resize-y`}
                  value={draft.instructions}
                  maxLength={32000}
                  onChange={(e) => update({ instructions: e.target.value })}
                  placeholder="Describe the task, reference any runbooks, and say what a useful result looks like…"
                />
              </label>
              <label className="block">
                Name <span className="text-text-tertiary">· optional</span>
                <TextInput
                  className="mt-1 w-full"
                  value={draft.name}
                  maxLength={100}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder={
                    draft.instructions.trim().split('\n')[0]!.slice(0, 80) ||
                    'Derived from the first line of the instructions'
                  }
                />
              </label>
            </section>

            <section className="space-y-3">
              <h3 className={EYEBROW}>Where and how</h3>
              <label className="block">
                Workspace
                <div className="mt-1 flex gap-1">
                  <TextInput
                    aria-label="Workspace"
                    className="min-w-0 flex-1"
                    value={draft.workspacePath}
                    onChange={(e) => update({ workspacePath: e.target.value })}
                  />
                  <Button
                    onClick={() =>
                      void window.phosphor
                        .invoke('app:selectFolder')
                        .then((path) => {
                          if (path) update({ workspacePath: path })
                        })
                        .catch((cause: unknown) => setError(String(cause)))
                    }
                  >
                    Choose…
                  </Button>
                </div>
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <ModelField
                    provider={draft.provider}
                    model={draft.model}
                    open={picking}
                    onOpenChange={setPicking}
                    onPick={(provider, model) => update({ provider, model })}
                  />
                </div>
                <label>
                  Execution
                  <select
                    className={`${SELECT} mt-1`}
                    value={draft.isolated ? 'isolated' : 'folder'}
                    onChange={(e) => update({ isolated: e.target.value === 'isolated' })}
                  >
                    <option value="isolated">Fresh worktree per run</option>
                    <option value="folder">Folder task · no isolation</option>
                  </select>
                </label>
                <label>
                  Task intent
                  <select
                    className={`${SELECT} mt-1`}
                    value={draft.intent}
                    onChange={(e) => update({ intent: e.target.value as RoutineInput['intent'] })}
                  >
                    <option value="code">Code changes / PR</option>
                    <option value="report">Analysis / report</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className={EYEBROW}>When</h3>
              <div
                role="group"
                aria-label="Schedule"
                className="border-border inline-flex flex-wrap rounded-md border p-0.5"
              >
                {(Object.keys(PRESETS) as Preset[]).map((p) => (
                  <button
                    type="button"
                    key={p}
                    aria-pressed={preset === p}
                    onClick={() => changePreset(p)}
                    className={clsx(
                      'rounded px-2.5 py-1 transition-colors',
                      preset === p
                        ? 'bg-accent text-accent-text'
                        : 'text-text-secondary hover:text-text hover:bg-bg-secondary',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {preset === 'Custom' && draft.schedule.kind === 'cron' && (
                  <label className="sm:col-span-2">
                    Cron expression
                    <TextInput
                      className="mt-1 w-full font-mono"
                      value={draft.schedule.expression}
                      onChange={(e) =>
                        update({ schedule: { kind: 'cron', expression: e.target.value } })
                      }
                      placeholder="0 9 * * 1-5"
                    />
                  </label>
                )}
                {draft.schedule.kind === 'cron' && preset !== 'Custom' && preset !== 'Hourly' && (
                  <label>
                    At
                    <TextInput
                      className="mt-1 w-full"
                      type="time"
                      value={`${fields[1]?.padStart(2, '0')}:${fields[0]?.padStart(2, '0')}`}
                      onChange={(e) => {
                        const [hour, minute] = e.target.value.split(':')
                        if (hour && minute)
                          update({
                            schedule: {
                              kind: 'cron',
                              expression: `${Number(minute)} ${Number(hour)} ${fields.slice(2).join(' ')}`,
                            },
                          })
                      }}
                    />
                  </label>
                )}
                {preset === 'Weekly' && (
                  <label>
                    Day
                    <select
                      className={`${SELECT} mt-1`}
                      value={fields[4]}
                      onChange={(e) => setCronField(4, e.target.value)}
                    >
                      {WEEKDAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {preset === 'Monthly' && (
                  <label>
                    Day of month
                    <select
                      className={`${SELECT} mt-1`}
                      value={fields[2]}
                      onChange={(e) => setCronField(2, e.target.value)}
                    >
                      {Array.from({ length: 31 }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {i + 1}
                        </option>
                      ))}
                      <option value="L">Last day</option>
                    </select>
                  </label>
                )}
                {draft.schedule.kind === 'once' && (
                  <label className="sm:col-span-2">
                    Date and time
                    <TextInput
                      className="mt-1 w-full"
                      type="datetime-local"
                      value={DateTime.fromMillis(draft.schedule.at, {
                        zone: draft.timezone,
                      }).toFormat("yyyy-MM-dd'T'HH:mm")}
                      onChange={(e) =>
                        update({
                          schedule: {
                            kind: 'once',
                            at: DateTime.fromISO(e.target.value, {
                              zone: draft.timezone,
                            }).toMillis(),
                          },
                        })
                      }
                    />
                  </label>
                )}
                {draft.schedule.kind !== 'manual' && (
                  <label title="Pinned: the schedule keeps this timezone even when you travel.">
                    Timezone
                    <TextInput
                      className="mt-1 w-full"
                      value={draft.timezone}
                      onChange={(e) => update({ timezone: e.target.value })}
                      placeholder="America/Argentina/Buenos_Aires"
                    />
                  </label>
                )}
              </div>
              {scheduleError ? (
                <p role="alert" className="text-danger">
                  {scheduleError}
                </p>
              ) : (
                <div className="text-text-secondary">
                  <strong className="text-text font-medium">Next runs</strong>
                  {preview.length ? (
                    <ul className="mt-1 space-y-0.5 tabular-nums">
                      {preview.slice(0, 3).map((at) => (
                        <li key={at}>
                          {DateTime.fromMillis(at, { zone: draft.timezone }).toFormat(
                            'ccc, dd LLL yyyy · HH:mm ZZZZ',
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1">
                      {draft.schedule.kind === 'manual'
                        ? 'Only when you click Run now.'
                        : 'No future occurrence. Choose a future date.'}
                    </p>
                  )}
                </div>
              )}
              {preview.length >= 2 && preview[1]! - preview[0]! < 3600000 && (
                <p className="text-warning">
                  Frequent schedule: every run spends model usage and can make external changes.
                </p>
              )}
            </section>

            <details>
              <summary className={clsx(EYEBROW, 'cursor-pointer')}>Advanced</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label>
                  Reporting period
                  <select
                    className={`${SELECT} mt-1`}
                    value={draft.period}
                    onChange={(e) => update({ period: e.target.value as RoutineInput['period'] })}
                  >
                    <option value="none">From instructions</option>
                    <option value="previous-day">Previous day</option>
                    <option value="previous-week">Previous week (Mon–Sun)</option>
                  </select>
                </label>
                <label title="0 skips missed runs instead of catching up.">
                  Catch-up window (h)
                  <TextInput
                    type="number"
                    min={0}
                    max={168}
                    className="mt-1 w-full"
                    value={draft.catchUpHours}
                    onChange={(e) => update({ catchUpHours: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Runtime limit (min)
                  <TextInput
                    type="number"
                    min={1}
                    max={240}
                    className="mt-1 w-full"
                    value={draft.maxRuntimeMinutes}
                    onChange={(e) => update({ maxRuntimeMinutes: Number(e.target.value) })}
                  />
                </label>
              </div>
              <p className="text-text-tertiary mt-2">
                No automatic retries. Three failures in a row pause the routine.
              </p>
            </details>

            <label className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-lg border p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.trusted}
                onChange={(e) => setDraft((r) => ({ ...r, trusted: e.target.checked }))}
              />
              <span>
                <span className="font-medium">Run unattended with full tool access.</span>{' '}
                <span className="text-text-secondary">
                  The agent can use files, shell commands, and connected services without asking.
                  Worktrees isolate branches, not the machine, and “report” is an instruction, not a
                  read-only mode.
                </span>
              </span>
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="text-danger mt-4 whitespace-pre-wrap">
              {error}
            </p>
          )}
          {check && (
            <div role="status" className="mt-4">
              {check.warning && (
                <p className="text-warning">Would not run right now: {check.warning}</p>
              )}
              <p className="text-text-secondary mt-1">{check.summary}</p>
            </div>
          )}
        </div>

        <div className="border-border flex flex-wrap items-center gap-2 border-t px-6 py-3">
          <Button
            disabled={busy || !dirty}
            title={existing ? 'Discard your changes to this routine' : 'Start from a blank routine'}
            onClick={reset}
          >
            Reset
          </Button>
          <span className="flex-1" />
          <Button disabled={busy} onClick={() => void checkSetup()}>
            Check setup
          </Button>
          <Button disabled={busy} onClick={() => void save(false)}>
            Save paused
          </Button>
          <Button
            disabled={busy || !draft.trusted}
            variant="primary"
            onClick={() => void save(true)}
          >
            {busy ? 'Saving…' : existing ? 'Save and enable' : 'Enable routine'}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}
