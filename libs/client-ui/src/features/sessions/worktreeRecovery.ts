import type { WorktreeRecovery } from '@shared/models'

/** `saved` restores the recorded commit; the others recreate from a branch or trunk. */
export type RecoverySource = 'saved' | 'branch' | 'fresh'

export interface RecoveryOption {
  value: RecoverySource
  label: string
  detail: string
}

const short = (sha: string): string => sha.slice(0, 8)

/** Most exact first; the first one is the default. */
export function recoveryOptions(recovery: WorktreeRecovery): RecoveryOption[] {
  const options: RecoveryOption[] = []
  const { saved, branch, fresh } = recovery
  if (saved)
    options.push({
      value: 'saved',
      label: `Restore saved commit ${short(saved.tip)}`,
      detail: `The exact state when it was removed, detached (was on ${saved.branch}).`,
    })
  if (branch)
    options.push({
      value: 'branch',
      label: `Check out ${branch.name}`,
      detail: `${branch.remoteOnly ? 'On origin only. ' : ''}Latest commit ${short(branch.tip)}: ${branch.subject}`,
    })
  if (fresh)
    options.push({
      value: 'fresh',
      label: `New branch from ${fresh.base}`,
      detail: `Creates ${fresh.branch}, without this lane's earlier work.`,
    })
  return options
}

export function editedFilesNote({ editedFiles, editedFileCount }: WorktreeRecovery): string {
  if (!editedFileCount)
    return 'The conversation did not edit or write files in the old checkout, so a new branch loses nothing it wrote. Shell commands are not checked.'
  const more = editedFileCount - editedFiles.length
  const list = editedFiles.join(', ') + (more > 0 ? `, and ${more} more` : '')
  const noun = editedFileCount === 1 ? 'file' : 'files'
  return `The conversation edited ${editedFileCount} ${noun} in the old checkout: ${list}. Only changes committed to the restored commit or branch come back.`
}
