import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as BlobsTypes from './drafts-blobs'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : tmpdir()) },
}))

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'phosphor-drafts-'))
  vi.resetModules()
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

type BlobsModule = typeof BlobsTypes
async function blobs(): Promise<BlobsModule> {
  return import('./drafts-blobs')
}

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
/** "hello" in base64. */
const HELLO = 'aGVsbG8='

describe('draft blobs', () => {
  it('round-trips base64 through a file', async () => {
    const { writeDraftBlob, readDraftBlob } = await blobs()
    await writeDraftBlob(ID, HELLO)
    expect(await readDraftBlob(ID)).toBe(HELLO)
  })

  it('creates the directory on first write', async () => {
    const { writeDraftBlob, listDraftBlobs } = await blobs()
    expect(await listDraftBlobs()).toEqual([])
    await writeDraftBlob(ID, HELLO)
    expect(await listDraftBlobs()).toEqual([ID])
  })

  it('returns null for a blob that is not there', async () => {
    const { readDraftBlob } = await blobs()
    expect(await readDraftBlob(ID)).toBeNull()
  })

  it('deletes blobs and tolerates ones already gone', async () => {
    const { writeDraftBlob, deleteDraftBlobs, listDraftBlobs } = await blobs()
    await writeDraftBlob(ID, HELLO)
    await deleteDraftBlobs([ID, OTHER])
    expect(await listDraftBlobs()).toEqual([])
  })

  it('refuses an id that could escape the directory', async () => {
    const { writeDraftBlob, readDraftBlob } = await blobs()
    await expect(writeDraftBlob('../../etc/passwd', HELLO)).rejects.toThrow('invalid draft blob id')
    // The read path swallows its errors, so it must simply not find anything.
    expect(await readDraftBlob('../../etc/passwd')).toBeNull()
  })

  it('ignores stray files that are not blob ids', async () => {
    const { writeDraftBlob, listDraftBlobs } = await blobs()
    await writeDraftBlob(ID, HELLO)
    writeFileSync(join(userData, 'drafts', '.DS_Store'), '')
    expect(await listDraftBlobs()).toEqual([ID])
  })

  it('totals the bytes it is holding', async () => {
    const { writeDraftBlob, draftBlobBytes } = await blobs()
    await writeDraftBlob(ID, HELLO)
    await writeDraftBlob(OTHER, HELLO)
    expect(await draftBlobBytes()).toBe(10)
  })

  it('reports zero bytes before anything is written', async () => {
    const { draftBlobBytes } = await blobs()
    expect(await draftBlobBytes()).toBe(0)
  })

  it('allows a write that fits under the cap', async () => {
    const { wouldExceedBlobCap } = await blobs()
    expect(await wouldExceedBlobCap(1024)).toBe(false)
  })

  it('refuses a write that would push past the cap', async () => {
    const { wouldExceedBlobCap } = await blobs()
    const { MAX_DRAFT_BLOB_BYTES } = await import('@shared/models')
    expect(await wouldExceedBlobCap(MAX_DRAFT_BLOB_BYTES + 1)).toBe(true)
  })

  /**
   * The hazard this module shares with electron/store.ts: resolving userData
   * at module scope would run before main.ts redirects it for E2E, and a
   * test's pasted images would land in the developer's real profile.
   */
  it('resolves userData lazily, not at import time', async () => {
    const moved = mkdtempSync(join(tmpdir(), 'phosphor-drafts-late-'))
    const module = await blobs()
    userData = moved
    await module.writeDraftBlob(ID, HELLO)
    expect(await module.listDraftBlobs()).toEqual([ID])
    rmSync(moved, { recursive: true, force: true })
  })
})
