import { useEffect, useState } from 'react'
import { BRAIN_ACCESS, type BrainAccess } from '@shared/brain-access'
import type { BrainApproval, BrainSurfaceScope } from '@shared/ipc/host-brain'
import { Button } from '@/components/form'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'

const LABELS: Record<BrainAccess, string> = {
  read: 'View knowledge and search Brain',
  control: 'Stop Brain Agent’s running turn',
  evidence: 'Read memory evidence and source excerpts',
  configure: 'Configure Brain and change knowledge',
}
/** The conversation shows what Brain Agent read and drives its changes to knowledge. */
export const BRAIN_AGENT_RIGHTS_HINT =
  'Talking to Brain Agent takes all four, and permission to control lanes on this Host.'

function current(scope: BrainSurfaceScope, rights: readonly BrainAccess[]) {
  const host = useRemoteLanesStore.getState().hosts[scope.hostId]
  return (
    host?.state === 'ready' &&
    host.brain === true &&
    host.connectionToken === scope.connectionToken &&
    BRAIN_ACCESS.every((right) => !!host.brainAccess?.includes(right) === rights.includes(right))
  )
}

export function HostBrainAccess({
  scope,
  rights,
}: {
  scope: BrainSurfaceScope
  rights: readonly BrainAccess[]
}) {
  const [open, setOpen] = useState(!rights.includes('read'))
  const [selected, setSelected] = useState(rights)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const bridge = window.phosphor.hostBrain
  if (!bridge?.access) return null
  const choose = (right: BrainAccess, checked: boolean) => {
    const next = new Set(selected)
    if (checked) {
      next.add(right)
      if (right !== 'control') next.add('read')
    } else {
      next.delete(right)
      if (right === 'read') {
        next.delete('configure')
        next.delete('evidence')
      }
    }
    setSelected([...next])
  }
  const save = async () => {
    if (busy || !current(scope, rights)) return
    setBusy(true)
    setError(false)
    try {
      await bridge.access(scope, selected)
      setOpen(false)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Brain access" className="space-y-2">
      <Button size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        Brain access
      </Button>
      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset className="space-y-1" disabled={busy}>
            <legend>Choose what this client can do on {machineLabel(scope.hostId)}.</legend>
            <p>{BRAIN_AGENT_RIGHTS_HINT}</p>
            {BRAIN_ACCESS.map((right) => (
              <label className="block" key={right}>
                <input
                  type="checkbox"
                  checked={selected.includes(right)}
                  onChange={(e) => choose(right, e.target.checked)}
                />{' '}
                {LABELS[right]}
              </label>
            ))}
            <Button
              type="submit"
              disabled={BRAIN_ACCESS.every(
                (right) => selected.includes(right) === rights.includes(right),
              )}
            >
              Apply Brain access
            </Button>
          </fieldset>
          {error && <p role="alert">The Host did not confirm these permissions.</p>}
        </form>
      )}
    </section>
  )
}

export function HostBrainApprovals({
  scope,
  rights,
}: {
  scope: BrainSurfaceScope
  rights: readonly BrainAccess[]
}) {
  const [pending, setPending] = useState<BrainApproval[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)
  const bridge = window.phosphor.hostBrain
  const { hostId, connectionToken } = scope
  const accessKey = BRAIN_ACCESS.filter((right) => rights.includes(right)).join(',')
  useEffect(() => {
    if (!bridge?.approvals) return undefined
    let mounted = true
    let reading = false
    const load = async () => {
      if (reading || !mounted || !current(scope, rights)) return
      reading = true
      try {
        const list = await bridge.approvals(scope)
        if (mounted && current(scope, rights)) {
          setPending(list)
          setError(false)
        }
      } catch {
        if (mounted) {
          setPending([])
          setError(true)
        }
      } finally {
        reading = false
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 3000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [bridge, hostId, connectionToken, accessKey, reload])
  const answer = async (id: string, approved: boolean) => {
    if (busy || !bridge?.answer || !current(scope, rights)) return
    const item = pending.find((entry) => entry.confirmId === id)
    if (!item || item.expiresAt <= Date.now()) return
    setBusy(true)
    try {
      await bridge.answer(scope, id, approved)
      setReload((n) => n + 1)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
      setPending((items) => items.filter((item) => item.confirmId !== id))
    }
  }
  if (!pending.length && !error) return null
  return (
    <ApprovalList
      hostId={hostId}
      pending={pending}
      error={error}
      busy={busy}
      answer={answer}
      reload={() => setReload((n) => n + 1)}
    />
  )
}

function ApprovalList({
  hostId,
  pending,
  error,
  busy,
  answer,
  reload,
}: {
  hostId: string
  pending: BrainApproval[]
  error: boolean
  busy: boolean
  answer: (id: string, approved: boolean) => Promise<void>
  reload: () => void
}) {
  return (
    <section aria-label="Brain CLI approvals" className="space-y-2">
      <h2>Brain CLI approvals · {machineLabel(hostId)}</h2>
      {error && (
        <p role="alert">
          The Host did not confirm the approval state.{' '}
          <Button size="xs" onClick={reload}>
            Refresh
          </Button>
        </p>
      )}
      {pending
        .filter((entry) => entry.expiresAt > Date.now())
        .map((entry) => (
          <article key={entry.confirmId}>
            <h3>{entry.title}</h3>
            <p>{entry.message}</p>
            <Button disabled={busy} onClick={() => void answer(entry.confirmId, true)}>
              Approve once
            </Button>{' '}
            <Button disabled={busy} onClick={() => void answer(entry.confirmId, false)}>
              Decline
            </Button>
          </article>
        ))}
    </section>
  )
}
