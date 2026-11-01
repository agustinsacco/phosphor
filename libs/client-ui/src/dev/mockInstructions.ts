import type { GlobalInstructions } from '@shared/global-instructions'

/**
 * This computer's global instructions in the browser harness: in memory only,
 * revisioned by a counter so the editor's conflict path behaves as it does on
 * disk. Never a real file read.
 */
let file: GlobalInstructions = {
  path: '/Users/dev/.pi/agent/AGENTS.md',
  content: '# My rules\n\n- Prefer small pull requests.\n',
  revision: '1'.padStart(64, '0'),
  exists: true,
}

export function mockInstructionsInvoke(channel: string, args: unknown[]): unknown {
  if (channel === 'pi:readInstructions') return structuredClone(file)
  if (channel === 'pi:writeInstructions') {
    if (args[1] !== file.revision)
      throw new Error('The instructions file changed on disk. Reload it and edit again.')
    const revision = (Number.parseInt(file.revision, 16) + 1).toString(16).padStart(64, '0')
    file = { ...file, content: String(args[0]), revision, exists: true }
    return structuredClone(file)
  }
  return undefined
}
