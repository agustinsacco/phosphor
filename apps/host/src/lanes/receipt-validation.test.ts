import { expect, it } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { storedReceipt } from './receipt-validation'
import { storedReceipt as publicStoredReceipt } from './validation'

const requestId = '11111111-1111-4111-8111-111111111111'
const clientId = '22222222-2222-4222-8222-222222222222'
const stateError = 'Invalid Host state input.'

it('keeps the original storedReceipt entry as an identical re-export', () => {
  expect(publicStoredReceipt).toBe(storedReceipt)
})

it('dispatches pending and unknown with only their allowed fields', () => {
  for (const status of ['pending', 'unknown']) {
    expect(storedReceipt({ requestId, status })).toStrictEqual({ requestId, status })
    expect(() => storedReceipt({ requestId, status, data: null })).toThrow(stateError)
  }
  expect(() => storedReceipt({ requestId, status: 'other' })).toThrow('Invalid Host receipt.')
})

it('reads done optional fields without interpreting result data', () => {
  const data = { result: () => 'not JSON' }
  const value = { requestId, status: 'done', laneId: clientId, fence: 1, data }
  expect(storedReceipt(value)).toStrictEqual(value)
  expect(storedReceipt({ requestId, status: 'done', data: undefined })).toStrictEqual({
    requestId,
    status: 'done',
  })
  for (const metadata of [{ fence: 0 }, { laneId: '' }, { error: null }])
    expect(() => storedReceipt({ requestId, status: 'done', ...metadata })).toThrow(stateError)
})

it('reads failed receipts using bounded messages and the fixed failure codes', () => {
  for (const code of ['pi-error', 'timeout', 'internal']) {
    const value = { requestId, status: 'failed', error: { code, message: '' } }
    expect(storedReceipt(value)).toStrictEqual(value)
  }
  for (const error of [
    { code: 'busy', message: 'Failed' },
    { code: 'internal', message: 'x'.repeat(HOST_LIMITS.messageChars + 1) },
    { code: 'internal', message: 'Failed', extra: null },
  ])
    expect(() => storedReceipt({ requestId, status: 'failed', error })).toThrow(stateError)
})

it('reads rejected receipts with absent, null-controller and populated control metadata', () => {
  const controller = { clientId, label: 'Client', connected: true }
  for (const control of [undefined, { fence: 1, controller: null }, { fence: 2, controller }]) {
    const value = {
      requestId,
      status: 'rejected',
      code: 'stale-fence',
      ...(control ? { control } : {}),
    }
    const receipt = storedReceipt(value)
    expect(receipt).toStrictEqual(value)
    if (receipt.status === 'rejected' && receipt.control && control) {
      expect(receipt.control).not.toBe(control)
      if (control.controller) expect(receipt.control.controller).not.toBe(control.controller)
    }
  }
})

it('refuses malformed rejected control and controller fields without broadening reject codes', () => {
  for (const control of [
    null,
    undefined,
    { fence: 0, controller: null },
    { fence: 1 },
    { fence: 1, controller: null, extra: true },
    { fence: 1, controller: { clientId, label: '', connected: true } },
    { fence: 1, controller: { clientId: 'bad', label: 'Client', connected: true } },
    { fence: 1, controller: { clientId, label: 'Client', connected: null } },
    { fence: 1, controller: { clientId, label: 'Client', connected: true, extra: true } },
  ])
    expect(() => storedReceipt({ requestId, status: 'rejected', code: 'busy', control })).toThrow(
      stateError,
    )
  for (const code of ['branch-exists', 'last-repository', 'internal'])
    expect(() => storedReceipt({ requestId, status: 'rejected', code })).toThrow(stateError)
})
