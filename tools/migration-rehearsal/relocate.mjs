import { readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** JSON-escaped, so a recorded path matches inside any string of the file. */
const escaped = (path) => JSON.stringify(path).slice(1, -1)

/**
 * Desktop records absolute paths in its prefs and archive records. Point the scratch
 * copies at scratch, as the real migration sees them at home; the source is never
 * opened for writing. `recorded` is where the files say the data lives.
 */
export async function relocate(root, roots, recorded) {
  const real = await realpath(root)
  /** @type {[string, string][]} */
  const pairs = [
    [escaped(`${recorded.agent}/`), escaped(`${real}/agent/`)],
    [escaped(`${recorded.userData}/`), escaped(`${real}/user-data/`)],
  ]
  const archive = join(roots.userData, 'lane-archive')
  const names = await readdir(archive).catch((err) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const files = [
    join(roots.userData, 'config.json'),
    ...names.filter((n) => n.endsWith('.json')).map((n) => join(archive, n)),
  ]
  let rewritten = 0
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (text === null) continue
    const next = pairs.reduce((s, [from, to]) => s.split(from).join(to), text)
    if (next === text) continue
    JSON.parse(next)
    await writeFile(file, next, { mode: 0o600 })
    rewritten++
  }
  return rewritten
}
