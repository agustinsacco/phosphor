// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { staticArtifactPreview } from './preview'
it('returns script-free opaque content without authored attributes, URLs or network access', () => {
  const url = staticArtifactPreview(
    '<h1 onclick="attack()">Static</h1><script>attack()</script><style>@import "https://evil.invalid";</style><iframe src="https://evil.invalid"></iframe><img src="https://evil.invalid"><a href="javascript:attack()">label</a><svg onload="attack()"></svg><meta http-equiv="refresh" content="0;url=https://evil.invalid"><p style="background:url(https://evil.invalid)">safe</p>',
  )
  expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
  const html = decodeURIComponent(url.split(',')[1]!)
  expect(html).toContain('<h1>Static</h1>')
  expect(html).toContain("script-src 'none'; connect-src 'none'")
  expect(html).not.toMatch(
    /attack|evil\.invalid|<script|<iframe|<svg|onclick|allow-same-origin|http-equiv="refresh"/,
  )
})
it('bounds source and nesting depth', () => {
  expect(() => staticArtifactPreview('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('large')
  expect(() => staticArtifactPreview('<div>'.repeat(110) + 'text' + '</div>'.repeat(110))).toThrow(
    'complex',
  )
})
