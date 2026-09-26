import { describe, expect, it } from 'vitest'
import { isNewerVersion, meetsMinimum } from './version'

describe('isNewerVersion', () => {
  it('detects a newer release', () => {
    expect(isNewerVersion('0.4.4', '0.4.3')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
  })

  it('is false for same or older', () => {
    expect(isNewerVersion('0.4.3', '0.4.3')).toBe(false)
    expect(isNewerVersion('0.4.2', '0.4.3')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
  })

  it('treats a prerelease as older than its release', () => {
    // A dev build must not offer itself as an update to the release.
    expect(isNewerVersion('0.4.4-dev.0', '0.4.4')).toBe(false)
    expect(isNewerVersion('0.4.4', '0.4.4-dev.0')).toBe(true)
  })

  it('tolerates ragged version lengths', () => {
    expect(isNewerVersion('1.2', '1.1.9')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.2')).toBe(false)
  })
})

describe('isNewerVersion — cases inherited from the updater', () => {
  it('compares numerically, not lexicographically', () => {
    // The bug this exists to prevent: "0.1.9" > "0.1.10" as strings would
    // strand every user on the ninth release forever.
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true)
    expect(isNewerVersion('0.1.9', '0.1.10')).toBe(false)
  })

  it('is false for the same version', () => {
    expect(isNewerVersion('0.1.42', '0.1.42')).toBe(false)
  })

  it('tolerates a leading v and missing segments', () => {
    expect(isNewerVersion('v0.2.0', '0.1.99')).toBe(true)
    expect(isNewerVersion('0.2', '0.1.99')).toBe(true)
  })

  it('refuses to claim an update on malformed input', () => {
    // A corrupt latest-*.yml must not trigger a phantom update prompt.
    expect(isNewerVersion('not-a-version', '0.1.0')).toBe(false)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.1', 'garbage')).toBe(false)
  })
})

describe('meetsMinimum', () => {
  it('passes the minimum and anything after it, numerically', () => {
    expect(meetsMinimum('0.9.0', '0.9.0')).toBe(true)
    expect(meetsMinimum('0.9.1', '0.9.0')).toBe(true)
    expect(meetsMinimum('0.10.0', '0.9.0')).toBe(true)
    expect(meetsMinimum('1.0.0', '0.9.0')).toBe(true)
  })

  it('fails anything older', () => {
    expect(meetsMinimum('0.8.3', '0.9.0')).toBe(false)
    expect(meetsMinimum('0.8.10', '0.9.0')).toBe(false)
  })

  it('fails what it cannot vouch for, even when it looks newer', () => {
    expect(meetsMinimum(undefined, '0.9.0')).toBe(false)
    expect(meetsMinimum('', '0.9.0')).toBe(false)
    expect(meetsMinimum('0.9.0-rc.1', '0.9.0')).toBe(false)
    expect(meetsMinimum('1.0.0-beta', '0.9.0')).toBe(false)
    expect(meetsMinimum('v1.0.0', '0.9.0')).toBe(false)
    expect(meetsMinimum('1.0', '0.9.0')).toBe(false)
    expect(meetsMinimum('latest', '0.9.0')).toBe(false)
  })
})
