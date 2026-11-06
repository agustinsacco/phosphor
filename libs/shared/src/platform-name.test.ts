import { expect, it } from 'vitest'
import { platformName } from './platform-name'

it('names a platform in words, and keeps one it does not know', () => {
  expect(platformName('darwin')).toBe('macOS')
  expect(platformName('win32')).toBe('Windows')
  expect(platformName('linux')).toBe('Linux')
  expect(platformName('freebsd')).toBe('freebsd')
})
