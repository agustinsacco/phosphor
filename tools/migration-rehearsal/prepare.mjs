import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, lstat, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { checkDescendants, checkedLayout, flags, inside, main } from './assert-scratch.mjs'
import { hashFile, identity, manifestChanges, snapshot } from './manifest.mjs'

const json = (path, data) =>
  writeFile(path, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 })
const overlaps = (a, b) => a === b || inside(a, b) || inside(b, a)

async function sourceRoot(input) {
  if (!isAbsolute(input) || !(await lstat(input)).isDirectory())
    throw new Error('Expected source directory')
  const path = await realpath(input)
  if (dirname(path) === path) throw new Error('Root cannot be a source')
  return path
}

async function cloneFile(source, dest, entry) {
  const id = identity(await lstat(source, { bigint: true }))
  if (
    (await realpath(source)) !== source ||
    JSON.stringify(entry.slice(1, -1)) !== JSON.stringify(id)
  )
    throw new Error('Source changed before copy')
  let cloned = true
  try {
    await copyFile(source, dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE)
  } catch (err) {
    if (!['ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EOPNOTSUPP'].includes(err.code)) throw err
    cloned = false
    await copyFile(source, dest, constants.COPYFILE_EXCL)
  }
  const stat = await lstat(dest, { bigint: true })
  if (
    (String(stat.dev) === id[0] && String(stat.ino) === id[1]) ||
    (await hashFile(dest, identity(stat))) !== entry.at(-1)
  )
    throw new Error('Copy verification failed')
  return cloned
}

export async function prepare(input, user, agent) {
  const { root, roots } = checkedLayout(input)
  if ((await readdir(root)).length !== 0) throw new Error('Scratch must be empty')
  const sources = { userData: await sourceRoot(user), agent: await sourceRoot(agent) }
  if (
    overlaps(sources.userData, sources.agent) ||
    Object.values(sources).some((path) => overlaps(root, path))
  )
    throw new Error('Overlapping roots')
  const before = await snapshot(sources)
  await json(join(root, 'before.json'), before)
  for (const kind of Object.keys(sources)) await mkdir(roots[kind], { mode: 0o700 })
  let clones = 0,
    copies = 0
  let after
  try {
    for (const [key, entry] of Object.entries(before.entries)) {
      const [kind, ...parts] = key.split('/'),
        dest = join(roots[kind], ...parts)
      checkDescendants(root, { dest })
      if (entry[0] === 'dir') await mkdir(dest, { mode: 0o700 })
      else if (await cloneFile(join(sources[kind], ...parts), dest, entry)) clones++
      else copies++
    }
  } finally {
    after = await snapshot(sources)
    await json(join(root, 'after.json'), after)
  }
  if (
    manifestChanges(before.entries, after.entries).length ||
    JSON.stringify(before.excluded) !== JSON.stringify(after.excluded)
  )
    throw new Error('Source changed')
  await json(join(root, 'prepared.json'), { version: 1, sources })
  return {
    clones,
    plainCopyFallbacks: copies,
    excluded: before.excluded.length,
    accountStandIns: before.standIns.length,
  }
}

if (main(import.meta.url)) {
  try {
    process.umask(0o077)
    const args = flags('scratch', 'source-user-data', 'source-agent-dir')
    console.log(
      JSON.stringify(
        await prepare(args.scratch, args['source-user-data'], args['source-agent-dir']),
      ),
    )
  } catch {
    console.error('Preparation refused or source/copy verification failed; discard this scratch.')
    process.exitCode = 1
  }
}
