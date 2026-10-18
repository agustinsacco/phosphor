import { expect, expectTypeOf, it } from 'vitest'
import {
  MAX_DRAFTS,
  MAX_DRAFT_BLOB_BYTES,
  type ComposerDraftRecord,
  type DraftAttachment,
} from './drafts'

it('drafts keeps attachment and draft metadata optional', () => {
  expect(MAX_DRAFTS).toBe(30)
  expect(MAX_DRAFT_BLOB_BYTES).toBe(52_428_800)
  expectTypeOf<DraftAttachment>().toEqualTypeOf<{
    kind: 'image' | 'file'
    name: string
    size: number
    path?: string
    blobId?: string
    mimeType?: string
  }>()
  expectTypeOf<ComposerDraftRecord>().toEqualTypeOf<{
    key: string
    text: string
    attachments: DraftAttachment[]
    model?: { provider: string; id: string }
    thinking?: string
    swarm?: boolean
    workspacePath?: string
    preferWorktree?: boolean
    updatedAt: number
  }>()
})
