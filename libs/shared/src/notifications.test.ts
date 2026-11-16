import { expect, it } from 'vitest'
import type { HostAttention } from './ipc'
import {
  attentionNotice,
  notificationPayload,
  notificationPath,
  parseNotificationRoute,
} from './notifications'

const attention: HostAttention = {
  hostId: 'host',
  laneId: 'lane',
  title: 'Fix build',
  kind: 'finished',
  at: '2026-01-01T00:00:00Z',
}
const pr = { host: 'github.com', owner: 'Acme', repo: 'app', number: 57 }

it.each([
  ['finished', 'Done'],
  ['failed', 'Stopped'],
  ['needs-input', 'needs-input'],
  ['routine', 'routine'],
] as const)('shares Desktop attention title and fallback body for %s', (kind, body) => {
  expect(attentionNotice('bee1', { ...attention, kind })).toEqual({
    title: 'bee1 · Fix build',
    body,
    route: { hostId: 'host', laneId: 'lane' },
  })
})
it('puts receipt facts, never the reply excerpt or paths, on the lock screen', () => {
  const notice = attentionNotice('bee1', {
    ...attention,
    receipt: {
      title: 'Fix build',
      repository: '/private/repo',
      branch: 'private-branch',
      excerpt: 'private reply',
      settledAt: null,
      durationMs: 4000,
      files: 1,
      added: 2,
      removed: 1,
      tests: 'passed',
      artifacts: 0,
      outcome: 'done',
    },
  })
  expect(notice.body).toBe('Done in 4s · 1 file changed · tests pass')
  expect(JSON.stringify(notice)).not.toMatch(/private/)
})
it('replaces per lane or PR, carries only route identifiers and supports explicit stable keys', () => {
  const route = { hostId: 'host', laneId: 'lane' }
  const notice = { title: 'Title', body: 'Body', route }
  expect(notificationPayload(notice)).toEqual({
    title: 'Title',
    options: {
      body: 'Body',
      tag: 'phosphor:lane:host:lane',
      icon: '/icons/icon-192.png',
      data: { type: 'phosphor-notification', route },
    },
  })
  expect(notificationPayload({ ...notice, route: { ...route, pr } }).options.tag).toBe(
    'phosphor:pr:github.com/acme/app#57',
  )
  expect(notificationPayload({ ...notice, key: 'test' }).options.tag).toBe('phosphor:test')
  expect(notificationPath({ ...route, pr })).toBe(
    `/lanes/host/lane/chat?notificationPr=${encodeURIComponent(JSON.stringify(pr))}`,
  )
  expect(notificationPath()).toBe('/lanes')
})
it.each([
  null,
  {},
  { hostId: '/private', laneId: 'lane' },
  { hostId: 'host', laneId: '../lane' },
  { hostId: 'host', laneId: 'lane', pr: { ...pr, number: 0 } },
])('rejects malformed or path-bearing routes %j', (route) => {
  expect(parseNotificationRoute(route)).toBeUndefined()
})
it('does not copy extra fields into notification data', () => {
  expect(parseNotificationRoute({ hostId: 'host', laneId: 'lane', path: '/private' })).toEqual({
    hostId: 'host',
    laneId: 'lane',
  })
})
