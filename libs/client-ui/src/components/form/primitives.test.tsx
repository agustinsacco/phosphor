// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Row, SaveStatus, Segmented, Select, SettingsNotice, SourceBadge } from '.'

const CHIP_CLASSES = ['rounded-full', 'px-1.5', 'py-0.5', 'text-2xs', 'font-medium']

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (node: React.ReactNode): void => act(() => root.render(node))
const SCOPES = [
  { value: 'machine', label: 'Machine' },
  { value: 'folder', label: 'Folder' },
  { value: 'other', label: 'Other', disabled: true },
] as const
const radios = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
]
const key = (target: Element, name: string): void =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })

describe('Select', () => {
  it('is a native select named by its Row and reports the chosen value', () => {
    const onChange = vi.fn()
    render(
      <Row title="Mono font">
        <Select
          value="Menlo"
          options={[
            { value: 'Menlo', label: 'Menlo' },
            { value: 'Fira Code', label: 'Fira Code' },
          ]}
          onChange={onChange}
        />
      </Row>,
    )
    const select = container.querySelector('select')!
    expect(select.getAttribute('aria-label')).toBe('Mono font')
    act(() => {
      select.value = 'Fira Code'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('Fira Code')
  })

  it('prefers an explicit label', () => {
    render(
      <Select
        label="Configure"
        value="a"
        options={[{ value: 'a', label: 'A' }]}
        onChange={vi.fn()}
      />,
    )
    expect(container.querySelector('select')!.getAttribute('aria-label')).toBe('Configure')
  })
})

describe('Segmented', () => {
  it('is a radio group with one tab stop on the checked option', () => {
    render(<Segmented label="Scope" value="folder" options={SCOPES} onChange={vi.fn()} />)
    const group = container.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Scope')
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    expect(radios()[2]!.disabled).toBe(true)
  })

  it('moves the choice and focus with arrow keys, skipping disabled options', () => {
    const onChange = vi.fn()
    render(<Segmented label="Scope" value="machine" options={SCOPES} onChange={onChange} />)
    radios()[0]!.focus()
    key(radios()[0]!, 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('folder')
    expect(document.activeElement).toBe(radios()[1])
    key(radios()[1]!, 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('machine')
    key(radios()[0]!, 'ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('folder')
    key(radios()[0]!, 'End')
    expect(onChange).toHaveBeenLastCalledWith('folder')
  })

  it('selects on click and takes its name from its Row', () => {
    const onChange = vi.fn()
    render(
      <Row title="Theme">
        <Segmented value="machine" options={SCOPES} onChange={onChange} />
      </Row>,
    )
    expect(container.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Theme')
    act(() => radios()[1]!.click())
    expect(onChange).toHaveBeenCalledWith('folder')
  })
})

describe('SettingsNotice', () => {
  it('announces danger, renders its body and runs its action', () => {
    const onClick = vi.fn()
    render(
      <SettingsNotice
        tone="danger"
        title="Host offline"
        body="Restart it."
        action={{ label: 'Reconnect', onClick }}
      />,
    )
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Host offline')
    expect(container.textContent).toContain('Restart it.')
    act(() => container.querySelector('button')!.click())
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('is not an alert below danger, and shows the busy label while busy', () => {
    render(
      <SettingsNotice
        tone="info"
        title="Configuration access is not enabled"
        action={{ label: 'Enable', busyLabel: 'Enabling…', busy: true, onClick: vi.fn() }}
      />,
    )
    expect(container.querySelector('[role="alert"]')).toBeNull()
    const button = container.querySelector('button')!
    expect(button.textContent).toBe('Enabling…')
    expect(button.disabled).toBe(true)
  })
})

describe('SourceBadge', () => {
  it.each([
    ['set-here', 'Set here'],
    ['inherited', 'Inherited from machine'],
    ['pi-default', 'pi default'],
  ] as const)('labels %s', (source, label) => {
    render(<SourceBadge source={source} />)
    expect(container.textContent).toBe(label)
  })

  it('is a small rounded chip in its source colours', () => {
    render(<SourceBadge source="set-here" />)
    const chip = container.querySelector('[data-setting-source="set-here"]')!
    for (const name of CHIP_CLASSES.concat('bg-accent-soft', 'text-accent'))
      expect(chip.classList).toContain(name)
  })
})

describe('SaveStatus', () => {
  it('renders nothing when idle and a status line while saving or saved', () => {
    render(<SaveStatus state={{ status: 'idle' }} />)
    expect(container.innerHTML).toBe('')
    render(<SaveStatus state={{ status: 'saving', message: 'Saving on bee1…' }} />)
    expect(container.querySelector('[role="status"]')!.textContent).toBe('Saving on bee1…')
    render(<SaveStatus state={{ status: 'saved' }} />)
    expect(container.textContent).toBe('Saved')
  })

  it('offers retry and discard for a failed save, and only what is given for a refusal', () => {
    const retry = vi.fn()
    const discard = vi.fn()
    render(<SaveStatus state={{ status: 'error', message: 'Host is busy', retry, discard }} />)
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Host is busy')
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Try again', 'Discard changes'])
    act(() => buttons[0]!.click())
    act(() => buttons[1]!.click())
    expect(retry).toHaveBeenCalledOnce()
    expect(discard).toHaveBeenCalledOnce()
    render(<SaveStatus state={{ status: 'refused', discard }} />)
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Discard changes',
    ])
  })
})
