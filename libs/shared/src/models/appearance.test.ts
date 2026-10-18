import { expect, expectTypeOf, it } from 'vitest'
import {
  clampUiScale,
  DEFAULT_FONT_PREFS,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  type ThemePreference,
} from './appearance'

it('appearance keeps font defaults and theme choices', () => {
  expect(DEFAULT_FONT_PREFS).toEqual({
    uiScale: 1,
    chatFontSize: 14.5,
    editorFontSize: 12.5,
    terminalFontSize: 12.5,
    monoFont: 'JetBrains Mono',
  })
  expectTypeOf<ThemePreference>().toEqualTypeOf<'light' | 'dark' | 'system'>()
})

it.each([
  [-Infinity, 1],
  [NaN, 1],
  [Infinity, 1],
  [0, 0.7],
  [0.7, 0.7],
  [1.456, 1.456],
  [2, 2],
  [20, 2],
])('clampUiScale(%s) is %s', (input, expected) => {
  expect(UI_SCALE_MIN).toBe(0.7)
  expect(UI_SCALE_MAX).toBe(2)
  expect(clampUiScale(input)).toBe(expected)
})
