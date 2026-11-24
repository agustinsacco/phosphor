import { HOST_RELEASE_VERSION_PATTERN } from '@phosphor/shared/host-release'

/** What an update prints when the installed release is the newest. */
export const UP_TO_DATE = 'already up to date'
/** What `update --stage` prints once a release is staged; `stagedVersionIn` reads it back. */
export const stagedLine = (version: string) =>
  `Staged Host ${version}; apply it with: phosphor update --apply ${version}`

/** The version a `update --stage` run reports it staged, or null. */
export function stagedVersionIn(output: string): string | null {
  const match = /^Staged Host (\S+); apply it with: phosphor update --apply (\S+)$/m.exec(output)
  if (!match || match[1] !== match[2] || !HOST_RELEASE_VERSION_PATTERN.test(match[1]!)) return null
  return match[1]!
}
