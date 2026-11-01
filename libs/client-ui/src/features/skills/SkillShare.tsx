import clsx from 'clsx'
import { useRef, useState } from 'react'
import type { ResolvedSkill } from '@shared/skills'
import { PopupMenu } from '@/components/PopupMenu'
import { Button } from '@/components/form'
import { CheckIcon, WarningIcon } from '@/components/icons'
import { Spinner } from '@/features/machines/MachineUi'
import { formatBytes } from '@/lib/format'
import { useMachinesStore } from '@/stores/machines'
import {
  loadSkillNames,
  shareMachineLabel,
  sourceMachine,
  useShareMachines,
  useSkillPresence,
  type Presence,
  type ShareMachine,
} from './skillPresence'
import { useSkillCopy, type SkillCopy } from './useSkillCopy'

type Share = ReturnType<typeof useSkillCopy>

/**
 * Detail actions for sharing: Export (This Mac only) and Share, which clones the skill into
 * another machine's global skills folder. The copy is independent: nothing stays linked.
 */
export function SkillShareActions({
  skill,
  workspacePath,
  disabled,
  onExport,
}: {
  skill: ResolvedSkill
  workspacePath: string
  disabled: boolean
  onExport: () => void
}): React.JSX.Element {
  const source = sourceMachine(workspacePath)
  const machines = useShareMachines(source)
  const presence = useSkillPresence(skill.name, machines)
  const share = useSkillCopy(skill, source)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const toggle = () => {
    if (!open) {
      // A finished copy gives way to the machine list; one in flight or waiting stays.
      if (share.copy?.step === 'done' || share.copy?.step === 'failed') share.reset()
      for (const machine of machines) if (machine.readable) void loadSkillNames(machine.id)
    }
    setOpen(!open)
  }
  return (
    <>
      {source === 'local' && (
        <Button size="sm" disabled={disabled} onClick={onExport}>
          Export
        </Button>
      )}
      <div className="relative">
        <Button
          ref={trigger}
          size="sm"
          disabled={disabled && !share.busy}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-tooltip="Copy this skill to another machine"
          onClick={toggle}
        >
          <span className="inline-flex items-center gap-1.5">
            {share.busy && <Spinner size={11} />}
            Share
          </span>
        </Button>
        {open && (
          <PopupMenu
            triggerRef={trigger}
            fitViewport
            escapeContainer
            onClose={() => setOpen(false)}
            className="absolute top-full right-0 mt-1.5 w-[23rem]"
          >
            <div role="dialog" aria-label={`Share ${skill.name}`} className="p-3 text-sm">
              {share.copy ? (
                <CopyProgress
                  name={skill.name}
                  source={source}
                  copy={share.copy}
                  share={share}
                  onClose={() => setOpen(false)}
                />
              ) : (
                <MachineList
                  name={skill.name}
                  machines={machines}
                  presence={presence}
                  onCopy={(target) => void share.start(target)}
                  onClose={() => setOpen(false)}
                />
              )}
            </div>
          </PopupMenu>
        )}
      </div>
    </>
  )
}

/** One line under the skill's path: which other machines already have this name. */
export function SkillMachines({
  skill,
  workspacePath,
}: {
  skill: ResolvedSkill
  workspacePath: string
}): React.JSX.Element | null {
  const machines = useShareMachines(sourceMachine(workspacePath))
  const presence = useSkillPresence(skill.name, machines)
  const labels = (state: Presence) =>
    machines.filter((machine) => presence[machine.id] === state).map((machine) => machine.label)
  const having = labels('has')
  const missing = labels('missing')
  // Offline or unreadable machines are never reported as lacking the skill.
  const text = having.length
    ? `Also on ${having.join(', ')}`
    : labels('checking').length
      ? 'Checking other machines…'
      : missing.length
        ? `Not on ${missing.join(', ')}`
        : null
  return text ? (
    <div className="text-text-tertiary pt-0.5 text-xs" data-testid="skill-machines">
      {text}
    </div>
  ) : null
}

const PRESENCE_TEXT: Record<Presence, string> = {
  has: 'Has this skill',
  missing: '',
  checking: 'Checking…',
  unknown: '',
}

/** Why a Host cannot take a copy now, or null when it can. */
function blocked(machine: ShareMachine): { text: string; settings?: true } | null {
  const host = machine.host
  if (!host) return null
  if (host.state !== 'ready') return { text: 'Not connected' }
  if (host.capabilities.includes('machine.configure')) return null
  return host.configurationSupported
    ? { text: 'Needs configuration access', settings: true }
    : { text: 'Update its Host to share skills' }
}

function MachineList({
  name,
  machines,
  presence,
  onCopy,
  onClose,
}: {
  name: string
  machines: ShareMachine[]
  presence: Record<string, Presence>
  onCopy: (target: string) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="text-text text-base font-medium">Copy {name} to…</div>
      <p className="text-text-tertiary pb-2">
        Clones the whole skill folder into that machine’s global skills. The copies are not linked
        afterwards.
      </p>
      {machines.length === 0 && (
        <p className="text-text-secondary py-1">No other machine is connected.</p>
      )}
      <ul className="space-y-1">
        {machines.map((machine) => {
          const reason = blocked(machine)
          const state = presence[machine.id] ?? 'unknown'
          return (
            <li key={machine.id} className="flex items-center gap-2">
              <span className="text-text min-w-0 flex-1 truncate">{machine.label}</span>
              <span
                className={clsx(
                  'shrink-0',
                  state === 'has' ? 'text-warning' : 'text-text-tertiary',
                )}
              >
                {reason?.text ?? PRESENCE_TEXT[state]}
              </span>
              {reason?.settings ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onClose()
                    useMachinesStore
                      .getState()
                      .show({ kind: 'machine', id: machine.id, settings: 'resources' })
                  }}
                >
                  Settings
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={reason !== null}
                  aria-label={`Copy ${name} to ${machine.label}`}
                  onClick={() => onCopy(machine.id)}
                >
                  Copy
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

type StepState = 'pending' | 'active' | 'done' | 'failed'

function Step({ state, children }: { state: StepState; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="inline-flex w-4 shrink-0 justify-center">
        {state === 'active' ? (
          <Spinner size={12} />
        ) : state === 'done' ? (
          <CheckIcon size={13} className="text-success" />
        ) : state === 'failed' ? (
          <WarningIcon size={13} className="text-danger" />
        ) : (
          <span className="bg-border h-1.5 w-1.5 rounded-full" />
        )}
      </span>
      <span className={state === 'pending' ? 'text-text-tertiary' : 'text-text'}>{children}</span>
    </li>
  )
}

function steps(copy: SkillCopy): [StepState, StepState] {
  if (copy.step === 'reading') return ['active', 'pending']
  if (copy.step === 'failed') return copy.read ? ['failed', 'pending'] : ['done', 'failed']
  if (copy.step === 'writing') return ['done', 'active']
  return ['done', copy.step === 'done' ? 'done' : 'failed']
}

function CopyProgress({
  name,
  source,
  copy,
  share,
  onClose,
}: {
  name: string
  source: string
  copy: SkillCopy
  share: Share
  onClose: () => void
}): React.JSX.Element {
  const target = shareMachineLabel(copy.target)
  const [read, write] = steps(copy)
  const size =
    'files' in copy
      ? ` · ${copy.files} ${copy.files === 1 ? 'file' : 'files'}, ${formatBytes(copy.bytes)}`
      : ''
  return (
    <>
      <div className="text-text text-base font-medium">
        Copy {name} to {target}
      </div>
      <ol className="space-y-1 py-2" aria-live="polite">
        <Step state={read}>
          {read === 'active' ? 'Reading' : 'Read'} from {shareMachineLabel(source)}
          {size}
        </Step>
        <Step state={write}>
          {copy.step === 'writing'
            ? `${copy.overwrite ? 'Replacing' : 'Writing'} on ${target}…`
            : copy.step === 'done'
              ? `${copy.replaced ? 'Replaced' : 'Added'} on ${target}`
              : `Write to ${target}`}
        </Step>
      </ol>
      <CopyOutcome name={name} target={target} copy={copy} share={share} onClose={onClose} />
    </>
  )
}

function CopyOutcome({
  name,
  target,
  copy,
  share,
  onClose,
}: {
  name: string
  target: string
  copy: SkillCopy
  share: Share
  onClose: () => void
}): React.JSX.Element | null {
  if (copy.step === 'reading' || copy.step === 'writing') return null
  const back = (
    <Button size="sm" onClick={share.reset}>
      {copy.step === 'done' ? 'Copy elsewhere' : 'Back'}
    </Button>
  )
  if (copy.step === 'done')
    return (
      <div className="flex justify-end gap-2">
        {back}
        <Button size="sm" variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    )
  if (copy.step === 'failed')
    return (
      <>
        <p role="alert" className="text-danger pb-2">
          {copy.message}
        </p>
        <div className="flex justify-end gap-2">
          {back}
          <Button size="sm" onClick={() => void share.start(copy.target)}>
            Try again
          </Button>
        </div>
      </>
    )
  return (
    <>
      <p role="alert" className="text-warning pb-2">
        {copy.replaceable
          ? `${target} already has a skill named ${name}. Replacing it deletes that folder and writes this copy.`
          : `${target} already loads a skill named ${name} from a package or another folder, so a copy would not replace it. Remove or rename it there first.`}
      </p>
      <div className="flex justify-end gap-2">
        {back}
        {copy.replaceable && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => void share.start(copy.target, true, copy.bundle)}
          >
            Replace on {target}
          </Button>
        )}
      </div>
    </>
  )
}
