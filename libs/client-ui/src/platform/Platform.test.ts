import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { desktopPlatform, usePlatform } from './Platform'
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
  const DESKTOP_PLATFORM = desktopPlatform(true, false)
  expect(differing(DESKTOP_PLATFORM, WIDE_BROWSER_PLATFORM)).toEqual([
    'appInfo',
    'appShortcuts',
    'cancelSignIn',
    'feedback',
    'fileEditing',
    'hostTrafficLog',
    'installableApp',
    'localBrain',
    'localLanes',
    'localVoice',
    'nativeFiles',
    'nativeImageClipboard',
    'notificationPermission',
    'pageZoom',
    'savedFontPrefs',
    'scriptedArtifacts',
    'splitPanes',
    'writingAssist',
  ])
})

it('does not grant Brain by default', () => {
  expect(DESKTOP_PLATFORM.localBrain).toBe(false)
  expect(COMPACT_PLATFORM.localBrain).toBe(false)
  expect(WIDE_BROWSER_PLATFORM.localBrain).toBe(false)
})

it('does not grant Brain when there is no platform provider', () => {
  const Capability = () => String(usePlatform().localBrain)
  expect(renderToStaticMarkup(createElement(Capability))).toBe('false')
})

it.each([
  [false, false, false],
  [true, false, true],
  [false, true, true],
  [true, true, true],
])('exposes Desktop Brain by enabled (%s) or preview (%s) state', (enabled, preview, visible) => {
  expect(desktopPlatform).toBeTypeOf('function')
  expect(desktopPlatform(enabled, preview).localBrain).toBe(visible)
})
