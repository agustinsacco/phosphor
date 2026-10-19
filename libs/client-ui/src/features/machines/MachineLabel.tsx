import { useEffect, useRef, useState, type RefObject } from 'react'
import { normalizeLabel, type MachineView } from '@shared/control-api'
import { Button, TextInput } from '@/components/form'
import { tooltipProps } from '@/components/Tooltip'
import { machinesAccountGeneration } from '@/stores/machines'
import { controlMessage } from './controlMessages'

/** The saved label stays visible on failure; never rename from a stale account reply. */
export function MachineLabel({
  machine,
  onSaved,
  heading = 'h1',
}: {
  machine: MachineView
  onSaved: (machine: MachineView) => void
  heading?: 'h1' | 'h2'
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(machine.label)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(false)
  const pending = useRef(false)
  const live = useRef(true)
  const trigger = useRef<HTMLButtonElement>(null)
  const [refocus, setRefocus] = useState(false)
  // The Rename button is not rendered while editing, so focus it once it is back.
  useEffect(() => {
    if (refocus && !editing && !busy) {
      trigger.current?.focus()
      setRefocus(false)
    }
  }, [refocus, editing, busy])
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const finish = (): void => {
    active.current = false
    setEditing(false)
    setLabel(machine.label)
    setRefocus(true)
  }
  async function save(): Promise<void> {
    if (!active.current || pending.current) return
    const normalized = normalizeLabel(label)
    if (!normalized) {
      setError('Use 1 to 80 characters without hidden control characters.')
      return
    }
    if (normalized === machine.label) {
      finish()
      return
    }
    pending.current = true
    setBusy(true)
    setError(null)
    const generation = machinesAccountGeneration()
    try {
      const result = await window.phosphor.invoke('control:renameMachine', machine.id, normalized)
      if (!live.current || generation !== machinesAccountGeneration()) return
      if (result.ok) onSaved(result.machine)
      else
        setError(
          result.error.code === 'not-found'
            ? 'This machine was already removed.'
            : controlMessage(result.error.code),
        )
    } catch {
      if (live.current && generation === machinesAccountGeneration())
        setError(controlMessage('offline'))
    } finally {
      pending.current = false
      if (live.current) {
        finish()
        setBusy(false)
      }
    }
  }
  return (
    <div className="machine-label">
      <div className="machine-label-row">
        {editing ? (
          <TextInput
            autoFocus
            aria-label="Machine label"
            aria-invalid={!!error}
            value={label}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void save()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                finish()
                setError(null)
              }
            }}
          />
        ) : (
          <MachineName name={machine.label} heading={heading} />
        )}
        {busy ? (
          <span role="status" className="text-text-secondary text-base">
            Saving…
          </span>
        ) : (
          !editing && (
            <RenameControl
              buttonRef={trigger}
              onClick={() => {
                active.current = true
                setLabel(machine.label)
                setError(null)
                setEditing(true)
              }}
            />
          )
        )}
      </div>
      {error && (
        <p role="alert" className="text-danger mt-2 text-base">
          {error}
        </p>
      )}
    </div>
  )
}

function RenameControl({
  buttonRef,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      ref={buttonRef}
      size="xs"
      className="machine-rename-control"
      aria-label="Rename"
      onClick={onClick}
    >
      <span className="machine-rename-label">Rename</span>
      <svg
        className="machine-rename-glyph"
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="m16 3 5 5-12 12-6 1 1-6L16 3Z" />
        <path d="m13 6 5 5" />
      </svg>
    </Button>
  )
}

function MachineName({ name, heading }: { name: string; heading: 'h1' | 'h2' }): React.JSX.Element {
  const Heading = heading
  return (
    <Heading
      className="machine-name"
      {...tooltipProps(name)}
      tabIndex={name.length > 24 ? 0 : undefined}
    >
      {name}
    </Heading>
  )
}
