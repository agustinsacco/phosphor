import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

const userDirs = ['lane-archive', 'drafts', 'artifacts', 'daemon-migration', 'claude-accounts']
const userFile = /^(config\.json|routines(-dev)?\.sqlite(-shm|-wal)?)$/
export const sensitiveName = (name) =>
  /^(auth.*\.json|\.env.*|models\.json|id_(rsa|ed25519)|cookies(?:-journal)?|login data(?:-journal)?)$|credential|keychain|\.(pem|key|pfx|p12)$|(?:^|[._-])token(?:s|[._-]|$)/i.test(
    name,
  )
export const manifestChanges = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
export const identity = (s) => [
  String(s.dev),
  String(s.ino),
  String(s.mode),
  String(s.size),
  String(s.ctimeNs),
  String(s.mtimeNs),
]

export async function hashFile(path, expected) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await f.stat({ bigint: true })
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      JSON.stringify(identity(stat)) !== JSON.stringify(expected)
    )
      throw new Error('Source identity changed')
    const hash = createHash('sha256')
    for await (const chunk of f.createReadStream({ autoClose: false })) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    await f.close()
  }
}

function topKind(kind, name) {
  if (kind === 'agent')
    return name === 'sessions' ? 'dir' : name === 'settings.json' ? 'file' : null
  return userDirs.includes(name) ? 'dir' : userFile.test(name) ? 'file' : null
}

/** Excluded names are recorded but never opened, even for hashing. Account entries are only lstat'd. */
export async function snapshot(sources) {
  const entries = Object.create(null),
    excluded = [],
    standIns = []
  async function visit(kind, base, rel = '') {
    const dir = join(base, rel)
    if ((await realpath(dir)) !== dir) throw new Error('Linked source directory')
    for (const name of (await readdir(dir)).sort()) {
      const child = join(rel, name),
        key = join(kind, child),
        path = join(dir, name)
      const expected = rel ? 'entry' : topKind(kind, name)
      if (!expected || sensitiveName(name) || (rel && name.toLowerCase() === 'claude-accounts')) {
        excluded.push(key)
        continue
      }
      const stat = await lstat(path, { bigint: true })
      if (rel === 'claude-accounts' && !stat.isDirectory()) {
        excluded.push(key)
        continue
      }
      if (stat.isDirectory() && expected !== 'file') {
        entries[key] = ['dir', ...identity(stat)]
        if (rel === 'claude-accounts') standIns.push(key)
        else await visit(kind, base, child)
      } else if (stat.isFile() && stat.nlink === 1n && expected !== 'dir') {
        const id = identity(stat)
        entries[key] = ['file', ...id, await hashFile(path, id)]
      } else throw new Error('Unexpected link, special file or input type')
    }
  }
  for (const [kind, base] of Object.entries(sources)) await visit(kind, base)
  return { entries, excluded, standIns }
}
