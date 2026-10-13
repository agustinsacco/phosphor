import { expect, it } from 'vitest'
import {
  parseClientRegisterRequest,
  parseClientRegisterResponse,
  parseGrantIssueRequest,
  parseGrantIssueResponse,
  parseHeartbeatResponse,
  parseHostRevocations,
} from './control-api'

const id = '00000000-0000-4000-8000-000000000001'
const revoked = { sessions: [id], clients: [id] }
it('validates and projects client and issue bodies at the label boundary', () => {
  expect(parseClientRegisterRequest({ label: ' Desktop ', extra: 'discard' })).toEqual({
    ok: true,
    value: { label: 'Desktop' },
  })
  expect(parseClientRegisterRequest({ label: 'x'.repeat(80) }).ok).toBe(true)
  for (const value of [
    null,
    [],
    {},
    { label: '' },
    { label: 'x'.repeat(81) },
    { label: 'bad\u2028label' },
  ])
    expect(parseClientRegisterRequest(value).ok).toBe(false)
  expect(
    parseClientRegisterResponse({ client: { id, label: 'Desktop', extra: true }, extra: true }),
  ).toEqual({ ok: true, value: { client: { id, label: 'Desktop' } } })
  for (const value of [
    null,
    { client: {} },
    { client: { id: 'bad', label: 'Desktop' } },
    { client: { id, label: ' Desktop ' } },
  ])
    expect(parseClientRegisterResponse(value).ok).toBe(false)
  expect(parseGrantIssueRequest({ hostId: id, clientId: id, extra: true })).toEqual({
    ok: true,
    value: { hostId: id, clientId: id },
  })
  for (const value of [
    null,
    [],
    {},
    { hostId: 'bad', clientId: id },
    { hostId: id, clientId: 'bad' },
  ])
    expect(parseGrantIssueRequest(value).ok).toBe(false)
})
it('bounds grant response tokens and checks the Host metadata without claiming signature verification', () => {
  const response = {
    grant: 'phosphor-grant.v1.e30.' + 'A'.repeat(86),
    expiresAt: '2026-10-13T12:00:00.000Z',
    host: { id, publicKey: 'A'.repeat(43), endpoint: null },
  }
  expect(parseGrantIssueResponse(response)).toEqual({ ok: true, value: response })
  expect(
    parseGrantIssueResponse({
      ...response,
      host: { ...response.host, endpoint: 'https://bee.ts.net' },
    }).ok,
  ).toBe(true)
  const atLimit = 'phosphor-grant.v1.' + 'a'.repeat(4096 - 'phosphor-grant.v1.'.length - 87) + '.' + 'A'.repeat(86)
  expect(atLimit).toHaveLength(4096)
  expect(parseGrantIssueResponse({ ...response, grant: atLimit }).ok).toBe(true)
  for (const patch of [
    { grant: atLimit + 'A' },
    { grant: 'not-a-grant' },
    { grant: response.grant + '=' },
    { expiresAt: 'yesterday' },
    { host: { ...response.host, id: 'bad' } },
    { host: { ...response.host, publicKey: 'bad' } },
    { host: { ...response.host, endpoint: 'http://evil.test' } },
  ])
    expect(parseGrantIssueResponse({ ...response, ...patch }).ok).toBe(false)
})
it('accepts legacy heartbeat responses and bounds each optional revocation list independently', () => {
  const base = { accepted: true, nextInSec: 30 }
  expect(parseHeartbeatResponse({ ...base, unknown: true })).toEqual({ ok: true, value: base })
  const metadata = { epoch: 1, ownerId: id, revoked }
  expect(parseHostRevocations(metadata)).toEqual({ ok: true, value: metadata })
  expect(parseHeartbeatResponse({ ...base, ...metadata })).toEqual({
    ok: true,
    value: { ...base, ...metadata },
  })
  for (const field of ['sessions', 'clients']) {
    expect(
      parseHeartbeatResponse({ ...base, revoked: { ...revoked, [field]: Array(100).fill(id) } }).ok,
    ).toBe(true)
    for (const list of [Array(101).fill(id), ['bad'], null, {}]) {
      const bad = { ...metadata, revoked: { ...revoked, [field]: list } }
      expect(parseHostRevocations(bad).ok).toBe(false)
      expect(parseHeartbeatResponse({ ...base, ...bad }).ok).toBe(false)
    }
  }
  for (const patch of [
    { epoch: 0 },
    { epoch: 1.5 },
    { epoch: 2147483648 },
    { ownerId: 'bad' },
    { revoked: null },
  ]) {
    expect(parseHostRevocations({ ...metadata, ...patch }).ok).toBe(false)
    expect(parseHeartbeatResponse({ ...base, ...metadata, ...patch }).ok).toBe(false)
  }
})
