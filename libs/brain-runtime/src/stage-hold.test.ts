import { expect, it } from 'vitest'
import { backstopHold, datesIn, strongerHold } from './stage-hold'

const saidAt = Date.UTC(2026, 10, 18, 15) // 18 Nov 2026
const hold = (
  text: string,
  namesPerson = true,
  valid: [number | null, number | null] = [null, null],
) => backstopHold({ text, namesPerson, saidAt, validFrom: valid[0], validTo: valid[1] })

it.each([
  'Rina Okafor will be away from Dec 1 to Dec 12.',
  'Harbor freezes deploys on 2026-12-20.',
  'The Ledger cutover happens on 5 January.',
  'As of now Harbor bills weekly.',
  'Harbor is currently migrating to Kestrel.',
  'Ledger still writes to the old bucket.',
  'Harbor ships the export this week.',
  'Kestrel finishes retries this sprint.',
  'PR 412 adds retries to Harbor.',
  'HBR-27 tracks the Ledger migration.',
  '#88 blocks the Harbor release.',
])('marks status, near-term dates and ticket subjects temporary: %s', (text) => {
  expect(hold(text, false)).toBe('temporary')
})

it.each([
  'Harbor uses a distillation step before export.',
  'Kestrel 2.1 drops the legacy webhook format.',
  'Kestrel-2 replaces the Ledger exporter.',
  'Harbor keeps invoices from 2021-11-12 onwards.',
  'Ledger rotates keys every March 3 by policy.',
  'Rina Okafor may 3 times ask for a recap.',
  'Harbor bills per organization, not per user.',
])('leaves lasting facts, version numbers and distant dates unmarked: %s', (text) => {
  expect(hold(text, false)).toBeNull()
})

it('marks a near-term validity window temporary even without a date in the text', () => {
  expect(hold('Harbor bills weekly.', false, [null, saidAt + 10 * 86_400_000])).toBe('temporary')
  expect(hold('Harbor bills weekly.', false, [saidAt - 400 * 86_400_000, null])).toBeNull()
})

it.each([
  'Tom Lee needs his promotion packet for the Staff case.',
  'Mara Voss was upset about a planned team move.',
  'Rina Okafor will be on leave in December.',
  'Tom Lee is calibrated at L5.',
  'Mara Voss has a performance review with Rina Okafor.',
  "Rina Okafor's absence moves the Harbor demo.",
  'Rina Okafor will be away from Dec 1 to Dec 12.',
  'Tom Lee is on vacation until the Ledger launch.',
])('marks remarks about a named person personal: %s', (text) => {
  expect(hold(text)).toBe('personal')
})

it('never marks personal without a named person, and ignores ordinary uses of the words', () => {
  expect(hold('The promotion banner on Harbor is cached.', false)).toBeNull()
  expect(hold('Rina Okafor sets the Harbor log level to debug.')).toBeNull()
  expect(hold('Tom Lee wants reviewers to leave comments in the doc.')).toBeNull()
  expect(hold('Rina Okafor owns Harbor query performance tuning.')).toBeNull()
  expect(hold('Tom Lee wants Harbor to move away from Ledger exports.')).toBeNull()
})

it('reads month-first, day-first and ISO dates, choosing the nearest year when none is given', () => {
  expect(datesIn('Away from Dec 1 to 12th December 2026, back 2027-01-04.', saidAt)).toEqual([
    Date.UTC(2026, 11, 1),
    Date.UTC(2026, 11, 12),
    Date.UTC(2027, 0, 4),
  ])
  expect(datesIn('Ships Jan 5.', saidAt)).toEqual([Date.UTC(2027, 0, 5)])
})

it('lets personal outrank temporary', () => {
  expect(strongerHold('temporary', 'personal')).toBe('personal')
  expect(strongerHold(null, 'temporary')).toBe('temporary')
  expect(strongerHold(null, null)).toBeNull()
})
