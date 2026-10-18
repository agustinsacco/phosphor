import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserApi } from './index'
import { createBrowserDrafts, BROWSER_DRAFT_LIMITS } from './drafts'
import { MAX_DRAFTS, type ComposerDraftRecord } from '@phosphor/shared/models'
import { hostResourceKey } from '@phosphor/shared/remote-host'

const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const blob = '33333333-3333-4333-8333-333333333333'
const disposals: (() => void)[] = []
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()))
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const draft = (key = 'session:remote-aaaaaaaaaaaaaaaa'): ComposerDraftRecord => ({
  key,
  text: 'Synthetic draft',
  attachments: [],
  updatedAt: 1,
})
async function setup() {
  let user = owner
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }
  const fetch = vi.fn<typeof globalThis.fetch>(async (path) => {
    if (path === '/api/auth/session')
      return json({
        user: { id: user, login: 'fixture' },
        clientId: user,
        csrfToken: user.replace(/-/g, ''),
      })
    if (path === '/api/v1/machines')
      return json({ machines: [], serverTime: new Date().toISOString() })
    return json({ signedOut: true, remoteCleanup: 'complete' })
  })
  const adapter = createBrowserApi({
    fetch,
    storage,
    navigate: () => {},
    invalidation: null,
    lifecycle: { subscribe: () => () => {} },
  })
  disposals.push(adapter.dispose)
  await adapter.start()
  return {
    ...adapter,
    storage,
    fetch,
    switchOwner: () => {
      user = other
    },
  }
}
it('round-trips canonical remote composer keys without mixing the same lane on different Hosts', async () => {
  const s = await setup()
  const first = hostResourceKey({ kind: 'remote', hostId: owner }, 'session', 'lane-1')
  const second = hostResourceKey({ kind: 'remote', hostId: other }, 'session', 'lane-1')
  await s.api.invoke('app:setDraft', { ...draft(first), text: 'First Host' })
  await s.api.invoke('app:setDraft', { ...draft(second), text: 'Second Host' })
  expect((await s.api.invoke('app:getPrefs')).drafts).toEqual({
    [first]: { ...draft(first), text: 'First Host' },
    [second]: { ...draft(second), text: 'Second Host' },
  })
  await s.api.invoke('app:clearDraft', first)
  expect(await s.api.invoke('app:sweepDrafts')).toEqual({
    [second]: { ...draft(second), text: 'Second Host' },
  })
})
it.each([
  '["remote","bad/host","session","lane"]',
  '["local",null,"session","lane"]',
  '["remote","host","workspace","lane"]',
  '["remote","host","session",""]',
  '["remote","host","session","lane","extra"]',
  '[ "remote", "host", "session", "lane" ]',
  '["remote","host","session",42]',
  '[malformed',
])('refuses noncanonical remote draft key %s', (key) => {
  expect(() => createBrowserDrafts(() => true).set(draft(key))).toThrow('Invalid browser draft')
})
it('round-trips real composer draft/blob shapes in memory, with detached reads and orphan cleanup', async () => {
  const s = await setup()
  expect(await s.api.invoke('app:writeDraftBlob', blob, 'aGVsbG8=')).toBe(true)
  const record = {
    ...draft(),
    model: { provider: 'fixture', id: 'model' },
    thinking: 'high',
    swarm: true,
    workspacePath: `host:${owner}/lane:${other}`,
    attachments: [
      { kind: 'image' as const, name: 'fixture.png', size: 8, blobId: blob, mimeType: 'image/png' },
    ],
  }
  await s.api.invoke('app:setDraft', record)
  record.text = 'changed outside'
  const first = await s.api.invoke('app:sweepDrafts')
  expect(first[draft().key]?.text).toBe('Synthetic draft')
  first[draft().key]!.text = 'changed read'
  expect((await s.api.invoke('app:getPrefs')).drafts[draft().key]?.text).toBe('Synthetic draft')
  expect(await s.api.invoke('app:readDraftBlob', blob)).toBe('aGVsbG8=')
  await s.api.invoke('app:clearDraft', draft().key)
  expect(await s.api.invoke('app:sweepDrafts')).toEqual({})
  expect(await s.api.invoke('app:readDraftBlob', blob)).toBeNull()
  expect(s.storage.setItem).not.toHaveBeenCalled()
})
it.each(['owner', 'logout'] as const)(
  'clears drafts/blobs and fences already-issued reads at %s invalidation',
  async (change) => {
    const s = await setup()
    await s.api.invoke('app:writeDraftBlob', blob, 'aGVsbG8=')
    await s.api.invoke('app:setDraft', {
      ...draft(),
      attachments: [
        { kind: 'image', name: 'fixture.png', size: 8, blobId: blob, mimeType: 'image/png' },
      ],
    })
    // These handlers are synchronous, but invoke delivers through a promise: invalidation
    // in that interval must not release the old owner's private data.
    const pending = s.api.invoke('app:sweepDrafts').then(
      (value) => ({ value }),
      () => ({ refused: true }),
    )
    const pendingBlob = s.api.invoke('app:readDraftBlob', blob).then(
      (value) => ({ value }),
      () => ({ refused: true }),
    )
    const pendingPrefs = s.api.invoke('app:getPrefs').then(
      (value) => ({ value }),
      () => ({ refused: true }),
    )
    const invalidation = s.api.invoke(change === 'owner' ? 'account:signIn' : 'account:signOut')
    expect(await pending).toEqual({ refused: true })
    expect(await pendingBlob).toEqual({ refused: true })
    expect(await pendingPrefs).toEqual({ refused: true })
    await invalidation
    if (change === 'owner') {
      s.switchOwner()
      await s.start()
    }
    expect(await s.api.invoke('app:sweepDrafts')).toEqual({})
    expect(await s.api.invoke('app:readDraftBlob', blob)).toBeNull()
  },
)
it('drops records on a verified owner switch even without a logout', async () => {
  const s = await setup()
  await s.api.invoke('app:setDraft', draft())
  await s.api.invoke('app:writeDraftBlob', blob, 'aGVsbG8=')
  s.switchOwner()
  await s.start()
  expect(await s.api.invoke('app:sweepDrafts')).toEqual({})
  expect(await s.api.invoke('app:readDraftBlob', blob)).toBeNull()
})
it('bounds metadata, record count and unreferenced blobs without writing storage', async () => {
  const s = await setup()
  for (let i = 0; i <= MAX_DRAFTS; i++)
    await s.api.invoke('app:setDraft', {
      ...draft(`home:host:${owner}/repository:${i}`),
      updatedAt: i,
    })
  const records = await s.api.invoke('app:sweepDrafts')
  expect(Object.keys(records)).toHaveLength(MAX_DRAFTS)
  expect(records[`home:host:${owner}/repository:0`]).toBeUndefined()
  await expect(
    s.api.invoke('app:setDraft', { ...draft(), text: 'x'.repeat(300_000) }),
  ).rejects.toThrow()
  await expect(
    s.api.invoke('app:setDraft', {
      ...draft(),
      attachments: [{ kind: 'file', name: 'file', size: 1, path: '/local/file' }],
    }),
  ).rejects.toThrow()
  expect(await s.api.invoke('app:writeDraftBlob', '../local', 'aGVsbG8=')).toBe(false)
  expect(await s.api.invoke('app:writeDraftBlob', blob, 'not base64')).toBe(false)
  for (let i = 0; i < 128; i++)
    expect(await s.api.invoke('app:writeDraftBlob', `fixture-${i}`, 'YQ==')).toBe(true)
  expect(await s.api.invoke('app:writeDraftBlob', 'overflow-blob', 'YQ==')).toBe(false)
  await s.api.invoke('app:sweepDrafts')
  expect(await s.api.invoke('app:writeDraftBlob', 'overflow-blob', 'YQ==')).toBe(true)
  expect(s.storage.setItem).not.toHaveBeenCalled()
})
it('refuses draft and blob writes while signed out', async () => {
  const s = await setup()
  await s.api.invoke('account:signOut')
  await expect(s.api.invoke('app:setDraft', draft())).rejects.toThrow()
  expect(await s.api.invoke('app:writeDraftBlob', blob, 'aGVsbG8=')).toBe(false)
  expect(await s.api.invoke('app:sweepDrafts')).toEqual({})
})

it('bounds aggregate metadata and image bytes, accounting replacements and reclaiming owner memory', () => {
  const memory = createBrowserDrafts(() => true)
  for (let i = 0; i < 5; i++)
    memory.set({ ...draft(`session:fixture-${i}`), text: 'x'.repeat(200_000) })
  expect(() => memory.set({ ...draft('session:overflow'), text: 'x'.repeat(200_000) })).toThrow(
    'full',
  )
  expect(Object.keys(memory.snapshot())).toHaveLength(5)
  const data = 'AAAA'.repeat(Math.floor(BROWSER_DRAFT_LIMITS.blobBytes / 3))
  for (let i = 0; i < 6; i++) expect(memory.writeBlob(`fixture-${i}`, data)).toBe(true)
  expect(memory.writeBlob('fixture-0', data)).toBe(true)
  expect(memory.writeBlob('overflow-image', data)).toBe(false)
  memory.clearOwner()
  expect(memory.writeBlob('overflow-image', data)).toBe(true)
  expect(memory.writeBlob('oversize-image', data + 'AAAA')).toBe(false)
  expect(memory.snapshot()).toEqual({})
})

it('collects only unshared images on replacement, clear and draft eviction', () => {
  const memory = createBrowserDrafts(() => true)
  const attachments = [
    { kind: 'image' as const, name: 'fixture.png', size: 4, blobId: blob, mimeType: 'image/png' },
  ]
  memory.writeBlob(blob, 'YQ==')
  memory.set({ ...draft('session:first'), attachments })
  memory.set({ ...draft('session:second'), attachments })
  memory.clear('session:first')
  expect(memory.readBlob(blob)).toBe('YQ==')
  memory.set(draft('session:second'))
  expect(memory.readBlob(blob)).toBeNull()
  memory.writeBlob(blob, 'YQ==')
  memory.set({ ...draft('session:oldest'), updatedAt: 0, attachments })
  for (let i = 0; i < MAX_DRAFTS; i++)
    memory.set({ ...draft(`session:new-${i}`), updatedAt: i + 2 })
  expect(memory.readBlob(blob)).toBeNull()
})
