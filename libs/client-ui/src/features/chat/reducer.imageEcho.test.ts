import { describe, expect, it } from 'vitest'
import type { ImageContent, UserMessage } from '@shared/rpc'
import { emptyChatSession, type ChatSessionState } from './chatItems'
import { reduceChatEvent } from './reducer'

const images: ImageContent[] = [
  { type: 'image', data: 'original-one', mimeType: 'image/png' },
  { type: 'image', data: 'original-two', mimeType: 'image/png' },
]
const notes = [
  '[Image: original 2246x1072, displayed at 2000x955. Multiply coordinates by 1.12 to map to original image.]',
  '[Image: original 2414x1262, displayed at 2000x1046. Multiply coordinates by 1.21 to map to original image.]',
]

function pending(text: string): ChatSessionState {
  return {
    ...emptyChatSession(),
    items: [{ id: 'local-image-prompt', kind: 'user', text, images, optimistic: true }],
  }
}

function echo(text: string, echoedImages = images): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...echoedImages],
    timestamp: 1_758_800_000_123,
  }
}

function deliver(state: ChatSessionState, message: UserMessage): ChatSessionState {
  state = reduceChatEvent(state, { type: 'message_start', message })
  return reduceChatEvent(state, { type: 'message_end', message })
}

describe('resized-image user echoes', () => {
  it.each(['look at these', ''])('confirms one local bubble for a resized echo of %j', (text) => {
    const resized = images.map((image) => ({ ...image, data: `resized-${image.data}` }))
    const state = deliver(pending(text), echo(`${text}\n\n${notes.join('\n')}`, resized))
    expect(state.items).toEqual([
      {
        id: 'local-image-prompt',
        kind: 'user',
        text,
        images,
        optimistic: false,
        timestamp: 1_758_800_000_123,
      },
    ])
  })

  it('accepts conversion hints mixed with size hints without changing the local preview', () => {
    const text = 'look at these'
    const hints = ['[Image converted from image/bmp to image/png.]', ...notes]
    const state = deliver(pending(text), echo(`${text}\n\n${hints.join('\n')}`))
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ id: 'local-image-prompt', text, optimistic: false })
  })

  it.each([
    'look at these\n\nA genuinely different instruction',
    `look at these\n\n${notes[0]}\nAlso change the title`,
    `look at these\n\n${notes[0]} extra text`,
    `look at these\n\n[Image: arbitrary text]`,
  ])('does not match an arbitrary text suffix: %s', (text) => {
    expect(deliver(pending('look at these'), echo(text)).items).toHaveLength(2)
  })

  it('does not use image hints to match a text-only optimistic message', () => {
    const state = pending('look at these')
    state.items = [{ id: 'text-only', kind: 'user', text: 'look at these', optimistic: true }]
    expect(deliver(state, echo(`look at these\n\n${notes.join('\n')}`)).items).toHaveLength(2)
  })

  it('does not match a different image count', () => {
    const message = echo(`look at these\n\n${notes[0]}`, images.slice(0, 1))
    expect(deliver(pending('look at these'), message).items).toHaveLength(2)
  })

  it('preserves authored hint-like text and only matches the appended hints', () => {
    const text = `An example of pi metadata:\n\n${notes[0]}`
    const state = deliver(pending(text), echo(`${text}\n\n${notes.join('\n')}`))
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ text, optimistic: false })
  })

  it('keeps a later, genuinely repeated message instead of merging confirmed bubbles', () => {
    const message = echo(`look at these\n\n${notes.join('\n')}`)
    const first = deliver(pending('look at these'), message)
    const second = deliver(first, { ...message, timestamp: message.timestamp! + 1 })
    expect(second.items).toHaveLength(2)
  })
})
