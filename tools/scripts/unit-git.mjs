import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob } from 'node:path'
import { repoPath } from './select-unit-tests.mjs'

/** @param {string} root @param {string[]} args */
export function gitText(root, ...args) {
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Mutable refs and abbreviated ids are never acceptance evidence.
 * @param {string} root @param {string} sha */
export function immutableCommit(root, sha) {
  if (typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
    throw new Error('Expected immutable full commit SHA')
  if (gitText(root, 'cat-file', '-t', sha).trim() !== 'commit')
    throw new Error('Expected commit object')
  return sha
}

/** @param {string} root @param {string} base @param {string} final */
export function commitHistory(root, base, final) {
  immutableCommit(root, base)
  immutableCommit(root, final)
  try {
    gitText(root, 'merge-base', '--is-ancestor', base, final)
  } catch {
    throw new Error('Base must be an ancestor of final SHA')
  }
  if (gitText(root, 'rev-list', '--merges', `${base}..${final}`).trim())
    throw new Error('Unit history must not contain merge commits')
  return gitText(root, 'rev-list', '--reverse', `${base}..${final}`)
    .trim()
    .split('\n')
    .filter(Boolean)
}

/** Disabling rename detection retains BOTH endpoints, including unusual filenames.
 * @param {string} root @param {string} before @param {string} after */
export function changedPaths(root, before, after) {
  immutableCommit(root, before)
  immutableCommit(root, after)
  return gitText(root, 'diff', '--name-only', '--no-renames', '-z', before, after, '--')
    .split('\0')
    .filter(Boolean)
    .map(repoPath)
}

/** @param {string} root @param {string} sha @param {string} file */
export function blobAt(root, sha, file) {
  immutableCommit(root, sha)
  repoPath(file)
  const entry = gitText(root, 'ls-tree', '-z', sha, '--', file).split('\0')[0]
  if (!entry) return undefined
  const [mode, type, blob] = entry.slice(0, entry.indexOf('\t')).split(' ')
  if (type !== 'blob') throw new Error(`Expected file blob: ${file}`)
  return { mode, blob }
}

/** @typedef {{commitSha:string,moves:{from:string,to:string}[]}} Relocation */
/** Frozen means the entire blob, in EVERY commit, not just the final diff.
 * @param {string} root @param {string} first @param {string[]} later
 * @param {string[]} files @param {Relocation | undefined} relocation */
export function frozenBlobs(root, first, later, files, relocation = undefined) {
  const frozen = files.map((file) => {
    const original = blobAt(root, first, file)
    if (!original) throw new Error(`Missing frozen test: ${file}`)
    return { original: file, file, ...original }
  })
  for (const sha of later) {
    for (const entry of frozen) {
      if (relocation?.commitSha === sha) {
        const move = relocation.moves.find((move) => move.from === entry.file)
        if (move) {
          if (blobAt(root, sha, entry.file))
            throw new Error(`Non-mechanical relocation: ${entry.file}`)
          entry.file = move.to
        }
      }
      const current = blobAt(root, sha, entry.file)
      if (current?.blob !== entry.blob || current?.mode !== entry.mode)
        throw new Error(`Changed frozen test at ${sha}: ${entry.file}`)
    }
  }
  return frozen.map(({ mode: _mode, ...entry }) => entry)
}

function linkDependencies(root, snapshot) {
  const tracked = gitText(snapshot, 'ls-files', '-z').split('\0').filter(Boolean)
  const manifests = tracked.filter((file) => file.endsWith('/package.json'))
  const read = (file) => JSON.parse(readFileSync(join(snapshot, file), 'utf8'))
  const links = new Map()
  if (existsSync(join(snapshot, 'package-lock.json'))) {
    for (const [path, entry] of Object.entries(read('package-lock.json').packages ?? {}))
      if (entry.link)
        links.set(repoPath(path.split('node_modules/').at(-1)), repoPath(entry.resolved))
  }
  if (existsSync(join(snapshot, 'package.json'))) {
    const declared = read('package.json').workspaces ?? []
    const patterns = Array.isArray(declared) ? declared : declared.packages
    for (const file of manifests)
      if (patterns.some((pattern) => matchesGlob(dirname(file), pattern)))
        links.set(repoPath(read(file).name), dirname(file))
  }
  for (const directory of new Set(['', ...manifests.map(dirname)])) {
    const installed = join(root, directory, 'node_modules')
    if (!existsSync(installed)) continue
    const target = join(snapshot, directory, 'node_modules')
    mkdirSync(target, { recursive: true })
    const names = readdirSync(installed).flatMap((name) =>
      name.startsWith('@')
        ? readdirSync(join(installed, name)).map((child) => `${name}/${child}`)
        : [name],
    )
    for (const name of new Set([...names, ...links.keys()])) {
      const destination = join(target, name)
      mkdirSync(dirname(destination), { recursive: true })
      const source = links.has(name) ? join(snapshot, links.get(name)) : join(installed, name)
      if (!existsSync(source)) throw new Error(`Missing snapshot dependency: ${name}`)
      symlinkSync(source, destination, 'junction')
    }
  }
}

/** Run only committed files, without changing the caller's checkout or workspace links.
 * @template T @param {string} root @param {string} sha
 * @param {(snapshot:string)=>T} operation @returns {T} */
export function withSnapshot(root, sha, operation) {
  immutableCommit(root, sha)
  const temporary = mkdtempSync(join(tmpdir(), 'phosphor-unit-gate-'))
  const snapshot = join(temporary, 'snapshot')
  let added = false
  try {
    gitText(root, 'worktree', 'add', '--detach', snapshot, sha)
    added = true
    linkDependencies(root, snapshot)
    return operation(snapshot)
  } finally {
    try {
      if (added) gitText(root, 'worktree', 'remove', '--force', snapshot)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
}
