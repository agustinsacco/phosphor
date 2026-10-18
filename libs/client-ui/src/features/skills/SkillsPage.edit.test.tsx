// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useSkillsStore } from '@/stores/skills'
import { SkillsPage } from './SkillsPage'

vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
const container = document.createElement('div')
const root = createRoot(container)
const dir = '/agent/skills/visual-artifacts'
afterEach(() => {
  act(() => root.render(null))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(writable = true) {
  const invoke = vi
    .fn()
    .mockResolvedValue({ content: 'Original guidance', binary: false, size: 17 })
  vi.stubGlobal('phosphor', { invoke })
  vi.spyOn(useSkillsStore.getState(), 'refresh').mockResolvedValue(undefined)
  useSkillsStore.setState({
    tab: 'yours',
    selectedDir: dir,
    byWorkspace: {
      '/repo': {
        userRoot: '/agent/skills',
        probe: 'rpc',
        skills: [
          {
            name: 'visual-artifacts',
            description: 'Visuals',
            dir,
            scope: 'user',
            origin: 'top-level',
            source: 'auto',
            writable,
            borrowed: false,
            draft: false,
            files: [{ path: 'SKILL.md', size: 17 }],
            totalSize: 17,
            warnings: [],
          },
        ],
      },
    },
  })
  await act(async () => root.render(<SkillsPage workspacePath="/repo" />))
  return invoke
}
function button(text: string) {
  return [...container.querySelectorAll('button')].find((node) => node.textContent === text)!
}

it('edits user skill source, keeps failed edits and supports cancel without writing', async () => {
  const invoke = await render()
  await act(async () => button('source').click())
  await act(async () => button('Edit source').click())
  const editor = container.querySelector('textarea')!
  expect(editor.value).toBe('Original guidance')
  expect(button('← Skills').disabled).toBe(true)
  invoke.mockRejectedValueOnce(new Error('Read-only disk'))
  await act(async () => button('Save source').click())
  expect(invoke).toHaveBeenCalledWith(
    'skills:writeFile',
    dir,
    'SKILL.md',
    'Original guidance',
    '/repo',
  )
  expect(container.textContent).toContain('Read-only disk')
  expect(container.querySelector('textarea')).not.toBeNull()
  invoke.mockClear()
  await act(async () => button('Cancel edit').click())
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => button('Edit source').click())
  invoke.mockResolvedValue(undefined)
  await act(async () => button('Save source').click())
  expect(container.querySelector('textarea')).toBeNull()
  expect(useSkillsStore.getState().refresh).toHaveBeenCalledWith('/repo')
})

it('never offers source editing for package/foreign skills', async () => {
  await render(false)
  await act(async () => button('source').click())
  expect(button('Edit source')).toBeUndefined()
  expect(button('Delete')).toBeUndefined()
})

it('restores only on request and surfaces restore failures', async () => {
  const invoke = await render()
  await act(async () => button('← Skills').click())
  expect(invoke).not.toHaveBeenCalledWith('skills:restoreBundled')
  invoke.mockRejectedValueOnce(new Error('Missing shipped resource'))
  await act(async () => button('Restore artifact skill').click())
  expect(invoke).toHaveBeenCalledWith('skills:restoreBundled')
  expect(container.textContent).toContain('Missing shipped resource')
})
