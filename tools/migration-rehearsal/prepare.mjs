import process from 'node:process'
import console from 'node:console'
import { mkdir, readdir, lstat, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { checkDescendants, checkedLayout, flags, inside, main } from './assert-scratch.mjs'
import { manifestChanges, snapshot } from './manifest.mjs'

import { cloneFile } from './clone.mjs'
import { relocate } from './relocate.mjs'

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

export async function prepare(input, user, agent, recorded) {
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
  const relocated = await relocate(root, roots, recorded ?? sources)
  await json(join(root, 'prepared.json'), { version: 1, sources })
  return {
    clones,
    plainCopyFallbacks: copies,
    excluded: before.excluded.length,
    accountStandIns: before.standIns.length,
    relocated,
  }
}

if (main(import.meta.url)) {
  try {
    process.umask(0o077)
    const args = flags(
      'scratch',
      'source-user-data',
      'source-agent-dir',
      'recorded-user-data',
      'recorded-agent-dir',
    )
    const recorded = args['recorded-user-data']
      ? { userData: args['recorded-user-data'], agent: args['recorded-agent-dir'] }
      : undefined
    if (recorded && !recorded.agent) throw new Error('Name both recorded roots')
    console.log(
      JSON.stringify(
        await prepare(args.scratch, args['source-user-data'], args['source-agent-dir'], recorded),
      ),
    )
  } catch {
    console.error('Preparation refused or source/copy verification failed; discard this scratch.')
    process.exitCode = 1
  }
}
