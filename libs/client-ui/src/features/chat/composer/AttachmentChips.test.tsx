// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { AttachmentChips } from './AttachmentChips'

vi.mock('../imageEditor/ImageEditor', () => ({
  ImageEditor: () => <div role="dialog" aria-label="Annotate image" />,
}))

it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'opens the canvas annotator without native file editing ($formFactor browser)',
  (platform) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      act(() =>
        root.render(
          <PlatformProvider value={platform}>
            <AttachmentChips
              attachments={[
                { kind: 'image', name: 'test.png', data: 'QUJD', mimeType: 'image/png' },
              ]}
              onRemove={() => {}}
              onEdit={() => true}
            />
          </PlatformProvider>,
        ),
      )
      act(() => container.querySelector('button')!.click())
      expect(document.querySelector('[role="dialog"][aria-label="Annotate image"]')).not.toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  },
)
