import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { BrainSurfaceAuthority } from '../../../api/brain-adapter'
import { createBrainAgentBinding } from '../binding'
import { createBrainAgentConversation } from '../conversation'
import { createBrainAgentLaunchProfile, type QualifiedInteractiveLaunch } from '../profile'
import { fakeReservedLane, SYNTHETIC_MODEL } from './reserved-fake'

/**
 * Synthetic, for tests only: a launch the tests declare qualified, matched by the fake's
 * synthetic model. No production launch qualifies (`production.ts` passes none).
 */
export const SYNTHETIC_QUALIFIED_LAUNCH: QualifiedInteractiveLaunch = {
  matches: (state) => state.model?.provider === SYNTHETIC_MODEL.provider,
}

export interface ConversationSetupOptions {
  guard?: string | null
  loadsGuard?: boolean
  /** Defaults to the synthetic qualified launch; null is production's profile. */
  qualified?: QualifiedInteractiveLaunch | null
}

/** One conversation over a synthetic reserved lane, in its own folder under `dir`. */
export function setupConversation(dir: string, options: ConversationSetupOptions = {}) {
  const at = mkdtempSync(join(dir, 'host-'))
  const guard = options.guard === undefined ? join(at, 'brain-agent-guard.mjs') : options.guard
  const qualified = options.qualified === undefined ? SYNTHETIC_QUALIFIED_LAUNCH : options.qualified
  const profile = createBrainAgentLaunchProfile(guard, qualified)
  const folder = join(at, 'Brain')
  const sessionsRoot = join(at, 'sessions')
  const lane = fakeReservedLane(profile, {
    loadsGuard: options.loadsGuard ?? true,
    directory: sessionDirForCwd(folder, sessionsRoot),
  })
  const bindingFile = join(at, 'agent-lane.json')
  const conversation = createBrainAgentConversation({
    reserved: lane.reserved,
    binding: createBrainAgentBinding(bindingFile),
    folder,
    sessionsRoot,
    profile,
    log: () => {},
  })
  return { ...lane, conversation, surface: conversation.surface, bindingFile, folder: at }
}

export type ConversationSetup = ReturnType<typeof setupConversation>

/** A synthetic authenticated person whose authority the test can revoke. */
export function person(label: string) {
  const authority = { allowed: true }
  const caller: BrainSurfaceAuthority = {
    client: { id: randomUUID(), label } as BrainSurfaceAuthority['client'],
    connectionId: randomUUID(),
    admit: () => authority.allowed,
  }
  return { caller, authority }
}

/** Waits until a named turn runs on the lane. */
export const started = (s: ConversationSetup) =>
  vi.waitFor(() => expect(s.conversation.turnGate()).not.toBeNull())
