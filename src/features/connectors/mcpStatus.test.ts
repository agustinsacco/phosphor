import { describe, expect, it } from 'vitest'
import {
  CHECK_DOT,
  checkResultLabel,
  connectorAction,
  connectorActionLabel,
  parseMcpStatus,
  stateLabel,
} from './mcpStatus'

/** Shaped like the adapter's own `createMcpStatusSnapshot` output. */
const snapshot = JSON.stringify({
  version: 1,
  servers: [
    { name: 'linear', status: 'connected', toolCount: 24, resourceCount: 2, disabled: false },
    { name: 'slack', status: 'needs-auth', toolCount: 0, disabled: false },
    { name: 'datadog', status: 'failed', toolCount: 0, failedAgoSeconds: 12, disabled: false },
    { name: 'notion', status: 'disabled', toolCount: 0, disabled: true },
  ],
  totalTools: 24,
  totalResources: 2,
  connectedCount: 1,
  disabledCount: 1,
})

describe('parseMcpStatus', () => {
  it('reads per-server state, tools and counts', () => {
    const parsed = parseMcpStatus(snapshot)!
    expect(parsed.servers.map((s) => [s.name, s.state])).toEqual([
      ['linear', 'connected'],
      ['slack', 'needs-auth'],
      ['datadog', 'failed'],
      ['notion', 'disabled'],
    ])
    expect(parsed.servers[0]).toMatchObject({ toolCount: 24, resourceCount: 2 })
    expect(parsed.servers[2]?.failedAgoSeconds).toBe(12)
    expect(parsed.totalTools).toBe(24)
    // Recomputed from the rows rather than trusted, so a stale count in the
    // payload cannot disagree with the badges beside it.
    expect(parsed.connectedCount).toBe(1)
    expect(parsed.disabledCount).toBe(1)
  })

  it('degrades to no status rather than a wrong badge', () => {
    expect(parseMcpStatus(undefined)).toBeNull()
    expect(parseMcpStatus('not json')).toBeNull()
    expect(parseMcpStatus('{"servers":"nope"}')).toBeNull()
    expect(parseMcpStatus('[]')).toBeNull()
  })

  it('drops unusable rows and unknown states', () => {
    const parsed = parseMcpStatus(
      JSON.stringify({
        servers: [{ status: 'connected' }, { name: 'x', status: 'quantum', toolCount: -4 }, 'nope'],
      }),
    )!
    expect(parsed.servers).toEqual([{ name: 'x', state: 'not-connected', toolCount: 0 }])
  })

  it('labels every state it can report', () => {
    expect(stateLabel('needs-auth')).toBe('Needs sign-in')
    expect(stateLabel('cached')).toBe('Signed in · idle')
  })
})

describe('connectorAction', () => {
  it('offers sign-in only when the credential was actually rejected', () => {
    expect(connectorAction('needs-auth', true)).toBe('sign-in')
  })

  it('offers reload, NOT sign-in, for a lazily-disconnected server', () => {
    // The regression this guards. `cached` means tool metadata is on disk and
    // nothing has opened a connection this session — it says nothing about
    // credentials. Offering "Sign in" here made people re-authorize servers
    // whose tokens were sitting valid in the OS keychain.
    expect(connectorAction('cached', true)).toBe('reload')
    expect(connectorAction('not-connected', true)).toBe('reload')
    expect(connectorAction('failed', true)).toBe('reload')
  })

  it('offers reload for a live connection', () => {
    expect(connectorAction('connected', true)).toBe('reload')
  })

  it('offers reload when the session has not reported this server yet', () => {
    expect(connectorAction(null, true)).toBe('reload')
  })

  it('falls back to sign-in with no session, the only path that can run', () => {
    // Reload rides /mcp reconnect, which needs the process holding the
    // connection. Sign-in has a headless route, so it is the honest offer.
    expect(connectorAction(null, false)).toBe('sign-in')
    expect(connectorAction('cached', false)).toBe('sign-in')
  })

  it('needs-auth wins even without a session', () => {
    expect(connectorAction('needs-auth', false)).toBe('sign-in')
  })
})

describe('connectorActionLabel', () => {
  it('names each action', () => {
    expect(connectorActionLabel('sign-in')).toBe('Sign in')
    expect(connectorActionLabel('reload')).toBe('Reload')
  })
})

describe('stateLabel', () => {
  it('does not describe an idle server in words that imply breakage', () => {
    expect(stateLabel('cached')).toBe('Signed in · idle')
    expect(stateLabel('needs-auth')).toBe('Needs sign-in')
  })
})

describe('checkResultLabel', () => {
  it('reports a live server with its tool count', () => {
    expect(checkResultLabel({ serverName: 'linear', outcome: 'connected', toolCount: 67 })).toBe(
      'Up · 67 tools',
    )
  })

  it('never renders an inconclusive test as up or down', () => {
    const label = checkResultLabel({ serverName: 'x', outcome: 'unknown', detail: 'timed out' })
    expect(label).toBe('Inconclusive')
    expect(CHECK_DOT.unknown).not.toBe('bg-success')
    expect(CHECK_DOT.unknown).not.toBe('bg-danger')
  })

  it('distinguishes a credential problem from an unreachable server', () => {
    expect(checkResultLabel({ serverName: 'x', outcome: 'needs-auth' })).toBe('Needs sign-in')
    expect(checkResultLabel({ serverName: 'x', outcome: 'failed', detail: 'ENOTFOUND' })).toBe(
      'Down',
    )
  })
})
