import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { externalToolInfo, parseExternalToolMarker } from './transcriptRows'
import { summarizeExternalTool } from '../tools/toolSummaries'

/**
 * Every `[Claude Code · …]` marker from one real lane's turn, replayed.
 *
 * The capture is the point. Nine rows of that turn rendered on screen as a
 * bare "Claude Code Bash" with no command at all, because the provider's
 * preview cap lands at 142 characters and `Bash` carries a single `command`
 * argument — cut the value and the pair scan has nothing complete to find.
 * Synthetic fixtures kept missing it: hand-written markers are short enough
 * to survive the cap.
 */
const MARKERS: string[] = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'claude-cli-markers.json'), 'utf8'),
) as string[]

const WORKSPACE =
  '/Users/agustinsacco/Phosphor/.phosphor/worktrees/orchestrators-of-workspaces-should-not'

describe('real Claude Code markers from a live lane', () => {
  it('has a corpus that actually exercises the cap', () => {
    const capped = MARKERS.filter((m) => m.endsWith('…]'))
    expect(MARKERS.length).toBeGreaterThan(20)
    // If this ever drops to zero the fixture stopped testing the hard case.
    expect(capped.length).toBeGreaterThan(10)
  })

  it('recovers a command for every Bash marker, capped or not', () => {
    const bare: string[] = []
    for (const marker of MARKERS) {
      const parsed = parseExternalToolMarker(marker)
      expect(parsed, `marker did not parse: ${marker.slice(0, 60)}`).not.toBeNull()
      if (parsed!.name !== 'Bash') continue

      const summary = summarizeExternalTool(
        parsed!.name,
        externalToolInfo(parsed!.name, parsed!.args).fields,
        WORKSPACE,
      )
      expect(summary.label).toBe('Ran')
      if (summary.object === 'a command') bare.push(marker)
    }
    expect(bare, `rows still rendering with no command:\n${bare.join('\n')}`).toEqual([])
  })

  it('never leaks marker syntax or raw JSON into a row label', () => {
    for (const marker of MARKERS) {
      const parsed = parseExternalToolMarker(marker)!
      const summary = summarizeExternalTool(
        parsed.name,
        externalToolInfo(parsed.name, parsed.args).fields,
        WORKSPACE,
      )
      const label = `${summary.label} ${summary.object ?? ''} ${summary.hint ?? ''}`
      expect(label).not.toContain('[Claude Code ·')
      expect(label).not.toContain('{"')
      expect(label).not.toContain('\\"')
    }
  })

  it('keeps every label to one line and within the truncation budget', () => {
    for (const marker of MARKERS) {
      const parsed = parseExternalToolMarker(marker)!
      const summary = summarizeExternalTool(
        parsed.name,
        externalToolInfo(parsed.name, parsed.args).fields,
        WORKSPACE,
      )
      if (!summary.object) continue
      expect(summary.object).not.toContain('\n')
      expect(summary.object.length).toBeLessThanOrEqual(65)
    }
  })
})
