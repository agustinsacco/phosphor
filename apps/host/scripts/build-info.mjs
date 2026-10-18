// BUILD-INFO.json: the build's version and source stamp, its Node target and
// entry, and every file it wrote, sorted by path, with its size and sha256.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_TARGET, OUTFILE } from './build-bundle.mjs'
import { INFO } from './output.mjs'

/** Every file under `dir`, sorted by path, with its size and sha256. */
export function listFiles(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => statSync(join(dir, file)).isFile())
    .sort()
    .map((file) => {
      const bytes = readFileSync(join(dir, file))
      return {
        path: file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    })
}

/** The release version, else 0.0.0-dev. and the commit's first 7 digits, or `source`. */
export function buildVersion(stamped, releaseVersion) {
  return releaseVersion ?? `0.0.0-dev.${stamped?.slice(0, 7) ?? 'source'}`
}

/**
 * Whether the tree differs from the stamped commit by `git status`, or null
 * when nothing is stamped. A release ignores untracked files. A status that
 * failed, null from `git`, counts as dirty.
 */
export function sourceDirty(stamped, releaseVersion, git) {
  if (!stamped) return null
  const untracked = releaseVersion === undefined ? [] : ['--untracked-files=no']
  return git('status', '--porcelain', ...untracked) !== ''
}

/**
 * Write BUILD-INFO.json into `stage`, listing every file already in it, and
 * return it. `git` runs git in the source root.
 */
export function writeBuildInfo(stage, { stamped, releaseVersion, git }) {
  const files = listFiles(stage)
  const info = {
    schema: 1,
    name: 'phosphor',
    version: buildVersion(stamped, releaseVersion),
    sourceSha: stamped,
    sourceDirty: sourceDirty(stamped, releaseVersion, git),
    nodeTarget: NODE_TARGET,
    entry: OUTFILE,
    files,
  }
  writeFileSync(join(stage, INFO), `${JSON.stringify(info, null, 2)}\n`)
  return info
}

/** Runs git in `root`: its trimmed output, or null when it fails. */
export function gitIn(root) {
  return (...args) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return null
    }
  }
}
