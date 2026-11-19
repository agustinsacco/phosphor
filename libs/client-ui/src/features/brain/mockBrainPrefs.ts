import { checkBrainNeverRead, setBrainLaneNeverRead, type BrainPrefs } from '@shared/brain'

/** Mock settings enforce the same exclusion bounds as Desktop. */
export function mockBrainPrefs(channel: string, args: unknown[], prefs: BrainPrefs): BrainPrefs {
  if (channel === 'brain:neverRead')
    return setBrainLaneNeverRead(prefs, args[0] as string, args[1] as boolean)
  const next = args[0] as BrainPrefs
  return { ...next, neverRead: checkBrainNeverRead(next.neverRead) }
}
