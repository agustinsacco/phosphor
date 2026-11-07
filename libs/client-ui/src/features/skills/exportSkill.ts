import type { ResolvedSkill } from '@shared/skills'

/**
 * Keep one skill on this device as a zip. This Mac zips its own folder (`skills:export`, no
 * share limits); another machine's skill comes as its share bundle, which the bridge saves
 * (a save dialog on Desktop, a download in a browser).
 */
export async function exportSkill(
  skill: Pick<ResolvedSkill, 'name' | 'dir'>,
  source: string,
): Promise<{ savedTo: string } | null> {
  if (source === 'local') return window.phosphor.invoke('skills:export', skill.dir)
  const bundle = await window.phosphor.invoke('hosts:skillExport', {
    machine: source,
    name: skill.name,
  })
  return window.phosphor.invoke('skills:saveBundle', bundle)
}
