import { describe, expect, it } from 'vitest'
import lanePrs, { LANE_PRS_ENTRY } from '@phosphor/pi-extensions/lane-prs'
import { emptyPrSignals, foldPrEntry, LANE_PR_ENTRY, prSignalsOf } from './lane-pr-signals'

const ref = (number: number) => ({ host: 'github.com', owner: 'acme', repo: 'web', number })
const url = (number: number) => `https://github.com/acme/web/pull/${number}`

/** Run `/phosphor-prs` the way pi does, and write each entry as a session-file line. */
function lane() {
  const lines: string[] = []
  let handler!: (args: string, ctx: unknown) => Promise<void>
  lanePrs({
    appendEntry: (customType, data) =>
      void lines.push(
        JSON.stringify({
          type: 'custom',
          customType,
          data,
          id: `e${lines.length}`,
          parentId: null,
        }),
      ),
    registerCommand: (_name, spec) => {
      handler = spec.handler
    },
  })
  return { lines, run: (args: string) => handler(args, {}) }
}

function signals(lines: string[]) {
  const state = emptyPrSignals()
  for (const line of lines)
    foldPrEntry(state, JSON.parse(line) as Record<string, unknown>, line, { mentions: true })
  return prSignalsOf(state)
}

describe('lane PR overrides, written by the extension and read by the fold', () => {
  it('uses the entry type the fold reads', () => {
    expect(LANE_PRS_ENTRY).toBe(LANE_PR_ENTRY)
  })

  it('folds pins and hides back into pinned and hidden, the last one per PR winning', async () => {
    const l = lane()
    await l.run(`pin ${url(1)}`)
    await l.run(`hide ${url(2)}`)
    await l.run(`pin ${url(3)}`)
    await l.run(`hide ${url(3)}`)
    await l.run(`pin ${url(4)}`)
    await l.run(`clear ${url(4)}`)
    expect(signals(l.lines)).toMatchObject({ pinned: [ref(1)], hidden: [ref(2), ref(3)] })
  })

  it('leaves a lane whose overrides were all cleared with no signals', async () => {
    const l = lane()
    await l.run(`hide ${url(5)}`)
    await l.run(`clear ${url(5)}`)
    expect(signals(l.lines)).toBeUndefined()
  })
})
