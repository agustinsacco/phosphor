import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BEACON, BEACON_OPACITY, ICON_SCALE } from './PhosphorMark'

/**
 * The app icon and the in-app mark are one drawing at two scales, and nothing
 * about SVG enforces that. The mark this replaced shipped as two different
 * drawings — `build/icon.svg` had bare shells while the website added animated
 * electrons — for as long as it existed, because the only thing keeping them
 * in step was remembering to.
 *
 * So: `BEACON` is the source of truth and this reads the committed SVG back.
 * If you retune the glyph, run `node scripts/generate-icons.mjs` and commit
 * `build/icon.svg` with it — that is what this failing is telling you.
 */
const repoFile = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8')
const icon = repoFile('build/icon.svg')

type El = Record<string, string>

/** Every `<tag …>` in the icon, as attribute maps. */
function elements(svg: string, tag: string): El[] {
  return [...svg.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...(m[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])),
  )
}

/** Indexing into a match list yields `T | undefined` under strict null checks,
 *  and a bare `!` would report "expected undefined" instead of what is wrong. */
function at(list: El[], i: number, what: string): El {
  const el = list[i]
  if (!el) throw new Error(`build/icon.svg has no ${what} (element ${i} of ${list.length})`)
  return el
}

const num = (el: El, attr: string): number => Number(el[attr])

// The tile is a <rect>; every <circle> belongs to the mark except the bloom,
// which is the only one filled with a gradient.
const circles = elements(icon, 'circle').filter((c) => c.fill !== 'url(#bloom)')

describe('build/icon.svg tracks the BeaconGlyph geometry', () => {
  it('draws exactly the four circles the glyph has', () => {
    expect(circles).toHaveLength(4)
  })

  it.each([
    ['outer shell', 0, BEACON.shellR, BEACON.shellStroke, BEACON_OPACITY.shell],
    ['inner shell', 1, BEACON.innerR, BEACON.innerStroke, BEACON_OPACITY.inner],
  ])('%s matches BEACON', (name, index, r, stroke, opacity) => {
    const el = at(circles, index, name)
    expect(num(el, 'r')).toBe(r * ICON_SCALE)
    expect(num(el, 'stroke-width')).toBe(stroke * ICON_SCALE)
    expect(num(el, 'opacity')).toBe(opacity)
  })

  it('nucleus and orbit head match BEACON', () => {
    expect(num(at(circles, 2, 'nucleus'), 'r')).toBe(BEACON.coreR * ICON_SCALE)
    expect(num(at(circles, 3, 'orbit head'), 'r')).toBe(BEACON.headR * ICON_SCALE)
  })

  it('the orbit rides the outer shell at the glyph stroke weight', () => {
    const orbit = at(elements(icon, 'path'), 0, 'orbit arc')
    expect(num(orbit, 'stroke-width')).toBe(BEACON.orbitStroke * ICON_SCALE)
    // Arc radius, from `A<r> <r> …` — the orbit must sit ON the outer shell.
    const arcR = /A(\d+(?:\.\d+)?)\s/.exec(orbit.d ?? '')?.[1]
    expect(Number(arcR)).toBe(BEACON.shellR * ICON_SCALE)
  })

  it('keeps the shells faint and the nucleus, orbit and head full strength', () => {
    // Inverting this is what made the previous mark's concept invisible.
    expect(BEACON_OPACITY.shell).toBeLessThan(0.5)
    expect(BEACON_OPACITY.inner).toBeLessThan(BEACON_OPACITY.shell)
    expect(at(circles, 2, 'nucleus').opacity).toBeUndefined()
    expect(at(circles, 3, 'orbit head').opacity).toBeUndefined()
  })

  it('scales to whole numbers, so the SVG holds nothing rounded', () => {
    // BEACON is lengths only, which is what makes this assertable at all —
    // opacities live in BEACON_OPACITY precisely because they do not scale.
    for (const [k, v] of Object.entries(BEACON)) {
      expect({ [k]: Number.isInteger(v * ICON_SCALE) }).toEqual({ [k]: true })
    }
  })
})

describe('site and app cannot drift apart', () => {
  it('the favicon is generated from icon.svg, not hand-kept', () => {
    expect(repoFile('site/public/favicon.svg')).toBe(icon)
  })

  /**
   * The site draws the mark by pointing an <img> at the generated favicon
   * rather than by inlining its own copy — so the check that matters is that
   * it keeps doing that. A hand-drawn `<svg>` in the layout is exactly how the
   * previous mark ended up as two different drawings.
   */
  it('the site layout consumes the generated favicon and inlines no mark of its own', () => {
    const layout = repoFile('site/src/layouts/Page.astro')
    expect(layout).toContain('/favicon.svg')
    expect(layout).not.toMatch(/<svg/)
  })
})
