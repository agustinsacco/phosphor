/**
 * Skill sharing on disk, the one home for Desktop and the Host. Reading collects a bundle
 * folder into a bounded SkillBundle; installing writes one into a skills root through a
 * private staging folder, so a target never holds half a skill.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  isSkippedSkillFolder,
  isShareablePath,
  isShareableSkillName,
  SKILL_SHARE_LIMITS,
  type SkillBundle,
  type SkillBundleFile,
  type SkillInstallResult,
} from '@phosphor/shared/host-protocol-skill-share'

export class SkillShareError extends Error {
  constructor(
    readonly code: 'too-large' | 'invalid',
    message: string,
  ) {
    super(message)
  }
}

async function readFileBytes(path: string, left: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new SkillShareError('invalid', 'Skill files must be regular files.')
    if (info.size > SKILL_SHARE_LIMITS.fileBytes || info.size > left)
      throw new SkillShareError('too-large', 'This skill is too large to share.')
    const bytes = Buffer.alloc(info.size)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

/**
 * Collect the bundle at `dir` (which must hold SKILL.md). Symbolic links, dot folders,
 * `node_modules` and provenance sidecars stay behind; any limit overrun fails the whole read.
 */
export async function readSkillBundle(dir: string, name: string): Promise<SkillBundle> {
  if (!isShareableSkillName(name)) throw new SkillShareError('invalid', 'Invalid skill name.')
  const root = await realpath(dir)
  // Checked first: a loose Markdown skill's folder is a whole skills root, never walked.
  const manifest = await lstat(join(root, 'SKILL.md')).catch(() => null)
  if (!manifest?.isFile())
    throw new SkillShareError('invalid', 'Only skill folders with a SKILL.md can be shared.')
  const files: SkillBundleFile[] = []
  let total = 0
  const walk = async (folder: string): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    // Files before folders, so SKILL.md leads its bundle.
    for (const entry of entries) {
      const path = join(folder, entry.name)
      const rel = relative(root, path).split(sep).join('/')
      if (!entry.isFile() || !isShareablePath(rel)) continue
      if (files.length >= SKILL_SHARE_LIMITS.files)
        throw new SkillShareError('too-large', 'This skill has too many files to share.')
      const bytes = await readFileBytes(path, SKILL_SHARE_LIMITS.totalBytes - total)
      total += bytes.length
      files.push({ path: rel, data: bytes.toString('base64') })
    }
    for (const entry of entries)
      if (entry.isDirectory() && !isSkippedSkillFolder(entry.name))
        await walk(join(folder, entry.name))
  }
  await walk(root)
  return { name, files }
}

/**
 * Whether a skill the machine already resolves for `name`, from `file`, comes from somewhere
 * other than `<root>/<name>`: then an install there would not replace it. A skill whose file
 * is unknown or unreadable counts as elsewhere.
 */
export async function resolvesElsewhere(
  root: string,
  name: string,
  file: string | undefined,
): Promise<boolean> {
  if (!file) return true
  try {
    const rel = relative(await realpath(join(root, name)), await realpath(file))
    return rel === '' || rel.startsWith('..') || isAbsolute(rel)
  } catch {
    return true
  }
}

const code = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined

/** What already sits at `<root>/<name>`: nothing, a skill folder, or something to leave alone. */
async function existing(target: string): Promise<'none' | 'folder' | 'other'> {
  try {
    const info = await lstat(target)
    return info.isDirectory() ? 'folder' : 'other'
  } catch (error) {
    if (code(error) === 'ENOENT') return 'none'
    throw error
  }
}

async function stage(root: string, bundle: SkillBundle): Promise<string> {
  const staging = join(root, `${STAGING}${randomUUID()}`)
  await mkdir(staging)
  try {
    for (const file of bundle.files) {
      if (!isShareablePath(file.path)) throw new SkillShareError('invalid', 'Invalid skill file.')
      const target = join(staging, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      )
      try {
        await handle.writeFile(Buffer.from(file.data, 'base64'))
      } finally {
        await handle.close()
      }
    }
    return staging
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

const STAGING = '.phosphor-share-'
const ASIDE = '.phosphor-replaced-'
/** A leftover younger than this may belong to an install still running in another process. */
const LEFTOVER_AGE_MS = 10 * 60_000
const UUID_SUFFIX = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Undo what a crashed install left in `root`: staging is removed, and a skill moved aside for
 * a replace goes back when nothing took its place (otherwise the aside copy is removed).
 * Best-effort: a sweep never fails an install.
 */
async function sweepLeftovers(root: string, now: number): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  for (const entry of names) {
    if (!entry.startsWith(STAGING) && !entry.startsWith(ASIDE)) continue
    const path = join(root, entry)
    try {
      const info = await lstat(path)
      // ctime, not mtime: renaming a folder aside changes its ctime only.
      if (!info.isDirectory() || now - info.ctimeMs < LEFTOVER_AGE_MS) continue
      const name = entry.startsWith(ASIDE) ? entry.slice(ASIDE.length).replace(UUID_SUFFIX, '') : ''
      if (isShareableSkillName(name) && (await existing(join(root, name))) === 'none')
        await rename(path, join(root, name))
      else await rm(path, { recursive: true, force: true })
    } catch {
      // Left for the next install.
    }
  }
}

/**
 * Install a parsed bundle as `<root>/<name>`. `elsewhere` reports that the machine already
 * resolves a skill with this name from some other place (a package, another folder): that
 * blocks the write even with `overwrite`, because replacing the folder would not replace it.
 */
export async function installSkillBundle(options: {
  root: string
  bundle: SkillBundle
  overwrite: boolean
  elsewhere: boolean
  /** Tests only: the clock leftovers are aged against. */
  now?: () => number
}): Promise<SkillInstallResult> {
  const { bundle } = options
  if (!isShareableSkillName(bundle.name)) throw new SkillShareError('invalid', 'Invalid name.')
  await mkdir(options.root, { recursive: true })
  const root = await realpath(options.root)
  await sweepLeftovers(root, (options.now ?? Date.now)())
  const target = join(root, bundle.name)
  const before = await existing(target)
  if (options.elsewhere || before === 'other') return { status: 'conflict', replaceable: false }
  if (before === 'folder' && !options.overwrite) return { status: 'conflict', replaceable: true }
  const staging = await stage(root, bundle)
  const aside = join(root, `${ASIDE}${bundle.name}-${randomUUID()}`)
  try {
    if (before === 'folder') await rename(target, aside)
    try {
      await rename(staging, target)
    } catch (error) {
      if (before === 'folder') await rename(aside, target)
      if (code(error) === 'EEXIST' || code(error) === 'ENOTEMPTY')
        return { status: 'conflict', replaceable: true }
      throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  // The copy is in place; an aside folder that will not go is swept by a later install.
  if (before === 'folder') await rm(aside, { recursive: true, force: true }).catch(() => undefined)
  return { status: 'installed', replaced: before === 'folder' }
}
