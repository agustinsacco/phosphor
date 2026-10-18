import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blobFile } from '@phosphor/pi-extensions/artifact-store'
import {
  accumulateCandidates,
  buildIndex,
  emptyScan,
  extractCandidate,
  parseEntryHead,
} from './artifact-indexer'

function toolEntry(details: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: {
      role: 'toolResult',
      toolName: 'artifact_create',
      details: { id: 'guide', version: 1, content: 'héllo', ...details },
    },
  }
}

function candidate(id = '1', details: Record<string, unknown> = {}) {
  return extractCandidate(toolEntry(details), id, false)!
}

describe('parseEntryHead', () => {
  it('reads the canonical head without parsing even a malformed irrelevant tail', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(parseEntryHead('{"type":"compaction","id":"1","parentId":null,broken')).toEqual({
        type: 'compaction',
        id: '1',
        parentId: null,
        parsed: undefined,
      })
      expect(parseEntryHead('{"type":"message","id":"2","parentId":"1"}')).toMatchObject({
        parentId: '1',
      })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('falls back to JSON for reordered or spaced fields and normalizes non-string parents', () => {
    const parsed = { id: '2', parentId: 42, type: 'message' }
    expect(parseEntryHead(JSON.stringify(parsed, null, 1))).toEqual({
      type: 'message',
      id: '2',
      parentId: null,
      parsed,
    })
    expect(parseEntryHead('{"id":"2","parentId":"1","type":"message"}')).toMatchObject({
      parentId: '1',
    })
    for (const line of ['not JSON', 'null', 'false', '42', '"text"']) {
      expect(parseEntryHead(line)).toBeUndefined()
    }
  })
})

describe('extractCandidate', () => {
  it.each([{ id: '' }, { id: 1 }, { id: 'x'.repeat(201) }, { content: null }, { version: '1' }])(
    'rejects invalid details %j',
    (details) => {
      expect(extractCandidate(toolEntry(details), '1', false)).toBeUndefined()
    },
  )

  it('requires a successful write-tool result or a matching custom snapshot', () => {
    const entry = toolEntry()
    for (const patch of [
      { role: 'assistant' },
      { isError: true },
      { toolName: 'artifact_read' },
      { details: undefined },
    ]) {
      expect(
        extractCandidate({ message: { ...(entry.message as object), ...patch } }, '1', false),
      ).toBeUndefined()
    }
    expect(extractCandidate(undefined, '1', false)).toBeUndefined()
    expect(extractCandidate({ customType: 'other', data: {} }, '1', true)).toBeUndefined()
    expect(
      extractCandidate(
        {
          customType: 'phosphor-saved-artifact',
          data: { id: 'saved', content: '', version: 1 },
        },
        '2',
        true,
      ),
    ).toMatchObject({ slug: 'saved', toolCallId: 'entry:2', content: '' })
  })

  it('prefers entry timestamps and call IDs, falling back to message time and the entry ID', () => {
    const entry = toolEntry({ id: 'x'.repeat(200), title: 'Title', type: 'html', language: 'js' })
    const message = { ...(entry.message as object), toolCallId: 'call-1', timestamp: 1000 }
    expect(extractCandidate({ message, timestamp: 'entry-time' }, '1', false)).toMatchObject({
      slug: 'x'.repeat(200),
      title: 'Title',
      type: 'html',
      language: 'js',
      toolCallId: 'call-1',
      entryId: '1',
      createdAt: 'entry-time',
    })
    expect(extractCandidate({ message }, '1', false)?.createdAt).toBe('1970-01-01T00:00:01.000Z')
    expect(candidate()).toMatchObject({
      toolCallId: 'entry:1',
      createdAt: '1970-01-01T00:00:00.000Z',
    })
    expect(
      extractCandidate({ message: { ...message, toolCallId: '' } }, '2', false)?.toolCallId,
    ).toBe('entry:2')
  })
})

describe('accumulateCandidates', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-steps-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('deduplicates by tool call ID per slug before writing a blob or changing metadata', async () => {
    const first = candidate()
    const duplicate = {
      ...candidate('2', { title: 'ignored', content: 'ignored' }),
      toolCallId: first.toolCallId,
    }
    const artifacts = await accumulateCandidates(root, [first, duplicate], new Set(['1']))
    expect(artifacts.guide!.versions).toHaveLength(1)
    expect(artifacts.guide!.title).toBe('guide')
    expect(readdirSync(join(root, 'blobs'))).toHaveLength(1)
    const copy = { ...first, slug: 'copy' }
    const next = await accumulateCandidates(root, [copy], new Set(), artifacts)
    expect(next.copy!.versions).toHaveLength(1)
    expect(next.copy!.versions[0]!.onBranch).toBe(false)
  })

  it('preserves old flags and metadata while setting new version flags and UTF-8 sizes', async () => {
    const first = await accumulateCandidates(
      root,
      [candidate('1', { title: 'Guide', type: 'html', language: 'html' })],
      new Set(['1']),
    )
    const next = await accumulateCandidates(
      root,
      [candidate('2', { type: 'update', version: 2 })],
      new Set(),
      first,
    )
    expect(next.guide).toMatchObject({ title: 'Guide', type: 'html', language: 'html' })
    expect(next.guide!.versions.map((version) => [version.onBranch, version.title])).toEqual([
      [true, 'Guide'],
      [false, 'Guide'],
    ])
    const version = next.guide!.versions[1]!
    expect(version.bytes).toBe(6)
    expect(readFileSync(blobFile(root, version.sha256), 'utf8')).toBe('héllo')
    expect(first.guide!.versions).toHaveLength(1)
    expect(next.guide!.versions[0]).not.toBe(first.guide!.versions[0])
  })

  it('creates and clones an own constructor artifact without inheriting a prototype member', async () => {
    const first = await accumulateCandidates(
      root,
      [candidate('1', { id: 'constructor', type: 'invalid' })],
      new Set(['1']),
    )
    expect(Object.hasOwn(first, 'constructor')).toBe(true)
    expect(first['constructor']).toMatchObject({ title: 'constructor', type: 'code' })
    const next = await accumulateCandidates(
      root,
      [candidate('2', { id: 'constructor', type: 'markdown', title: 'New title' })],
      new Set(['2']),
      first,
    )
    expect(next['constructor']).toMatchObject({ title: 'New title', type: 'markdown' })
    expect(next['constructor']!.versions).toHaveLength(2)
    expect(first['constructor']!.versions).toHaveLength(1)
  })
})

describe('buildIndex', () => {
  const scan = { offset: 10, size: 10, mtimeMs: 1, signature: 'signature', leafId: '1' }

  it('selects current header metadata on rebuild and previous metadata on resume', () => {
    const state = emptyScan()
    state.header = { id: 'old', cwd: '/old', timestamp: 'old-time', parentSession: 'parent' }
    state.name = 'Old name'
    state.firstUserText = 'First prompt'
    const previous = { ...buildIndex('/file', null, state, false, scan, {}), deleted: true }
    const appended = emptyScan()
    appended.header = { id: 'new', cwd: '/new', timestamp: 'new-time', parentSession: 'new-parent' }
    appended.firstUserText = 'Later prompt'
    expect(buildIndex('/file', previous, appended, true, scan, {})).toMatchObject({
      sessionId: 'old',
      cwd: '/old',
      createdAt: 'old-time',
      parentSession: 'parent',
      name: 'Old name',
      firstUserText: 'First prompt',
      deleted: false,
      scan,
    })
    appended.name = 'New name'
    expect(buildIndex('/file', previous, appended, false, scan, {})).toMatchObject({
      sessionId: 'new',
      cwd: '/new',
      createdAt: 'new-time',
      parentSession: 'new-parent',
      name: 'New name',
      firstUserText: 'Later prompt',
    })
  })

  it('retains header fallbacks on a rebuild but does not retain stale names or prompts', () => {
    const state = emptyScan()
    state.header = { id: 'old', cwd: '/old', timestamp: 'old-time', parentSession: 'parent' }
    state.name = 'Old name'
    state.firstUserText = 'Old prompt'
    const previous = buildIndex('/file', null, state, false, scan, {})
    const rebuilt = emptyScan()
    rebuilt.header = { id: 'new' }
    const next = buildIndex('/file', previous, rebuilt, false, scan, {})
    expect(next).toMatchObject({ cwd: '/old', createdAt: 'old-time', parentSession: 'parent' })
    expect(next.name).toBeUndefined()
    expect(next.firstUserText).toBeUndefined()
    expect(buildIndex('/file', null, rebuilt, false, scan, {}).cwd).toBe('')
  })
})
