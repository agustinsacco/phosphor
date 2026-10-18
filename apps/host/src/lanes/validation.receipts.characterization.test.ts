import { expect, it } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { canonicalJson, storedReceipt } from './validation'

const requestId = '11111111-1111-4111-8111-111111111111'
const clientId = '22222222-2222-4222-8222-222222222222'
const controller = { clientId, label: 'Client', connected: false }
const control = { fence: 1, controller }
const stateError = 'Invalid Host state input.'

it('preserves every stored receipt variant and its exact field allowlist', () => {
  const receipts = [
    { requestId, status: 'pending' },
    { requestId, status: 'unknown' },
    { requestId, status: 'done' },
    { requestId, status: 'done', fence: 1, laneId: clientId, data: null },
    { requestId, status: 'failed', error: { code: 'pi-error', message: 'Failed' } },
    { requestId, status: 'rejected', code: 'busy' },
    { requestId, status: 'rejected', code: 'stale-fence', control },
    {
      requestId,
      status: 'rejected',
      code: 'not-controller',
      control: { fence: Number.MAX_SAFE_INTEGER, controller: null },
    },
  ]
  for (const receipt of receipts) {
    expect(storedReceipt(receipt)).toStrictEqual(receipt)
    expect(() => storedReceipt({ ...receipt, extra: true })).toThrow(stateError)
  }
  for (const status of ['pending', 'unknown', 'failed', 'rejected']) {
    const receipt = receipts.find((entry) => entry.status === status)
    for (const field of ['data', 'fence', 'laneId'])
      expect(() => storedReceipt({ ...receipt, [field]: undefined })).toThrow(stateError)
  }
  expect(storedReceipt({ requestId, status: 'done', data: undefined })).toStrictEqual({
    requestId,
    status: 'done',
  })
})

it('retains the stored failure and rejection code sets including omitted wire codes', () => {
  for (const code of ['pi-error', 'timeout', 'internal'])
    expect(
      storedReceipt({ requestId, status: 'failed', error: { code, message: '' } }),
    ).toStrictEqual({ requestId, status: 'failed', error: { code, message: '' } })
  for (const code of [
    'bad-request',
    'unsupported',
    'forbidden',
    'unknown-lane',
    'lane-stopped',
    'not-controller',
    'stale-fence',
    'conflict',
    'busy',
    'too-many-requests',
  ]) {
    const receipt = { requestId, status: 'rejected', code }
    expect(storedReceipt(receipt)).toStrictEqual(receipt)
  }
  for (const code of ['branch-exists', 'last-repository', 'other', null, undefined]) {
    expect(() => storedReceipt({ requestId, status: 'rejected', code })).toThrow(stateError)
    expect(() =>
      storedReceipt({ requestId, status: 'failed', error: { code, message: 'Failed' } }),
    ).toThrow(stateError)
  }
})

it('rejects invalid receipt envelopes and statuses with the existing errors', () => {
  for (const value of [null, [], 1, 'receipt', {}, { status: 'pending' }])
    expect(() => storedReceipt(value)).toThrow(stateError)
  for (const id of ['', 'bad', null, 1, '00000000-0000-0000-0000-000000000000'])
    expect(() => storedReceipt({ requestId: id, status: 'pending' })).toThrow(stateError)
  expect(() => storedReceipt({ requestId })).toThrow(stateError)
  for (const status of ['other', null, undefined, 1])
    expect(() => storedReceipt({ requestId, status })).toThrow('Invalid Host receipt.')
})

it('checks done fence and lane metadata without accepting explicit undefined', () => {
  for (const fence of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined])
    expect(() => storedReceipt({ requestId, status: 'done', fence })).toThrow(stateError)
  for (const laneId of ['bad', '', null, undefined, 1])
    expect(() => storedReceipt({ requestId, status: 'done', laneId })).toThrow(stateError)
  expect(
    storedReceipt({ requestId, status: 'done', fence: Number.MAX_SAFE_INTEGER }),
  ).toStrictEqual({ requestId, status: 'done', fence: Number.MAX_SAFE_INTEGER })
})

it('checks failed metadata keys and message boundaries while permitting empty messages', () => {
  const failed = (error: unknown) => ({ requestId, status: 'failed', error })
  for (const error of [
    null,
    undefined,
    {},
    { code: 'timeout' },
    { message: 'Failed' },
    { code: 'timeout', message: null },
    { code: 'timeout', message: 1 },
    { code: 'timeout', message: 'Failed', extra: true },
    ...['\n', '\x7f', '\u2028', '\u2029', 'x'.repeat(HOST_LIMITS.messageChars + 1)].map(
      (message) => ({ code: 'timeout', message }),
    ),
  ])
    expect(() => storedReceipt(failed(error))).toThrow(stateError)
  const receipt = failed({ code: 'timeout', message: 'x'.repeat(HOST_LIMITS.messageChars) })
  expect(storedReceipt(receipt)).toStrictEqual(receipt)
})

it('checks rejected control fields and requires controller metadata or explicit null', () => {
  const rejected = (metadata: unknown) => ({
    requestId,
    status: 'rejected',
    code: 'busy',
    control: metadata,
  })
  for (const metadata of [
    null,
    undefined,
    {},
    { fence: 1 },
    { controller: null },
    { fence: 1, controller: undefined },
    { fence: 1, controller: null, extra: true },
    ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((fence) => ({
      fence,
      controller: null,
    })),
  ])
    expect(() => storedReceipt(rejected(metadata))).toThrow(stateError)
  for (const metadata of [
    {},
    { ...controller, clientId: 'bad' },
    { ...controller, clientId: 1 },
    { ...controller, label: '' },
    { ...controller, label: null },
    { ...controller, label: 'x'.repeat(HOST_LIMITS.labelChars + 1) },
    { ...controller, label: '\n' },
    { ...controller, connected: 'false' },
    { ...controller, extra: true },
  ])
    expect(() => storedReceipt(rejected({ fence: 1, controller: metadata }))).toThrow(stateError)
  const receipt = rejected({
    fence: 1,
    controller: { ...controller, label: 'x'.repeat(HOST_LIMITS.labelChars), connected: true },
  })
  expect(storedReceipt(receipt)).toStrictEqual(receipt)
})

it('leaves arbitrary done data to separate canonical JSON validation', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const data of [
    NaN,
    1n,
    () => {},
    new Date(),
    cyclic,
    'x'.repeat(HOST_LIMITS.receiptDataBytes),
  ]) {
    const receipt = storedReceipt({ requestId, status: 'done', data })
    expect(receipt).toStrictEqual({ requestId, status: 'done', data })
    if (receipt.status === 'done') expect(receipt.data).toBe(data)
    expect(() => canonicalJson(data, HOST_LIMITS.receiptDataBytes)).toThrow()
  }
})

it('retains inherited fields and nested array metadata rather than adding object-shape rules', () => {
  const inherited = Object.create({ requestId, status: 'pending' })
  expect(storedReceipt(inherited)).toStrictEqual({ requestId, status: 'pending' })
  const error = Object.assign([], { code: 'internal', message: '' })
  expect(storedReceipt({ requestId, status: 'failed', error })).toStrictEqual({
    requestId,
    status: 'failed',
    error: { code: 'internal', message: '' },
  })
  const receipt = {
    requestId,
    status: 'rejected',
    code: 'busy',
    control: Object.assign([], { fence: 1, controller: Object.assign([], controller) }),
  }
  expect(storedReceipt(receipt)).toStrictEqual({
    requestId,
    status: 'rejected',
    code: 'busy',
    control,
  })
})
