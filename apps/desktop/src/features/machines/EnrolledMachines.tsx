import { useState } from 'react'
import { type MachineView } from '@shared/control-api'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { useMachinesStore } from '@/stores/machines'
import { AddMachineDialog } from './AddMachineDialog'
import { controlMessage } from './controlMessages'

export function EnrolledMachines(): React.JSX.Element {
  const machines = useMachinesStore((s) => s.machines)
  const statuses = useMachinesStore((s) => s.statuses)
  const nowMs = useMachinesStore((s) => s.nowMs)
  const offset = useMachinesStore((s) => s.clockOffsetMs)
  const loading = useMachinesStore((s) => s.loading)
  const error = useMachinesStore((s) => s.error)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<MachineView | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  async function remove(): Promise<void> {
    if (!removing || busy) return
    setBusy(true)
    setRemoveError(null)
    try {
      const result = await window.phosphor.invoke('control:removeMachine', removing.id)
      if (!useMachinesStore.getState().remoteEnabled) return
      if (result.ok || result.error.code === 'not-found') {
        setNotice(result.ok ? 'Machine removed.' : 'That machine was already removed.')
        setRemoving(null)
        await useMachinesStore.getState().refresh()
      } else setRemoveError(controlMessage(result.error.code))
    } catch {
      setRemoveError(controlMessage('offline'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Your machines</h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add a machine
        </Button>
      </div>
      {loading && <p role="status">Loading machines…</p>}
      {error && (
        <p role="alert">
          {controlMessage(error)}{' '}
          <Button size="xs" onClick={() => void useMachinesStore.getState().refresh()}>
            Retry
          </Button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loading && !error && machines.length === 0 && (
        <div>
          <p>No machines yet.</p>
          <ol>
            <li>
              Install Phosphor Host on the machine (see the{' '}
              <a
                className="underline"
                href="https://github.com/agustinsacco/phosphor/blob/main/docs/host.md"
                onClick={(event) => {
                  event.preventDefault()
                  void window.phosphor.invoke('app:openExternal', event.currentTarget.href)
                }}
                data-tooltip="Open link"
              >
                Host guide
              </a>
              ).
            </li>
            <li>
              Run <code>phosphor login</code> there and enter the code under Add a machine.
            </li>
          </ol>
        </div>
      )}
      <div className="border-border divide-border divide-y rounded-lg border">
        {machines.map((machine) => {
          const status = statuses[machine.id]
          const seen =
            machine.lastSeenAt === null
              ? 'never connected'
              : `seen ${Math.max(0, Math.floor((nowMs + offset - Date.parse(machine.lastSeenAt)) / 1000))} s ago`
          return (
            <div
              key={machine.id}
              data-testid="enrolled-machine-row"
              data-status={status}
              className="flex items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0 break-words">
                <h3 className="font-semibold">{machine.label}</h3>
                <p>
                  {machine.hostname} · {machine.platform}/{machine.arch} · Host{' '}
                  {machine.hostVersion ?? 'unknown'}
                </p>
                <p>{status === 'never-seen' ? seen : `${status} · ${seen}`}</p>
                {machine.readiness && (
                  <p>
                    pi: {machine.readiness.pi} · Claude: {machine.readiness.claude} · Tailscale:{' '}
                    {machine.readiness.tailscale}
                  </p>
                )}
                {machine.lanes && (
                  <p>
                    {machine.lanes.running} running · {machine.lanes.waiting} waiting
                  </p>
                )}
              </div>
              <Button
                size="xs"
                onClick={() => {
                  setNotice(null)
                  setRemoveError(null)
                  setRemoving(machine)
                }}
              >
                Remove
              </Button>
            </div>
          )
        })}
      </div>
      {adding && <AddMachineDialog onClose={() => setAdding(false)} />}
      {removing && (
        <ModalOverlay
          onClose={() => {
            if (!busy) setRemoving(null)
          }}
        >
          <div role="dialog" aria-modal="true" aria-label="Remove machine">
            <ModalPanel
              width={440}
              title={`Remove ${removing.label}?`}
              footer={
                <>
                  <Button disabled={busy} onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                  <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                    Remove machine
                  </Button>
                </>
              }
            >
              <p className="p-4">
                The machine stays installed. It must re-run <code>phosphor login</code> to come
                back.
              </p>
              {removeError && (
                <p role="alert" className="text-danger px-4 pb-4">
                  {removeError}
                </p>
              )}
            </ModalPanel>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
