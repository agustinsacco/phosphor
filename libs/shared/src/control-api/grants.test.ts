import { describe, expect, it } from 'vitest'
import {
  parseClientRegisterRequest,
  parseClientRegisterResponse,
  parseGrantIssueRequest,
  parseGrantIssueResponse,
  parseHeartbeatResponse,
  parseHostRevocations,
} from '../control-api'
import * as facade from '../control-api'
import * as grants from './grants'

const ID = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const NOT_OBJECTS = [null, undefined, [], 'body', 7]
const SIGNATURE = 'A'.repeat(86)
const issued = {
  grant: `phosphor-grant.v1.eyJ2IjoxfQ.${SIGNATURE}`,
  expiresAt: '2026-10-13T12:00:00.000Z',
  host: { id: ID, endpoint: 'https://bee1.ts.net:8443', publicKey: 'A'.repeat(43) },
}
const revocations = { epoch: 3, ownerId: ID, revoked: { sessions: [ID], clients: [] } }

describe('client and grant parsers through the control-api entry', () => {
  it('reports a bad client registration as its label or client', () => {
    for (const value of [...NOT_OBJECTS, {}, { label: '' }])
      expect(parseClientRegisterRequest(value)).toStrictEqual({ ok: false, reason: 'label' })
    for (const value of [...NOT_OBJECTS, {}, { client: null }, { client: { id: 'x' } }])
      expect(parseClientRegisterResponse(value)).toStrictEqual({ ok: false, reason: 'client' })
    for (const label of [' Desktop', '', null, 'x'.repeat(81)])
      expect(parseClientRegisterResponse({ client: { id: ID, label } })).toStrictEqual({
        ok: false,
        reason: 'label',
      })
  })

  it('reports a bad issue request as its ids', () => {
    for (const value of [
      ...NOT_OBJECTS,
      { hostId: ID },
      { clientId: ID },
      { hostId: ID.toUpperCase(), clientId: ID },
    ])
      expect(parseGrantIssueRequest(value)).toStrictEqual({ ok: false, reason: 'ids' })
  })

  it('checks an issued grant body, token, expiry, host and endpoint in that order', () => {
    expect(parseGrantIssueResponse(issued)).toStrictEqual({ ok: true, value: issued })
    for (const value of [...NOT_OBJECTS, { ...issued, host: null }, { ...issued, host: [] }])
      expect(parseGrantIssueResponse(value)).toStrictEqual({ ok: false, reason: 'body' })
    const steps = [
      { grant: 'x', expiresAt: 'x', host: { id: 'x', publicKey: 'x', endpoint: 'x' } },
      { expiresAt: 'x', host: { id: 'x', publicKey: 'x', endpoint: 'x' } },
      { host: { ...issued.host, id: 'x', endpoint: 'x' } },
      { host: { ...issued.host, publicKey: 'x', endpoint: 'x' } },
      { host: { id: ID, publicKey: issued.host.publicKey } },
    ]
    expect(steps.map((patch) => parseGrantIssueResponse({ ...issued, ...patch }))).toStrictEqual(
      ['grant', 'expiresAt', 'host', 'host', 'endpoint'].map((reason) => ({ ok: false, reason })),
    )
    const nullEndpoint = { ...issued, host: { ...issued.host, endpoint: null } }
    expect(parseGrantIssueResponse(nullEndpoint)).toStrictEqual({ ok: true, value: nullEndpoint })
  })

  it('takes a prefixed two-part token within 4096 characters', () => {
    const token = (payload: string, signature = SIGNATURE) =>
      parseGrantIssueResponse({ ...issued, grant: `phosphor-grant.v1.${payload}.${signature}` })
    const longest = 'a'.repeat(4096 - 'phosphor-grant.v1.'.length - 87)
    expect(token(longest).ok).toBe(true)
    expect(token(`${longest}a`)).toStrictEqual({ ok: false, reason: 'grant' })
    expect(token('-_aZ09').ok).toBe(true)
    for (const [payload, signature] of [
      ['', SIGNATURE],
      ['e30=', SIGNATURE],
      ['e3.0', SIGNATURE],
      ['e30', `${SIGNATURE}A`],
      ['e30', SIGNATURE.slice(1)],
      ['e30', `${SIGNATURE.slice(1)}+`],
    ] as const)
      expect(token(payload, signature)).toStrictEqual({ ok: false, reason: 'grant' })
    for (const grant of [7, null, `PHOSPHOR-GRANT.v1.e30.${SIGNATURE}`, `e30.${SIGNATURE}`])
      expect(parseGrantIssueResponse({ ...issued, grant })).toStrictEqual({
        ok: false,
        reason: 'grant',
      })
  })

  it('checks revocations owner, epoch and both lists in that order', () => {
    expect(parseHostRevocations(revocations)).toStrictEqual({ ok: true, value: revocations })
    for (const value of [...NOT_OBJECTS, {}, { ...revocations, ownerId: 'x' }])
      expect(parseHostRevocations(value)).toStrictEqual({ ok: false, reason: 'ownerId' })
    for (const epoch of [0, -1, 1.5, 2_147_483_648, '3', null])
      expect(parseHostRevocations({ ...revocations, epoch, revoked: null })).toStrictEqual({
        ok: false,
        reason: 'epoch',
      })
    expect(parseHostRevocations({ ...revocations, epoch: 2_147_483_647 }).ok).toBe(true)
    for (const revoked of [
      null,
      [],
      { sessions: [] },
      { clients: [] },
      { sessions: [ID, 'x'], clients: [] },
    ])
      expect(parseHostRevocations({ ...revocations, revoked })).toStrictEqual({
        ok: false,
        reason: 'revoked',
      })
  })

  it('bounds each revocation list at 100 ids, alone and inside a heartbeat reply', () => {
    for (const field of ['sessions', 'clients']) {
      const at = (count: number) => ({
        ...revocations,
        revoked: { ...revocations.revoked, [field]: Array(count).fill(ID) },
      })
      expect(parseHostRevocations(at(100)).ok).toBe(true)
      expect(parseHostRevocations(at(101))).toStrictEqual({ ok: false, reason: 'revoked' })
      const reply = { accepted: true, nextInSec: 30, revoked: at(101).revoked }
      expect(parseHeartbeatResponse(reply)).toStrictEqual({ ok: false, reason: 'revoked' })
    }
  })
})

describe('grants module', () => {
  it('is what the control-api entry exports, apart from the revocation-list parser', () => {
    const shared = Object.keys(grants).filter((name) => name !== 'parseRevoked')
    for (const name of shared)
      expect(facade[name as keyof typeof facade], name).toBe(grants[name as keyof typeof grants])
    expect(shared.sort()).toEqual([
      'parseClientRegisterRequest',
      'parseClientRegisterResponse',
      'parseGrantIssueRequest',
      'parseGrantIssueResponse',
      'parseHostRevocations',
    ])
    expect('parseRevoked' in facade).toBe(false)
  })

  it('copies revocation lists in order, keeps duplicates and refuses anything else', () => {
    const sessions = [ID, ID]
    const parsed = grants.parseRevoked({ sessions, clients: [ID], extra: [ID] })
    expect(parsed).toStrictEqual({ sessions: [ID, ID], clients: [ID] })
    expect(parsed?.sessions).not.toBe(sessions)
    expect(grants.parseRevoked({ sessions: [], clients: Array(100).fill(ID) })).not.toBeNull()
    for (const value of [
      ...NOT_OBJECTS,
      {},
      { sessions: [], clients: Array(101).fill(ID) },
      { sessions: [ID.toUpperCase()], clients: [] },
      { sessions: 'x', clients: [] },
    ])
      expect(grants.parseRevoked(value)).toBeNull()
  })
})
