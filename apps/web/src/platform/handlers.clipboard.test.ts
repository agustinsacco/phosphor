// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readBrowserImage, writeBrowserImage } from '@phosphor/shared/browser-image-clipboard'
import { createBrowserHandlers } from './handlers'

vi.mock('@phosphor/shared/browser-image-clipboard', () => ({
  writeBrowserImage: vi.fn(async () => {}),
  readBrowserImage: vi.fn(async () => ({ data: 'QUJD', mimeType: 'image/png' })),
}))
afterEach(() => vi.clearAllMocks())

it('routes both image clipboard channels locally, without a Host connection', async () => {
  const proxy = new Proxy({}, { get: () => () => undefined })
  const handlers = createBrowserHandlers({
    control: proxy,
    hosts: proxy,
    resources: proxy,
    prefs: proxy,
    drafts: proxy,
    lanes: proxy,
    window: () => proxy,
    openExternal: () => {},
    broadcastLogout: () => {},
    machinesChanged: () => {},
  } as never)
  const image = { data: 'QUJD', mimeType: 'image/png' }
  await handlers['clipboard:writeImage'](image)
  expect(writeBrowserImage).toHaveBeenCalledWith(image)
  expect(await handlers['clipboard:readImage']()).toEqual(image)
  expect(readBrowserImage).toHaveBeenCalledOnce()
})
