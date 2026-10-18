import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as facade from '../control-api'
import {
  account,
  fail,
  isCount,
  isEndpoint,
  isHostname,
  isIso,
  isIsoTime,
  isRecord,
  isUuid,
  isVersion,
  lanes,
  normalizeLabel,
  ok,
  oneOf,
  optional,
  readiness,
} from './fields'

describe('label rules', () => {
  it('refuses bidi controls and line separators wherever they sit', () => {
    for (const mark of ['\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069']) {
      expect(normalizeLabel(`${mark}bee`)).toBeNull()
      expect(normalizeLabel(`be${mark}e`)).toBeNull()
      expect(normalizeLabel(`bee${mark}`)).toBeNull()
    }
    expect(normalizeLabel('bee\u2028admin')).toBeNull()
    expect(normalizeLabel('bee\u2029admin')).toBeNull()
  })

  it('refuses C0 and C1 controls but keeps ordinary Unicode text', () => {
    for (const control of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085', '\u009f'])
      expect(normalizeLabel(`bee${control}1`)).toBeNull()
    expect(normalizeLabel('  ビー1 · café 🐝  ')).toBe('ビー1 · café 🐝')
    expect(normalizeLabel('x'.repeat(80))).toBe('x'.repeat(80))
    expect(normalizeLabel('x'.repeat(81))).toBeNull()
  })
})

describe('endpoint and host rules', () => {
  it('takes bare lowercase HTTPS origins with a port from 1 to 65535', () => {
    expect(isEndpoint('https://bee1.tail9f6158.ts.net')).toBe(true)
    for (const port of [1, 443, 8443, 65_535])
      expect(isEndpoint(`https://bee.ts.net:${port}`)).toBe(true)
    for (const port of ['0', '00443', '65536', '99999', '100000', ''])
      expect(isEndpoint(`https://bee.ts.net:${port}`)).toBe(false)
    for (const bad of [
      'http://bee.ts.net',
      'https://Bee.ts.net',
      'https://bee.ts.net/',
      'https://bee.ts.net#x',
      'https://u:p@bee.ts.net',
      'https://[::1]',
      'wss://bee.ts.net',
    ])
      expect(isEndpoint(bad)).toBe(false)
  })

  it('takes hostnames and versions with one bounded suffix within their bounds', () => {
    expect(isHostname(`a${'.'.repeat(252)}`)).toBe(true)
    expect(isHostname(`a${'.'.repeat(253)}`)).toBe(false)
    expect(isVersion('10.20.30-beta.1')).toBe(true)
    expect(isVersion('10.20.30+sha.abc')).toBe(true)
    expect(isVersion('10.20.30-beta.1+sha.abc')).toBe(false)
    expect(isVersion('10.20')).toBe(false)
  })
})

describe('time and id rules', () => {
  it('takes exactly what toISOString writes and nothing it would rewrite', () => {
    for (const ms of [0, 1, 951_782_400_000, 1_792_000_000_123, 253_402_300_799_999])
      expect(isIsoTime(new Date(ms).toISOString())).toBe(true)
    for (const bad of [
      '2026-04-31T00:00:00.000Z',
      '2025-02-29T00:00:00.000Z',
      '2026-10-12T10:60:00.000Z',
      '2026-10-12T10:00:00.000+01:00',
      new Date(0),
    ])
      expect(isIsoTime(bad)).toBe(false)
    expect(isIso).toBe(isIsoTime)
  })

  it('takes lowercase uuids as Postgres and randomUUID write them', () => {
    for (let i = 0; i < 20; i++) expect(isUuid(randomUUID())).toBe(true)
    expect(isUuid(randomUUID().toUpperCase())).toBe(false)
    expect(isUuid(`{${randomUUID()}}`)).toBe(false)
    expect(isUuid(randomUUID().replaceAll('-', ''))).toBe(false)
  })
})

describe('parser helpers', () => {
  it('builds results and tells records from arrays and null', () => {
    expect(ok(1)).toStrictEqual({ ok: true, value: 1 })
    expect(fail('label')).toStrictEqual({ ok: false, reason: 'label' })
    expect(isRecord({})).toBe(true)
    for (const bad of [null, [], 'x', 1, undefined]) expect(isRecord(bad)).toBe(false)
  })

  it('bounds counts and members', () => {
    expect(isCount(0, 0)).toBe(true)
    expect(isCount(10, 10)).toBe(true)
    for (const bad of [11, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1'])
      expect(isCount(bad, 10)).toBe(false)
    expect(oneOf(['a', 'b'] as const, 'b')).toBe(true)
    expect(oneOf(['a', 'b'] as const, 'c')).toBe(false)
    expect(oneOf(['a'] as const, ['a'])).toBe(false)
  })

  it('tells null from missing and invalid optional values', () => {
    expect(optional(null, isUuid)).toBeNull()
    const id = randomUUID()
    expect(optional(id, isUuid)).toBe(id)
    expect(optional(undefined, isUuid)).toBeUndefined()
    expect(optional('bad', isUuid)).toBeUndefined()
  })

  it('projects readiness, lanes and accounts to their known fields', () => {
    const ready = { pi: 'outdated', claude: 'signed-out', tailscale: 'no-https' }
    expect(readiness({ ...ready, extra: 1 })).toStrictEqual(ready)
    expect(readiness({ ...ready, pi: 'signed-out' })).toBeNull()
    expect(readiness({ pi: 'ok', claude: 'ok' })).toBeNull()
    expect(lanes({ running: 10_000, waiting: 0, extra: 1 })).toStrictEqual({
      running: 10_000,
      waiting: 0,
    })
    expect(lanes({ running: 10_001, waiting: 0 })).toBeNull()
    expect(account({ login: null, extra: 1 })).toStrictEqual({ login: null })
    expect(account({ login: 'a'.repeat(39) })).toStrictEqual({ login: 'a'.repeat(39) })
    for (const login of ['a'.repeat(40), '', 'a b', 'a_b', undefined])
      expect(account({ login })).toBeNull()
  })
})

describe('control-api entry', () => {
  it('exports the public field rules and keeps parser helpers private', () => {
    expect(facade.isUuid).toBe(isUuid)
    expect(facade.normalizeLabel).toBe(normalizeLabel)
    expect(facade.isHostname).toBe(isHostname)
    expect(facade.isVersion).toBe(isVersion)
    expect(facade.isEndpoint).toBe(isEndpoint)
    expect(facade.isIsoTime).toBe(isIsoTime)
    for (const name of ['ok', 'fail', 'isRecord', 'isIso', 'isCount', 'oneOf', 'optional'])
      expect(name in facade).toBe(false)
    for (const name of ['readiness', 'lanes', 'account']) expect(name in facade).toBe(false)
  })
})
