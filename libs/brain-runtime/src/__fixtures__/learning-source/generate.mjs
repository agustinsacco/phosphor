// Offline only: re-project the synthetic entries with the explicitly supplied pi installation.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { URL, pathToFileURL } from 'node:url'
import process from 'node:process'

if (!process.argv[2]) throw new Error('Pass the pi-coding-agent package directory')
const root = resolve(process.argv[2])
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (version !== '1.4.0')
  throw new Error('Review projection changes before updating the pinned pi version')
const { buildSessionProjection } = await import(
  pathToFileURL(join(root, 'dist/core/session-manager.js')).href
)
const { convertToLlm } = await import(pathToFileURL(join(root, 'dist/core/messages.js')).href)
const file = new URL('./pi-1.4-projection.json', import.meta.url)
const fixture = JSON.parse(await readFile(file, 'utf8'))
fixture.projection = buildSessionProjection(fixture.entries, fixture.leafId)
fixture.wireByEntry = fixture.projection.entries.map((entry) => convertToLlm(entry.messages))
await writeFile(file, JSON.stringify(fixture, null, 2) + '\n')
