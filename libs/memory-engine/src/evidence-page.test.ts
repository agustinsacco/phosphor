import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { BrainEvidence } from '@phosphor/shared/brain'
import { openMemoryStore } from './service'

const prefs = {
  enabled: true,
  recall: false,
  workspaces: ['/a', '/b'],
  processor: null,
  retentionDays: 1,
}
type Page = {
  items: Pick<BrainEvidence, 'id' | 'scope' | 'label' | 'role' | 'observedAt'>[]
  nextCursor: string | null
}
const cleanups: (() => void)[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'brain-evidence-page-'))
  let now = 1000
  const store = openMemoryStore({ directory, Database: DatabaseSync, now: () => now })
  store.setPrefs(prefs)
  cleanups.push(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const page = (scope: string, afterId?: string): Page => {
    const candidate = store as typeof store & {
      evidencePage?: (scope: string, afterId?: string) => Page
    }
    expect(typeof candidate.evidencePage).toBe('function')
    return candidate.evidencePage!(scope, afterId)
  }
  const capture = (entryId: string, scope = '/a') =>
    store.capture({
      scope,
      sessionId: 'synthetic',
      entryId,
      rootIds: [entryId],
      parentId: null,
      branch: null,
      role: 'user',
      label: entryId,
      observedAt: now,
      text: 'Synthetic uncited source.',
    })!
  return {
    store,
    directory,
    page,
    capture,
    time: (value: number) => {
      now = value
    },
  }
}
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

it('regression: every uncited source beyond snapshot limits is reachable through fixed seek pages', () => {
  const { store, capture, page } = fixture()
  const expected = Array.from({ length: 251 }, (_, index) => capture(`entry-${index}`).id).sort()
  capture('other-scope', '/b')
  expect(store.snapshot().evidence.length).toBeLessThanOrEqual(200)
  const actual: string[] = []
  const sizes: number[] = []
  let cursor: string | undefined
  do {
    const result = page('/a', cursor)
    sizes.push(result.items.length)
    actual.push(...result.items.map((item) => item.id))
    expect(result.items.every((item) => item.scope === '/a')).toBe(true)
    expect(
      result.items.every(
        (item) => Object.keys(item).sort().join(',') === 'id,label,observedAt,role,scope',
      ),
    ).toBe(true)
    cursor = result.nextCursor ?? undefined
    if (cursor) expect(cursor).toBe(result.items.at(-1)!.id)
  } while (cursor)
  expect(sizes).toEqual([50, 50, 50, 50, 50, 1])
  expect(actual).toEqual(expected)
  expect(store.snapshot().counts.claims).toBe(0)
})
it('regression: paging continues after the cursor source is forgotten', () => {
  const { store, capture, page } = fixture()
  const ids = Array.from({ length: 51 }, (_, index) => capture(`entry-${index}`).id).sort()
  const first = page('/a')
  expect(first.items).toHaveLength(50)
  expect(first.nextCursor).toBe(ids[49])
  store.forget([first.nextCursor!])
  expect(page('/a', first.nextCursor!).items.map((item) => item.id)).toEqual([ids[50]])
  expect(page('/a', first.nextCursor!).nextCursor).toBeNull()
})
it('regression: empty/exact-last pages are terminal and cursors need not refer to existing rows', () => {
  const { capture, page } = fixture()
  expect(page('/a')).toEqual({ items: [], nextCursor: null })
  for (let index = 0; index < 50; index++) capture(`entry-${index}`)
  expect(page('/a').items).toHaveLength(50)
  expect(page('/a').nextCursor).toBeNull()
  expect(page('/a', 'f'.repeat(64))).toEqual({ items: [], nextCursor: null })
})
it('regression: inventory enforces exact enrolled scope, enabled state and cursor syntax', () => {
  const { store, capture, page } = fixture()
  capture('source')
  expect(() => page('/a/')).toThrow()
  expect(() => page('/private')).toThrow()
  for (const cursor of ['', 'not-a-cursor', "' OR 1=1 --", 'f'.repeat(65), 'A'.repeat(64)]) {
    expect(() => page('/a', cursor)).toThrow()
  }
  store.setPrefs({ ...prefs, workspaces: ['/b'] })
  expect(() => page('/a')).toThrow()
  store.setPrefs({ ...prefs, enabled: false })
  expect(() => page('/b')).toThrow()
})
it('regression: source inventory reads metadata without opening retained blobs', () => {
  const { capture, page, directory } = fixture()
  const source = capture('source')
  for (const filename of readdirSync(join(directory, 'evidence')))
    unlinkSync(join(directory, 'evidence', filename))
  expect(page('/a')).toEqual({
    items: [
      {
        id: source.id,
        scope: source.scope,
        label: source.label,
        role: source.role,
        observedAt: source.observedAt,
      },
    ],
    nextCursor: null,
  })
})
it('regression: inventory expires old retained sources consistently with other reads', () => {
  const { store, capture, page, time } = fixture()
  capture('expired')
  time(86_401_000)
  expect(page('/a')).toEqual({ items: [], nextCursor: null })
  expect(store.snapshot().counts.evidence).toBe(0)
})
