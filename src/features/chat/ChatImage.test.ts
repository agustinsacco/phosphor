// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { ImageContent } from '@shared/rpc'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { copyChatImage, imageUrl } from './ChatImage'

const image: ImageContent = { type: 'image', data: 'QUJD', mimeType: 'image/png' }

function stubInvoke(handler: (channel: string, ...args: unknown[]) => unknown): void {
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = {
    invoke: (channel: string, ...args: unknown[]) => Promise.resolve(handler(channel, ...args)),
  }
}

beforeEach(() => {
  useExtensionUiStore.setState({ toasts: [] })
})

describe('imageUrl', () => {
  it('builds a data URL from the mime type and base64 payload', () => {
    expect(imageUrl(image)).toBe('data:image/png;base64,QUJD')
  })
})

describe('copyChatImage', () => {
  it('sends the image payload through the clipboard channel and toasts success', async () => {
    const calls: unknown[] = []
    stubInvoke((channel, ...args) => {
      calls.push([channel, ...args])
    })

    await copyChatImage(image)

    expect(calls).toEqual([['clipboard:writeImage', { data: 'QUJD', mimeType: 'image/png' }]])
    expect(useExtensionUiStore.getState().toasts).toEqual([
      { id: expect.any(Number), message: 'Image copied', kind: 'info' },
    ])
  })

  it('toasts an error instead of throwing when the write fails', async () => {
    ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = {
      invoke: () => Promise.reject(new Error('clipboard unavailable')),
    }

    await copyChatImage(image)

    expect(useExtensionUiStore.getState().toasts).toEqual([
      { id: expect.any(Number), message: 'Copy failed: clipboard unavailable', kind: 'error' },
    ])
  })
})
