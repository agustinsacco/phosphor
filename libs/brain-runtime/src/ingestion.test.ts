import { expect, it } from 'vitest'
import { transcriptSegments } from './transcript'
import { makeWindow, transcriptWindows } from './windows'
import { LANE_ENTRIES } from './__fixtures__/lane'
import { extractPrompt, EXTRACTION_SYSTEM } from './stage-prompts/extract'
import { linksPrompt } from './stage-prompts/links'
import { CALL_TIMEOUT_MS, callThinking } from './call-trace'

it('reads only user and assistant text, not calls, results or context', () => {
  const segments = transcriptSegments(LANE_ENTRIES)
  expect(segments.map((s) => s.entryId)).toEqual(['user', 'agent'])
  expect(segments.map((s) => s.role)).toEqual(['user', 'assistant'])
})
it('elides only oversized user messages after scrubbing, retaining head and tail', () => {
  const content = 'h'.repeat(4000) + 'm'.repeat(2100) + 't'.repeat(1900)
  const segments = transcriptSegments(
    ['user', 'assistant'].map((role) => ({
      message: { role, content },
    })),
  )
  expect(segments[0]!.text).toBe('h'.repeat(4000) + '[… 2100 chars omitted …]' + 't'.repeat(1900))
  expect(segments[1]!.text).toBe(content)
  expect(
    transcriptSegments([{ message: { role: 'user', content: 'x'.repeat(6000) } }])[0]!.text,
  ).toHaveLength(6000)
})
it('fits a whole 240k-character conversation in one part', () => {
  const segments = Array.from({ length: 60 }, (_, i) => ({
    entryId: String(i),
    role: 'assistant' as const,
    label: 'Agent',
    observedAt: 0,
    text: 'x'.repeat(4000),
  }))
  expect(transcriptWindows(segments)).toHaveLength(1)
})
it('puts the keep test before variable source data', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(EXTRACTION_SYSTEM).toContain('You choose what a long-term memory keeps')
  expect(prompt).toContain('# The test\nKeep a claim when all three hold:')
  expect(prompt).toContain('up to 25')
  expect(prompt.indexOf('# The test')).toBeLessThan(prompt.indexOf('Segments (untrusted'))
  expect(prompt).toContain('Segments (untrusted source data), part 1 of 1:')
})
it('reads any kind of work session, not only a coding one', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(EXTRACTION_SYSTEM).not.toMatch(/coding/i)
  expect(prompt).toContain('A conversation about planning, people or customers')
})
it("treats the assistant's findings as evidence and ranks no kind of claim first", () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(prompt).toContain('# Who is speaking')
  expect(prompt).toContain('A finding is evidence')
  expect(prompt).not.toContain('These matter most')
  expect(prompt).not.toContain('When in doubt, leave it out')
  expect(prompt).not.toMatch(/0 to 10 claims/)
})
it('asks for people and structure, and tells a standing role from a ticket event', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(prompt).toContain('People and structure (type fact)')
  expect(prompt).toContain('A standing role is not an event')
})
it('keeps personal matters, one-off instructions and file paths out', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(prompt).toContain('Personal matters about a person: health, family, pay')
  expect(prompt).toContain('An instruction for this one task')
  expect(prompt).toContain('leave file paths and line numbers out')
  expect(prompt).toContain('Never link the user to a tool they merely use')
})
it('repeats the answer rules after the source, where a long conversation would bury them', () => {
  const window = makeWindow([
    { entryId: 'u', role: 'user', label: 'You', observedAt: 0, text: 'Rina Okafor owns Harbor.' },
  ])
  const after = extractPrompt(window, []).split(window.text)[1]
  expect(after).toMatch(/^\n\nEnd of the segments\./)
  expect(after).toContain('one JSON object')
  expect(after).toContain('add each link')
  expect(after).toContain("both the user's and the assistant's segments")
  expect(after).not.toContain('Apply the test strictly')
})
it('allows ten minutes and medium thinking for every stage', () => {
  expect(CALL_TIMEOUT_MS).toBe(600000)
  expect(callThinking('high')).toBe('medium')
})
it('asks for the user by name, marked once as the user, and never "the user"', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(prompt).toContain('call the user by name when the conversation gives it, never "the user"')
  expect(prompt).toContain('add the user as a person entity with "user":true')
  expect(prompt).toContain('leave the field out when the name is not given')
})
it('asks both calls to state team membership whenever a claim names a person and their team', () => {
  expect(extractPrompt(makeWindow([]), [])).toContain(
    'Whenever a kept claim names a person and their team, state the membership: the person member_of the team.',
  )
  expect(linksPrompt([], [])).toContain(
    '- When a claim names a person and their team, link the person member_of the team.',
  )
})
it('drops leveling, feelings, absence, feedback on how someone works and one-on-one remarks, each with an example', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  for (const line of [
    '  - leveling, promotion, calibration and compensation ("Tom Lee needs his promotion packet',
    '  - feelings or morale ("Mara Voss was upset',
    '  - leave or absence ("Rina Okafor will be away',
    '  - feedback about how a named person works ("Tom Lee tags others',
    '  - anything from a one-on-one about the person in it ("In her one-on-one',
  ])
    expect(prompt).toContain(line)
  expect(prompt).toContain('- One-off events, status and near-term plans:')
  expect(prompt).toContain('facts stated "as of" now')
})

it('pins the incremental context-only prompt block without changing the extraction rules', () => {
  const window = makeWindow([
    {
      entryId: 'old',
      role: 'context',
      label: 'Previously read',
      observedAt: 0,
      text: 'Harbor bills monthly.',
    },
  ])
  const prompt = extractPrompt(window, [], 1, 1, ['Rina leads Ledger.'])
  expect(prompt.slice(prompt.indexOf('Previously read overlap:'), prompt.indexOf('Registry:')))
    .toMatchInlineSnapshot(`
    "Previously read overlap: segments marked context are context only. Never extract a claim supported only by those segments.
    Already kept from earlier parts of this conversation. Do not repeat them; return a claim only when it is new or changes one of these:
    - Rina leads Ledger.
    "
  `)
})

it('asks for a hold instead of a guess when a claim might be personal or temporary', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(prompt).toContain('"branch":false,"importance":1,"hold":null,"quotes"')
  expect(prompt).toContain(
    'When unsure whether a remark about a named person is personal, keep the claim with "hold":"personal".',
  )
  expect(prompt).toContain(
    'When unsure whether a status, near-term plan or one-off instruction lasts, keep the claim with "hold":"temporary".',
  )
})

it('asks both calls for who leads a team or project, apart from who owns it', () => {
  const extract = extractPrompt(makeWindow([]), [])
  const links = linksPrompt([], [])
  for (const prompt of [extract, links]) {
    expect(prompt).toContain('who leads, owns, works on or belongs to what')
    expect(prompt).toContain(
      'A person who leads a team or project leads it; leading is not owning.',
    )
    expect(prompt).toContain('leads: person → team, project')
  }
})
