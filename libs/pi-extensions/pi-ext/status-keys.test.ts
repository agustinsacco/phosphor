import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SWARM_COMMAND, SWARM_STATUS_KEY } from './swarm'
import { LANE_RELOAD_COMMAND, LANE_RELOAD_STATUS_KEY } from './lane-reload'
import { HEADROOM_STATUS_KEY } from './headroom'
import { SNAPSHOT_COMMAND, SNAPSHOT_WIDGET, SNAPSHOT_PREFIX } from './subagent-snapshot'
import { CONTEXT_FILES_COMMAND } from './context-files'
import contextBudget from './context-budget'
import { CONTEXT_BREAKDOWN_STATUS_KEY } from '../../client-ui/src/features/chat/composer/contextBreakdown'
import { RATE_LIMIT_STATUS_KEY } from '../../client-ui/src/features/chat/composer/rateLimit'
import { SUBAGENTS_STATUS_KEY } from '../../client-ui/src/features/chat/subagentStatus'
import {
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_INSPECT_WIDGET_KEY,
  parseFleetWidget,
} from '../../client-ui/src/features/chat/subagentRuns'

const goldenInventory = {
  SWARM_STATUS_KEY: 'phosphor-swarm',
  CONTEXT_BREAKDOWN_STATUS_KEY: 'phosphor-context-breakdown',
  LANE_RELOAD_STATUS_KEY: 'phosphor-reload',
  HEADROOM_STATUS_KEY: 'phosphor-headroom',
  RATE_LIMIT_STATUS_KEY: 'claude-rate-limit',
  SUBAGENTS_STATUS_KEY: 'claude-subagents',
  SUBAGENT_ASYNC_WIDGET_KEY: 'subagent-async',
  SUBAGENT_INSPECT_WIDGET_KEY: 'subagent-inspect',
  SUBAGENT_ASYNC_WIDGET_PREFIX: 'PI_SUBAGENT_ASYNC_JSON:',
  SUBAGENT_INSPECT_WIDGET_PREFIX: 'PI_SUBAGENT_INSPECT_JSON:',
  SNAPSHOT_WIDGET: 'phosphor-subagent-save',
  SNAPSHOT_PREFIX: 'PHOSPHOR_SUBAGENT_SAVE:',
  CONTEXT_BUDGET_COMMAND: 'phosphor-context-budget',
  CONTEXT_FILES_COMMAND: 'phosphor-context-files',
  SNAPSHOT_COMMAND: 'phosphor-save-subagent-snapshot',
  SWARM_COMMAND: 'phosphor-swarm',
  LANE_RELOAD_COMMAND: 'phosphor-reload',
} as const

const root = resolve(import.meta.dirname, '../../..')
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('status-keys existing wire inventory', () => {
  it('pins the existing producers and app consumers to the literal golden inventory', () => {
    let budgetCommand: string | undefined
    contextBudget({
      on: () => undefined,
      setModel: async () => true,
      registerCommand: (name) => {
        budgetCommand = name
      },
    })
    expect({
      SWARM_STATUS_KEY,
      CONTEXT_BREAKDOWN_STATUS_KEY,
      LANE_RELOAD_STATUS_KEY,
      HEADROOM_STATUS_KEY,
      RATE_LIMIT_STATUS_KEY,
      SUBAGENTS_STATUS_KEY,
      SUBAGENT_ASYNC_WIDGET_KEY,
      SUBAGENT_INSPECT_WIDGET_KEY,
      SUBAGENT_ASYNC_WIDGET_PREFIX: source(
        'libs/client-ui/src/features/chat/subagentRuns.ts',
      ).match(/const ASYNC_WIDGET_PREFIX = '([^']+)'/)?.[1],
      SUBAGENT_INSPECT_WIDGET_PREFIX: source(
        'libs/client-ui/src/features/chat/subagentInspect.ts',
      ).match(/const prefix = '([^']+)'/)?.[1],
      SNAPSHOT_WIDGET,
      SNAPSHOT_PREFIX,
      CONTEXT_BUDGET_COMMAND: budgetCommand,
      CONTEXT_FILES_COMMAND,
      SNAPSHOT_COMMAND,
      SWARM_COMMAND,
      LANE_RELOAD_COMMAND,
    }).toEqual(goldenInventory)
    // The breakdown emitter's key is private to its original entry point.
    expect(source('libs/pi-extensions/pi-ext/context-breakdown.ts')).toContain(
      `const STATUS_KEY = '${goldenInventory.CONTEXT_BREAKDOWN_STATUS_KEY}'`,
    )
  })

  it('accepts the literal async prefix and rejects its lowercase spelling', () => {
    const payload = JSON.stringify({
      kind: 'pi-subagents.async-status-snapshot',
      version: 1,
      generatedAt: 42,
      runs: [],
    })
    expect(parseFleetWidget([goldenInventory.SUBAGENT_ASYNC_WIDGET_PREFIX + payload])).toEqual({
      generatedAt: 42,
      runs: [],
      omittedRuns: 0,
      incomplete: false,
      active: 0,
    })
    expect(
      parseFleetWidget([goldenInventory.SUBAGENT_ASYNC_WIDGET_PREFIX.toLowerCase() + payload]),
    ).toBeNull()
  })
})

describe('status-keys published vocabulary', () => {
  it('exports exactly the frozen inventory through the package subpath', async () => {
    const vocabulary = await import('@phosphor/pi-extensions/status-keys')
    expect({ ...vocabulary }).toEqual(goldenInventory)
    expect(
      source('libs/pi-extensions/pi-ext/status-keys.ts').trim().split('\n').length,
    ).toBeLessThanOrEqual(100)
  })

  it('bundles the package subpath for browsers without dependencies or external imports', async () => {
    const { build } = await import('esbuild')
    const result = await build({
      stdin: {
        contents: 'export * from "@phosphor/pi-extensions/status-keys"',
        resolveDir: root,
        sourcefile: 'status-keys-browser-entry.ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
    })
    const inputs = Object.entries(result.metafile.inputs).filter(
      ([path]) => path !== 'status-keys-browser-entry.ts',
    )
    expect(inputs.map(([path]) => path)).toEqual(['libs/pi-extensions/pi-ext/status-keys.ts'])
    expect(inputs[0]?.[1].imports).toEqual([])
    expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([])
    expect(result.outputFiles).toHaveLength(1)
  })
})
