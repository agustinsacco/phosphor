import { ownerCall } from '@phosphor/host-client/owner'
import type { LocalMachineAction, LocalMachineStatus } from '@shared/ipc'
import { errorText } from '@shared/errors'
import { broadcast } from '../broadcast'
import { localSlotConnection, sameMachine } from '../local-machine/same-machine'
import { handle } from './handle'
import { runOnHost, OPS_SERVICE_NOT_READY } from './ops-handlers'
import { exportServiceDiagnostics, restartToFinish, startService } from './local-service-actions'

export const IN_APP_LOCAL_MACHINE: LocalMachineStatus = { mode: 'in-app', migration: 'not-needed' }
type Answer = { ok: boolean; message?: string }
export interface LocalMachineGate {
  status(): LocalMachineStatus
  onStatus(cb: (s: LocalMachineStatus) => void): () => void
  retry(): Promise<Answer>
  retryOwnerKey?(): Promise<Answer>
  consent(): Promise<Answer>
}
let gate: LocalMachineGate | null = null
let off: (() => void) | undefined
let lastPush = ''
type Slot = NonNullable<ReturnType<typeof localSlotConnection>>
let facts:
  | (Pick<LocalMachineStatus, 'pause' | 'lastUpdate'> & { token?: string; version: string })
  | undefined
let read: { slot: Slot; token?: string; done: Promise<LocalMachineStatus> } | undefined

export function bindLocalMachineGate(next: LocalMachineGate | null): void {
  const previous = gate
  off?.()
  gate = next
  facts = read = undefined
  off = next?.onStatus(notifyLocalMachineChanged)
  if (previous || next) pushStatus(snapshot())
}

function snapshot(): LocalMachineStatus {
  const base = gate?.status() ?? IN_APP_LOCAL_MACHINE
  if (base.mode !== 'daemon') return base
  const slot = localSlotConnection()?.snapshot()
  if (slot?.state === 'ready') {
    const known = facts && facts.token === slot.connectionToken ? facts : undefined
    return {
      ...base,
      service: 'ready',
      serviceVersion: known?.version ?? slot.hostVersion,
      pause: known?.pause,
      lastUpdate: known?.lastUpdate,
    }
  }
  facts = undefined
  const service =
    slot?.state === 'wrong-machine' ||
    slot?.state === 'signed-out' ||
    slot?.lastError === 'forbidden' ||
    slot?.lastError === 'grant-refused'
      ? 'attestation-failed'
      : slot?.state === 'connecting' || slot?.state === 'reconnecting'
        ? 'connecting'
        : base.service === 'attestation-failed'
          ? base.service
          : 'down'
  return { ...base, service, pause: undefined }
}

/** Called by the gate and local slot; lane traffic must not trigger owner calls or redundant pushes. */
export function notifyLocalMachineChanged(): void {
  if (!gate) return
  pushStatus(snapshot())
}

function pushStatus(status: LocalMachineStatus) {
  const key = JSON.stringify(status)
  if (key === lastPush) return
  lastPush = key
  broadcast('app:localMachineChanged', status)
}

/** The visible card polls machine.local (D4 has no pause push). Windows share a single outstanding read. */
function status(): LocalMachineStatus | Promise<LocalMachineStatus> {
  const base = snapshot()
  const local = base.mode === 'daemon' && base.service === 'ready' && sameMachine()
  if (!local) return base
  const slot = local.connection
  const token = slot.snapshot().connectionToken
  if (read?.slot === slot && read.token === token) return read.done
  const current = gate
  const done = ownerCall(slot, 'machine.local', undefined)
    .then((result) => {
      if (
        current === gate &&
        localSlotConnection() === slot &&
        slot.snapshot().connectionToken === token &&
        result.machineId === local.hostId
      ) {
        facts = {
          token,
          version: result.hostVersion,
          pause: result.pause,
          lastUpdate: result.lastUpdate,
        }
        notifyLocalMachineChanged()
      }
      return snapshot()
    })
    .finally(() => {
      if (read?.done === done) read = undefined
    })
  read = { slot, token, done }
  return done
}

const refused = (message: string): Answer => ({ ok: false, message })
const unavailable = () =>
  refused(
    OPS_SERVICE_NOT_READY.status === 'denied' ? OPS_SERVICE_NOT_READY.text : 'Service unavailable.',
  )
async function action(current: LocalMachineGate, name: LocalMachineAction): Promise<Answer> {
  const base = current.status()
  if (name === 'retry-owner-key' && base.ownerKeyAccess === 'unavailable')
    return current.retryOwnerKey?.() ?? unavailable()
  if (name === 'retry-migration' && ['failed', 'reverted', 'waiting'].includes(base.migration))
    return current.retry()
  if (base.mode === 'in-app') {
    if (name === 'consent-migration' && base.migration === 'consent-needed')
      return current.consent()
    if (name === 'restart-to-finish' && base.migration === 'committed') return restartToFinish()
  }
  if (name === 'export-diagnostics' && base.migration === 'failed')
    return exportServiceDiagnostics(snapshot())
  if (base.mode !== 'daemon') return refused('This action is not available now.')
  const service = sameMachine()
  if (name === 'start-service' && !service && base.notice !== 'dev-build') return startService()
  if (!service) return unavailable()
  if (name === 'update-service') {
    const answer = await runOnHost(service.hostId, { op: 'service.update', args: {} })
    if (answer.status === 'ok') return { ok: true, message: answer.text }
    return refused(answer.status === 'denied' ? answer.text : answer.message)
  }
  if (name === 'update-abort-now' || name === 'update-cancel') {
    // Never abort a turn outside the current pause. The daemon checks again when applying the action.
    const live = await ownerCall(service.connection, 'machine.local', undefined)
    if (live.pause?.kind !== 'pausing' || sameMachine()?.connection !== service.connection)
      return refused('The service is no longer waiting to pause.')
    await ownerCall(service.connection, 'machine.pause', {
      action: name === 'update-cancel' ? 'cancel' : 'abort-now',
    })
    return { ok: true }
  }
  return refused('This action is not available now.')
}

export function registerLocalMachineHandlers(): void {
  handle('app:localMachine', status)
  handle('app:localMachineAction', (_event, name) =>
    gate
      ? action(gate, name).catch((error: unknown) => refused(errorText(error)))
      : refused('This Mac runs its lanes in Phosphor itself; there is nothing to do yet.'),
  )
}
