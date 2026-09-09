#!/usr/bin/env node
/**
 * Regenerate the platform icon assets from build/icon.svg.
 *
 *   node scripts/generate-icons.mjs
 *
 * Renders the SVG with Playwright's bundled Chromium (already a
 * devDependency) so the rasterization matches what the renderer would
 * paint — no extra image tooling as a dependency. Produces:
 *
 *   build/icon.png     1024×1024 (linux; install.sh downloads this)
 *   build/icons/*.png  per-size linux set (electron-builder picks the best)
 *   build/icon.icns    macOS (via `iconutil`, so darwin-only)
 *   build/icon.ico     windows (via `npx png-to-ico`, network on first run)
 *   site/public/favicon.svg  a copy of icon.svg
 *
 * The favicon is written here rather than kept by hand because it WAS kept by
 * hand: it sat byte-identical to a superseded icon.svg with nothing comparing
 * the two, so a mark revision would regenerate eight platform binaries and
 * silently leave the browser tab on the old logo.
 *
 * macOS art is inset inside its canvas (MACOS_TILE_RATIO). icon.svg is a
 * full-bleed rounded tile, and macOS does NOT inset for you — shipping it
 * edge-to-edge made Phosphor render visibly larger than every neighbouring dock
 * icon. Apple's grid puts a rounded-rect app tile at ~80% of the canvas.
 *
 * Maintainer script — not part of the build; run it when the mark changes
 * and commit the regenerated binaries.
 */
import { chromium } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const tmp = join(buildDir, '.icon-tmp')
const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]

/**
 * Fraction of the canvas the tile occupies on macOS. Apple's icon grid sizes
 * a rounded-rect app tile at 824/1024 of the full canvas, the remainder being
 * transparent margin that the system relies on for optical alignment.
 */
const MACOS_TILE_RATIO = 824 / 1024

/** Render the mark at `size`, optionally inset to leave transparent margin. */
async function render(browser, size, inset) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  })
  const art = Math.round(size * inset)
  const pad = (size - art) / 2
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}` +
      `svg{display:block;width:${art}px;height:${art}px;` +
      `position:absolute;left:${pad}px;top:${pad}px}</style>${svg}`,
  )
  // omitBackground keeps the tile's rounded corners transparent.
  const png = await page.screenshot({ omitBackground: true })
  await page.close()
  return png
}

/** macOS iconset naming: logical size → [filename, pixel size]. */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const browser = await chromium.launch()
try {
  for (const size of SIZES) {
    // Full-bleed for linux/windows, inset for the macOS iconset.
    writeFileSync(join(tmp, `icon-${size}.png`), await render(browser, size, 1))
    writeFileSync(join(tmp, `mac-${size}.png`), await render(browser, size, MACOS_TILE_RATIO))
  }
} finally {
  await browser.close()
}

// linux / install.sh
copyFileSync(join(tmp, 'icon-1024.png'), join(buildDir, 'icon.png'))
console.log('✓ build/icon.png (1024)')

// linux icon set — electron-builder picks the closest size per context
// instead of downscaling the single 1024 for a 22px tray slot.
const iconsDir = join(buildDir, 'icons')
rmSync(iconsDir, { recursive: true, force: true })
mkdirSync(iconsDir, { recursive: true })
for (const size of SIZES.filter((s) => s >= 16 && s <= 512)) {
  copyFileSync(join(tmp, `icon-${size}.png`), join(iconsDir, `${size}x${size}.png`))
}
console.log('✓ build/icons/ (16-512)')

// Dev dock icon: main.ts feeds this to app.dock.setIcon in unpackaged runs.
// It needs the same inset as the .icns, or the dev dock icon renders visibly
// larger than its neighbours (the packaged app gets it from icon.icns).
copyFileSync(join(tmp, 'mac-1024.png'), join(buildDir, 'icon-dock.png'))
console.log('✓ build/icon-dock.png (inset, dev dock)')

// macOS
if (process.platform === 'darwin') {
  const iconset = join(tmp, 'icon.iconset')
  mkdirSync(iconset)
  for (const [name, px] of ICONSET) {
    copyFileSync(join(tmp, `mac-${px}.png`), join(iconset, name))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
  console.log('✓ build/icon.icns')
} else {
  console.log('– skipped icon.icns (iconutil is darwin-only)')
}

// windows
//
// The .ico container is written here rather than via `png-to-ico`, which
// silently dropped the 128 and 64 entries (the committed icon.ico had only
// 256/48/32/16, so Windows upscaled 48 into every mid-size slot). The format
// is a 6-byte header + 16 bytes per entry + the PNG payloads, and PNG-in-ICO
// is supported by every Windows version this app targets.
const ICO_SIZES = [256, 128, 64, 48, 32, 16]

const pngs = ICO_SIZES.map((size) => ({ size, data: readFileSync(join(tmp, `icon-${size}.png`)) }))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: 1 = icon
header.writeUInt16LE(pngs.length, 4)

let offset = 6 + 16 * pngs.length
const entries = pngs.map(({ size, data }) => {
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size // 0 means 256
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0 // palette colours
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // colour planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(data.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += data.length
  return entry
})

writeFileSync(
  buildDir + '/icon.ico',
  Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]),
)
console.log(`✓ build/icon.ico (${ICO_SIZES.join(', ')})`)

// site — the browser tab. A plain copy, so `git status` after a mark change
// shows the site asset alongside the binaries instead of hiding the drift.
copyFileSync(join(buildDir, 'icon.svg'), join(root, 'site', 'public', 'favicon.svg'))
console.log('✓ site/public/favicon.svg')

rmSync(tmp, { recursive: true, force: true })
