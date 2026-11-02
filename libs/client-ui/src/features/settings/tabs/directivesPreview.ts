import { composeDirectives } from '@shared/agent-directives'
import type { MachineContext } from '@shared/machine-prompt'
import type { AgentDirectivePrefs } from '@shared/models'

/**
 * What a lane started now would be sent, composed by the same function the
 * session service uses. Per-lane facts (its worktree, branch and the main
 * checkout) are placeholders, since no lane exists yet.
 */
export function directivesPreview(prefs: AgentDirectivePrefs, machine: MachineContext): string {
  return (
    composeDirectives({
      cwd: '/path/to/this-lane-worktree',
      git: { isRepo: true, isWorktree: true, mainRepoPath: '/path/to/main-checkout' },
      prefs,
      machine,
      charter: { branch: 'this-lane-branch', base: 'main' },
    }) ?? ''
  )
}
