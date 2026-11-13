import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { privateAgentDir } from './local-app'
import { scratchDir } from './scratch'

export interface BrainLane {
  title: string
  source: string
  original: string
  facts: string[]
}

async function seedLane(
  agent: string,
  workspace: string,
  title: string,
  id: string,
  facts: string[],
): Promise<BrainLane> {
  const directory = join(
    agent,
    'sessions',
    `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`,
  )
  await mkdir(directory, { recursive: true })
  const source = join(directory, `2026-11-06T12-00-00-000Z_${id}.jsonl`)
  const at = (second: number) => `2026-11-06T12:00:0${second}Z`
  const original =
    [
      { type: 'session', version: 3, id, cwd: workspace, timestamp: at(0) },
      { type: 'session_info', id: 'name0001', parentId: null, name: title, timestamp: at(1) },
      {
        type: 'message',
        id: 'ask00001',
        parentId: 'name0001',
        timestamp: at(2),
        message: { role: 'user', content: facts.join(' ') },
      },
      {
        type: 'message',
        id: 'ans00001',
        parentId: 'ask00001',
        timestamp: at(3),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Noted.' }],
          provider: 'stub',
          model: 'stub-model',
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'
  await writeFile(source, original)
  return { title, source, original, facts }
}

/** Stopped, made-up lanes: the real pipeline only reads their bytes. */
export async function seedBrainLanes() {
  const workspace = await scratchDir('phosphor-e2e-brain-')
  const profile = join(workspace, 'profile')
  const agent = privateAgentDir()
  await mkdir(profile)
  const harbor = await seedLane(
    agent,
    workspace,
    'Harbor ledger',
    '01a0272a-7be5-76ed-b420-36b363924633',
    ['Rina Okafor owns Harbor ledger.', 'Harbor ledger is part of Harbor.'],
  )
  const ledger = await seedLane(
    agent,
    workspace,
    'Ledger bridge',
    '02a0272a-7be5-76ed-b420-36b363924644',
    ['Tom Lee owns Ledger bridge.', 'Ledger bridge is part of Harbor.'],
  )
  await writeFile(
    join(profile, 'config.json'),
    JSON.stringify({
      lastWorkspacePath: workspace,
      recentWorkspaces: [{ path: workspace, name: 'Harbor' }],
    }),
  )
  // Brain's minimal-stub launch intentionally inherits no test env. This wrapper changes only
  // the stub's failure switch once the spec arms it; all dispatch still belongs to pi-stub.cjs.
  const armed = join(workspace, 'arm-failure')
  const failureDirectory = join(workspace, 'failure')
  const wrapper = join(workspace, 'pi-brain-test.cjs')
  await writeFile(
    wrapper,
    `if (require('node:fs').existsSync(${JSON.stringify(armed)}))
  process.env.PHOSPHOR_STUB_BRAIN_FAIL_ONCE = ${JSON.stringify(failureDirectory)};
require(${JSON.stringify(join(import.meta.dirname, 'pi-stub.cjs'))});\n`,
  )
  return { workspace, profile, agent, harbor, ledger, armed, failureDirectory, wrapper }
}
