import type { IpcInvokeMap } from '@shared/ipc'
import type { ResolvedSkill } from '@shared/skills'

/**
 * Harness skill sharing. Copies land in memory, so a Host lists what it was given and a second
 * copy of the same name asks to replace. This Mac's fixed mock skills always conflict.
 */
const LOCAL = ['snowflake-mcp', 'debug', 'council-mode']
const copied = new Map<string, Set<string>>()
const namesOn = (machine: string): Set<string> => {
  const names = copied.get(machine) ?? new Set(machine === 'local' ? LOCAL : [])
  copied.set(machine, names)
  return names
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 700))

function remoteSkill(machine: string, name: string): ResolvedSkill {
  return {
    name,
    description: 'Copied in the harness.',
    dir: `host:${machine}/machine/skill:${name}`,
    scope: 'user',
    source: 'local',
    origin: 'top-level',
    writable: false,
    borrowed: false,
    draft: false,
    files: [],
    totalSize: 0,
    warnings: [],
  }
}

type Channel = 'hosts:skills' | 'hosts:skillExport' | 'hosts:skillInstall' | 'skills:saveBundle'
export const SKILL_SHARE_MOCK: ReadonlySet<string> = new Set<Channel>([
  'hosts:skills',
  'hosts:skillExport',
  'hosts:skillInstall',
  'skills:saveBundle',
])
export async function mockSkillShareInvoke(
  channel: string,
  args: unknown[],
): Promise<IpcInvokeMap[Channel]['result']> {
  if (channel === 'hosts:skills') {
    const [machine] = args as IpcInvokeMap['hosts:skills']['args']
    const skills = [...(copied.get(machine) ?? [])].map((name) => remoteSkill(machine, name))
    return { skills, probe: 'rpc', userRoot: `host:${machine}/machine` }
  }
  await pause()
  if (channel === 'hosts:skillExport') {
    const [{ name }] = args as IpcInvokeMap['hosts:skillExport']['args']
    const text = `---\nname: ${name}\ndescription: Shared from the harness.\n---\n`
    return { name, files: [{ path: 'SKILL.md', data: btoa(text) }] }
  }
  // The harness keeps nothing on disk; it reports where Desktop's dialog would have saved.
  if (channel === 'skills:saveBundle') {
    const [bundle] = args as IpcInvokeMap['skills:saveBundle']['args']
    return { savedTo: `/Users/dev/Downloads/${bundle.name}.zip` }
  }
  const [machine, bundle, overwrite] = args as IpcInvokeMap['hosts:skillInstall']['args']
  const names = namesOn(machine)
  if (names.has(bundle.name) && !overwrite) return { status: 'conflict', replaceable: true }
  const replaced = names.has(bundle.name)
  names.add(bundle.name)
  return { status: 'installed', replaced }
}
