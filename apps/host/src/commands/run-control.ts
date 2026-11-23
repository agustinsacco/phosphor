import type { KeyObject } from 'node:crypto'
import { randomInt } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { parseHeartbeatResponse } from '@phosphor/shared/control-api'
import type { Receipt } from '@phosphor/shared/host-protocol'
import { createAuthority, type Authority } from '../api/authority'
import { startApi } from '../api/server'
import type { ControlClient } from '../control/client'
import { prepareControl, withCommandLock } from '../control/command'
import { createControlLink, type ControlLink, type ControlLinkPorts } from '../control/link'
import { REMOVED, createHeartbeat, createSequenceStore } from '../control/heartbeat'
import type { HostIdentity } from '../control/identity'
import type { LaneService } from '../lanes/service'
import type { HostClaudeAccounts } from '../providers/accounts'
import type { HostWebPush, WebPushOptions } from '../push/web-push'
import { healthWriter } from '../update/health'
import { HOST_VERSION } from '../version'
import type { RunContext } from './run'
import { runReadiness, startRunWebPush } from './run-administration'
import type { RunConfig } from './run-state'
import type { RunParts } from './run-teardown'

/** Where receipts and presence go. The store opens before the API, so the API fills it in later. */
export interface ReceiptSink {
  deliver(clientId: string, receipt: Receipt, connectionId?: string): void
  isConnected(clientId: string): boolean
}

export function createReceiptSink(): ReceiptSink {
  return { deliver: () => {}, isConnected: () => false }
}

/** An enrolled Host's link to control: its client, identity and signing key. */
export interface EnrolledControl {
  client: ControlClient
  url: string
  identity: HostIdentity
  key: KeyObject
  /** The identity folder, which holds the heartbeat sequence. */
  directory: string
  authority: Authority
}

/** Starts Web Push for a machine's lanes; the machine supplies its lanes topic and receipts. */
export type StartWebPush = (
  options: Pick<WebPushOptions, 'lanesTopic' | 'receipt'> & {
    log: Parameters<typeof startRunWebPush>[1]['log']
  },
) => Promise<HostWebPush | undefined>

export function runWebPush(context: RunContext, control: EnrolledControl): StartWebPush {
  return (options) =>
    startRunWebPush(context, {
      identity: control.identity,
      controlUrl: control.url,
      authority: control.authority,
      ...options,
    })
}

/** Starts the TCP API. It binds only once a heartbeat has been accepted. */
export function startRunApi(
  context: RunContext,
  parts: RunParts,
  sink: ReceiptSink,
  options: { control: EnrolledControl; config: RunConfig; epoch: string; lanes?: LaneService },
) {
  const { control, config } = options
  parts.api = startApi({
    runtimeEpoch: options.epoch,
    lanes: options.lanes,
    authority: control.authority,
    origin: control.url,
    hostId: control.identity.hostId,
    hostVersion: HOST_VERSION,
    key: control.key,
    port: config.config.api?.port,
    webOrigin: config.config.api?.webOrigin,
    fetch: context.fetch,
    log: (event: string, fields: Record<string, unknown>) => context.log?.('host', event, fields),
  })
  sink.deliver = parts.api.deliver
  sink.isConnected = parts.api.isConnected
}

/** The heartbeat loop. An accepted running beat writes run.json and opens the authority. */
export function createRunHeartbeat(
  context: RunContext,
  options: {
    control: EnrolledControl
    config: RunConfig
    stateDirectory: string
    accounts: HostClaudeAccounts | undefined
  },
) {
  const { control, config } = options
  let endpoint: string | null = null
  let routeState = ''
  const accepted = healthWriter(
    options.stateDirectory,
    context.uid,
    HOST_VERSION,
    context.now ?? Date.now,
  )
  return createHeartbeat({
    endpoint: () => endpoint,
    onAccepted: control.authority.accept,
    onRemoved: control.authority.remove,
    now: context.now ?? Date.now,
    wait: context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal })),
    random: context.heartbeat?.random ?? (() => randomInt(3001) / 3000),
    client: async (body, signal) => {
      context.log?.('host', 'heartbeat', { seq: body.seq, state: body.state, trace: context.trace })
      const answer = await control.client.heartbeat(
        control.identity.hostId,
        control.key,
        body,
        signal,
      )
      if (body.state === 'running' && !signal.aborted && parseHeartbeatResponse(answer).ok)
        accepted()
      return answer
    },
    readiness:
      context.heartbeat?.readiness ??
      (() =>
        runReadiness(config.config, context, options.accounts, (found) => {
          endpoint = found.endpoint
          if (routeState !== found.state) {
            routeState = found.state
            context.log?.('host', 'tailscale.endpoint', { state: found.state })
          }
        })),
    seq:
      context.heartbeat?.seq ??
      createSequenceStore(control.directory, context.uid, control.identity.hostId),
    hostVersion: HOST_VERSION,
    signal: context.signal,
    log: (line) => {
      const retry = /^retrying in ([0-9.]+)s$/.exec(line)
      context.log?.('host', line === REMOVED ? 'removed' : retry ? 'retry' : 'state', {
        state: line,
        trace: context.trace,
        ...(line === REMOVED ? { exitCode: 77 } : {}),
        ...(retry ? { delayMs: Number(retry[1]) * 1000 } : {}),
      })
      context.print(line)
    },
  })
}

/** The control link over run's API and heartbeat. In local mode a 410 stops only the TCP API. */
export function createRunLink(
  context: RunContext,
  parts: RunParts,
  sink: ReceiptSink,
  options: {
    initial: EnrolledControl | null
    /** The local-mode marker exists: a 410 keeps the lanes. */
    local: boolean
    /** The local daemon's in-process enrollment; absent for a headless Host. */
    enroll?: ControlLinkPorts<EnrolledControl>['enroll']
    directory: string
    config: RunConfig
    epoch: string
    stateDirectory: string
    lanes?: LaneService
    accounts?: HostClaudeAccounts
  },
): ControlLink {
  const { config, stateDirectory, accounts } = options
  const now = context.now ?? Date.now
  return createControlLink<EnrolledControl>(
    {
      local: options.local,
      load: async () => {
        const found = await withCommandLock(context, () => prepareControl(context))
        if (!found.loaded) return null
        const { client, url } = found
        const authority = createAuthority(now)
        return { ...found.loaded, client, url, directory: options.directory, authority }
      },
      connect: (control) => {
        startRunApi(context, parts, sink, {
          control,
          config,
          epoch: options.epoch,
          lanes: options.lanes,
        })
        return createRunHeartbeat(context, { control, config, stateDirectory, accounts })
      },
      disconnect: async () => {
        await parts.api?.stop()
      },
      enroll: options.enroll,
      now,
      wait: context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal })),
      log: (event, fields) => context.log?.('host', event, fields),
    },
    options.initial,
  )
}
