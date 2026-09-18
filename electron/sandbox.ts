import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { SandboxInfo } from '@shared/models'

/**
 * Sandbox folders back the "No folder" option: a session that belongs to no
 * project still needs a real cwd for pi, so we mint one under the app's own
 * data dir (`<userData>/sandboxes/<name>`). From then on it is an ordinary
 * workspace — it enters recents and hosts any number of sessions.
 *
 * Names are a random `adjective-noun` rather than the `sandbox-N` counter this
 * used to mint. Two sandboxes are told apart by name in the sidebar, the
 * switcher and Settings, and a column of `sandbox-5 / sandbox-6 / sandbox-7`
 * carries nothing to tell apart — worse, the counter reuses a number as soon as
 * the folder above it is deleted, so two DIFFERENT folders could read the same
 * in the same list. `sandbox-N` folders from before the change are still
 * ordinary sandboxes; nothing migrates them.
 *
 * A sandbox is therefore any non-hidden directory directly inside the base,
 * whatever it is called — the base is Phosphor's own, so there is nothing else
 * in there — and the user can rename one to whatever they like.
 *
 * The base is injected rather than read from `app` here so this module stays
 * importable in tests without mocking electron, and so E2E runs (which
 * redirect userData via PHOSPHOR_TEST_USER_DATA) never write into the real one.
 */

/**
 * Deliberately bland and short. These end up in a shell prompt, a window title
 * and a `cd` argument, so nothing here is long, punctuated, or ambiguous to
 * type. 40 x 40 = 1600 pairs, far more than anyone's sandbox count, which
 * makes a collision rare enough that one retry settles it.
 *
 * Split from a string rather than written as an array literal purely for the
 * diff: one word per line is 80 lines of nothing.
 */
const words = (list: string): string[] => list.trim().split(/\s+/)

const ADJECTIVES = words(`
  amber bright brisk calm clever copper crisp dusky eager fleet gentle golden hazy humble
  ivory jolly keen lively lucid mellow merry misty nimble noble plucky quiet rapid rustic
  silent snowy solar spry sunny teal tidal velvet warm wild witty zesty
`)

const NOUNS = words(`
  anchor arbor badger beacon birch bison brook canyon cedar comet coral cove dune ember
  falcon fern fjord garnet glade harbor heron iris juniper kestrel lagoon lantern maple
  meadow mesa orchard otter pebble quarry reef ridge river sparrow thicket willow zephyr
`)

/** Longer than this and the sidebar shows nothing but an ellipsis. */
export const SANDBOX_NAME_MAX_LENGTH = 64

/**
 * Characters no sandbox name may contain.
 *
 * `/` and `\` would escape the base, and `:` is here for a subtler reason:
 * pi mangles a cwd into a session-directory name by turning `/`, `\` and `:`
 * all into `-` (pi-paths.ts), so `my:box` and `my-box` would share one
 * transcript directory and read as each other's history. The rest are the
 * characters Windows refuses in a filename.
 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/

/** Windows refuses these as filenames, extension or not. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A code-point test rather than a regex range, so that this file holds no raw
 * control bytes of its own — one pasted into a character class is invisible in
 * review and turns the source into something `grep` reports as binary.
 */
function hasControlCharacter(name: string): boolean {
  return [...name].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
}

/** A sandbox is any non-hidden directory; a dotfolder is never one. */
function isSandboxName(name: string): boolean {
  return name.length > 0 && !name.startsWith('.')
}

/**
 * A name the user may type, or null.
 *
 * Runs in the main process on a renderer-supplied string, so it is the guard
 * rather than a convenience — the renderer's own copy of these rules is only
 * there to explain them before the user submits.
 */
export function validateSandboxName(raw: string): string | null {
  const name = raw.trim()
  if (!name || name.length > SANDBOX_NAME_MAX_LENGTH) return null
  if (ILLEGAL_NAME_CHARS.test(name) || hasControlCharacter(name)) return null
  // `.`, `..` and anything hidden: `listSandboxFolders` would not list it back.
  if (name.startsWith('.')) return null
  // Windows silently strips a trailing dot, so the folder would not be the
  // name the user typed. (A trailing space is already gone with the trim.)
  if (name.endsWith('.')) return null
  if (WINDOWS_RESERVED.test(name)) return null
  return name
}

/**
 * A fresh `adjective-noun` not among `existing`.
 *
 * Compared case-insensitively because macOS and Windows are: `Quiet-Otter`
 * already occupies `quiet-otter`. `random` is injected so tests can pin it.
 */
export function randomSandboxName(
  existing: Iterable<string> = [],
  random: () => number = Math.random,
): string {
  const taken = new Set([...existing].map((name) => name.toLowerCase()))
  const pick = (): string => {
    const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)] ?? 'quiet'
    const noun = NOUNS[Math.floor(random() * NOUNS.length)] ?? 'meadow'
    return `${adjective}-${noun}`
  }

  let candidate = pick()
  for (let attempt = 0; attempt < 20 && taken.has(candidate.toLowerCase()); attempt++) {
    candidate = pick()
  }
  // Every draw collided (a very full base, or a pinned RNG in a test): fall
  // back to a counter rather than returning a name that is already in use.
  for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix++) {
    candidate = `${pick()}-${suffix}`
  }
  return candidate
}

/**
 * Every sandbox under `base`, most recently touched first.
 *
 * `itemCount` ignores dotfiles: Finder drops a `.DS_Store` into any folder it
 * looks at, and a sandbox holding nothing but that is still untouched as far
 * as the user is concerned.
 */
export function listSandboxFolders(base: string): SandboxInfo[] {
  let names: string[]
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSandboxName(entry.name))
      .map((entry) => entry.name)
  } catch {
    return [] // No sandbox has ever been created.
  }

  const sandboxes: SandboxInfo[] = []
  for (const name of names) {
    const path = join(base, name)
    try {
      const itemCount = readdirSync(path).filter((entry) => !entry.startsWith('.')).length
      sandboxes.push({ path, name, itemCount, lastUsedAt: statSync(path).mtimeMs })
    } catch {
      // Vanished between the two reads (a concurrent delete); skip it.
    }
  }
  return sandboxes.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** Create a randomly-named folder under `base` and return its path. */
export function createSandboxFolder(base: string): string {
  mkdirSync(base, { recursive: true })
  const existing = readdirSync(base)
  // `randomSandboxName` already avoids what it can see; the retry is for the
  // folder appearing between the read and the mkdir.
  for (let attempt = 0; ; attempt++) {
    const path = join(base, randomSandboxName(existing))
    try {
      mkdirSync(path)
      return path
    } catch (error) {
      existing.push(basename(path))
      if (attempt >= 5 || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/**
 * The folder "No folder" should open.
 *
 * An empty sandbox is handed out again rather than replaced. Minting one per
 * click was the original design — scratch space per task — but a sandbox only
 * fills up if the model writes to it, so asking twice in a row left an empty
 * folder behind in the sidebar every time. Reuse costs nothing (there are no
 * files to mix) and the moment a sandbox holds real work the next ask mints a
 * fresh one.
 */
export function openSandboxFolder(base: string): string {
  const reusable = listSandboxFolders(base).find((sandbox) => sandbox.itemCount === 0)
  return reusable ? reusable.path : createSandboxFolder(base)
}

/**
 * Deletion/rename guard: the resolved path, or null when it is not a sandbox
 * folder directly inside `base`.
 *
 * These are the two sandbox operations that take a path FROM the renderer, so
 * the main process re-derives what is legal instead of trusting it.
 *
 * Both sides are compared as REAL paths, because one folder can be named by
 * more than one string — a symlink anywhere on the way to the base gives
 * another spelling, and a purely lexical compare refused the sandbox's own
 * real path as "not a sandbox", which silently disabled Delete and Rename for
 * it. Resolution is best-effort: a path that does not exist falls back to its
 * lexical form, so a vanished folder is still judged rather than crashing, and
 * the caller still has to cope with it being gone.
 */
function realOrLexical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

export function resolveSandboxFolder(base: string, path: string): string | null {
  const target = realOrLexical(path)
  if (dirname(target) !== realOrLexical(base)) return null
  return isSandboxName(basename(target)) ? target : null
}

/**
 * Where Phosphor puts a lane inside a workspace. `.pidex` is the pre-rename
 * (2026-09-08) folder; lanes created before then still live there.
 */
const WORKTREE_PARENTS = ['.phosphor', '.pidex']

/**
 * Every cwd a session could have been started in under `folder`: the folder
 * itself, then each lane Phosphor has created inside it.
 *
 * A sandbox that is a git repo grows lanes like any other workspace, and each
 * lane is its OWN cwd with its own transcript directory. Renaming or deleting
 * the sandbox has to account for all of them or the lane chats are orphaned —
 * the folder moves, and their transcripts keep naming a path that is gone.
 *
 * Enumerated from disk rather than by matching the mangled directory names
 * under pi's sessions root, which looks cheaper and is wrong: the mangling
 * joins path segments with `-` and folder names may contain `-`, so
 * `<base>/games` and `<base>/games-2` mangle to `--…-games--` and
 * `--…-games-2--`. The second starts with the first's prefix, nothing can
 * un-mangle a directory name back into a path to tell them apart, and the
 * mistake would move a bystander sandbox's history.
 */
export function sandboxCwds(folder: string): string[] {
  const cwds = [folder]
  for (const parent of WORKTREE_PARENTS) {
    const root = join(folder, parent, 'worktrees')
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) cwds.push(join(root, entry.name))
      }
    } catch {
      // No lanes of that vintage; the common case, not an error.
    }
  }
  return cwds
}

/** Same directory on disk, rather than same string — see `planSandboxRename`. */
function isSameFolder(a: string, b: string): boolean {
  try {
    const left = statSync(a)
    const right = statSync(b)
    return left.ino === right.ino && left.dev === right.dev
  } catch {
    return false
  }
}

export type SandboxRenamePlan =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: 'not-a-sandbox' | 'invalid-name' | 'exists' }

/**
 * Where a rename would move a sandbox, or why it may not.
 *
 * Split from the move itself because the caller has to check for a live
 * session in between, and because everything decided here is testable without
 * renaming anything.
 *
 * The collision check compares inodes, not strings: on a case-insensitive
 * filesystem `quiet-otter` → `Quiet-Otter` finds an existing folder at the
 * destination, but it is the very folder being renamed, and refusing that
 * would make a pure change of case impossible. On a case-sensitive one they
 * are two real folders and the inodes differ, so it is still refused.
 */
export function planSandboxRename(base: string, path: string, raw: string): SandboxRenamePlan {
  const from = resolveSandboxFolder(base, path)
  if (!from) return { ok: false, reason: 'not-a-sandbox' }

  const name = validateSandboxName(raw)
  if (!name) return { ok: false, reason: 'invalid-name' }

  // Anchored to `from`, not to `base`: the guard above has already established
  // that `from` sits directly inside the base, and `from` is resolved, so this
  // cannot land in a different spelling of the base than the folder it moves.
  const to = join(dirname(from), name)
  if (to === from) return { ok: true, from, to }
  if (existsSync(to) && !isSameFolder(to, from)) return { ok: false, reason: 'exists' }
  return { ok: true, from, to }
}
