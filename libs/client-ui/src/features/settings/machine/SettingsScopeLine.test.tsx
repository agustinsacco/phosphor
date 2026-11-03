// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsScopeLine } from './SettingsScopeLine'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['darwin', 'This Mac', 'this Mac'],
  ['win32', 'This PC', 'this PC'],
  ['linux', 'This computer', 'this computer'],
])(
  'names the local machine mid-sentence in lower case on %s (regression)',
  async (platform, label, inSentence) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('phosphor', { platform })
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<SettingsScopeLine machine={{ id: 'local', label }} />))
    expect(container.textContent).toBe(
      `Configuring ${label}. These settings stay on ${inSentence}.`,
    )
    act(() => root.unmount())
  },
)
