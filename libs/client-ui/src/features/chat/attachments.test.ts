import { describe, expect, it } from 'vitest'
import {
  annotatedName,
  buildAttachmentBlock,
  composePrompt,
  formatFileSize,
  isInlineableImage,
  placeAnnotated,
  toImageContents,
  type PendingAttachment,
} from './attachments'

const image = (name = 'a.png'): PendingAttachment => ({
  kind: 'image',
  data: 'BASE64',
  mimeType: 'image/png',
  name,
})
const file = (path: string, name = 'spec.pdf'): PendingAttachment => ({
  kind: 'file',
  path,
  name,
  size: 2048,
})

describe('isInlineableImage', () => {
  it('accepts exactly the MIME types pi supports', () => {
    for (const m of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']) {
      expect(isInlineableImage(m)).toBe(true)
    }
  })

  it('rejects PDFs and other documents — pi has no document content type', () => {
    expect(isInlineableImage('application/pdf')).toBe(false)
    expect(isInlineableImage('text/plain')).toBe(false)
    // SVG is an image to the browser but not to pi's sniffer.
    expect(isInlineableImage('image/svg+xml')).toBe(false)
  })
})

describe('buildAttachmentBlock', () => {
  it('is empty when there are no file attachments', () => {
    expect(buildAttachmentBlock([])).toBe('')
    expect(buildAttachmentBlock([image()])).toBe('')
  })

  it('lists one absolute path per line inside a named block', () => {
    const block = buildAttachmentBlock([file('/tmp/a.pdf'), file('/tmp/b.csv', 'b.csv')])
    expect(block).toBe('\n\n<attached-files>\n/tmp/a.pdf\n/tmp/b.csv\n</attached-files>')
  })

  it('ignores images when building the block', () => {
    const block = buildAttachmentBlock([image(), file('/tmp/only.pdf')])
    expect(block).toContain('/tmp/only.pdf')
    expect(block).not.toContain('BASE64')
  })

  it('keeps paths verbatim, including spaces', () => {
    // The agent gets the real path; quoting is its problem, mangling is ours.
    expect(buildAttachmentBlock([file('/tmp/my docs/spec v2.pdf')])).toContain(
      '/tmp/my docs/spec v2.pdf',
    )
  })
})

describe('composePrompt', () => {
  it('returns the text unchanged when nothing is attached', () => {
    expect(composePrompt('summarize this', [])).toBe('summarize this')
  })

  it('appends the block after the user text', () => {
    const prompt = composePrompt('summarize this', [file('/tmp/a.pdf')])
    expect(prompt.startsWith('summarize this')).toBe(true)
    expect(prompt).toContain('<attached-files>')
    expect(prompt).toContain('/tmp/a.pdf')
  })
})

describe('toImageContents', () => {
  it('maps only images, into pi ImageContent shape', () => {
    const contents = toImageContents([image(), file('/tmp/a.pdf')])
    expect(contents).toEqual([{ type: 'image', data: 'BASE64', mimeType: 'image/png' }])
  })
})

describe('formatFileSize', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [1024 * 1024 * 3, '3.0 MB'],
  ])('formats %d as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected)
  })
})

describe('placeAnnotated', () => {
  const annotated = { kind: 'image', data: 'NEW', mimeType: 'image/png', name: 'a.png' } as const

  it('replaces the original in place by default', () => {
    const next = placeAnnotated([image('a.png'), image('b.png')], 0, annotated, true)
    expect(next.map((a) => (a.kind === 'image' ? a.data : ''))).toEqual(['NEW', 'BASE64'])
  })

  it('keeps the original and attaches the copy right after it', () => {
    const next = placeAnnotated([image('a.png'), image('b.png')], 0, annotated, false)
    expect(next.map((a) => a.name)).toEqual(['a.png', 'a.png', 'b.png'])
    expect(next[1]).toBe(annotated)
  })

  it('returns the same array when the index no longer exists', () => {
    const current = [image()]
    expect(placeAnnotated(current, 3, annotated, true)).toBe(current)
  })
})

describe('annotatedName', () => {
  it('keeps the name in place and suffixes a copy, always as png', () => {
    expect(annotatedName('shot.jpg', true)).toBe('shot.png')
    expect(annotatedName('shot.jpg', false)).toBe('shot-annotated.png')
    expect(annotatedName('shot-annotated.png', false)).toBe('shot-annotated.png')
    expect(annotatedName('image-1', false)).toBe('image-1-annotated.png')
  })
})

it('preflights ten remote attachments and never returns a partial batch after uncertainty', async () => {
  const { remotePromptAttachments } = await import('./attachments')
  const doc: PendingAttachment = {
    kind: 'file',
    path: '',
    name: 'a.pdf',
    size: 3,
    data: 'YWJj',
    mime: 'application/pdf',
  }
  let calls = 0
  const upload = async () => {
    calls++
    return ['/host/a.pdf']
  }
  await expect(remotePromptAttachments(Array(11).fill(doc), upload)).rejects.toThrow('At most 10')
  await expect(remotePromptAttachments([file('/local/file')], upload)).rejects.toThrow(
    'Pick the attachment again',
  )
  expect(calls).toBe(0)
  expect(composePrompt('read', await remotePromptAttachments([doc], upload))).toContain(
    '/host/a.pdf',
  )
  await expect(remotePromptAttachments([doc], async () => [])).rejects.toThrow('not confirmed')
  await expect(
    remotePromptAttachments([doc], async () => {
      throw new Error('unknown')
    }),
  ).rejects.toThrow('unknown')
})

it('reads remote picks as bytes without resolving or retaining a local path', async () => {
  const { toAttachment } = await import('./attachments')
  const document = new File(['abc'], 'report.pdf', { type: 'application/pdf' })
  const attachment = await toAttachment(
    document,
    () => {
      throw new Error('local path resolver must not run')
    },
    true,
  )
  expect(attachment).toEqual({
    kind: 'file',
    name: 'report.pdf',
    size: 3,
    path: '',
    data: 'YWJj',
    mime: 'application/pdf',
  })
})
