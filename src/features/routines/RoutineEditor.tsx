import { useState } from 'react'
import { DateTime } from 'luxon'
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
import { useModelCatalogueStore } from '@/stores/modelCatalogue'

const SELECT = 'border-border bg-surface text-text w-full rounded-md border px-2.5 py-1.5'
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

function initialPreset(schedule: RoutineSchedule): Preset {
  if (schedule.kind === 'manual') return 'Manual'
  if (schedule.kind === 'once') return 'Once'
  return (
    (Object.keys(PRESETS) as Preset[]).find((p) => PRESETS[p] === schedule.expression) ?? 'Custom'
  )
}

export function RoutineEditor({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  initial: RoutineInput
  existing?: Routine
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [preset, setPreset] = useState<Preset>(initialPreset(initial.schedule))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [check, setCheck] = useState<RoutineCheck | null>(null)
  const models = useModelCatalogueStore((s) => s.models)
  const update = (patch: Partial<RoutineInput>): void => {
    setDraft((r) => ({ ...r, ...patch, trusted: false }))
    setCheck(null)
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
    <ModalOverlay onClose={onClose} closeOnBackdrop={!busy} closeOnEscape={!busy}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="routine-editor-title"
        className="bg-bg border-border max-h-[90vh] w-[min(720px,92vw)] overflow-y-auto rounded-xl border p-6 shadow-xl"
      >
        <h2 id="routine-editor-title" className="text-xl font-semibold">
          {existing ? 'Edit routine' : 'New routine'}
        </h2>
        <p className="text-text-secondary mb-5 mt-2">
          Local · runs while Phosphor is running and this computer is awake. Closing the app or
          sleeping can delay or skip a run.
        </p>
        {existing?.attention && (
          <p role="alert" className="text-warning mb-4">
            {existing.attention}
          </p>
        )}
        <fieldset disabled={busy} className="space-y-4">
          <label className="block">
            Name <span className="text-text-tertiary">· optional, derived from instructions</span>
            <TextInput
              className="mt-1 w-full"
              value={draft.name}
              maxLength={100}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="Weekly credit analysis"
            />
          </label>
          <label className="block">
            What should happen?
            <textarea
              autoFocus
              className={`${SELECT} mt-1 min-h-36 resize-y`}
              value={draft.instructions}
              maxLength={32000}
              onChange={(e) => update({ instructions: e.target.value })}
              placeholder="Describe the task, reference any runbooks, and say what a useful result looks like…"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
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
            <label>
              Execution
              <select
                className={`${SELECT} mt-1`}
                value={draft.isolated ? 'isolated' : 'folder'}
                onChange={(e) => update({ isolated: e.target.value === 'isolated' })}
              >
                <option value="isolated">Fresh Git worktree per run</option>
                <option value="folder">Folder task · no isolation</option>
              </select>
            </label>
            <label>
              Model
              <select
                className={`${SELECT} mt-1`}
                value={JSON.stringify([draft.provider, draft.model])}
                onChange={(e) => {
                  const [provider, model] = JSON.parse(e.target.value) as [string, string]
                  update({ provider, model })
                }}
              >
                <option value='["",""]'>Choose a model…</option>
                {draft.model &&
                  !models.some((m) => m.id === draft.model && m.provider === draft.provider) && (
                    <option value={JSON.stringify([draft.provider, draft.model])}>
                      {draft.provider} / {draft.model} · saved
                    </option>
                  )}
                {models.map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={JSON.stringify([m.provider, m.id])}>
                    {m.name} · {m.provider}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Task intent
              <select
                className={`${SELECT} mt-1`}
                value={draft.intent}
                onChange={(e) => update({ intent: e.target.value as RoutineInput['intent'] })}
              >
                <option value="code">Code changes / pull request</option>
                <option value="report">Analysis / report</option>
              </select>
            </label>
          </div>
          <div>
            <p className="mb-2 font-medium">When?</p>
            <div className="flex flex-wrap gap-1">
              {(Object.keys(PRESETS) as Preset[]).map((p) => (
                <Button
                  size="sm"
                  key={p}
                  aria-pressed={preset === p}
                  variant={preset === p ? 'primary' : 'secondary'}
                  onClick={() => changePreset(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
            {draft.schedule.kind === 'cron' && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {preset === 'Custom' ? (
                  <label>
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
                ) : (
                  preset !== 'Hourly' && (
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
                  )
                )}
                {preset === 'Weekly' && (
                  <label>
                    Day
                    <select
                      className={`${SELECT} mt-1`}
                      value={fields[4]}
                      onChange={(e) => setCronField(4, e.target.value)}
                    >
                      {[
                        'Sunday',
                        'Monday',
                        'Tuesday',
                        'Wednesday',
                        'Thursday',
                        'Friday',
                        'Saturday',
                      ].map((d, i) => (
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
              </div>
            )}
            {draft.schedule.kind === 'once' && (
              <label className="mt-3 block">
                Date and time in the selected timezone
                <TextInput
                  className="mt-1 w-full"
                  type="datetime-local"
                  value={DateTime.fromMillis(draft.schedule.at, { zone: draft.timezone }).toFormat(
                    "yyyy-MM-dd'T'HH:mm",
                  )}
                  onChange={(e) =>
                    update({
                      schedule: {
                        kind: 'once',
                        at: DateTime.fromISO(e.target.value, { zone: draft.timezone }).toMillis(),
                      },
                    })
                  }
                />
              </label>
            )}
            <label className="mt-3 block">
              Timezone
              <TextInput
                className="mt-1 w-full"
                value={draft.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
                placeholder="America/Argentina/Buenos_Aires"
              />
            </label>
            <p className="text-text-tertiary mt-2">
              Pinned to this timezone, even when you travel. Cron uses five fields; day-of-month and
              weekday match with OR. Missing DST times are skipped; explicit repeated-hour schedules
              run once. Monthly dates absent from a month are skipped.
            </p>
            {scheduleError ? (
              <p role="alert" className="text-danger mt-2">
                {scheduleError}
              </p>
            ) : (
              <div className="bg-bg-secondary mt-3 rounded-lg p-3">
                <strong>Next runs</strong>
                {preview.length ? (
                  <ul className="mt-1 space-y-1">
                    {preview.map((at) => (
                      <li key={at}>
                        {DateTime.fromMillis(at, { zone: draft.timezone }).toFormat(
                          'ccc, dd LLL yyyy · HH:mm ZZZZ (ZZ)',
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    {draft.schedule.kind === 'manual'
                      ? 'Only when you click Run now.'
                      : 'No future occurrence. Choose a future date.'}
                  </p>
                )}
              </div>
            )}
            {preview.length >= 2 && preview[1]! - preview[0]! < 3600000 && (
              <p className="text-warning mt-2">
                Frequent schedule: each run can spend model usage and make external changes. Runs do
                not overlap; only the latest queued scheduled occurrence is kept.
              </p>
            )}
          </div>
          <details>
            <summary className="cursor-pointer font-medium">
              Advanced · reporting period and reliability
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label>
                Reporting period
                <select
                  className={`${SELECT} mt-1`}
                  value={draft.period}
                  onChange={(e) => update({ period: e.target.value as RoutineInput['period'] })}
                >
                  <option value="none">Determined by instructions</option>
                  <option value="previous-day">Previous complete day</option>
                  <option value="previous-week">Previous complete week (Mon–Sun)</option>
                </select>
              </label>
              <label>
                Catch-up window (hours; 0 = skip missed)
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
                Runtime limit (minutes)
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
            <p className="text-text-secondary mt-3">
              Fresh context every run. Two routine workers maximum; one per routine/source folder.
              No automatic task retries. After three consecutive execution failures, scheduling
              pauses. Account routing follows your Phosphor account settings.
            </p>
          </details>
          <div className="border-warning/40 bg-warning/5 rounded-lg border p-3">
            <p className="font-medium">Trusted automation · full tool permissions</p>
            <p className="text-text-secondary mt-1">
              This agent can use local files, shell commands, and connected services without asking.
              Worktrees are branch isolation, not a sandbox. “Report” is an instruction, not
              enforced read-only access.
            </p>
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={draft.trusted}
                onChange={(e) => setDraft((r) => ({ ...r, trusted: e.target.checked }))}
              />
              <span>
                I authorize these instructions to run unattended with the selected model and
                available tools. A test run can also make real changes.
              </span>
            </label>
          </div>
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
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
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
