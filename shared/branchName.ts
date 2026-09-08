/**
 * Turning a session title into the branch and folder a new chat runs on.
 *
 * A chat that starts with "Fix the composer autogrow jump" becomes the session
 * *Composer Autogrow Fix*, the folder `.phosphor/worktrees/composer-autogrow-fix`
 * and the branch `phosphor/composer-autogrow-fix` — one name in three places, so
 * the sidebar group, the branch chip and the session title all agree.
 *
 * Folder and branch are derived together and deliberately differ: the prefix
 * contains a `/`, and a `/` in the folder name would nest the checkout a level
 * deeper and rename the sidebar group to the last segment.
 *
 * Pure and side-effect free; the git calls live in `git-worktrees.ts`.
 */

/**
 * Default cap on the slug, not on the title. Long enough for a 4-5 word title,
 * short enough that `git branch` output and the sidebar stay readable.
 * Overridable per user via `LanePrefs.branchSlugMaxLength`.
 */
const DEFAULT_MAX_SLUG = 40

/** Give up on numeric suffixes here and salt instead; N is absurd by then. */
const MAX_SUFFIX = 100

export interface BranchNameInput {
  /** Session title, or the first user message when naming fell through. */
  title: string
  /** Configured prefix, e.g. `phosphor/`. Empty means no prefix. */
  prefix: string
  /** Branch names already in this repo. */
  takenBranches: string[]
  /** Worktree folder names already under `.phosphor/worktrees`. */
  takenFolders: string[]
  /** Slug cap; defaults to 40. From `LanePrefs.branchSlugMaxLength`. */
  maxSlug?: number
}

export interface BranchName {
  /** Worktree folder name. Never contains a slash. */
  folder: string
  /** Branch to create: the prefix followed by the folder name. */
  branch: string
}

/**
 * Kebab-case a title into something safe as both a folder and a git ref.
 *
 * The charset is deliberately narrower than git's rules ([a-z0-9-] only, must
 * start alphanumeric): every ref name git rejects — `..`, `@{`, `~^:?*[\`, a
 * leading `-`, a trailing `.lock` — is unreachable from this alphabet, so the
 * result needs no second round of validation.
 */
export function slugifyTitle(title: string, maxSlug = DEFAULT_MAX_SLUG): string {
  const slug = title
    // Decompose accents so "Café" slugs to "cafe" rather than losing the word.
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return 'session'
  const limit = Math.max(4, Math.floor(maxSlug))
  if (slug.length <= limit) return slug
  // Cut on a word boundary when one is close to the limit, so a truncated slug
  // reads as words rather than as a severed one ("composer-autogrow-ju").
  const clipped = slug.slice(0, limit)
  const lastDash = clipped.lastIndexOf('-')
  const trimmed = lastDash >= limit / 2 ? clipped.slice(0, lastDash) : clipped
  return trimmed.replace(/-+$/, '') || 'session'
}

/**
 * Make a user-typed prefix safe and separator-terminated.
 *
 * Someone who types `Phosphor` in settings means `phosphor/`, but someone who types
 * `phosphor-` means `phosphor-`: a prefix already ending in a separator is left
 * alone, and one ending in an alphanumeric gets a `/`. Empty stays empty.
 */
export function normalizePrefix(prefix: string): string {
  const cleaned = prefix
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/^[/.-]+/, '')
  if (!cleaned) return ''
  return /[/\-_]$/.test(cleaned) ? cleaned : `${cleaned}/`
}

/**
 * Pick the folder/branch pair for a new session, avoiding names already in use.
 *
 * Both namespaces are checked for every candidate: a folder is free but its
 * branch is taken exactly as often as the reverse (a worktree removed with its
 * branch kept, or vice versa), and creating one without the other leaves a
 * chat whose sidebar group and branch chip disagree.
 */
export function branchNameFor(input: BranchNameInput): BranchName {
  const prefix = normalizePrefix(input.prefix)
  const base = slugifyTitle(input.title, input.maxSlug ?? DEFAULT_MAX_SLUG)
  // Lowercased on both sides: git refs are case-sensitive but the macOS and
  // Windows filesystems the folder lands on are not, so `Fix-Bug` and `fix-bug`
  // are the same worktree even where they are different branches.
  const branches = new Set(input.takenBranches.map((b) => b.trim().toLowerCase()))
  const folders = new Set(input.takenFolders.map((f) => f.trim().toLowerCase()))

  const free = (folder: string): boolean =>
    !folders.has(folder.toLowerCase()) && !branches.has(`${prefix}${folder}`.toLowerCase())

  if (free(base)) return { folder: base, branch: `${prefix}${base}` }
  for (let n = 2; n < MAX_SUFFIX; n++) {
    const folder = `${base}-${n}`
    if (free(folder)) return { folder, branch: `${prefix}${folder}` }
  }
  // 98 collisions on one title: salt rather than fail, since the alternative is
  // refusing to start a chat.
  const folder = `${base}-${Date.now().toString(36)}`
  return { folder, branch: `${prefix}${folder}` }
}
