import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingAttachment } from '@/features/chat/attachments'

const invoke = vi.fn()

const IMAGE: PendingAttachment = {
  kind: 'image',
  data: 'AAAA',
  mimeType: 'image/png',
  name: 'shot.png',
}
const FILE: PendingAttachment = { kind: 'file', path: '/tmp/a.pdf', name: 'a.pdf', size: 42 }

beforeEach(async () => {
  vi.useFakeTimers()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'app:sweepDrafts') return {}
    if (channel === 'app:writeDraftBlob') return true
    if (channel === 'app:readDraftBlob') return 'AAAA'
    return undefined
  })
  vi.stubGlobal('window', { phosphor: { invoke } })
  vi.stubGlobal('crypto', { randomUUID: () => 'blob-id' })
  const { useDraftsStore } = await import('./drafts')
  useDraftsStore.setState({ hydrated: false, drafts: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Let the debounce fire and its async persist settle. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500)
}

function setCalls(): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === 'app:setDraft')
}

describe('draft keys', () => {
  it('prefers the session file path, the only id that survives a restart', async () => {
    const { sessionDraftKey } = await import('./drafts')
    expect(sessionDraftKey('/repo/s.jsonl', 'phosphor-1')).toBe('session:/repo/s.jsonl')
  })

  it('falls back to the phosphorId before pi reports the path', async () => {
    const { sessionDraftKey } = await import('./drafts')
    expect(sessionDraftKey(undefined, 'phosphor-1')).toBe('session:phosphor-1')
  })

  it('keys the home composer by folder, so two projects keep two drafts', async () => {
    const { homeDraftKey } = await import('./drafts')
    expect(homeDraftKey('/repo')).toBe('home:/repo')
  })
})

describe('useDraftsStore', () => {
  it('reads back an empty draft for an unknown key', async () => {
    const { useDraftsStore } = await import('./drafts')
    expect(useDraftsStore.getState().get('home:/nope')).toEqual({ text: '', attachments: [] })
  })

  it('keeps text per key', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setText('home:/a', 'one')
    useDraftsStore.getState().setText('home:/b', 'two')
    expect(useDraftsStore.getState().get('home:/a').text).toBe('one')
    expect(useDraftsStore.getState().get('home:/b').text).toBe('two')
  })

  it('debounces writes so typing does not thrash the disk', async () => {
    const { useDraftsStore } = await import('./drafts')
    for (const text of ['a', 'ab', 'abc']) useDraftsStore.getState().setText('home:/a', text)
    expect(setCalls()).toHaveLength(0)
    await flush()
    expect(setCalls()).toHaveLength(1)
    expect((setCalls()[0]![1] as { text: string }).text).toBe('abc')
  })

  it('clears instead of persisting once a draft goes empty', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setText('home:/a', '   ')
    await flush()
    expect(setCalls()).toHaveLength(0)
    expect(invoke).toHaveBeenCalledWith('app:clearDraft', 'home:/a')
  })

  it('cancels a pending write when the draft is cleared', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setText('home:/a', 'sent')
    useDraftsStore.getState().clear('home:/a')
    await flush()
    // The send already cleared it; a late write would resurrect the message.
    expect(setCalls()).toHaveLength(0)
    expect(useDraftsStore.getState().get('home:/a').text).toBe('')
  })

  it('writes image bytes to a blob and stores only the id', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setAttachments('home:/a', [IMAGE])
    await flush()
    expect(invoke).toHaveBeenCalledWith('app:writeDraftBlob', 'blob-id', 'AAAA')
    const record = setCalls()[0]![1] as { attachments: { blobId?: string; data?: string }[] }
    expect(record.attachments[0]!.blobId).toBe('blob-id')
    expect(record.attachments[0]).not.toHaveProperty('data')
  })

  it('writes a blob once however many times the draft is saved', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setAttachments('home:/a', [IMAGE])
    await flush()
    useDraftsStore.getState().setText('home:/a', 'more')
    await flush()
    expect(invoke.mock.calls.filter((c) => c[0] === 'app:writeDraftBlob')).toHaveLength(1)
  })

  it('keeps a refused image in memory but out of the record', async () => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'app:writeDraftBlob' ? false : channel === 'app:sweepDrafts' ? {} : undefined,
    )
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setAttachments('home:/a', [IMAGE])
    await flush()
    expect(useDraftsStore.getState().get('home:/a').attachments).toHaveLength(1)
    expect((setCalls()[0]![1] as { attachments: unknown[] }).attachments).toEqual([])
  })

  it('persists a file attachment by path, never by bytes', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setAttachments('home:/a', [FILE])
    await flush()
    expect((setCalls()[0]![1] as { attachments: unknown[] }).attachments).toEqual([
      { kind: 'file', name: 'a.pdf', size: 42, path: '/tmp/a.pdf' },
    ])
    expect(invoke).not.toHaveBeenCalledWith(
      'app:writeDraftBlob',
      expect.anything(),
      expect.anything(),
    )
  })

  it('records the model the draft was composed against', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().patch('home:/a', {
      text: 'hi',
      model: { provider: 'anthropic', id: 'claude-opus-5' },
    })
    await flush()
    expect((setCalls()[0]![1] as { model: unknown }).model).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-5',
    })
  })
})

describe('rekey', () => {
  it('moves a draft when the session learns its file path', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setText('session:phosphor-1', 'typed early')
    useDraftsStore.getState().rekey('session:phosphor-1', 'session:/repo/s.jsonl')
    expect(useDraftsStore.getState().get('session:/repo/s.jsonl').text).toBe('typed early')
    expect(useDraftsStore.getState().get('session:phosphor-1').text).toBe('')
    expect(invoke).toHaveBeenCalledWith('app:clearDraft', 'session:phosphor-1')
  })

  it('does nothing when there is no draft to move', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().rekey('session:phosphor-1', 'session:/repo/s.jsonl')
    expect(useDraftsStore.getState().drafts).toEqual({})
    expect(invoke).not.toHaveBeenCalledWith('app:clearDraft', 'session:phosphor-1')
  })

  it('is a no-op when the key has not changed', async () => {
    const { useDraftsStore } = await import('./drafts')
    useDraftsStore.getState().setText('session:a', 'x')
    useDraftsStore.getState().rekey('session:a', 'session:a')
    expect(useDraftsStore.getState().get('session:a').text).toBe('x')
  })
})

describe('hydrate', () => {
  it('restores text, the model, and the image bytes behind each blob', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'app:sweepDrafts') {
        return {
          'home:/repo': {
            key: 'home:/repo',
            text: 'saved',
            updatedAt: 1,
            model: { provider: 'anthropic', id: 'claude-opus-5' },
            attachments: [
              { kind: 'image', name: 'shot.png', size: 4, blobId: 'b1', mimeType: 'image/png' },
            ],
          },
        }
      }
      if (channel === 'app:readDraftBlob') return 'AAAA'
      return undefined
    })
    const { useDraftsStore } = await import('./drafts')
    await useDraftsStore.getState().hydrate()
    const draft = useDraftsStore.getState().get('home:/repo')
    expect(draft.text).toBe('saved')
    expect(draft.model).toEqual({ provider: 'anthropic', id: 'claude-opus-5' })
    expect(draft.attachments).toEqual([
      // blobId rides along so a re-save reuses the file already on disk.
      { kind: 'image', data: 'AAAA', mimeType: 'image/png', name: 'shot.png', blobId: 'b1' },
    ])
  })

  it('drops a chip whose blob file has gone missing', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'app:sweepDrafts') {
        return {
          'home:/repo': {
            key: 'home:/repo',
            text: 'saved',
            updatedAt: 1,
            attachments: [{ kind: 'image', name: 'shot.png', size: 4, blobId: 'gone' }],
          },
        }
      }
      if (channel === 'app:readDraftBlob') return null
      return undefined
    })
    const { useDraftsStore } = await import('./drafts')
    await useDraftsStore.getState().hydrate()
    expect(useDraftsStore.getState().get('home:/repo').attachments).toEqual([])
    expect(useDraftsStore.getState().get('home:/repo').text).toBe('saved')
  })

  it('reuses the restored blob instead of writing a second copy', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'app:sweepDrafts') {
        return {
          'home:/repo': {
            key: 'home:/repo',
            text: 'saved',
            updatedAt: 1,
            attachments: [{ kind: 'image', name: 'shot.png', size: 4, blobId: 'b1' }],
          },
        }
      }
      if (channel === 'app:readDraftBlob') return 'AAAA'
      if (channel === 'app:writeDraftBlob') return true
      return undefined
    })
    const { useDraftsStore } = await import('./drafts')
    await useDraftsStore.getState().hydrate()
    useDraftsStore.getState().setText('home:/repo', 'saved more')
    await flush()
    expect(invoke.mock.calls.filter((c) => c[0] === 'app:writeDraftBlob')).toHaveLength(0)
  })

  it('runs once', async () => {
    const { useDraftsStore } = await import('./drafts')
    await useDraftsStore.getState().hydrate()
    await useDraftsStore.getState().hydrate()
    expect(invoke.mock.calls.filter((c) => c[0] === 'app:sweepDrafts')).toHaveLength(1)
  })

  it('does not overwrite a keystroke that landed while it was reading', async () => {
    let release: (() => void) | undefined
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'app:sweepDrafts') {
        await new Promise<void>((r) => (release = r))
        return { 'home:/repo': { key: 'home:/repo', text: 'stale', updatedAt: 1, attachments: [] } }
      }
      return undefined
    })
    const { useDraftsStore } = await import('./drafts')
    const hydrating = useDraftsStore.getState().hydrate()
    useDraftsStore.getState().setText('home:/repo', 'just typed')
    release!()
    await hydrating
    expect(useDraftsStore.getState().get('home:/repo').text).toBe('just typed')
  })
})

describe('isEmptyDraft', () => {
  it('treats whitespace-only text with no attachments as empty', async () => {
    const { isEmptyDraft } = await import('./drafts')
    expect(isEmptyDraft({ text: '  \n ', attachments: [] })).toBe(true)
  })

  it('is not empty when an image is pending', async () => {
    const { isEmptyDraft } = await import('./drafts')
    expect(isEmptyDraft({ text: '', attachments: [IMAGE] })).toBe(false)
  })
})
