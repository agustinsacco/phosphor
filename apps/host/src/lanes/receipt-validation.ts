import {
  HOST_LIMITS,
  type LaneControl,
  type LaneController,
  type Receipt,
} from '@phosphor/shared/host-protocol'
import { check, integer, text, uuid } from './validation-primitives'

function keys(value: object, allowed: readonly string[]): void {
  check(Object.keys(value).every((key) => allowed.includes(key)))
}

function doneReceipt(value: object, requestId: string): Receipt {
  keys(value, ['requestId', 'status', 'data', 'fence', 'laneId'])
  const receipt: {
    requestId: string
    status: 'done'
    data?: unknown
    fence?: number
    laneId?: string
  } = { requestId, status: 'done' }
  if ('fence' in value) {
    check(typeof value.fence === 'number')
    integer(value.fence, 1)
    receipt.fence = value.fence
  }
  if ('laneId' in value) {
    check(typeof value.laneId === 'string')
    uuid(value.laneId)
    receipt.laneId = value.laneId
  }
  if ('data' in value && value.data !== undefined) receipt.data = value.data
  return receipt
}

function failedReceipt(value: object, requestId: string): Receipt {
  keys(value, ['requestId', 'status', 'error'])
  check(
    'error' in value &&
      typeof value.error === 'object' &&
      value.error !== null &&
      'code' in value.error &&
      'message' in value.error,
  )
  const { code, message } = value.error
  check(code === 'pi-error' || code === 'timeout' || code === 'internal')
  check(typeof message === 'string')
  text(message, HOST_LIMITS.messageChars, true)
  keys(value.error, ['code', 'message'])
  return { requestId, status: 'failed', error: { code, message } }
}

function storedController(controller: unknown): LaneController {
  check(
    typeof controller === 'object' &&
      controller !== null &&
      'clientId' in controller &&
      typeof controller.clientId === 'string' &&
      'label' in controller &&
      typeof controller.label === 'string' &&
      'connected' in controller &&
      typeof controller.connected === 'boolean',
  )
  uuid(controller.clientId)
  text(controller.label, HOST_LIMITS.labelChars)
  keys(controller, ['clientId', 'label', 'connected'])
  return {
    clientId: controller.clientId,
    label: controller.label,
    connected: controller.connected,
  }
}

function storedControl(control: unknown): LaneControl {
  check(
    typeof control === 'object' &&
      control !== null &&
      'fence' in control &&
      typeof control.fence === 'number' &&
      'controller' in control,
  )
  integer(control.fence, 1)
  keys(control, ['fence', 'controller'])
  if (control.controller === null) return { fence: control.fence, controller: null }
  const controller = storedController(control.controller)
  return { fence: control.fence, controller }
}

function rejectedReceipt(value: object, requestId: string): Receipt {
  keys(value, ['requestId', 'status', 'code', 'control'])
  check('code' in value)
  const code = value.code
  check(
    code === 'bad-request' ||
      code === 'unsupported' ||
      code === 'forbidden' ||
      code === 'unknown-lane' ||
      code === 'lane-stopped' ||
      code === 'not-controller' ||
      code === 'stale-fence' ||
      code === 'conflict' ||
      code === 'busy' ||
      code === 'too-many-requests',
  )
  if (!('control' in value)) return { requestId, status: 'rejected', code }
  return { requestId, status: 'rejected', code, control: storedControl(value.control) }
}

/** Validate receipt metadata separately from arbitrary result data. */
export function storedReceipt(value: unknown): Receipt {
  check(typeof value === 'object' && value !== null && !Array.isArray(value))
  check('requestId' in value && typeof value.requestId === 'string')
  uuid(value.requestId)
  check('status' in value)
  const requestId = value.requestId
  switch (value.status) {
    case 'pending':
    case 'unknown':
      keys(value, ['requestId', 'status'])
      return { requestId, status: value.status }
    case 'done':
      return doneReceipt(value, requestId)
    case 'failed':
      return failedReceipt(value, requestId)
    case 'rejected':
      return rejectedReceipt(value, requestId)
    default:
      throw new Error('Invalid Host receipt.')
  }
}
