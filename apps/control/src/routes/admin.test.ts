import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES as R } from '@phosphor/shared/control-api'
import { token, userId } from '../test-support'
import { cookieName, fixture, mutationHeaders, origin } from '../web/test-fixture'
import { ADMIN_GITHUB_ID, ADMIN_READS_PER_MINUTE } from './admin'
import { setup } from './__fixtures__/fixtures'

const totals = { day: 1, week: 2, lastWeek: 3, month: 4, lastMonth: 5, new7d: 6, new30d: 7 }
const stats = {
  generatedAt: '2026-10-27T12:00:00.000Z',
  accounts: { total: 12, new7d: 1, new30d: 3 },
  hosts: { enrolled: 4, online: 2, seen24h: 3 },
  downloads: { last7d: 9, last30d: 40, total: 100, byArtifact30d: [] },
  usage: { desktop: totals, host: totals },
  series: [],
  versions: [],
  platforms: [],
}
function admin(check: unknown = true, answer: unknown = stats) {
  return fixture((name) =>
    name === 'control_admin_check'
      ? check
      : name === 'control_admin_stats'
        ? answer
        : { outcome: 'not-found' },
  )
}
const called = (f: { deps: { supabase: { rpc: unknown } } }, name: string) =>
  vi.mocked(f.deps.supabase.rpc as (n: string) => unknown).mock.calls.filter(([n]) => n === name)

describe('admin summary', () => {
  it('answers the owner with aggregates, checked against the fixed GitHub id', async () => {
    const f = admin()
    const { sealed } = await f.login()
    const res = await f.app.request(origin + R.adminStats, { headers: { cookie: sealed } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(stats)
    expect(called(f, 'control_admin_check')).toEqual([
      ['control_admin_check', { p_user_id: userId, p_github_id: '5874561' }],
    ])
    expect(vi.mocked(f.deps.log).mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ event: 'admin.read', userId }),
    )
  })

  it('shows anyone else nothing, and never reads the summary for them', async () => {
    for (const check of [false, null, 'true', 1, { admin: true }]) {
      const f = admin(check)
      const { sealed } = await f.login()
      const res = await f.app.request(origin + R.adminStats, { headers: { cookie: sealed } })
      expect(res.status, JSON.stringify(check)).toBe(404)
      expect(called(f, 'control_admin_stats')).toEqual([])
    }
  })

  it('is reachable only through a browser session on the app origin', async () => {
    const f = admin()
    expect((await f.app.request(origin + R.adminStats)).status).toBe(404)
    const native = setup()
    native.results.control_admin_check = true
    native.results.control_admin_stats = stats
    expect((await native.call(R.adminStats, 'GET')).status).toBe(404)
    expect(called(native, 'control_admin_check')).toEqual([])
    const { sealed } = await f.login()
    const bearer = `Bearer ${token(Math.floor(f.deps.clock() / 1000) + 100)}`
    const res = await f.app.request(origin + R.adminStats, {
      headers: { cookie: sealed, authorization: bearer },
    })
    expect(res.status).toBe(400)
  })

  it('drops anything unlisted and refuses a malformed summary', async () => {
    const leaky = admin(true, { ...stats, users: [{ login: 'someone' }] })
    const { sealed } = await leaky.login()
    const res = await leaky.app.request(origin + R.adminStats, { headers: { cookie: sealed } })
    expect(JSON.stringify(await res.json())).not.toContain('someone')
    const broken = admin(true, { ...stats, hosts: null })
    const login = await broken.login()
    expect(
      (await broken.app.request(origin + R.adminStats, { headers: { cookie: login.sealed } }))
        .status,
    ).toBe(503)
  })

  it('limits reads per user', async () => {
    const f = admin()
    const { sealed } = await f.login()
    for (let i = 0; i < ADMIN_READS_PER_MINUTE; i++)
      await f.app.request(origin + R.adminStats, { headers: { cookie: sealed } })
    const res = await f.app.request(origin + R.adminStats, { headers: { cookie: sealed } })
    expect(res.status).toBe(429)
  })

  it('names the same GitHub id as the database check constraint', () => {
    const dir = resolve(import.meta.dirname, '../../../../supabase/migrations')
    const sql = readdirSync(dir)
      .map((file) => readFileSync(resolve(dir, file), 'utf8'))
      .join('\n')
    const checks = [...sql.matchAll(/github_id text primary key check \(github_id = '(\d+)'\)/g)]
    expect(checks.map((m) => m[1])).toEqual([ADMIN_GITHUB_ID])
  })
})

describe('account deletion', () => {
  it('deletes the caller only', async () => {
    const f = setup()
    f.results.control_account_delete = { outcome: 'deleted' }
    const res = await f.call(R.me, 'DELETE')
    expect(res.status).toBe(204)
    expect(called(f, 'control_account_delete')).toEqual([
      ['control_account_delete', { p_user_id: userId }],
    ])
    expect(vi.mocked(f.deps.log).mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ event: 'account.deleted', userId }),
    )
  })

  it('refuses a body, the way the Node adapter frames one', async () => {
    const f = setup()
    const bearer = `Bearer ${token(Math.floor(f.deps.clock() / 1000) + 100)}`
    const res = await f.app.request(
      R.me,
      { method: 'DELETE', headers: { authorization: bearer } },
      {
        incoming: { headers: { 'content-length': '2' }, socket: { remoteAddress: '203.0.113.5' } },
      },
    )
    expect(res.status).toBe(400)
    expect(called(f, 'control_account_delete')).toEqual([])
  })

  it('needs a signed-in caller and reports a missing account', async () => {
    const f = setup()
    expect((await f.app.request(R.me, { method: 'DELETE' })).status).toBe(401)
    expect(called(f, 'control_account_delete')).toEqual([])
    f.results.control_account_delete = { outcome: 'not-found' }
    expect((await f.call(R.me, 'DELETE')).status).toBe(404)
  })

  it('in the browser, needs the CSRF token and clears the session cookie', async () => {
    const f = fixture((name) =>
      name === 'control_account_delete' ? { outcome: 'deleted' } : { outcome: 'not-found' },
    )
    const { sealed, view } = await f.login()
    const request = (headers: Record<string, string>) =>
      f.app.request(origin + R.me, { method: 'DELETE', headers })
    expect(
      (await request({ ...mutationHeaders(sealed, view.csrfToken), 'x-phosphor-csrf': 'x' }))
        .status,
    ).toBe(403)
    expect(called(f, 'control_account_delete')).toEqual([])
    const res = await request(mutationHeaders(sealed, view.csrfToken))
    expect(res.status).toBe(204)
    const cookies = res.headers.getSetCookie().filter((c) => c.startsWith(cookieName + '='))
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(/^__Host-phosphor-session=; .*Max-Age=0/)
  })
})
