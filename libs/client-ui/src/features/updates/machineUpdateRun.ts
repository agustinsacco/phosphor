import { errorText, ipcErrorText } from '@shared/errors'
import { record } from '@shared/host-protocol/primitives'
import { machineUpdateEntry, updateMachineEntry } from '@/stores/machineUpdates'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { appendUpdateDetails } from './machineUpdateFacts'
import { startRun, type UpdatePath, type UpdateRun } from './machineUpdateState'

export function changeUpdateRun(
  id: string,
  started: number,
  change: (run: UpdateRun) => UpdateRun,
) {
  updateMachineEntry(id, (entry) => {
    if (entry.run?.started !== started) return entry
    const run = change(entry.run)
    return run === entry.run ? entry : { ...entry, run }
  })
}

export function updateOp(id: string, op: string, args: Record<string, unknown> = {}) {
  return window.phosphor.invoke('ops:run', { kind: 'remote', hostId: id }, { op, args })
}

export async function reconnectForUpdate(id: string): Promise<void> {
  await window.phosphor.invoke('hosts:reconnect', id).catch(() => undefined)
}

async function startOp(id: string, started: number) {
  const answer = await updateOp(id, 'service.update')
  changeUpdateRun(id, started, (run) => {
    if (run.finish) return run
    if (answer.status === 'ok' && record(answer.data) && typeof answer.data.jobId === 'string')
      return { ...appendUpdateDetails(run, answer.text), jobId: answer.data.jobId }
    const message = answer.status === 'confirm' ? answer.message : answer.text
    return { ...appendUpdateDetails(run, message), finish: 'refused' }
  })
}

/** The legacy PTY is a bounded log, not a view. It outlives this Settings mount. */
async function startTask(id: string, started: number) {
  const { ptyId } = await window.phosphor.invoke('hosts:machineTask', id, {
    type: 'machine.task',
    task: 'host.update',
  })
  let exited: number | undefined
  let attached = false
  const output = (text: string) =>
    changeUpdateRun(id, started, (run) => appendUpdateDetails(run, text))
  const finish = () => {
    offData()
    offExit()
    clearTimeout(expire)
    changeUpdateRun(id, started, (run) => {
      if (run.finish || run.wentOffline) return run
      // On restart the task's PTY may close before the disconnect is published.
      if (exited === 0 && run.details?.includes('already up to date'))
        return { ...run, finish: 'current' }
      return run
    })
  }
  const offData = window.phosphor.onPtyData(ptyId, output)
  const offExit = window.phosphor.onPtyExit(ptyId, (code) => {
    exited = code
    if (attached) finish()
  })
  const expire = setTimeout(finish, 15 * 60_000)
  try {
    const { scrollback } = await window.phosphor.invoke('pty:attach', ptyId)
    if (scrollback) output(scrollback)
  } catch (error) {
    output(errorText(error))
  } finally {
    attached = true
    if (exited !== undefined) finish()
  }
}

export async function beginMachineUpdate(id: string, path: UpdatePath): Promise<void> {
  const previous = machineUpdateEntry(id).run
  if (previous && !previous.settled) return
  const host = useRemoteLanesStore.getState().hosts[id]
  if (host?.state !== 'ready') return
  const run = startRun(path, machineUpdateEntry(id), host, Date.now())
  updateMachineEntry(id, (entry) => ({ ...entry, run }))
  try {
    await (path === 'op' ? startOp(id, run.started) : startTask(id, run.started))
  } catch (error) {
    changeUpdateRun(id, run.started, (current) =>
      current.finish || current.wentOffline
        ? current
        : { ...appendUpdateDetails(current, ipcErrorText(error)), finish: 'refused' },
    )
  }
}

export async function controlMachineUpdate(
  id: string,
  action: 'abort-now' | 'cancel',
  owner: boolean,
): Promise<void> {
  const entry = machineUpdateEntry(id)
  const run = entry.run
  if (!run || run.finish || run.controlling || entry.status?.pause.kind !== 'pausing') return
  changeUpdateRun(id, run.started, (r) => ({ ...r, controlling: action }))
  try {
    if (owner) {
      const result = await window.phosphor.invoke(
        'app:localMachineAction',
        action === 'cancel' ? 'update-cancel' : 'update-abort-now',
      )
      if (!result.ok) throw new Error(result.message)
    } else {
      const result = await updateOp(id, 'service.pause', { action })
      if (result.status !== 'ok')
        throw new Error(result.status === 'denied' ? result.text : result.message)
    }
    if (action === 'cancel')
      changeUpdateRun(id, run.started, (r) => ({ ...r, finish: r.finish ?? 'cancelled' }))
  } catch (error) {
    changeUpdateRun(id, run.started, (r) => appendUpdateDetails(r, ipcErrorText(error)))
  } finally {
    changeUpdateRun(id, run.started, (r) => ({ ...r, controlling: undefined }))
  }
}
