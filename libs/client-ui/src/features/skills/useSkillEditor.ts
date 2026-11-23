import type { ResolvedSkill } from '@shared/skills'
import { hostIdOfPath } from '@phosphor/shared/remote-host'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { runAgentOp } from '@/features/agent-control/agentOps'

/** Machine-wide inventory shows only user skills. The service confines the named bundle. */
export function useSkillEditor(workspacePath: string) {
  const id = hostIdOfPath(workspacePath)
  const enabled = useRemoteLanesStore((s) => {
    const h = id && s.hosts[id]
    return (
      h &&
      h.state === 'ready' &&
      h.ops &&
      h.configFiles &&
      h.capabilities.includes('machine.configure') &&
      h.capabilities.includes('sessions.control')
    )
  })
  return id && enabled
    ? (name: string, file: string, content: string) =>
        runAgentOp(id, 'skill.edit', { name, scope: 'user', file, content })
    : null
}

export async function writeSkillSource(
  editor: ReturnType<typeof useSkillEditor>,
  skill: ResolvedSkill,
  workspace: string,
  file: string,
  content: string,
) {
  if (hostIdOfPath(workspace)) {
    if (!editor) throw Error('Configuration access on this machine is required.')
    await editor(skill.name, file, content)
  } else await window.phosphor.invoke('skills:writeFile', skill.dir, file, content, workspace)
}
