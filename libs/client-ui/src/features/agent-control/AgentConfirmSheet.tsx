import { useCallback, useEffect, useRef, useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { type PendingDialog, useExtensionUiStore } from '@/stores/extensionUi'
import { canControlSession, machineLabel, useSessionHostLane } from '@/stores/remoteLanes'
import { ipcErrorText } from '@phosphor/shared/errors'
import type { ConfirmInfo } from '@phosphor/shared/ops'
import { OpDenied, readConfirm } from './agentOps'
import { approveTargets, reviewTargets } from './confirmRelay'
import { LoadError, useOpAction, useOpRead } from './useOpRead'

/** The prefix is routing, not proof. Only the origin owner's dialog binding
 * permits a relay. While looking it up never mount the generic Enter handler. */
export function AgentDialog({
  dialog,
  children,
}: {
  dialog: PendingDialog
  children: React.ReactNode
}) {
  const remote = useSessionHostLane(dialog.sessionId)
  if (remote && (!remote.host?.ops || remote.host.state !== 'ready')) return children
  return (
    <BoundDialog machine={remote?.hostId ?? 'local'} dialog={dialog}>
      {children}
    </BoundDialog>
  )
}
function BoundDialog({
  machine,
  dialog,
  children,
}: {
  machine: string
  dialog: PendingDialog
  children: React.ReactNode
}) {
  const load = useCallback(
    () => readConfirm(machine, { dialogId: dialog.request.id }),
    [machine, dialog.request.id],
  )
  const { data, error, reload } = useOpRead(load, machine, 'confirm')
  const answer = (approved: boolean) => {
    const store = useExtensionUiStore.getState()
    if (store.dialogs[0] === dialog && canControlSession(dialog.sessionId))
      store.resolveDialog(dialog, { confirmed: approved })
  }
  if (
    error instanceof OpDenied &&
    ['confirm-expired', 'unsupported', 'confirm-mismatch'].includes(error.code)
  )
    return children
  if (
    data &&
    data.dialogId === dialog.request.id &&
    data.title === dialog.request.title &&
    dialog.request.method === 'confirm' &&
    data.message === dialog.request.message
  )
    return <Review key={data.digest} info={data} answer={async (v) => answer(v)} />
  return (
    <ModalOverlay onClose={() => answer(false)}>
      <ModalPanel
        width={500}
        title="Checking agent request"
        footer={<Button onClick={() => answer(false)}>Deny</Button>}
      >
        {error || data ? (
          <LoadError error={error ?? 'This request no longer matches the dialog.'} retry={reload} />
        ) : (
          <p>Loading confirmation…</p>
        )}
      </ModalPanel>
    </ModalOverlay>
  )
}
export function Review({
  info,
  answer,
  onClose,
}: {
  info: ConfirmInfo
  answer: (v: boolean) => Promise<void>
  onClose?: () => void
}) {
  const [generation, refresh] = useState(0)
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof reviewTargets>> | null>(null),
    [error, setError] = useState('')
  const action = useOpAction()
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let live = true
    setTargets(null)
    setError('')
    void reviewTargets(info).then(
      (t) => {
        if (live) setTargets(t)
      },
      (e) => {
        if (live) setError(ipcErrorText(e))
      },
    )
    return () => {
      live = false
    }
  }, [info, generation])
  const decide = (yes: boolean) =>
    action.run(async () => {
      if (yes) {
        if (!targets || info.state !== 'pending' || Date.now() >= info.expiresAt)
          throw Error('This request is not pending.')
        await approveTargets(targets)
      }
      if (alive.current) await answer(yes)
    })
  const close = () => {
    if (!action.busy) {
      if (onClose) onClose()
      else decide(false)
    }
  }
  return (
    <ModalOverlay onClose={close} closeOnBackdrop={false} shortcutOverlay="extension">
      <ModalPanel
        width={580}
        title={info.title}
        subtitle={`Requested by ${info.origin.label} · ${info.op}`}
        footer={
          <>
            {onClose && (
              <Button disabled={action.busy} onClick={close}>
                Cancel
              </Button>
            )}
            <Button disabled={action.busy} onClick={() => decide(false)}>
              Deny
            </Button>
            <Button
              variant="primary"
              disabled={
                action.busy || info.state !== 'pending' || !targets || targets.some((t) => t.error)
              }
              onClick={() => decide(true)}
            >
              Approve
            </Button>
          </>
        }
      >
        <div className="max-h-[55vh] space-y-3 overflow-y-auto whitespace-pre-wrap break-words p-4">
          <p>{info.message}</p>
          {targets?.map((t) => (
            <section key={`${t.hostId}:${t.confirmId}`}>
              <strong>
                {machineLabel(t.hostId)} ({t.hostId})
              </strong>
              <p>{t.error ?? t.message}</p>
            </section>
          ))}
          {(error || targets?.some((t) => t.error)) && (
            <LoadError
              error={error || 'A target could not be verified.'}
              retry={() => refresh((g) => g + 1)}
            />
          )}
          {action.error && <p role="alert">{action.error}</p>}
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
