// Where the Host build writes. It replaces only an empty folder or an earlier
// build, builds in a fresh folder beside it, and puts that in place with a
// rollback, so a failure leaves the output as it was.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const INFO = 'BUILD-INFO.json'

/**
 * Why `dir` may not be replaced, or null. It may be when it does not exist,
 * is empty, or is an earlier build: a real folder whose BUILD-INFO.json, a
 * regular file, is this Host's manifest and lists every other file in it.
 * A link anywhere in it is refused.
 */
export function replaceRefusal(dir) {
  if (!existsSync(dir)) return null
  if (!lstatSync(dir).isDirectory()) return 'is not a folder'
  const entries = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  if (entries.length === 0) return null
  const link = entries.find((entry) => lstatSync(join(dir, entry)).isSymbolicLink())
  if (link !== undefined) return `holds a link, ${link}`
  const marker = join(dir, INFO)
  if (!existsSync(marker) || !lstatSync(marker).isFile()) return `holds no ${INFO} file`
  let listed
  try {
    const manifest = JSON.parse(readFileSync(marker, 'utf8'))
    if (manifest.schema !== 1 || manifest.name !== 'phosphor' || !Array.isArray(manifest.files)) {
      return `holds a ${INFO} that is not this Host's`
    }
    listed = new Set(manifest.files.map((file) => file.path))
  } catch {
    return `holds a ${INFO} that is not JSON`
  }
  const unlisted = entries.find(
    (entry) => entry !== INFO && lstatSync(join(dir, entry)).isFile() && !listed.has(entry),
  )
  return unlisted === undefined ? null : `holds ${unlisted}, which its ${INFO} does not list`
}

/**
 * Run `work` on a fresh folder beside `out`, a sibling so that relative
 * paths and the final rename hold, then put that folder at `out`. The
 * earlier output is moved aside first, moved back if the new one cannot
 * take its place, and deleted only once it has. Any failure removes the
 * fresh folder, the only thing this removes on a failure, and leaves `out`
 * as it was. A build killed outright can leave a `.phosphor-build-*` folder.
 * `fs` is for tests. Returns what `work` returned, and the earlier output's
 * folder if it could not be deleted.
 */
export async function buildInto(out, work, fs = { renameSync, rmSync }) {
  const refusal = replaceRefusal(out)
  if (refusal) throw new Error(`${out} ${refusal}: refusing to replace it`)
  mkdirSync(dirname(out), { recursive: true })
  const stage = mkdtempSync(join(dirname(out), '.phosphor-build-'))
  const aside = `${stage}-previous`
  let value
  try {
    value = await work(stage)
    // Checked again: the folder may have changed while the build ran.
    const late = replaceRefusal(out)
    if (late) throw new Error(`${out} ${late}: refusing to replace it`)
    if (existsSync(out)) fs.renameSync(out, aside)
    try {
      fs.renameSync(stage, out)
    } catch (error) {
      if (existsSync(aside)) restore(aside, out, error, fs)
      throw error
    }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
  if (!existsSync(aside)) return { value, kept: null }
  try {
    fs.rmSync(aside, { recursive: true, force: true })
    return { value, kept: null }
  } catch {
    return { value, kept: aside }
  }
}

function restore(aside, out, cause, fs) {
  try {
    fs.renameSync(aside, out)
  } catch {
    const why = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${why}; the earlier build could not be put back and is at ${aside}`, {
      cause,
    })
  }
}
