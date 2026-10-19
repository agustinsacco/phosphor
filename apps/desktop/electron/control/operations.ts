import {
  CONTROL_ROUTES,
  isUuid,
  machineRoute,
  parseMachineRenameRequest,
  parseEnrollmentApproveRequest,
  parseEnrollmentApproveResponse,
  parseEnrollmentLookupRequest,
  parseEnrollmentLookupResponse,
  parseMachinesResponse,
  parseClientRegisterRequest,
  parseClientRegisterResponse,
  parseGrantIssueRequest,
  parseGrantIssueResponse,
  type Parsed,
} from '@shared/control-api'
import { machineObservations, type TraceLog } from './observations'
import { newControlTrace, type ControlCall } from './client-state'
import { controlFailure } from './transport'

const empty = (body: unknown): Parsed<Record<never, never>> =>
  body === null ? { ok: true, value: {} } : { ok: false, reason: 'body' }

interface OperationPorts {
  call: ControlCall
  syncGeneration: () => void
  log: TraceLog
  now: () => number
}

function enrollmentOperations({ call, syncGeneration, log, now }: OperationPorts) {
  let enrollmentTrace: { trace: string; expiresAt: number } | undefined
  return {
    clearTrace() {
      enrollmentTrace = undefined
    },
    operations: {
      async lookupEnrollment(code: unknown) {
        const trace = newControlTrace()
        const parsed = parseEnrollmentLookupRequest({ userCode: code })
        const result = parsed.ok
          ? await call(
              CONTROL_ROUTES.enrollmentLookup,
              'POST',
              parseEnrollmentLookupResponse,
              parsed.value,
              trace,
            )
          : controlFailure('bad-request')
        enrollmentTrace = result.ok
          ? { trace, expiresAt: Math.min(Date.parse(result.expiresAt), now() + 15 * 60_000) }
          : undefined
        log('control', 'enrollment.lookup', {
          trace,
          result: result.ok ? 'found' : result.error.code,
          ...(result.ok
            ? { hostname: result.hostname, keyFingerprint: result.keyFingerprint }
            : {}),
        })
        return result
      },
      async approveEnrollment(code: unknown, label: unknown) {
        syncGeneration()
        const trace =
          enrollmentTrace && enrollmentTrace.expiresAt > now()
            ? enrollmentTrace.trace
            : newControlTrace()
        enrollmentTrace = undefined
        const parsed = parseEnrollmentApproveRequest({ userCode: code, label })
        const result = parsed.ok
          ? await call(
              CONTROL_ROUTES.enrollmentApprove,
              'POST',
              parseEnrollmentApproveResponse,
              parsed.value,
              trace,
            )
          : controlFailure('bad-request')
        log('control', 'enrollment.approved', {
          trace,
          result: result.ok ? 'approved' : result.error.code,
          ...(result.ok
            ? {
                hostId: result.machine.id,
                hostname: result.machine.hostname,
                keyFingerprint: result.machine.keyFingerprint,
              }
            : {}),
        })
        return result
      },
    },
  }
}

export function createControlOperations(ports: OperationPorts) {
  const { call, log, now } = ports
  const observations = machineObservations(log)
  const enrollment = enrollmentOperations(ports)
  return {
    clearObservations() {
      observations.clear()
      enrollment.clearTrace()
    },
    ...enrollment.operations,
    registerClient(label: unknown) {
      const parsed = parseClientRegisterRequest({ label })
      return parsed.ok
        ? call(CONTROL_ROUTES.clients, 'POST', parseClientRegisterResponse, parsed.value)
        : Promise.resolve(controlFailure('bad-request'))
    },
    grant(hostId: unknown, clientId: unknown, configure?: true) {
      const parsed = parseGrantIssueRequest({
        hostId,
        clientId,
        ...(configure ? { configure } : {}),
      })
      return parsed.ok
        ? call(CONTROL_ROUTES.grants, 'POST', parseGrantIssueResponse, parsed.value)
        : Promise.resolve(controlFailure('bad-request'))
    },
    async machines() {
      const trace = newControlTrace()
      const result = await call(
        CONTROL_ROUTES.machines,
        'GET',
        parseMachinesResponse,
        undefined,
        trace,
      )
      if (result.ok) observations.observe(result, now(), trace)
      return result
    },
    renameMachine(id: unknown, label: unknown) {
      const parsed = parseMachineRenameRequest({ label })
      return isUuid(id) && parsed.ok
        ? call(machineRoute(id), 'PATCH', parseEnrollmentApproveResponse, parsed.value)
        : Promise.resolve(controlFailure('bad-request'))
    },
    removeMachine(id: unknown) {
      return isUuid(id)
        ? call(machineRoute(id), 'DELETE', empty)
        : Promise.resolve(controlFailure('bad-request'))
    },
  }
}
