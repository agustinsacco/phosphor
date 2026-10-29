import { expect, it } from 'vitest'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  WIDE_BROWSER_PLATFORM,
  type Platform,
} from './Platform'

const differing = (a: Platform, b: Platform): string[] =>
  (Object.keys(a) as (keyof Platform)[]).filter((key) => a[key] !== b[key]).sort()

/* A phone and a wide browser are one client at two widths: the same capabilities,
 * so the same features. Only primitives and shells read the form factor. */
it('the phone and the wide browser differ only in form factor', () => {
  expect(differing(COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM)).toEqual(['formFactor'])
  expect(COMPACT_PLATFORM.formFactor).toBe('compact')
  expect(WIDE_BROWSER_PLATFORM.formFactor).toBe('expanded')
})

/* Every Desktop/browser difference is a declared capability; a new one must be added here. */
it('Desktop and the browser differ only in the capabilities each declares', () => {
  expect(differing(DESKTOP_PLATFORM, WIDE_BROWSER_PLATFORM)).toEqual([
    'appInfo',
    'appShortcuts',
    'cancelSignIn',
    'feedback',
    'fileEditing',
    'installableApp',
    'localLanes',
    'nativeFiles',
    'pageZoom',
    'savedFontPrefs',
    'scriptedArtifacts',
    'splitPanes',
    'writingAssist',
  ])
})
