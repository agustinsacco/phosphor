import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blobFile, currentVersion, readIndex } from '@phosphor/pi-extensions/artifact-store'
import { emptyScan, indexSessionFile, scanLine, writeIndex } from './artifact-indexer'

const SESSION_ID = '01a10e05-6032-757f-b3c3-b00bb780ca19'

/** pi's own serialisation order: type, id, parentId first. */
function entry(type: string, id: string, parentId: string | null, rest: object = {}): string {
  return JSON.stringify({
    type,
    id,
    parentId,
    timestamp: `2026-10-06T00:00:${id.padStart(2, '0').slice(-2)}.000Z`,
    ...rest,
  })
}

function header(): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: SESSION_ID,
    timestamp: '2026-10-05T21:43:15.764Z',
    cwd: '/work/lane',
  })
}

function artifactResult(
  id: string,
  parentId: string,
  tool: string,
  details: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return entry('message', id, parentId, {
    message: { role: 'toolResult', toolName: tool, toolCallId: `call-${id}`, details, ...extra },
  })
}

const v = (version: number, content: string, type = 'html') => ({
  id: 'guide',
  title: `Guide v${version}`,
  type,
  content,
  version,
})

describe('indexSessionFile', () => {
  let dir: string
  let root: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-indexer-'))
    root = join(dir, 'store')
    file = join(dir, 'session.jsonl')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (lines: string[]): void => writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
  const append = (lines: string[]): void =>
    appendFileSync(file, lines.map((l) => `${l}\n`).join(''))

  it('keeps artifacts written before a compaction: the case that emptied the pane', async () => {
    write([
      header(),
      entry('message', '1', null, { message: { role: 'user', content: 'make a guide' } }),
      artifactResult('2', '1', 'artifact_create', v(1, 'one')),
      artifactResult('3', '2', 'artifact_edit', v(2, 'two')),
      entry('compaction', '4', '3', { summary: 'long story', firstKeptEntryId: '4' }),
      entry('message', '5', '4', { message: { role: 'user', content: 'continue' } }),
    ])
    const index = (await indexSessionFile(root, file, null))!
    expect(index.sessionId).toBe(SESSION_ID)
    expect(index.cwd).toBe('/work/lane')
    expect(index.firstUserText).toBe('make a guide')
    const guide = index.artifacts.guide!
    expect(guide.versions.map((x) => [x.version, x.onBranch])).toEqual([
      [1, true],
      [2, true],
    ])
    expect(currentVersion(guide)?.title).toBe('Guide v2')
    expect(readFileSync(blobFile(root, guide.versions[1]!.sha256), 'utf8')).toBe('two')
  })

  it('indexes Pi-owned saved snapshots before compaction and tracks their branch membership', async () => {
    write([
      header(),
      entry('custom', '1', null, {
        customType: 'phosphor-saved-artifact',
        data: v(1, 'saved preview', 'markdown'),
      }),
      entry('compaction', '2', '1', { firstKeptEntryId: '2' }),
    ])
    const first = (await indexSessionFile(root, file, null))!
    expect(first.artifacts.guide!.type).toBe('markdown')
    // A v1 scan may have passed the new custom entry without understanding it.
    const upgraded = await indexSessionFile(root, file, { ...first, format: 1, artifacts: {} })
    expect(upgraded?.format).toBe(2)
    expect(upgraded?.artifacts.guide).toEqual(first.artifacts.guide)
    expect(currentVersion(first.artifacts.guide!)?.toolCallId).toBe('entry:1')
    expect(
      readFileSync(blobFile(root, currentVersion(first.artifacts.guide!)!.sha256), 'utf8'),
    ).toBe('saved preview')
    append([entry('message', '3', null, { message: { role: 'user', content: 'other branch' } })])
    const moved = (await indexSessionFile(root, file, first))!
    expect(currentVersion(moved.artifacts.guide!)).toBeUndefined()
  })

  it('ignores reads, lists, failures and malformed details, and drops the legacy type', async () => {
    write([
      header(),
      artifactResult('1', '0', 'artifact_create', v(1, 'one')),
      artifactResult('2', '1', 'artifact_read', v(1, 'one')),
      artifactResult('3', '2', 'artifact_edit', v(2, 'bad'), { isError: true }),
      artifactResult('4', '3', 'artifact_edit', { id: 'guide', version: 2 }),
      artifactResult('5', '4', 'artifact_update', { ...v(2, 'two'), type: 'update' }),
      '{"type":"message","id":"6","parentId":"5","message":{"role":"toolResult","toolName":"artifact_cre',
    ])
    const guide = (await indexSessionFile(root, file, null))!.artifacts.guide!
    expect(guide.versions.map((x) => x.version)).toEqual([1, 2])
    expect(guide.type).toBe('html')
  })

  it('flags versions on an abandoned branch', async () => {
    write([
      header(),
      artifactResult('1', '0', 'artifact_create', v(1, 'one')),
      artifactResult('2', '1', 'artifact_edit', v(2, 'two on branch a')),
      // Back to 1, then on: pi's leaf is the last entry in the file.
      artifactResult('3', '1', 'artifact_edit', v(2, 'two on branch b')),
    ])
    const guide = (await indexSessionFile(root, file, null))!.artifacts.guide!
    expect(guide.versions.map((x) => [x.toolCallId, x.onBranch])).toEqual([
      ['call-1', true],
      ['call-2', false],
      ['call-3', true],
    ])
  })

  it('reads only what was appended, and returns the same index when nothing was', async () => {
    write([header(), artifactResult('1', '0', 'artifact_create', v(1, 'one'))])
    const first = (await indexSessionFile(root, file, null))!
    expect(await indexSessionFile(root, file, first)).toBe(first)

    append([artifactResult('2', '1', 'artifact_edit', v(2, 'two'))])
    const second = (await indexSessionFile(root, file, first))!
    expect(second.artifacts.guide!.versions.map((x) => [x.version, x.onBranch])).toEqual([
      [1, true],
      [2, true],
    ])
    expect(second.scan.offset).toBe(readFileSync(file).length)
    // The previous index was not mutated.
    expect(first.artifacts.guide!.versions).toHaveLength(1)
  })

  it('rescans everything when an append moves the branch under old versions', async () => {
    write([
      header(),
      artifactResult('1', '0', 'artifact_create', v(1, 'one')),
      artifactResult('2', '1', 'artifact_edit', v(2, 'two')),
    ])
    const first = (await indexSessionFile(root, file, null))!
    append([artifactResult('3', '1', 'artifact_edit', v(2, 'other two'))])
    const second = (await indexSessionFile(root, file, first))!
    expect(second.artifacts.guide!.versions.map((x) => [x.toolCallId, x.onBranch])).toEqual([
      ['call-1', true],
      ['call-2', false],
      ['call-3', true],
    ])
  })

  it('waits for a half-written last line instead of skipping it', async () => {
    const complete = artifactResult('2', '1', 'artifact_edit', v(2, 'two'))
    write([header(), artifactResult('1', '0', 'artifact_create', v(1, 'one'))])
    appendFileSync(file, complete.slice(0, 40))
    const first = (await indexSessionFile(root, file, null))!
    expect(first.artifacts.guide!.versions).toHaveLength(1)
    appendFileSync(file, `${complete.slice(40)}\n`)
    const second = (await indexSessionFile(root, file, first))!
    expect(second.artifacts.guide!.versions).toHaveLength(2)
  })

  it('starts over when the file was rewritten rather than appended to', async () => {
    write([header(), artifactResult('1', '0', 'artifact_create', v(1, 'one'))])
    const first = (await indexSessionFile(root, file, null))!
    write([header(), artifactResult('9', '0', 'artifact_create', { ...v(1, 'x'), id: 'other' })])
    const second = (await indexSessionFile(root, file, first))!
    expect(Object.keys(second.artifacts)).toEqual(['other'])
  })

  it('indexes constructor on fresh scans and full branch rebuilds without losing siblings', async () => {
    write([
      header(),
      artifactResult('1', '0', 'artifact_create', v(1, 'guide')),
      artifactResult('2', '1', 'artifact_create', { ...v(1, 'one'), id: 'constructor' }),
    ])
    const first = (await indexSessionFile(root, file, null))!
    expect(Object.keys(first.artifacts)).toEqual(['guide', 'constructor'])
    expect(currentVersion(first.artifacts['constructor']!)?.toolCallId).toBe('call-2')

    append([artifactResult('3', '1', 'artifact_create', { ...v(1, 'other'), id: 'constructor' })])
    const rebuilt = (await indexSessionFile(root, file, first))!
    expect(rebuilt.artifacts.guide).toEqual(first.artifacts.guide)
    expect(
      rebuilt.artifacts['constructor']!.versions.map((x) => [x.toolCallId, x.onBranch]),
    ).toEqual([
      ['call-2', false],
      ['call-3', true],
    ])
  })

  it('adds and clones constructor incrementally after persisted reloads', async () => {
    write([header(), artifactResult('1', '0', 'artifact_create', v(1, 'guide'))])
    const first = (await indexSessionFile(root, file, null))!
    await writeIndex(root, first)
    const reloaded = readIndex(root, SESSION_ID)!
    append([artifactResult('2', '1', 'artifact_create', { ...v(1, 'one'), id: 'constructor' })])
    const second = (await indexSessionFile(root, file, reloaded))!
    expect(Object.hasOwn(reloaded.artifacts, 'constructor')).toBe(false)
    expect(second.artifacts.guide).toEqual(first.artifacts.guide)
    await writeIndex(root, second)
    const stored = readIndex(root, SESSION_ID)!
    expect(Object.hasOwn(stored.artifacts, 'constructor')).toBe(true)

    append([artifactResult('3', '2', 'artifact_edit', { ...v(2, 'two'), id: 'constructor' })])
    const third = (await indexSessionFile(root, file, stored))!
    expect(Object.keys(third.artifacts)).toEqual(['guide', 'constructor'])
    expect(stored.artifacts['constructor']!.versions).toHaveLength(1)
    expect(third.artifacts['constructor']!.versions.map((x) => [x.version, x.onBranch])).toEqual([
      [1, true],
      [2, true],
    ])
    const latest = currentVersion(third.artifacts['constructor']!)!
    expect(readFileSync(blobFile(root, latest.sha256), 'utf8')).toBe('two')
    expect(third.artifacts.guide).toEqual(first.artifacts.guide)
  })

  it('answers null for a missing file or one that is not a session', async () => {
    expect(await indexSessionFile(root, file, null)).toBeNull()
    writeFileSync(file, '{"hello":"world"}\n')
    expect(await indexSessionFile(root, file, null)).toBeNull()
  })

  it('stores each distinct content once', async () => {
    write([
      header(),
      artifactResult('1', '0', 'artifact_create', v(1, 'same')),
      artifactResult('2', '1', 'artifact_create', { ...v(1, 'same'), id: 'copy' }),
    ])
    const index = (await indexSessionFile(root, file, null))!
    expect(index.artifacts.guide!.versions[0]!.sha256).toBe(
      index.artifacts.copy!.versions[0]!.sha256,
    )
  })
})

describe('scanLine', () => {
  it('takes the name from the latest session_info and parses the header itself', () => {
    const state = emptyScan()
    scanLine(state, header())
    scanLine(state, entry('session_info', '1', null, { name: 'first' }))
    scanLine(state, entry('session_info', '2', '1', { name: 'second' }))
    expect(state.header?.id).toBe(SESSION_ID)
    expect(state.name).toBe('second')
    expect(state.lastId).toBe('2')
  })
})
