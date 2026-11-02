import { normalizePrefix } from '@shared/branchName'
import { LANE_FOLDER_MAX } from '@shared/host-protocol'
import { newChatBranchName } from '@/features/sessions/startChat'
import { useWorktreesStore } from '@/stores/worktrees'

const HOST_BRANCH_LIMIT = LANE_FOLDER_MAX

/** Host folders flatten slashes; This Mac has no corresponding 100-character cap. */
export function remoteBranchName(prompt: string, attempt = 1): string {
  const prefix = normalizePrefix(useWorktreesStore.getState().branchPrefix)
  const suffix = attempt === 1 ? '' : `-${attempt}`
  const available = HOST_BRANCH_LIMIT - prefix.length - suffix.length
  if (available < 1) throw new Error('branch-prefix-too-long')
  const { branch } = newChatBranchName(prompt, { takenBranches: [], takenFolders: [] })
  const slug = branch.slice(prefix.length, prefix.length + available).replace(/-+$/, '')
  return `${prefix}${slug}${suffix}`
}
