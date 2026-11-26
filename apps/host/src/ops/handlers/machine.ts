import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import {
  dataResult,
  fields,
  modelColumns,
  op,
  pageInventory,
} from '@phosphor/session-runtime/ops/results'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import { runServiceUpdate } from '../service-update'
import { HOST_VERSION } from '../../version'
import type { DaemonHandlerDeps } from './index'
import { projectId, settingsOps } from './settings-access'
import { resourceCall } from './resources-call'
import { laneCall } from './lane-target'
import { laneIdOfRef } from '../lane-ref'
import { CLAUDE_CLI_PROVIDER } from '../../machine/providers'

import { isLiveActivity } from '@phosphor/shared/host-protocol/lanes'
import {
  machineRecord,
  parseMachineProviders,
  parseMachineModelList,
  type MachineProvider,
} from '@phosphor/shared/host-protocol-machine'

function machineInventory(deps: DaemonHandlerDeps) {
  return {
    'machine.models': op<{ provider?: string }>(async ({ provider }, c) => {
      const answer = await laneCall(deps.lanes, 'machine.models', {})
      const list = parseMachineModelList(answer)
      if (!list) throw new OpRefusal('unavailable', 'Model inventory unavailable.')
      return pageInventory(
        list.models.filter((m) => !provider || m.provider === provider),
        c,
        modelColumns,
        {
          wrap: (models) => ({ ...(machineRecord(answer) ? answer : list), models }),
        },
      )
    }),
    'machine.providers': op(async (_, c) => {
      const list = (await laneCall(deps.lanes, 'machine.providers', {})) as {
        providers: MachineProvider[]
      }
      return pageInventory(list.providers, c, fields('id', 'name', 'status'), {
        wrap: (providers) => ({ ...list, providers }),
      })
    }),
  }
}

export function machineHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    ...machineInventory(deps),
    'machine.status': op(() => {
      const lanes = deps.store.listLanes()
      const summaries = lanes.flatMap((l) => deps.laneRuntime?.summaryFor(l.laneId) ?? [])
      const live = summaries.filter((s) => isLiveActivity(s.activity))
      return dataResult({
        hostVersion: HOST_VERSION,
        lanes: {
          total: lanes.length,
          live: live.length,
          working: live.filter((s) => s.activity === 'working').length,
        },
        pause: deps.pauseState?.() ?? { kind: 'none' },
        ...(deps.machineUpdate || deps.pauseControl
          ? {
              update: {
                ...deps.machineUpdate?.report(),
                ...(deps.pauseControl ? { pauseControl: true } : {}),
              },
            }
          : {}),
      })
    }),
    'machine.doctor': op(() =>
      dataResult({
        ...(deps.machineHealth?.() ?? { pi: 'unknown', control: 'unknown' }),
        service: deps.pauseState?.() ?? { kind: 'none' },
        shellEnvironment: deps.shellEnvironment?.status() ?? { status: 'not-used' },
      }),
    ),
    'machine.usage': machineUsage(deps),
    'machine.commands': machineCommands(deps),
    'machine.refreshEnvironment': refreshEnvironment(deps),
    'service.pause': op<{ action: 'abort-now' | 'cancel' }>(({ action }, ctx) => {
      if (ctx.principal.kind !== 'surface')
        throw new OpRefusal('forbidden', 'Only a person can control this update.')
      if (!deps.pauseControl?.(action))
        throw new OpRefusal('unavailable', 'The service is no longer waiting to pause.')
      return {
        text:
          action === 'cancel' ? 'Update cancelled. Nothing changed.' : 'Stopping working turns.',
      }
    }),
    'service.update': op(() => {
      const update = deps.serviceUpdate
      if (!update)
        throw new OpRefusal(
          'unavailable',
          'This Phosphor service cannot update itself: it was not installed from a release.',
        )
      return runServiceUpdate(update)
    }),
  }
}

/** Commands for the named project, else the asking lane's repository, else the machine. */
function machineCommands(deps: DaemonHandlerDeps) {
  return op(async (args, ctx) => {
    const laneId = ctx.lane && laneIdOfRef(ctx.lane.ref)
    const repoId =
      args.project === undefined
        ? laneId
          ? deps.store.getLane(laneId)?.repositoryId
          : undefined
        : projectId(deps, args.project, ctx)
    const params = repoId ? { repositoryId: repoId } : {}
    const list = (await resourceCall(deps, 'machine.commands', params, ctx.signal)) as {
      commands: { name: string; source: string; description?: string }[]
    }
    return pageInventory(list.commands, ctx, fields('name', 'source', 'description'), {
      wrap: (commands) => ({ ...list, commands }),
    })
  })
}

function refreshEnvironment(deps: DaemonHandlerDeps) {
  return op(async () => {
    const shell = deps.shellEnvironment
    if (!shell)
      throw new OpRefusal(
        'unsupported',
        'Shell refresh is unavailable on this binding: it does not read a login-shell environment.',
      )
    if (!(await shell.refresh()))
      throw new OpRefusal(
        'unavailable',
        'Could not refresh the login-shell environment. Lanes keep the last one that worked.',
      )
    return {
      text: 'Read the login-shell environment again. New lanes start with it.',
      data: { shellEnvironment: 'refreshed' },
    }
  })
}

function machineUsage(deps: DaemonHandlerDeps) {
  return op(async (_args, ctx) => {
    const settings = settingsOps(deps).settings
    const [accountsResult, providersResult, codexResult] = await Promise.allSettled([
      settings.usageAccounts(ctx.signal),
      resourceCall(deps, 'machine.providers', {}, ctx.signal),
      settings.codexUsage?.(),
    ])
    const accounts = accountsResult.status === 'fulfilled' ? accountsResult.value : []
    const rawProviders =
      providersResult.status === 'fulfilled'
        ? (providersResult.value as { providers?: unknown }).providers
        : undefined
    const codex = codexResult.status === 'fulfilled' ? codexResult.value : undefined
    const readiness = parseMachineProviders(rawProviders) ?? []
    if (codex?.ok && !readiness.some((p) => p.id === 'openai-codex'))
      readiness.push({ id: 'openai-codex', name: 'Codex', status: 'ready' })
    const providers = readiness.map((provider) => ({
      ...provider,
      usage:
        provider.id === CLAUDE_CLI_PROVIDER && accounts.length > 0
          ? 'see Claude accounts'
          : provider.id === 'openai-codex' && codex?.ok
            ? codex.snapshot
            : 'usage not available',
    }))
    const text = [
      ...accounts.map(
        (a) =>
          `${a.label}: ${a.status === 'ok' ? a.windows.map((w) => `${w.label} ${w.percentUsed}%`).join(', ') : a.reason}`,
      ),
      ...providers.map(
        (p) =>
          `${p.name}: ${p.status} (${typeof p.usage === 'string' ? p.usage : p.usage.windows.map((w) => `${w.label} ${w.percentUsed}%`).join(', ') || 'usage available'})`,
      ),
      ...(accountsResult.status === 'rejected' ? ['Claude account metadata is unavailable.'] : []),
      ...(providersResult.status === 'rejected' ? ['Provider readiness could not be read.'] : []),
    ].join('\n')
    if (
      !codex?.ok &&
      !accounts.some((a) => a.status === 'ok') &&
      !providers.some((p) => p.id !== CLAUDE_CLI_PROVIDER && p.status !== 'unknown')
    )
      throw new OpRefusal('unavailable', `No provider usage could be read. ${text}`.trim())
    return { text, data: { accounts, providers } }
  })
}
