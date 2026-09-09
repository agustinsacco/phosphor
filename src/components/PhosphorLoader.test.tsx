// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PhosphorLoader } from './PhosphorLoader'

function render(props: React.ComponentProps<typeof PhosphorLoader> = {}): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<PhosphorLoader {...props} />)
  return host.firstElementChild as HTMLElement
}

it('names a standalone indeterminate indicator without inventing progress', () => {
  const mark = render({ label: 'Waiting for a response' })
  expect(mark.getAttribute('role')).toBe('img')
  expect(mark.getAttribute('aria-label')).toBe('Waiting for a response')
  expect(mark.hasAttribute('aria-valuenow')).toBe(false)
  expect(mark.dataset.animated).toBe('true')
})

it('does not repeat adjacent status copy to assistive technology', () => {
  const mark = render({ decorative: true })
  expect(mark.getAttribute('aria-hidden')).toBe('true')
  expect(mark.hasAttribute('role')).toBe(false)
  expect(mark.hasAttribute('aria-label')).toBe(false)
})

it.each([20, 24, 80])('keeps the same beacon geometry at %ipx', (size) => {
  const mark = render({ size, animated: false })
  expect(mark.style.width).toBe(`${size}px`)
  expect(mark.style.height).toBe(`${size}px`)
  expect(mark.dataset.animated).toBe('false')
  expect(mark.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 32 32')
  expect(mark.querySelector('.phosphor-loader-core')).not.toBeNull()
  expect(mark.querySelector('.phosphor-loader-orbit')).not.toBeNull()
})
