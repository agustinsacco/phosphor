#!/usr/bin/env node
/** Import real PNG captures from site/shots-raw into the canonical site assets. */
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

export async function importShots(rawDir, outDir) {
  const files = (await readdir(rawDir)).filter((file) => extname(file) === '.png').sort()
  if (files.length === 0) throw new Error(`No .png captures in ${rawDir}`)
  await mkdir(outDir, { recursive: true })
  for (const file of files) {
    const name = basename(file, '.png')
    // The centrepiece remains the original PNG. Astro derives display sizes;
    // don't silently replace it with a recompressed or differently named session.
    if (name === 'ide-flex') {
      await copyFile(join(rawDir, file), join(outDir, file))
      console.log(`  ✓ ${file} — original preserved`)
      continue
    }
    const out = join(outDir, `${name}.webp`)
    const info = await sharp(join(rawDir, file)).webp({ quality: 90, effort: 6 }).toFile(out)
    console.log(
      `  ✓ ${name}.webp  ${info.width}×${info.height}  ${Math.round(info.size / 1024)} KB`,
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = join(dirname(fileURLToPath(import.meta.url)), '..')
  await importShots(join(site, 'shots-raw'), join(site, 'src', 'assets', 'shots'))
}
