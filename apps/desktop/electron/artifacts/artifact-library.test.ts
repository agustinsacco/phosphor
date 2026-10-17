import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactLibrary } from './artifact-library'
import { writeIndex } from './artifact-indexer'

function sessionFile(
  id: string,
  artifacts: Array<{ slug: string; version: number; content: string }>,
  cwd = '/work',
): string {
  const lines = [JSON.stringify({ type: 'session', version: 3, id, timestamp: 't', cwd })]
  let parent: string | null = null
  artifacts.forEach((a, i) => {
    const entryId = `${id.slice(-2)}${i}`
    lines.push(
      JSON.stringify({
        type: 'message',
        id: entryId,
        parentId: parent,
        timestamp: `2026-10-0${i + 1}T00:00:00.000Z`,
        message: {
          role: 'toolResult',
          toolName: a.version === 1 ? 'artifact_create' : 'artifact_edit',
          toolCallId: `call-${a.slug}-${a.version}`,
          details: {
            id: a.slug,
            title: a.slug,
            type: 'markdown',
            content: a.content,
            version: a.version,
          },
        },
      }),
    )
    parent = entryId
  })
  return lines.map((l) => `${l}\n`).join('')
}

describe('ArtifactLibrary', () => {
  let dir: string
  let sessions: string
  let library: ArtifactLibrary
  const root = (): string => join(dir, 'store')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-library-'))
    sessions = join(dir, 'sessions')
    mkdirSync(join(sessions, '--work--'), { recursive: true })
    library = new ArtifactLibrary(root)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const put = (
    name: string,
    id: string,
    artifacts: Parameters<typeof sessionFile>[1],
    cwd?: string,
  ): string => {
    const path = join(sessions, '--work--', name)
    writeFileSync(path, sessionFile(id, artifacts, cwd))
    return path
  }

  it('gives a pane every version on the branch, with content and real dates', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [
      { slug: 'notes', version: 1, content: '# one' },
      { slug: 'notes', version: 2, content: '# two' },
    ])
    const [notes] = await library.forSession(path)
    expect(notes!.id).toBe('notes')
    expect(notes!.versions.map((v) => [v.version, v.content])).toEqual([
      [1, '# one'],
      [2, '# two'],
    ])
    expect(new Date(notes!.versions[1]!.createdAt).toISOString()).toBe('2026-10-02T00:00:00.000Z')
  })

  it('keeps a deleted session’s artifacts, says so, and removes them only on request', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [{ slug: 'notes', version: 1, content: 'x' }])
    await library.indexFile(path)
    // A live session's artifact is part of its history: not removable on its own.
    expect(await library.remove('session-aaaaaaaa/notes')).toBe(false)

    // However the file goes (here, Finder, pi), the next look finds it gone.
    rmSync(path)
    const [listing] = await library.list()
    expect(listing).toMatchObject({ key: 'session-aaaaaaaa/notes', sessionDeleted: true })
    expect((await library.read('session-aaaaaaaa/notes'))?.artifact.versions[0]?.content).toBe('x')

    expect(await library.remove('session-aaaaaaaa/notes')).toBe(true)
    expect(await library.list()).toEqual([])
    // Its content goes too, and so does the now-empty index.
    expect(readdirSync(join(root(), 'blobs'))).toEqual([])
    expect(existsSync(join(root(), 'sessions', 'session-aaaaaaaa.json'))).toBe(false)
  })

  it('takes a deleted session back when its file returns from the trash', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [{ slug: 'notes', version: 1, content: 'x' }])
    await library.indexFile(path)
    const saved = readFileSync(path)
    rmSync(path)
    await library.list()
    writeFileSync(path, saved)
    expect((await library.indexFile(path))?.deleted).toBe(false)
  })

  it('keeps no index for a deleted session that had no artifacts', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [])
    await library.indexFile(path)
    rmSync(path)
    await library.list()
    expect(existsSync(join(root(), 'sessions', 'session-aaaaaaaa.json'))).toBe(false)
  })

  it('says whether a session’s folder is still there to resume it in', async () => {
    put('a.jsonl', 'session-aaaaaaaa', [{ slug: 'here', version: 1, content: 'x' }], dir)
    put('b.jsonl', 'session-bbbbbbbb', [{ slug: 'gone', version: 1, content: 'y' }], '/no/such')
    await library.backfill(sessions)
    const rows = Object.fromEntries((await library.list()).map((l) => [l.id, l.workspaceExists]))
    expect(rows).toEqual({ here: true, gone: false })
  })

  it('survives a restart: a new library reads the same store', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [{ slug: 'notes', version: 1, content: 'x' }])
    await library.indexFile(path)
    const again = new ArtifactLibrary(root)
    expect((await again.list()).map((l) => l.key)).toEqual(['session-aaaaaaaa/notes'])
  })

  it('treats absent prototype-named slugs as missing after loading an index', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [{ slug: 'notes', version: 1, content: 'x' }])
    await library.indexFile(path)
    const again = new ArtifactLibrary(root)
    for (const slug of ['constructor', 'toString', '__proto__']) {
      expect(await again.read(`session-aaaaaaaa/${slug}`)).toBeNull()
      expect(await again.remove(`session-aaaaaaaa/${slug}`)).toBe(false)
    }
    expect(await again.read('missing-session/constructor')).toBeNull()
  })

  it('reads and removes an own constructor slug from a persisted index, preserving siblings', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [
      { slug: 'notes', version: 1, content: 'constructor content' },
      { slug: 'guide', version: 1, content: 'sibling content' },
    ])
    const index = (await library.indexFile(path))!
    index.artifacts = {
      constructor: { ...index.artifacts.notes!, slug: 'constructor' },
      guide: index.artifacts.guide!,
    }
    await writeIndex(root(), index)
    rmSync(path)
    const again = new ArtifactLibrary(root)
    expect((await again.read('session-aaaaaaaa/constructor'))?.artifact.versions[0]?.content).toBe(
      'constructor content',
    )
    await again.list()
    expect(await again.remove('session-aaaaaaaa/constructor')).toBe(true)
    const reloaded = new ArtifactLibrary(root)
    expect(await reloaded.read('session-aaaaaaaa/constructor')).toBeNull()
    expect((await reloaded.read('session-aaaaaaaa/guide'))?.artifact.versions[0]?.content).toBe(
      'sibling content',
    )
    expect((await reloaded.list()).map((l) => l.id)).toEqual(['guide'])
  })

  it('backfills every session file once, then only the ones that changed', async () => {
    put('a.jsonl', 'session-aaaaaaaa', [{ slug: 'notes', version: 1, content: 'x' }])
    put('b.jsonl', 'session-bbbbbbbb', [{ slug: 'plan', version: 1, content: 'y' }])
    writeFileSync(join(sessions, '--work--', 'ignored.txt'), 'not a session')
    expect(await library.backfill(sessions)).toEqual({ indexed: 2, failed: 0 })
    expect(await library.backfill(sessions)).toEqual({ indexed: 0, failed: 0 })
    expect((await library.list()).map((l) => l.id).sort()).toEqual(['notes', 'plan'])
    expect(await library.backfill(join(dir, 'missing'))).toEqual({ indexed: 0, failed: 0 })
  })

  it('serialises concurrent indexing of one file', async () => {
    const path = put('a.jsonl', 'session-aaaaaaaa', [{ slug: 'notes', version: 1, content: 'x' }])
    const results = await Promise.all([library.indexFile(path), library.indexFile(path)])
    expect(results[0]!.artifacts.notes!.versions).toHaveLength(1)
    expect(results[1]!.artifacts.notes!.versions).toHaveLength(1)
  })
})
