import { expect, it } from 'vitest'
import { discoveryCandidates } from './discoveryCandidates'
const peer = { dnsName: 'bee.tail123.ts.net', os: 'linux' as const, online: true }
it('suggests online peers only and matches enrolled endpoint hostname, not label or port', () => {
  expect(
    discoveryCandidates([peer, { ...peer, dnsName: 'offline.tail123.ts.net', online: false }], []),
  ).toEqual([peer])
  expect(discoveryCandidates([peer], [{ endpoint: 'https://BEE.tail123.ts.net:443' }])).toEqual([])
  expect(discoveryCandidates([peer, peer], [{ endpoint: null }, { endpoint: 'invalid' }])).toEqual([
    peer,
  ])
  expect(discoveryCandidates([peer], [{ endpoint: 'https://other.tail123.ts.net' }])).toEqual([
    peer,
  ])
})
