import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HARBOR_RECALL } from '@phosphor/brain-client/__fixtures__/recall'
import { registerBrain } from '@phosphor/pi-extensions/brain'
import { sendOp } from '@phosphor/pi-extensions/op-channel'
import type { ToolDefinition } from '@phosphor/pi-extensions/pi-api'
import { parseOpChannelRequest, OP_TITLE } from '@phosphor/shared/ops'
import type { LaneSummary } from '@phosphor/shared/host-protocol'
import { parseOwnerParams } from '@phosphor/shared/host-protocol-owner'
import { BrainAppService } from './app-service'
import { createAppServices } from '../../../host/src/session/app-services'
import { openStore } from '../../../host/src/lanes/store'
import { createOpsService, type OpsService } from '../../../host/src/ops/service'

function piSearch(ops: OpsService, session: string) {
  const tools: ToolDefinition<{ query: string }, unknown, unknown>[] = []
  registerBrain({ registerTool: (tool) => tools.push(tool as (typeof tools)[number]) }, sendOp)
  const ctx = {
    ui: {
      editor: async (title: string, prefill: string) => {
        expect(title).toBe(OP_TITLE)
        const request = parseOpChannelRequest(prefill)
        if (!request || request.op !== 'brain.search') throw new Error('invalid channel request')
        return JSON.stringify(await ops.dispatcher.runFromTool(session, request))
      },
    },
  }
  return () => tools[0]!.execute('tool-id', { query: 'Harbor' }, undefined, undefined, ctx)
}

it('returns a Desktop briefing to the pi tool through the daemon dispatcher, then unavailable after disconnect', async ({
  onTestFinished,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'm8-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const uid = process.getuid?.()
  const stateDirectory = join(dir, 'state')
  const store = await openStore(stateDirectory, uid, {})
  onTestFinished(() => store.close())
  const appServices = createAppServices(stateDirectory, uid)
  const lane = {
    laneId: 'lane',
    cwd: dir,
    title: 'Owner lane',
    activity: 'idle',
    control: { fence: 1, controller: null },
  } as LaneSummary
  const session = 'daemon-session'
  const ops = await createOpsService({
    stateDirectory,
    uid,
    store,
    appServices,
    lanes: {} as never,
    editing: {} as never,
    shellEnvironment: null,
    selfIds: () => ['machine'],
    enrolledId: () => null,
    daemonLanes: { list: () => [lane], sessionFor: () => session, summary: () => lane },
    command: vi.fn(),
    unattended: () => false,
    log: vi.fn(),
  })
  onTestFinished(() => ops.close())
  appServices.attachLane(session, dir)
  const lifetime = new AbortController()
  const desktop = new BrainAppService()
  onTestFinished(() => desktop.dispose())
  const agent = vi.fn(async () => HARBOR_RECALL)
  desktop.install(
    async () => ({
      agent: agent as never,
      recallLaunch: async () => ({ extensions: [], skills: [] }),
    }),
    vi.fn(),
  )
  desktop.ownerChanged({
    snapshot: () => ({ state: 'ready', ownerLocal: true, connectionToken: 'owner', lanes: [] }),
    call: async (method, params) => {
      const reg = parseOwnerParams('app.service.register', params)
      if (method !== 'app.service.register' || !reg) throw new Error('unexpected call')
      return {
        ok: true,
        data: await appServices.handlers['app.service.register'](reg, {
          signal: lifetime.signal,
          connectionId: 'owner',
          client: { id: 'desktop', label: 'Desktop' },
          principal: { kind: 'owner', clientId: 'desktop' },
        }),
      }
    },
  })
  await vi.waitFor(() => expect(appServices.status().brain).toBe('registered'))
  const search = piSearch(ops, session)
  expect((await search()).details).toEqual({ status: 'ok', memories: 1 })
  expect(agent).toHaveBeenCalledWith(
    'search',
    expect.objectContaining({ query: 'Harbor', sessionId: session, cwd: dir }),
  )
  lifetime.abort()
  expect((await search()).details).toEqual({ status: 'unavailable', memories: 0 })
  expect(agent).toHaveBeenCalledTimes(1)
})
