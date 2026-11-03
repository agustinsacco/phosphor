const SEGMENT = '[^\\n;|&]*'
const MERGE = new RegExp(
  `\\bgh\\b${SEGMENT}\\bpr\\s+merge\\b|\\bgh\\b${SEGMENT}\\bapi\\b${SEGMENT}/merges?\\b`,
)
const FORCE = new RegExp(
  `\\bgit\\b${SEGMENT}\\bpush\\b${SEGMENT}(?:\\s--force(?:-with-lease|-if-includes)?\\b|\\s-[a-zA-Z]*f[a-zA-Z]*\\b|\\s\\+\\S)`,
)

/**
 * A guard against the release lane's own mistakes, not a security boundary:
 * merges go through release_merge, which checks the lease, and nothing is
 * force-pushed. Shell indirection can get past it; the prompt forbids both.
 */
export function releaseBashRefusal(command: string): string | undefined {
  if (MERGE.test(command))
    return 'Merge with release_merge: it checks this lane still holds the release lease and pins the head you reviewed.'
  if (FORCE.test(command))
    return 'The release manager never force-pushes. Push a merge commit instead of rewriting history.'
  return undefined
}
