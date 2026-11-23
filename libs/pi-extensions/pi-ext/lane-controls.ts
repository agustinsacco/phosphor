import type { LaneEffect, OpFacts } from '@phosphor/shared/ops'
import { LANE_PRS_ENTRY, parseLanePrsArgs } from './lane-prs'
import type { SessionEntryApi } from './pi-api'

export interface LaneControl<F> {
  facts(): F
  agentSet(next: boolean, reason: string, ctx: unknown): void | Promise<void>
}
export interface ContextFilesControl extends LaneControl<NonNullable<OpFacts['contextFiles']>> {
  setArgs?(args: string, ctx: unknown): void | Promise<void>
}

type Name = 'swarm' | 'contextFiles'
type Controls = {
  swarm?: LaneControl<NonNullable<OpFacts['swarm']>>
  contextFiles?: ContextFilesControl
}
const slot = Symbol.for('phosphor/lane-controls/v1')
const slots = globalThis as { [slot]?: Map<string, Controls> }
const restart = 'This lane must restart to load that control.'

/** Each -e entry is a separate module instance, including after a reload. */
export function registerLaneControl<F>(
  sessionKey: string,
  name: Name,
  control: LaneControl<F>,
): () => void {
  const registry = (slots[slot] ??= new Map())
  const controls = registry.get(sessionKey) ?? {}
  Object.assign(controls, { [name]: control })
  registry.set(sessionKey, controls)
  return () => {
    if (controls[name] !== control) return
    delete controls[name]
    if (!Object.keys(controls).length) registry.delete(sessionKey)
  }
}

export function laneControlFacts(sessionKey: string): OpFacts {
  const controls = slots[slot]?.get(sessionKey)
  return {
    ...(controls?.swarm && { swarm: controls.swarm.facts() }),
    ...(controls?.contextFiles && { contextFiles: controls.contextFiles.facts() }),
  }
}

export async function applyLaneEffect(
  effect: LaneEffect,
  pi: SessionEntryApi,
  ctx: {
    sessionManager: { getSessionId(): string }
    ui: { notify(message: string, level: 'info' | 'warning'): void }
  },
): Promise<void> {
  const controls = slots[slot]?.get(ctx.sessionManager.getSessionId())
  switch (effect.kind) {
    case 'swarm':
      if (!controls?.swarm) throw new Error(restart)
      return controls.swarm.agentSet(effect.enabled, effect.reason, ctx)
    case 'contextFiles':
      if (!controls?.contextFiles?.setArgs) throw new Error(restart)
      return controls.contextFiles.setArgs(effect.args, ctx)
    case 'pr':
      pi.appendEntry(LANE_PRS_ENTRY, parseLanePrsArgs(`${effect.action} ${effect.url}`))
      return
    case 'notify':
      ctx.ui.notify(effect.message, effect.level)
  }
}
