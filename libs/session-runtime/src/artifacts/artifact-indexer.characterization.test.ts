import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blobFile, type SessionArtifactIndex } from '@phosphor/pi-extensions/artifact-store'
import { indexSessionFile } from './artifact-indexer'

const header = JSON.stringify({
  type: 'session',
  id: 'session-characterization',
  cwd: '/work',
  timestamp: '2026-10-01T00:00:00.000Z',
})

function result(id: string, parentId: string | null, slug = 'guide'): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-10-02T00:00:00.000Z',
    message: {
      role: 'toolResult',
      toolName: 'artifact_create',
      toolCallId: `call-${id}`,
      details: { id: slug, title: slug, type: 'markdown', content: `content-${id}`, version: 1 },
    },
  })
}

describe('artifact-indexer characterization', () => {
  let dir: string
  let root: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-characterization-'))
    root = join(dir, 'store')
    file = join(dir, 'session.jsonl')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function write(...lines: string[]): void {
    writeFileSync(file, `${lines.join('\n')}\n`)
  }

  async function expectParity(previous: SessionArtifactIndex): Promise<SessionArtifactIndex> {
    const incremental = (await indexSessionFile(root, file, previous))!
    expect(incremental).toEqual(await indexSessionFile(root, file, null))
    return incremental
  }

  it('preserves full/incremental parity when an append jumps under an old version', async () => {
    write(header, result('1', null), result('2', '1'))
    const first = (await indexSessionFile(root, file, null))!
    appendFileSync(file, `${result('3', '1')}\n`)
    const next = await expectParity(first)
    expect(next.artifacts.guide!.versions.map((version) => version.onBranch)).toEqual([
      true,
      false,
      true,
    ])
    expect(first.artifacts.guide!.versions.map((version) => version.onBranch)).toEqual([true, true])
  })

  it('returns null while deleted and restores full/incremental parity from a deleted index', async () => {
    write(header, result('1', null))
    const first = (await indexSessionFile(root, file, null))!
    const saved = readFileSync(file)
    rmSync(file)
    expect(await indexSessionFile(root, file, first)).toBeNull()
    writeFileSync(file, saved)
    const restored = await expectParity({ ...first, deleted: true })
    expect(restored.deleted).toBe(false)
    expect(restored.artifacts).toEqual(first.artifacts)
  })

  it('leaves a half record unread and reaches parity after its terminating LF arrives', async () => {
    write(header, result('1', null))
    const complete = result('2', '1')
    const offset = readFileSync(file).length
    appendFileSync(file, complete.slice(0, 50))
    const first = (await indexSessionFile(root, file, null))!
    expect(first.scan.offset).toBe(offset)
    expect(first.artifacts.guide!.versions).toHaveLength(1)
    appendFileSync(file, `${complete.slice(50)}\n`)
    const next = await expectParity(first)
    expect(next.artifacts.guide!.versions).toHaveLength(2)
  })

  it('keeps custom snapshots and an own constructor slug on incremental scans and branch rebuilds', async () => {
    write(
      header,
      JSON.stringify({
        type: 'custom',
        id: '1',
        parentId: null,
        customType: 'phosphor-saved-artifact',
        data: { id: 'guide', content: 'saved', version: 1, type: 'markdown' },
      }),
    )
    const first = (await indexSessionFile(root, file, null))!
    appendFileSync(file, `${result('2', '1', 'constructor')}\n`)
    const second = await expectParity(first)
    expect(Object.keys(second.artifacts)).toEqual(['guide', 'constructor'])
    expect(Object.hasOwn(first.artifacts, 'constructor')).toBe(false)
    expect(second.artifacts.guide!.versions[0]).toMatchObject({ toolCallId: 'entry:1' })
    appendFileSync(file, `${result('3', '1', 'constructor')}\n`)
    const third = await expectParity(second)
    expect(third.artifacts['constructor']!.versions.map((version) => version.onBranch)).toEqual([
      false,
      true,
    ])
    const snapshot = third.artifacts.guide!.versions[0]!
    expect(readFileSync(blobFile(root, snapshot.sha256), 'utf8')).toBe('saved')
  })

  it('returns the identical index object for an unchanged complete session file', async () => {
    write(header, result('1', null))
    const first = (await indexSessionFile(root, file, null))!
    expect(await indexSessionFile(root, file, first)).toBe(first)
  })
})
