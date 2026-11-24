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

it.each([
  'Harbor uses Ledger for now.',
  'Harbor keeps the endpoint until Friday.',
  'Kestrel keeps the old queue until next tue.',
  'Harbor pauses exports until March.',
  'Ledger keeps the old bucket until the end of June.',
  'Kestrel keeps the old queue until 2027-06-01.',
  'Harbor holds refunds until 3 August.',
  'Ledger stays read-only until further notice.',
  'Kestrel moves to the new queue this quarter.',
  'Harbor temporarily routes invoices through Ledger.',
  'Ledger keeps the old schema for the time being.',
])('regression: marks wording that puts an end in sight temporary: %s', (text) => {
  expect(hold(text, false)).toBe('temporary')
})

it.each([
  'Tom Lee is taking leave.',
  'Rina Okafor took leave after the Harbor launch.',
  'Mara Voss starts parental leave in the spring.',
  'Rina Okafor is on sick leave.',
  "Tom Lee's performance is below expectations.",
  "Tom Lee's performance has not met the team's expectations.",
  'Mara Voss is on a performance improvement plan.',
  'Mara Voss has a performance PIP with Rina Okafor.',
  "Tom Lee's performance came up in his review.",
])('regression: marks leave and performance remarks about a named person personal: %s', (text) => {
  expect(hold(text)).toBe('personal')
})

it.each([
  'Harbor waits until Kestrel 2.1 to drop the webhook.',
  'Harbor runs distillation before every export.',
  'Harbor retries until the Ledger queue drains.',
  'Ledger waits until marketing approves the copy.',
  'Kestrel runs until saturation, then sheds load.',
])(
  'leaves version numbers, words that contain a trigger and open-ended waits unmarked: %s',
  (text) => {
    expect(hold(text, false)).toBeNull()
  },
)

it.each([
  "Tom Lee says Harbor's query performance is below expectations.",
  'Rina Okafor set a performance budget for Harbor.',
  "Tom Lee reviews Harbor's query performance.",
  "Rina Okafor tracks Harbor's query performance issues.",
  'Mara Voss runs the database performance review for Ledger.',
])('never marks technical performance personal, even in a claim naming a person: %s', (text) => {
  expect(hold(text)).toBeNull()
})

it('keeps a lasting handover with a near start date', () => {
  expect(
    hold('Tom Lee takes over Ledger billing on 2027-01-05.', true, [Date.UTC(2027, 0, 5), null]),
  ).toBeNull()
})
