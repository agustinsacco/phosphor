import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARTIFACT_INDEX_FORMAT,
  blobFile,
  currentVersion,
  findIndex,
  indexFile,
  parseArtifactRef,
  readAllIndexes,
  type SessionArtifactIndex,
  type StoredArtifact,
} from './artifact-store'

const SESSION = '01a10e05-6032-757f-b3c3-b00bb780ca19'

describe('parseArtifactRef', () => {
  it('reads a session/slug ref, with or without a version', () => {
    expect(parseArtifactRef(`${SESSION}/field-guide`)).toEqual({
      session: SESSION,
      slug: 'field-guide',
    })
    expect(parseArtifactRef(`${SESSION}/field-guide@v7`)).toEqual({
      session: SESSION,
      slug: 'field-guide',
      version: 7,
    })
    // The form chat links use.
    expect(parseArtifactRef(`artifact://${SESSION}/field-guide#v2`)?.version).toBe(2)
  })

  it('leaves a bare id alone: it still means this session', () => {
    expect(parseArtifactRef('field-guide')).toBeNull()
  })

  it('accepts a session prefix only when it is long enough to mean something', () => {
    expect(parseArtifactRef('01a10e05/field-guide')?.session).toBe('01a10e05')
    expect(parseArtifactRef('01a1/field-guide')).toBeNull()
  })

  it('never lets a ref reach outside the store', () => {
    expect(parseArtifactRef('../../etc/passwd')).toBeNull()
    expect(parseArtifactRef(`${SESSION}/../x`)).toBeNull()
    expect(() => indexFile('/store', '../x')).toThrow(/invalid session id/)
    expect(() => blobFile('/store', '../x')).toThrow(/invalid artifact blob id/)
  })
})

describe('currentVersion', () => {
  it('is the newest version on the branch, not the newest in the file', () => {
    const artifact: StoredArtifact = {
      slug: 'a',
      title: 'A',
      type: 'html',
      versions: [
        version(1, true),
        version(2, true),
        // An abandoned branch went further; it does not count.
        version(3, false),
      ],
    }
    expect(currentVersion(artifact)?.version).toBe(2)
  })
})

describe('reading indexes', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-store-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds a session by exact id or unique prefix, and says when a prefix is ambiguous', () => {
    write(root, index('01a10e05-aaaa-7000-8000-000000000001'))
    write(root, index('01a10e05-bbbb-7000-8000-000000000002'))
    expect(findIndex(root, '01a10e05-aaaa')).not.toBe('ambiguous')
    expect(findIndex(root, '01a10e05')).toBe('ambiguous')
    expect(findIndex(root, '99999999')).toBeNull()
  })

  it('skips unreadable or foreign-format indexes instead of failing', () => {
    write(root, index(SESSION))
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(join(root, 'sessions', 'broken.json'), '{nope')
    writeFileSync(
      join(root, 'sessions', 'future.json'),
      JSON.stringify({ ...index('future'), format: 99 }),
    )
    expect(readAllIndexes(root).map((i) => i.sessionId)).toEqual([SESSION])
  })

  it('keeps v1 artifacts readable when the source session was deleted', () => {
    write(root, {
      ...index(SESSION),
      format: 1,
      deleted: true,
      artifacts: { a: { slug: 'a', title: 'A', type: 'markdown', versions: [version(1, true)] } },
    })
    const old = readAllIndexes(root)[0]!
    expect(old.format).toBe(1)
    expect(old.deleted).toBe(true)
    expect(currentVersion(old.artifacts.a!)?.version).toBe(1)
  })

  it('treats a store that does not exist yet as empty', () => {
    expect(readAllIndexes(join(root, 'missing'))).toEqual([])
  })
})

function version(n: number, onBranch: boolean): StoredArtifact['versions'][number] {
  return {
    version: n,
    toolCallId: `call-${n}-${onBranch}`,
    entryId: `e${n}`,
    sha256: 'a'.repeat(64),
    bytes: 1,
    createdAt: '2026-10-06T00:00:00.000Z',
    title: 'A',
    onBranch,
  }
}

function index(sessionId: string): SessionArtifactIndex {
  return {
    format: ARTIFACT_INDEX_FORMAT,
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    cwd: '/work',
    deleted: false,
    scan: { offset: 0, size: 0, mtimeMs: 0, signature: '', leafId: null },
    artifacts: {},
  }
}

function write(root: string, value: SessionArtifactIndex): void {
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(indexFile(root, value.sessionId), JSON.stringify(value))
}
