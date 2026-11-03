import { describe, expect, it } from 'vitest'
import {
  HEADLESS_STANDARD_PACKAGES,
  STANDARD_PACKAGES,
  standardPackageState,
} from './standard-packages'

describe('the standard packages', () => {
  it('offers every package where a desktop session runs, and all but computer use headless', () => {
    expect(STANDARD_PACKAGES.map((entry) => entry.title)).toEqual([
      'Claude Code provider',
      'Web access',
      'Subagents',
      'Computer use',
    ])
    expect(HEADLESS_STANDARD_PACKAGES.map((entry) => entry.name)).toEqual([
      '@saccolabs/pi-claude-cli',
      'pi-web-access',
      'pi-subagents',
    ])
    for (const entry of STANDARD_PACKAGES) expect(entry.spec).toBe(`npm:${entry.name}`)
  })

  it('matches a machine’s packages by name, so pins and redacted specs still match', () => {
    const pkg = (name: string, installed: boolean) => ({ name, installed })
    expect(standardPackageState('pi-subagents', [])).toBe('absent')
    expect(standardPackageState('pi-subagents', [pkg('pi-subagents', false)])).toBe('declared')
    expect(
      standardPackageState('pi-subagents', [pkg('pi-subagents', false), pkg('pi-subagents', true)]),
    ).toBe('installed')
    // A prefix is not the package.
    expect(standardPackageState('pi-subagents', [pkg('pi-subagents-x', true)])).toBe('absent')
  })
})
