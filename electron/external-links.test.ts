import { describe, it, expect } from 'vitest'
import { externalUrl, isAppNavigation } from './external-links'

describe('externalUrl', () => {
  it('passes http and https through, normalised', () => {
    expect(externalUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1')
    expect(externalUrl('http://localhost:3000')).toBe('http://localhost:3000/')
  })

  it('refuses every other scheme', () => {
    expect(externalUrl('file:///etc/passwd')).toBeNull()
    expect(externalUrl('pidex-artifact://x')).toBeNull()
    expect(externalUrl('javascript:alert(1)')).toBeNull()
    expect(externalUrl('mailto:a@b.com')).toBeNull()
    expect(externalUrl('docs/specs/x.md')).toBeNull()
    expect(externalUrl('')).toBeNull()
  })
})

describe('isAppNavigation', () => {
  const dev = 'http://localhost:5173/'
  const packaged = 'file:///Applications/pidex.app/Contents/Resources/app/renderer/index.html'

  it('allows the dev server reloading itself', () => {
    expect(isAppNavigation('http://localhost:5173/', dev)).toBe(true)
    expect(isAppNavigation('http://localhost:5173/index.html', dev)).toBe(true)
  })

  it('allows the packaged bundle to reload its own files', () => {
    expect(isAppNavigation(packaged, packaged)).toBe(true)
    expect(
      isAppNavigation(
        'file:///Applications/pidex.app/Contents/Resources/app/renderer/assets/x.js',
        packaged,
      ),
    ).toBe(true)
  })

  it('blocks a link leaving the app', () => {
    expect(isAppNavigation('https://github.com', dev)).toBe(false)
    expect(isAppNavigation('http://localhost:5174/', dev)).toBe(false)
    expect(isAppNavigation('https://github.com', packaged)).toBe(false)
  })

  it('blocks a file:// path outside the bundle', () => {
    expect(isAppNavigation('file:///etc/passwd', packaged)).toBe(false)
    expect(isAppNavigation('file:///Users/u/pidex/docs/x.md', packaged)).toBe(false)
    expect(isAppNavigation('file:///Users/u/secret.md', dev)).toBe(false)
  })

  it('is false when either URL is unparseable', () => {
    expect(isAppNavigation('not a url', dev)).toBe(false)
    expect(isAppNavigation(dev, '')).toBe(false)
  })
})
