import { describe, expect, it } from 'vitest'
import {
  parseEnrollmentApproveRequest,
  parseEnrollmentApproveResponse,
  parseEnrollmentCreateRequest,
  parseEnrollmentCreateResponse,
  parseEnrollmentLookupRequest,
  parseEnrollmentLookupResponse,
  parseEnrollmentPollRequest,
  parseEnrollmentPollResponse,
  type Parsed,
} from '../control-api'
import * as facade from '../control-api'
import * as enrollment from './enrollment'

const ID = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const KEY = 'A'.repeat(43)
const FINGERPRINT = '0a1b-2c3d-4e5f-6a7b'
const TIME = '2026-10-12T10:00:00.000Z'
const NOT_OBJECTS = [null, undefined, [], 'body', 7]

/** The reason a parser gives while each bad field, in turn, is the first one left. */
function failureOrder(
  parse: (value: unknown) => Parsed<unknown>,
  valid: Record<string, unknown>,
  bad: Record<string, unknown>,
): string[] {
  const fields = Object.keys(bad)
  return fields.map((_, index) => {
    const body: Record<string, unknown> = { ...valid }
    for (const field of fields.slice(index)) body[field] = bad[field]
    const parsed = parse(body)
    return parsed.ok ? 'ok' : parsed.reason
  })
}

describe('enrollment parsers through the control-api entry', () => {
  const create = {
    publicKey: KEY,
    hostname: 'bee1',
    platform: 'linux',
    arch: 'x64',
    hostVersion: '0.2.0',
  }
  const createReply = {
    enrollmentId: ID,
    userCode: 'BCDFGHJK',
    keyFingerprint: FINGERPRINT,
    expiresAt: TIME,
    pollIntervalSec: 5,
  }
  const lookupReply = {
    hostname: 'bee1',
    platform: 'darwin',
    arch: 'arm64',
    hostVersion: '0.2.0',
    keyFingerprint: FINGERPRINT,
    expiresAt: TIME,
  }
  const approved = { status: 'approved', hostId: ID, label: 'bee1', owner: { login: 'octo' } }

  it('checks create request fields in wire order and refuses non-objects first', () => {
    expect(
      failureOrder(parseEnrollmentCreateRequest, create, {
        publicKey: `${KEY.slice(0, -1)}B`,
        hostname: '-bee',
        platform: 'freebsd',
        arch: 'ia32',
        hostVersion: '1.2',
      }),
    ).toEqual(['publicKey', 'hostname', 'platform', 'arch', 'hostVersion'])
    for (const value of NOT_OBJECTS)
      expect(parseEnrollmentCreateRequest(value)).toStrictEqual({
        ok: false,
        reason: 'body must be an object',
      })
    expect(parseEnrollmentCreateRequest({ ...create, extra: 1 })).toStrictEqual({
      ok: true,
      value: create,
    })
  })

  it('requires the canonical code and a 1-60 second poll interval in a create reply', () => {
    expect(
      failureOrder(parseEnrollmentCreateResponse, createReply, {
        enrollmentId: ID.toUpperCase(),
        userCode: 'bcdfghjk',
        keyFingerprint: '0a1b2c3d4e5f6a7b',
        expiresAt: '2026-10-12T10:00:00Z',
        pollIntervalSec: 0,
      }),
    ).toEqual(['enrollmentId', 'userCode', 'keyFingerprint', 'expiresAt', 'pollIntervalSec'])
    for (const userCode of ['BCDF-GHJK', ' BCDFGHJK', 'bcdfghjk', undefined])
      expect(parseEnrollmentCreateResponse({ ...createReply, userCode })).toStrictEqual({
        ok: false,
        reason: 'userCode',
      })
    for (const pollIntervalSec of [1, 60])
      expect(parseEnrollmentCreateResponse({ ...createReply, pollIntervalSec }).ok).toBe(true)
    for (const pollIntervalSec of [0, 61, 1.5, '5', null])
      expect(parseEnrollmentCreateResponse({ ...createReply, pollIntervalSec })).toStrictEqual({
        ok: false,
        reason: 'pollIntervalSec',
      })
    expect(parseEnrollmentCreateResponse(null)).toStrictEqual({
      ok: false,
      reason: 'body must be an object',
    })
  })

  it('reports every bad poll request as its enrollment id', () => {
    for (const value of [...NOT_OBJECTS, {}, { enrollmentId: 'x' }])
      expect(parseEnrollmentPollRequest(value)).toStrictEqual({
        ok: false,
        reason: 'enrollmentId',
      })
    expect(parseEnrollmentPollRequest({ enrollmentId: ID, status: 'pending' })).toStrictEqual({
      ok: true,
      value: { enrollmentId: ID },
    })
  })

  it('parses each poll outcome and checks an approval in field order', () => {
    for (const status of ['pending', 'expired'])
      expect(parseEnrollmentPollResponse({ ...approved, status, label: '' })).toStrictEqual({
        ok: true,
        value: { status },
      })
    for (const status of ['denied', 'PENDING', undefined, null])
      expect(parseEnrollmentPollResponse({ ...approved, status })).toStrictEqual({
        ok: false,
        reason: 'status',
      })
    expect(
      failureOrder(parseEnrollmentPollResponse, approved, {
        hostId: 'x',
        label: ' bee1 ',
        owner: { login: 'a b' },
      }),
    ).toEqual(['hostId', 'label', 'owner'])
    for (const owner of [null, undefined, {}, { login: 'a'.repeat(40) }])
      expect(parseEnrollmentPollResponse({ ...approved, owner })).toStrictEqual({
        ok: false,
        reason: 'owner',
      })
    expect(parseEnrollmentPollResponse([])).toStrictEqual({
      ok: false,
      reason: 'body must be an object',
    })
  })

  it('normalizes a typed code for lookup and reports anything else as the code', () => {
    expect(parseEnrollmentLookupRequest({ userCode: ' bcdf-ghjk ' })).toStrictEqual({
      ok: true,
      value: { userCode: 'BCDFGHJK' },
    })
    for (const value of [...NOT_OBJECTS, {}, { userCode: 'BCDFGHJ' }])
      expect(parseEnrollmentLookupRequest(value)).toStrictEqual({ ok: false, reason: 'userCode' })
  })

  it('checks every lookup reply field a person compares, in order', () => {
    expect(
      failureOrder(parseEnrollmentLookupResponse, lookupReply, {
        hostname: 'a b',
        platform: 'Linux',
        arch: 'arm',
        hostVersion: null,
        keyFingerprint: FINGERPRINT.toUpperCase(),
        expiresAt: null,
      }),
    ).toEqual(['hostname', 'platform', 'arch', 'hostVersion', 'keyFingerprint', 'expiresAt'])
    expect(parseEnrollmentLookupResponse({ ...lookupReply, extra: true })).toStrictEqual({
      ok: true,
      value: lookupReply,
    })
    expect(parseEnrollmentLookupResponse('x')).toStrictEqual({
      ok: false,
      reason: 'body must be an object',
    })
  })

  it('normalizes the typed code and label of an approval, code first', () => {
    expect(parseEnrollmentApproveRequest({ userCode: 'x', label: '' })).toStrictEqual({
      ok: false,
      reason: 'userCode',
    })
    expect(parseEnrollmentApproveRequest({ userCode: 'bcdfghjk', label: 'a\u0000' })).toStrictEqual(
      { ok: false, reason: 'label' },
    )
    expect(parseEnrollmentApproveRequest({ userCode: 'bcdf ghjk', label: ' bee ' })).toStrictEqual({
      ok: true,
      value: { userCode: 'BCDFGHJK', label: 'bee' },
    })
    expect(parseEnrollmentApproveRequest(undefined)).toStrictEqual({
      ok: false,
      reason: 'body must be an object',
    })
  })

  it('prefixes an approved machine failure with the machine field', () => {
    expect(parseEnrollmentApproveResponse({})).toStrictEqual({
      ok: false,
      reason: 'machine: machine must be an object',
    })
    expect(parseEnrollmentApproveResponse({ machine: { id: 'x' } })).toStrictEqual({
      ok: false,
      reason: 'machine: id',
    })
    expect(parseEnrollmentApproveResponse(null)).toStrictEqual({
      ok: false,
      reason: 'body must be an object',
    })
  })
})

describe('enrollment module', () => {
  it('is what the control-api entry exports', () => {
    for (const name of Object.keys(enrollment))
      expect(facade[name as keyof typeof facade], name).toBe(
        enrollment[name as keyof typeof enrollment],
      )
    expect(Object.keys(enrollment).sort()).toEqual([
      'parseEnrollmentApproveRequest',
      'parseEnrollmentApproveResponse',
      'parseEnrollmentCreateRequest',
      'parseEnrollmentCreateResponse',
      'parseEnrollmentLookupRequest',
      'parseEnrollmentLookupResponse',
      'parseEnrollmentPollRequest',
      'parseEnrollmentPollResponse',
    ])
  })

  it('normalizes labels a person typed but requires canonical labels in replies', () => {
    const machine = {
      id: ID,
      label: 'bee1',
      hostname: 'bee1',
      platform: 'linux',
      arch: 'x64',
      hostVersion: null,
      keyFingerprint: FINGERPRINT,
      enrolledAt: TIME,
      lastSeenAt: null,
      state: null,
      readiness: null,
      lanes: null,
      endpoint: null,
    }
    expect(enrollment.parseEnrollmentApproveResponse({ machine })).toStrictEqual({
      ok: true,
      value: { machine },
    })
    for (const label of [' bee1', 'bee1 '])
      expect(
        enrollment.parseEnrollmentApproveRequest({ userCode: 'BCDFGHJK', label }),
      ).toStrictEqual({ ok: true, value: { userCode: 'BCDFGHJK', label: 'bee1' } })
    for (const label of [' bee1', 'bee1 ', 'bee\u202e1']) {
      expect(
        enrollment.parseEnrollmentApproveResponse({ machine: { ...machine, label } }),
      ).toStrictEqual({ ok: false, reason: 'machine: label' })
      expect(
        enrollment.parseEnrollmentPollResponse({
          status: 'approved',
          hostId: ID,
          label,
          owner: { login: null },
        }),
      ).toStrictEqual({ ok: false, reason: 'label' })
    }
  })
})
