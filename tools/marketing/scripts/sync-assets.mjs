/* global console, process */
// Fills each film's git-ignored assets/ from the things that own them: the shared look in
// shared/, the site's font files, the generated favicon, and the product captures. Nothing here
// is a second copy in git, so a film cannot drift from the site it is shown on.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repo = resolve(root, '../..')
export const manifest = JSON.parse(readFileSync(join(root, 'films.json'), 'utf8'))

const shared = ['film.css', 'kit.js', 'cursor.svg']
const fonts = ['InterVariable.woff2', 'JetBrainsMono.ttf']

/** Captures default to the repository's own; PHOSPHOR_FILM_PLATES points at another checkout. */
export function platesDirectory() {
  return resolve(process.env.PHOSPHOR_FILM_PLATES ?? join(repo, 'docs/img'))
}

function copy(from, to) {
  if (!existsSync(from)) throw new Error(`Missing film input: ${from}`)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

export function syncAssets() {
  const plates = platesDirectory()
  for (const film of manifest.films) {
    const assets = join(root, 'films', film.id, 'assets')
    rmSync(assets, { recursive: true, force: true })
    for (const file of shared) copy(join(root, 'shared', file), join(assets, file))
    for (const file of fonts)
      copy(join(repo, 'apps/site/public/fonts', file), join(assets, 'fonts', file))
    copy(join(repo, 'apps/site/public/favicon.svg'), join(assets, 'mark.svg'))
    for (const plate of film.plates)
      copy(join(plates, `${plate}.png`), join(assets, 'shots', `${plate}.png`))
  }
  return plates
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`Synced film assets; plates from ${syncAssets()}`)
