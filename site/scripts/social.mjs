import { readFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import sharp from 'sharp'

const css = await readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
const token = (name) => {
  const value = css.match(new RegExp(`--px-${name}:\\s*([^;]+);`))?.[1]
  if (!value) throw new Error(`Missing token: ${name}`)
  return value
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${token('bg')}"/>
<g fill="none" stroke="${token('border')}"><path d="M60 100H1140M60 540H1140"/><rect x="780" y="165" width="360" height="310"/></g>
<g font-family="monospace" fill="${token('text-secondary')}" font-size="15"><text x="60" y="67">Phosphor</text><text x="60" y="583">BUILT BY ENGINEERS / FOR ENGINEERS</text><text x="780" y="583">pi + your extensions</text></g>
<g font-family="sans-serif" font-size="84" font-weight="500" letter-spacing="-5"><text x="55" y="275" fill="${token('text')}">Same agent.</text><text x="55" y="375" fill="${token('accent')}">Your surface.</text></g>
<text x="60" y="449" font-family="sans-serif" font-size="22" fill="${token('text-secondary')}">The desktop workspace for the pi coding agent.</text>
<g fill="${token('sidebar')}" stroke="${token('border-strong')}"><rect x="805" y="200" width="93" height="94"/><rect x="914" y="200" width="93" height="94"/><rect x="1023" y="200" width="93" height="94"/></g>
<g fill="${token('accent-soft')}" stroke="${token('border-strong')}"><rect x="815" y="212" width="20" height="70"/><rect x="841" y="212" width="47" height="70"/><rect x="924" y="212" width="73" height="33"/><rect x="924" y="252" width="73" height="30"/><rect x="1033" y="212" width="21" height="70"/><rect x="1060" y="212" width="46" height="70"/></g>
<path d="M850 294V332H960M1070 294V332H960M960 294V370" fill="none" stroke="${token('accent')}"/>
<rect x="805" y="370" width="310" height="65" fill="${token('bg')}" stroke="${token('accent')}"/>
<text x="960" y="411" text-anchor="middle" font-family="monospace" font-size="21" fill="${token('text')}">pi --mode rpc</text>
</svg>`
await sharp(Buffer.from(svg))
  .png()
  .toFile(new URL('../public/og.png', import.meta.url).pathname)
console.log('Generated public/og.png from the site tokens')
