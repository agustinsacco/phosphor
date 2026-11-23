import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@phosphor/shared/models'
import { CONTEXT_FILES_ENV } from '@phosphor/shared/context-files'
import { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import { EXTENSIONS_ROOT } from '../../__fixtures__/machine'
import { hostLivePolicy } from '../../config/live-policy'
import { createHostRuntime } from '../../session/runtime'
import { createHostLog } from '../../machine/log'
import { policyImporter } from './policy'
import { scratchHost } from './__fixtures__/scratch-host'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
it('spawns each Host lane with its own snapshot of the imported context file default', async () => {
  const h = await scratchHost()
  const repo = h.folder('repo')
  const agent = h.folder('agent')
  vi.stubEnv('PI_CODING_AGENT_DIR', agent)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PATH', process.env.PATH)
  const runtime = createHostRuntime(
    {
      roots: [repo],
      pi: {
        binaryPath: process.execPath,
        prefixArgs: [join(import.meta.dirname, '../../__fixtures__/fake-pi.cjs')],
      },
      env: { HOME: h.root, PATH: '/usr/bin:/bin', PI_CODING_AGENT_DIR: agent },
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      log: createHostLog(join(h.root, 'logs'), []),
    },
    hostLivePolicy(h.config, { version: 1, pi: { executable: '/usr/bin/pi' }, repositories: [] }),
  )
  try {
    runtime.life.to('validating')
    runtime.life.to('ready')
    const spawns = vi.spyOn(SessionRegistry.prototype, 'create')
    for (const claude of [false, true]) {
      await policyImporter(h.ports).apply(
        {
          section: 'policy',
          contextBudget: '',
          agentDirectives: DEFAULT_AGENT_DIRECTIVES,
          directivesByFolder: {},
          autoNameLanes: true,
          contextFiles: { claude, agents: !claude },
          headroom: false,
        },
        h.context(),
      )
      await runtime.start({ repository: repo })
    }
    expect(spawns.mock.calls.map(([, options]) => options.env?.[CONTEXT_FILES_ENV])).toEqual([
      'claude=off',
      'agents=off',
    ])
  } finally {
    await runtime.drain('test over')
    h.close()
  }
})
