#!/usr/bin/env node
/**
 * Turn the raw captures in site/shots-raw (written by
 * `OUT_DIR=site/shots-raw MAX_WIDTH=0 node scripts/capture-live-shots.mjs`
 * from the repo root) into the committed WebP sources in src/assets/shots.
 *
 * Raw PNGs are 2x device-scale (2880×1840 on a retina display) and ~500 KB
 * each; WebP at q=90 keeps the UI text crisp at a third of the size, and
 * Astro's <Image> derives every responsive width from these at build time.
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawDir = join(site, 'shots-raw')
const outDir = join(site, 'src', 'assets', 'shots')

await mkdir(outDir, { recursive: true })
const files = (await readdir(rawDir)).filter((f) => extname(f) === '.png').sort()
if (files.length === 0) {
  console.error(`no .png captures in ${rawDir}`)
  process.exit(1)
}
for (const f of files) {
  const name = basename(f, '.png')
  const out = join(outDir, `${name}.webp`)
  const info = await sharp(join(rawDir, f)).webp({ quality: 90, effort: 6 }).toFile(out)
  console.log(`  ✓ ${name}.webp  ${info.width}×${info.height}  ${Math.round(info.size / 1024)} KB`)
}
