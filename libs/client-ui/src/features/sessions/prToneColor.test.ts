import { describe, expect, it } from 'vitest'
import { PR_TONE_BEAD_CLASSES } from './PrToneGlyph'
import { PR_CHIP_CLASSES } from './prChip'
import { TONE_CHIP, TONE_TEXT } from './pr-inspector/PrIcons'
import { PR_TONE_BAR } from '../notifications/PrNoticeParts'

/**
 * "Closed" and "failing" used to render in the same red, which made an
 * abandoned PR look like a build that needed you. Every place a tone becomes a
 * colour is pinned here so the two never collapse back onto one another.
 */
const EVERYWHERE: Record<string, Record<string, string>> = {
  bead: PR_TONE_BEAD_CLASSES,
  chip: PR_CHIP_CLASSES,
  inspectorText: TONE_TEXT,
  inspectorChip: TONE_CHIP,
}

describe('closed is not failing', () => {
  for (const [name, map] of Object.entries(EVERYWHERE)) {
    it(`${name}: closed carries no danger, failing keeps it`, () => {
      expect(map.closed).not.toMatch(/danger/)
      expect(map.closed).toContain('closed')
      expect(map.failing).toContain('danger')
    })
  }

  it('the notice bar for closed is its own colour, not the failing bar', () => {
    expect(PR_TONE_BAR.closed).toBe('bg-closed')
    expect(PR_TONE_BAR.bad).toBe('bg-danger')
  })

  it('closed is distinct from merged, which is already not success', () => {
    expect(PR_TONE_BEAD_CLASSES.closed).not.toBe(PR_TONE_BEAD_CLASSES.merged)
  })
})
