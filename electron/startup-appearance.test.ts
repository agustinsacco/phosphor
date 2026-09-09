// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyStartupAppearance } from './startup-appearance'

afterEach(() => {
  document.documentElement.className = ''
  document.documentElement.style.colorScheme = ''
  vi.unstubAllGlobals()
})

it.each([
  ['light', true, false],
  ['light', false, false],
  ['dark', false, true],
  ['dark', true, true],
  ['system', false, false],
  ['system', true, true],
  ['invalid', false, true],
])('applies %s with OS dark=%s before hydration', (theme, systemDark, expectedDark) => {
  vi.stubGlobal('matchMedia', () => ({ matches: systemDark }))
  applyStartupAppearance([`--phosphor-theme=${theme}`])
  expect(document.documentElement.classList.contains('dark')).toBe(expectedDark)
  expect(document.documentElement.style.colorScheme).toBe(expectedDark ? 'dark' : 'light')
})

it('applies when the parser creates html, then leaves later appearance changes alone', async () => {
  const html = document.documentElement
  html.remove()
  try {
    applyStartupAppearance(['--phosphor-theme=dark'])
    document.append(html)
    await Promise.resolve()
    expect(html.classList.contains('dark')).toBe(true)
    html.classList.remove('dark')
    document.append(document.createComment('later parsing'))
    await Promise.resolve()
    expect(html.classList.contains('dark')).toBe(false)
  } finally {
    if (!document.documentElement) document.append(html)
  }
})
