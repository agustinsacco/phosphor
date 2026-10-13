import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { absolutePath, canonicalJson, integer, storedReceipt, text, uuid } from './validation'

it('canonicalizes every nested key and bounds depth, size and JSON values', () => {
  expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: null })).toBe('{"a":null,"z":[{"a":1,"b":2}]}')
  expect(canonicalJson('é', 4)).toBe('"é"')
  expect(() => canonicalJson('é', 3)).toThrow()
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  let deep: unknown = null
  for (let i = 0; i < 65; i++) deep = [deep]
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    cyclic,
    deep,
    { getter: undefined },
  ])
    expect(() => canonicalJson(value)).toThrow()
  expect(() =>
    canonicalJson({
      get a() {
        throw new Error('must not evaluate')
      },
    }),
  ).toThrow('Invalid Host state input.')
  expect(() => canonicalJson('x'.repeat(HOST_LIMITS.inboundFrameBytes))).toThrow()
  expect(() => canonicalJson(Array(20).fill(null), 10)).toThrow()
  expect(() => canonicalJson({ a: 1, b: 2 }, 4)).toThrow()
})
it('validates ids, numbers, text and normalized absolute paths', () => {
  expect(() => uuid(randomUUID())).not.toThrow()
  for (const value of ['bad', '', '00000000-0000-0000-0000-000000000000'])
    expect(() => uuid(value)).toThrow()
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => integer(value)).toThrow()
  expect(() => integer(Number.MAX_SAFE_INTEGER)).not.toThrow()
  for (const value of ['relative', '/a/../b', '/a\0b']) expect(() => absolutePath(value)).toThrow()
  expect(() => text(null, 80)).not.toThrow()
  for (const value of ['', 'x'.repeat(81), '\n']) expect(() => text(value, 80)).toThrow()
})
it('validates every receipt variant and rejects malformed metadata and extra keys', () => {
  const requestId = randomUUID()
  const clientId = randomUUID()
  const valid = [
    { requestId, status: 'pending' },
    { requestId, status: 'unknown' },
    { requestId, status: 'done', fence: 1, laneId: randomUUID(), data: { result: true } },
    { requestId, status: 'failed', error: { code: 'pi-error', message: 'Failed' } },
    { requestId, status: 'rejected', code: 'stale-fence', control: { fence: 1, controller: null } },
    {
      requestId,
      status: 'rejected',
      code: 'not-controller',
      control: { fence: 2, controller: { clientId, label: 'Client', connected: false } },
    },
  ]
  for (const value of valid) expect(storedReceipt(value)).toEqual(value)
  const invalid = [
    null,
    {},
    { requestId, status: 'other' },
    { requestId, status: 'unknown', extra: true },
    { requestId, status: 'done', fence: 0 },
    { requestId, status: 'done', laneId: 'bad' },
    { requestId, status: 'failed', error: { code: 'other', message: 'Failed' } },
    {
      requestId,
      status: 'failed',
      error: { code: 'timeout', message: 'x'.repeat(HOST_LIMITS.messageChars + 1) },
    },
    { requestId, status: 'failed', error: { code: 'timeout', message: 'Failed', extra: true } },
    { requestId, status: 'rejected', code: 'other' },
    {
      requestId,
      status: 'rejected',
      code: 'stale-fence',
      control: { fence: -1, controller: null },
    },
    {
      requestId,
      status: 'rejected',
      code: 'stale-fence',
      control: { fence: 1, controller: null, extra: true },
    },
    {
      requestId,
      status: 'rejected',
      code: 'stale-fence',
      control: { fence: 1, controller: { clientId, label: '', connected: false } },
    },
    {
      requestId,
      status: 'rejected',
      code: 'stale-fence',
      control: { fence: 1, controller: { clientId, label: 'Client', connected: 'false' } },
    },
  ]
  for (const value of invalid) expect(() => storedReceipt(value)).toThrow()
})
