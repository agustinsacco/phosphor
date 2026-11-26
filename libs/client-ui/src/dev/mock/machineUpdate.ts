import type { OpsRunRequest, OpsRunResult } from '@shared/host-protocol-ops'
import type { ServicePauseState } from '@shared/host-protocol-owner'

const jobs = new Map<string, { started: number; cancelled: boolean; forced: boolean }>()
const jobId = 'demo-service-update'
const ok = (text: string, data?: unknown): OpsRunResult => ({
  status: 'ok',
  applies: 'now',
  text,
  data,
})

/** Simulates a wait ending without ever invoking a real updater. */
export function mockMachineUpdate(
  machine: string,
  request: OpsRunRequest,
): OpsRunResult | undefined {
  const job = jobs.get(machine)
  const waiting = job && !job.cancelled && !job.forced && Date.now() - job.started < 30_000
  let pause: ServicePauseState = { kind: 'none' }
  if (waiting && Date.now() - job.started >= 2000)
    pause = {
      kind: 'pausing',
      purpose: 'update',
      since: new Date(job.started).toISOString(),
      deadline: new Date(job.started + 30_000).toISOString(),
      waitingOn: { turns: Date.now() - job.started < 8000 ? 2 : 1, routines: 0, subagents: 0 },
    }
  switch (request.op) {
    case 'machine.status':
      return ok('Machine status', { pause, update: { pauseControl: true } })
    case 'service.update':
      jobs.set(machine, { started: Date.now(), cancelled: false, forced: false })
      return ok('Started a synthetic update.', { jobId })
    case 'job.status':
      if (!job || request.args.jobId !== jobId) return undefined
      return ok('Service update job', {
        op: 'service.update',
        state: waiting ? 'running' : 'done',
        result: waiting
          ? null
          : {
              text: 'Synthetic update finished.',
              data: job.forced
                ? { outcome: 'current' }
                : { outcome: 'not-paused', pause: job.cancelled ? 'cancelled' : 'deadline' },
            },
      })
    case 'service.pause':
      if (!job || pause.kind !== 'pausing')
        return {
          status: 'denied',
          code: 'unavailable',
          text: 'The service is no longer waiting to pause.',
        }
      if (request.args.action === 'cancel') job.cancelled = true
      else job.forced = true
      return ok('Pause action accepted.')
  }
}
