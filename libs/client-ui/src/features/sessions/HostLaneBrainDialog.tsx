import { useState } from 'react'
import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import {
  useBrainRequest,
  useHostBrain,
  useHostBrainSelection,
  type ReadyBrainSurface,
} from '@/features/brain/useHostBrain'
import type { HostBrainRequest, HostBrainVersion } from '@shared/host-brain-request'
import type { HostBrainLaneState } from '@shared/host-brain'
import { hostLaneBrainContext, hostLaneReadSummary } from './hostLaneBrain'

interface Props {
  hostId: string
  laneId: string
  title: string
  close: () => void
}

/** Load Brain only after opening a lane's action, not for every row in the sidebar. */
export function HostLaneBrainDialog(props: Props) {
  const selection = useHostBrainSelection(props.hostId)
  return (
    <ModalOverlay onClose={props.close}>
      <div role="dialog" aria-modal="true" aria-label="Brain read">
        <ModalPanel
          width={520}
          title={`Brain read · ${props.title}`}
          footer={<Button onClick={props.close}>Close</Button>}
        >
          <div className="space-y-2 p-4">
            {selection.state === 'ready' &&
            selection.token &&
            selection.access.includes('configure') ? (
              <LaneBrainSession
                key={JSON.stringify([selection.key, props.laneId])}
                {...props}
                token={selection.token}
                access={selection.access}
              />
            ) : (
              <p role="status">
                This lane’s Host is unavailable or Brain configuration access was not granted.
              </p>
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}

function LaneBrainSession({
  hostId,
  laneId,
  token,
  access,
  title,
}: Props & { token: string; access: ReturnType<typeof useHostBrainSelection>['access'] }) {
  const brain = useHostBrain(hostId, token, access)
  const { status } = brain
  if (!status)
    return (
      <p role="status">
        {brain.error || 'Checking Brain…'}{' '}
        {brain.error && <Button onClick={() => void brain.refresh()}>Retry</Button>}
      </p>
    )
  if (!status.supported || !status.prefs.enabled)
    return <p role="status">Brain is not enabled on this Host.</p>
  return (
    <LaneReadActions
      key={status.generation}
      laneId={laneId}
      title={title}
      brain={{ ...brain, status }}
    />
  )
}

function LaneReadActions({
  brain,
  laneId,
  title,
}: {
  brain: ReadyBrainSurface
  laneId: string
  title: string
}) {
  const read = useBrainRequest<'brain:laneState'>(brain, {
    method: 'brain:laneState',
    args: [laneId],
  })
  const actions = useLaneReadMutation(brain, read.retry)
  if (read.data === undefined)
    return (
      <p role="status">
        {read.error ? (
          <>
            Lane read information is unavailable. <Button onClick={read.retry}>Retry</Button>
          </>
        ) : (
          'Checking lane read…'
        )}
      </p>
    )
  return (
    <LaneReadControls
      key={read.data.lastRead?.jobId}
      lane={read.data}
      laneId={laneId}
      title={title}
      brain={brain}
      actions={actions}
    />
  )
}

type LaneWrite = HostBrainRequest<
  'brain:queue' | 'brain:reread' | 'brain:cancel' | 'brain:neverRead'
>
function useLaneReadMutation(brain: ReadyBrainSurface, retry: () => void) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const apply = async (request: LaneWrite) => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      await brain.invoke(request)
      setMessage(
        request.method === 'brain:queue' || request.method === 'brain:reread'
          ? 'Queued on this Host.'
          : 'Brain read settings updated.',
      )
      await brain.refresh()
    } catch {
      setMessage('The Host did not confirm this read. Check Brain before trying again.')
    } finally {
      setBusy(false)
      retry()
    }
  }
  return { busy, message, apply }
}

function LaneReadControls({
  lane,
  laneId,
  title,
  brain,
  actions,
}: {
  lane: HostBrainLaneState
  laneId: string
  title: string
  brain: ReadyBrainSurface
  actions: ReturnType<typeof useLaneReadMutation>
}) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const { busy, message, apply } = actions
  const { generation, revision } = brain.status
  const expected: HostBrainVersion = { generation, revision }
  const context = hostLaneBrainContext(brain.status, lane, title)
  const confirming = !!confirm && confirm === lane.lastRead?.jobId
  return (
    <>
      {message && <p role="status">{message}</p>}
      {lane.activeJob && (
        <Button
          disabled={busy}
          onClick={() =>
            void apply({ method: 'brain:cancel', args: [lane.activeJob!.id], expected })
          }
        >
          Cancel knowledge extraction
        </Button>
      )}
      {context.brainExclusion === 'title' && (
        <p>Brain never reads this lane (title rule in Settings › Brain).</p>
      )}
      {context.brainExclusion !== 'title' && (
        <Button
          disabled={busy || confirming}
          onClick={() =>
            void apply({ method: 'brain:neverRead', args: [laneId, !lane.excluded], expected })
          }
        >
          {lane.excluded ? 'Let Brain read this lane' : 'Never let Brain read this lane'}
        </Button>
      )}
      {context.brainExclusion === null && !lane.activeJob && (
        <Button
          disabled={busy || confirming}
          onClick={() => void apply({ method: 'brain:queue', args: [laneId], expected })}
        >
          {lane.lastRead ? 'Read new messages for Brain' : 'Queue for knowledge extraction'}
        </Button>
      )}
      {context.brainExclusion === null && !lane.activeJob && lane.lastRead && !confirming && (
        <Button disabled={busy} onClick={() => setConfirm(lane.lastRead!.jobId)}>
          Read again for Brain…
        </Button>
      )}
      {context.brainExclusion === null && !lane.activeJob && lane.lastRead && confirming && (
        <>
          <p>{hostLaneReadSummary(lane.lastRead)}</p>
          <Button disabled={busy} onClick={() => setConfirm(null)}>
            Cancel
          </Button>{' '}
          <Button
            disabled={busy}
            onClick={() => {
              if (confirm) {
                setConfirm(null)
                void apply({ method: 'brain:reread', args: [confirm], expected })
              }
            }}
          >
            Read again
          </Button>
        </>
      )}
    </>
  )
}
