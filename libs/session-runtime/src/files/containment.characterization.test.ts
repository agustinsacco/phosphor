import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SEARCH_OPTIONS } from '@shared/text-search'
import { transferEntry } from './mutations'
import { searchFiles, type SearchBatch } from './workspace-search'

// The containment boundaries of the runtime's file transfer and search:
// equal roots, sibling prefixes and dot-prefixed names.

let root: string, ws: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phosphor-containment-'))
  ws = join(root, 'ws')
  await mkdir(join(ws, '..notes'), { recursive: true })
  await mkdir(join(root, 'ws-sibling'), { recursive: true })
  await writeFile(join(ws, '..notes', 'a.txt'), 'needle')
  await writeFile(join(ws, '..top.txt'), 'needle')
  await writeFile(join(root, 'ws-sibling', 'b.txt'), 'needle')
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('transferEntry containment', () => {
  it('accepts the workspace root itself as the destination', async () => {
    const moved = await transferEntry(ws, join(ws, '..notes', 'a.txt'), ws, 'move')
    expect(moved).toBe(join(ws, 'a.txt'))
  })

  it('treats a dot-prefixed name as inside the workspace', async () => {
    const moved = await transferEntry(ws, join(ws, '..top.txt'), join(ws, '..notes'), 'move')
    expect(await readFile(moved, 'utf8')).toBe('needle')
  })

  it('refuses a sibling folder that shares the workspace prefix', async () => {
    await expect(transferEntry(ws, join(root, 'ws-sibling', 'b.txt'), ws, 'move')).rejects.toThrow(
      'inside this workspace',
    )
    await expect(
      transferEntry(ws, join(ws, '..top.txt'), join(root, 'ws-sibling'), 'copy'),
    ).rejects.toThrow('Destination')
  })
})

describe('searchFiles containment', () => {
  it('reads dot-prefixed names and never a sibling that shares the root prefix', async () => {
    const batches: SearchBatch[] = []
    await searchFiles(
      {
        root: ws,
        files: ['..top.txt', '..notes/a.txt', '../ws-sibling/b.txt', '.', ''],
        query: { ...DEFAULT_SEARCH_OPTIONS, text: 'needle' },
      },
      (batch) => batches.push(batch),
    )
    expect(batches.flatMap((b) => b.files.map((f) => f.path))).toEqual([
      '..top.txt',
      '..notes/a.txt',
    ])
  })
})
