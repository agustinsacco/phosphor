/**
 * The reference model for the relation conservation property test: what each write does to the
 * links of current memories, per design 2.5. Pure data, cloned per step, no engine code.
 */
import {
  BRAIN_SINGLE_VALUED_PREDICATES,
  type BrainPredicate,
  type BrainStatedBy,
} from '@phosphor/shared/brain-links'

export interface LinkSpec {
  s: string
  p: BrainPredicate
  o: string
  label: string
  vf: number | null
  vt: number | null
}
export interface ClaimSpec {
  summary: string
  entities: string[]
  links: LinkSpec[]
  validFrom: number | null
  /** A current memory this claim supersedes. */
  target: string | null
}
/** A citation's evidence: `order` follows evidence insertion, `session` its lane (null: Brain Agent). */
export interface Cited {
  order: number
  session: string | null
}
export interface ModelRelation extends LinkSpec {
  by: BrainStatedBy
  sessions: (string | null)[]
}
export interface ModelMemory {
  id: string
  lane: string | null
  job: string | null
  current: boolean
  validFrom: number | null
  mentions: string[]
  citations: Cited[]
  relations: ModelRelation[]
}
export interface Model {
  memories: ModelMemory[]
  /** Evidence rows inserted so far, so relate can pick a memory's oldest citation. */
  evidence: number
}

const SINGLE = new Set<string>(BRAIN_SINGLE_VALUED_PREDICATES)
const add = <T>(list: T[], value: T): void => {
  if (!list.includes(value)) list.push(value)
}
export const triple = (r: Pick<LinkSpec, 's' | 'p' | 'o'>): string => `${r.s}|${r.p}|${r.o}`
export function memoryOf(model: Model, id: string): ModelMemory {
  const found = model.memories.find((m) => m.id === id)
  if (!found) throw new Error(`Model memory ${id} not found.`)
  return found
}
export function current(model: Model): ModelMemory[] {
  return model.memories.filter((m) => m.current)
}
/** Every name a memory still mentions; cleanOrphans removes the others when touched. */
export function names(model: Model): string[] {
  return [...new Set(model.memories.flatMap((m) => m.mentions))].sort()
}
/** One key per link on a current memory: what the property compares, sorted. */
export function facts(model: Model, detail: boolean): string[] {
  return current(model)
    .flatMap((m) =>
      m.relations.map((r) =>
        detail ? `${triple(r)}|${r.label}|${r.vf}|${r.vt}|${r.by}|live` : triple(r),
      ),
    )
    .sort()
}
function insertMemory(
  model: Model,
  id: string,
  claim: ClaimSpec,
  lane: string | null,
  job: string | null,
  by: BrainStatedBy,
): ModelMemory {
  const order = ++model.evidence
  const memory: ModelMemory = {
    id,
    lane,
    job,
    current: true,
    validFrom: claim.validFrom,
    mentions: [],
    citations: [{ order, session: lane }],
    relations: [],
  }
  for (const name of [...claim.entities, ...claim.links.flatMap((l) => [l.s, l.o])])
    add(memory.mentions, name)
  for (const link of claim.links)
    if (link.s !== link.o && !memory.relations.some((r) => triple(r) === triple(link)))
      memory.relations.push({ ...link, by, sessions: [lane] })
  model.memories.push(memory)
  return memory
}
const live = (r: ModelRelation, now: number): boolean => r.vt === null || r.vt > now
/** The carry rule: every link of `from` the change does not contradict moves to `to`. */
export function carry(
  from: ModelMemory,
  to: ModelMemory,
  endAt: number,
  now: number,
  ends: Set<string> = new Set(),
): void {
  const stated = to.relations.filter((r) => live(r, now))
  for (const r of from.relations) {
    const same = to.relations.find((x) => triple(x) === triple(r))
    if (same) {
      same.label ||= r.label
      same.vf ??= r.vf
      for (const s of r.sessions) add(same.sessions, s)
      continue
    }
    const contradicted =
      ends.has(triple(r)) ||
      stated.some((x) => x.p === r.p && x.o === r.o && x.s !== r.s) ||
      (SINGLE.has(r.p) && stated.some((x) => x.s === r.s && x.p === r.p && x.o !== r.o))
    to.relations.push({
      ...r,
      vt: contradicted ? (r.vt ?? endAt) : r.vt,
      sessions: [...r.sessions],
    })
    add(to.mentions, r.s)
    add(to.mentions, r.o)
  }
  from.current = false
}
/** Lane memories Read again replaces: no support from elsewhere and no agent or owner link. */
export function replaceable(model: Model, lane: string, exceptJob: string): string[] {
  const elsewhere = (s: string | null) => s !== null && s !== lane
  return model.memories
    .filter(
      (m) =>
        m.lane === lane &&
        m.job !== exceptJob &&
        !m.citations.some((c) => elsewhere(c.session)) &&
        !m.relations.some((r) => r.by !== 'reader' || r.sessions.some(elsewhere)),
    )
    .map((m) => m.id)
}
export function remove(model: Model, id: string): void {
  model.memories = model.memories.filter((m) => m.id !== id)
}
export function saveRead(
  model: Model,
  input: { lane: string; job: string; claims: ClaimSpec[]; ids: string[]; now: number },
  reread: boolean,
): void {
  const replaced = reread ? replaceable(model, input.lane, input.job) : []
  input.claims.forEach((claim, i) => {
    const memory = insertMemory(model, input.ids[i]!, claim, input.lane, input.job, 'reader')
    if (claim.target)
      carry(memoryOf(model, claim.target), memory, claim.validFrom ?? input.now, input.now)
  })
  for (const id of replaced) remove(model, id)
}
export function fold(model: Model, source: string, target: string): void {
  const from = memoryOf(model, source),
    to = memoryOf(model, target)
  for (const name of from.mentions) add(to.mentions, name)
  for (const r of from.relations) {
    const same = to.relations.find((x) => triple(x) === triple(r))
    if (same) {
      same.label ||= r.label
      same.vf ??= r.vf
      for (const s of r.sessions) add(same.sessions, s)
    } else to.relations.push({ ...r, sessions: [...r.sessions] })
  }
  for (const c of from.citations)
    if (!to.citations.some((x) => x.order === c.order)) to.citations.push(c)
  to.citations.sort((a, b) => a.order - b.order)
  remove(model, source)
}
/** Entity merge: names re-point; a duplicate absorbs the moved link; a self loop goes (F25). */
export function merge(model: Model, source: string, target: string): void {
  for (const m of model.memories) {
    m.mentions = [...new Set(m.mentions.map((n) => (n === source ? target : n)))]
    const kept = m.relations.filter((r) => r.s !== source && r.o !== source)
    for (const r of m.relations.filter((x) => x.s === source || x.o === source)) {
      const moved = { ...r, s: r.s === source ? target : r.s, o: r.o === source ? target : r.o }
      if (moved.s === moved.o) continue
      const same = kept.find((x) => triple(x) === triple(moved))
      if (same) {
        same.label ||= moved.label
        same.vf ??= moved.vf
        for (const s of moved.sessions) add(same.sessions, s)
      } else kept.push(moved)
    }
    m.relations = kept
  }
}
export function correct(
  model: Model,
  input: { old: string; id: string; links: LinkSpec[]; ends: string[]; now: number },
): void {
  const old = memoryOf(model, input.old)
  const memory = insertMemory(
    model,
    input.id,
    { summary: '', entities: old.mentions, links: input.links, validFrom: null, target: null },
    null,
    null,
    'agent',
  )
  memory.citations = [{ order: memory.citations[0]!.order, session: null }]
  for (const r of memory.relations) r.sessions = [null]
  carry(old, memory, input.now, input.now, new Set(input.ends))
}
export function replace(model: Model, newer: string, older: string, now: number): void {
  const to = memoryOf(model, newer)
  carry(memoryOf(model, older), to, to.validFrom ?? now, now)
}
export function relate(model: Model, host: string, link: LinkSpec): void {
  const memory = memoryOf(model, host)
  const oldest = memory.citations.reduce((a, b) => (b.order < a.order ? b : a))
  memory.relations.push({ ...link, by: 'agent', sessions: [oldest.session] })
}
export function editRelation(
  model: Model,
  host: string,
  key: string,
  patch: Partial<Pick<LinkSpec, 'label' | 'vf' | 'vt'>>,
): void {
  const relation = memoryOf(model, host).relations.find((r) => triple(r) === key)!
  Object.assign(relation, patch)
}
