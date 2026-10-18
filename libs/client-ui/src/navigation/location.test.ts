import { describe, expect, it } from 'vitest'
import { decodeLocation, encodeLocation, type Location } from './location'
import { SCREENS } from './screens'

describe('Location codec', () => {
  it.each<Location>([
    { to: 'lanes' },
    { to: 'lanes', machine: 'host-one' },
    { to: 'inbox' },
    { to: 'new', machine: 'host-two' },
    { to: 'page', page: 'skills', machine: 'host-one' },
    { to: 'page', page: 'settings' },
    { to: 'lane', lane: { hostId: 'host-one', laneId: 'lane-one' }, pane: 'changes' },
  ])('round trips %j without local paths', (location) => {
    expect(decodeLocation(encodeLocation(location))).toEqual(location)
  })
  it.each([
    '/lanes/%ZZ/x',
    '/lanes/a/%2Ftmp',
    '/lanes/a/..',
    '/lanes/a/x/edit',
    '/pages/nope',
    '/pages/skills/%00',
    '/lanes/a/x/chat/extra',
    '//evil.test',
    '/lanes/a/%5Ctmp',
  ])('fails closed for %s', (path) => {
    expect(decodeLocation(path)).toEqual({ to: 'unavailable' })
  })
  it('never encodes native session identities', () => {
    expect(() =>
      encodeLocation({ to: 'lane', lane: { sessionId: '/local/session.jsonl' } }),
    ).toThrow()
    expect(() => encodeLocation({ to: 'new', machine: '/path' })).toThrow()
  })
  it('declares a place or explicit refusal in both shells', () => {
    for (const screen of Object.values(SCREENS)) {
      expect(screen.title).toBeTruthy()
      expect(screen.expanded).toBeTruthy()
      expect(typeof screen.compact === 'string' || screen.compact.notYet.length > 0).toBe(true)
    }
    expect(SCREENS.terminal.compact.notYet).toContain('Desktop')
  })
})
