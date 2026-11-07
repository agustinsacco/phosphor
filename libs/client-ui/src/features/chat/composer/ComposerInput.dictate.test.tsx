// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  type Platform,
} from '@/platform/Platform'
import { ComposerInput } from './ComposerInput'
import { useSlashMenu } from './useSlashMenu'
vi.mock('./ComposerField', () => ({ ComposerField: () => null }))
vi.mock('@/features/voice/DictateButton', () => ({ DictateButton: () => <span>Dictate</span> }))
vi.mock('./SwarmSwitch', () => ({
  useSwarm: () => null,
  swarmLook: () => '',
  SwarmSwitch: () => null,
  SwarmControl: () => null,
}))
afterEach(() => vi.unstubAllGlobals())

function Harness() {
  const slash = useSlashMenu({ entries: [], setText: () => {}, focus: () => {} })
  return (
    <ComposerInput
      placeholder="Message"
      workspacePath="/mac"
      attachments={[]}
      onAttachmentsChange={() => {}}
      onWarning={() => {}}
      slash={slash}
      modelPicker={null}
      actions={null}
      value=""
      textareaRef={createRef()}
      onChange={() => {}}
      onSubmit={() => {}}
    />
  )
}

async function dictateShown(platform: Platform): Promise<boolean> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => []) })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <Harness />
      </PlatformProvider>,
    ),
  )
  const shown = container.textContent?.includes('Dictate') ?? false
  act(() => root.unmount())
  container.remove()
  return shown
}

it('Dictate follows the localVoice capability, not local lanes', async () => {
  expect(await dictateShown(DESKTOP_PLATFORM)).toBe(true)
  expect(await dictateShown(COMPACT_PLATFORM)).toBe(false)
  expect(await dictateShown({ ...DESKTOP_PLATFORM, localVoice: false })).toBe(false)
  expect(await dictateShown({ ...COMPACT_PLATFORM, localVoice: true })).toBe(true)
})
