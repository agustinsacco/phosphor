/**
 * Nothing automatic drops a relationship. Random sequences of saves, folds, merges, corrections,
 * replacements, Read again, links, edits, forgets and undos run against the engine and against a
 * pure model of design 2.5; after every step the links on current memories must match. A link
 * leaves only on purpose: forget, a self loop on merge, a reader link of a memory Read again
 * replaced, or the undo of the change that made it. A contradicted link stays, ended.
 */
import { afterEach, expect, it } from 'vitest'
import {
  BRAIN_LINK_RULES,
  BRAIN_PREDICATES,
  type BrainPredicate,
} from '@phosphor/shared/brain-links'
import {
  ENTITY_KINDS,
  type ConservationDriver,
  type Outcome,
} from './__fixtures__/conservation-driver'
import { V8Driver } from './__fixtures__/conservation-driver-v8'
import * as model from './__fixtures__/conservation-model'
import type { ClaimSpec, LinkSpec, Model } from './__fixtures__/conservation-model'

const SEEDS = Number(process.env.BRAIN_CONSERVATION_SEEDS ?? 200)
const STEPS = 40
const DAY = 86_400_000
interface Driver extends ConservationDriver {
  readonly clock: { time: number }
  setup(groups: { lane: string; claims: ClaimSpec[]; create: string[] }[]): string[][]
  close(): void
}
/** Links compare with their wording, dates, speaker and liveness. */
const DETAIL = true
const open: Driver[] = []
afterEach(() => {
  for (const driver of open.splice(0)) driver.close()
})
function makeDriver(): Driver {
  const driver = new V8Driver()
  open.push(driver)
  return driver
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Random = () => number
const pick = <T>(rng: Random, list: readonly T[]): T | undefined =>
  list.length ? list[Math.floor(rng() * list.length)] : undefined
const LABELS = ['', 'runs', 'took over billing from', 'answers to', 'is building', 'belongs to']

const link = (s: string, p: BrainPredicate, o: string, label = ''): LinkSpec => ({
  s,
  p,
  o,
  label,
  vf: null,
  vt: null,
})
const claim = (summary: string, entities: string[], links: LinkSpec[]): ClaimSpec => ({
  summary,
  entities,
  links,
  validFrom: null,
  target: null,
})
/** Six people and things, eight memories with mixed links, read from two lanes. */
const SETUP = [
  {
    lane: 'harbor-lane',
    create: ['Rina Okafor', 'Tom Lee', 'Harbor', 'Ledger', 'Northwind'],
    claims: [
      claim(
        'Rina Okafor owns Harbor.',
        ['Rina Okafor', 'Harbor'],
        [link('Rina Okafor', 'owns', 'Harbor', 'owns the Harbor service')],
      ),
      claim('Tom Lee leads Ledger.', ['Tom Lee', 'Ledger'], [link('Tom Lee', 'leads', 'Ledger')]),
      claim(
        'Harbor is part of Ledger.',
        ['Harbor', 'Ledger'],
        [link('Harbor', 'part_of', 'Ledger')],
      ),
      claim(
        'Ledger is built for Northwind.',
        ['Ledger', 'Northwind'],
        [link('Ledger', 'for_customer', 'Northwind', 'is built for')],
      ),
    ],
  },
  {
    lane: 'ledger-lane',
    create: ['Mara Voss'],
    claims: [
      claim(
        'Tom Lee reports to Mara Voss.',
        ['Tom Lee', 'Mara Voss'],
        [
          {
            ...link('Tom Lee', 'reports_to', 'Mara Voss'),
            vf: 1_690_000_000_000 - (1_690_000_000_000 % DAY),
          },
        ],
      ),
      claim(
        'Rina Okafor works on Ledger.',
        ['Rina Okafor', 'Ledger'],
        [link('Rina Okafor', 'works_on', 'Ledger')],
      ),
      claim(
        'Mara Voss took over Harbor billing from Rina Okafor.',
        ['Mara Voss', 'Rina Okafor'],
        [link('Mara Voss', 'took_over_from', 'Rina Okafor', 'took over Harbor billing from')],
      ),
      claim(
        'Tom Lee works on Harbor and reports to Mara Voss.',
        ['Tom Lee', 'Harbor', 'Mara Voss'],
        [
          link('Tom Lee', 'works_on', 'Harbor'),
          link('Tom Lee', 'reports_to', 'Mara Voss', 'answers to'),
        ],
      ),
    ],
  },
]

interface Run {
  rng: Random
  driver: Driver
  state: Model
  lanes: Set<string>
  undo: { operationId: string; snapshot: Model }[]
  log: string[]
  count: number
}
function linkBetween(run: Run, names: string[]): LinkSpec | null {
  const { rng } = run
  const now = run.driver.clock.time
  for (let tries = 0; tries < 8; tries++) {
    const s = pick(rng, names),
      o = pick(rng, names),
      p = pick(rng, BRAIN_PREDICATES)!
    if (!s || !o || s === o) continue
    const rule = BRAIN_LINK_RULES[p]
    if (!rule.subject.includes(ENTITY_KINDS[s]!) || !rule.object.includes(ENTITY_KINDS[o]!))
      continue
    const vf = rng() < 0.5 ? null : now - Math.ceil(rng() * 30) * DAY
    const vt = rng() < 0.7 ? null : (vf ?? now - 10 * DAY) + Math.ceil(rng() * 30) * DAY
    return model.normalize(run.state, { s, p, o, label: pick(rng, LABELS)!, vf, vt })
  }
  return null
}
function claimSpec(run: Run, target: string | null): ClaimSpec {
  const { rng } = run
  const pool = model.names(run.state).filter((n) => n in ENTITY_KINDS)
  const entities = [...new Set([pick(rng, pool)!, pick(rng, pool)!, pick(rng, pool)!])]
  const links: LinkSpec[] = []
  for (let i = Math.floor(rng() * 3); i > 0; i--) {
    const next = linkBetween(run, entities)
    if (next && !links.some((l) => model.triple(l) === model.triple(next))) links.push(next)
  }
  return {
    summary: `Claim ${++run.count} of this run, said on day ${run.driver.clock.time / DAY}.`,
    entities,
    links,
    validFrom: rng() < 0.3 ? run.driver.clock.time - Math.ceil(rng() * 20) * DAY : null,
    target,
  }
}
function currentIds(run: Run): string[] {
  return model.current(run.state).map((m) => m.id)
}

type Step = (
  run: Run,
) => { name: string; outcome: Outcome; apply: (created: string[], job?: string) => void } | null
const save =
  (reread: boolean): Step =>
  (run) => {
    const lane = reread
      ? pick(run.rng, [...run.lanes])
      : pick(run.rng, ['harbor-lane', 'ledger-lane', 'kestrel-lane'])!
    if (!lane) return null
    const target = run.rng() < 0.35 ? (pick(run.rng, currentIds(run)) ?? null) : null
    const claims = [claimSpec(run, target)]
    if (run.rng() < 0.25) claims.push(claimSpec(run, null))
    const now = run.driver.clock.time
    return {
      name: `${reread ? 'reread' : 'save'} ${lane} ${JSON.stringify(claims)}`,
      outcome: run.driver.save({ lane, claims, reread }),
      apply: (ids, job) => {
        model.saveRead(run.state, { lane, job: job!, claims, ids, now }, reread)
        run.lanes.add(lane)
      },
    }
  }
const pairStep =
  (kind: 'fold' | 'replace'): Step =>
  (run) => {
    const [a, b] = [pick(run.rng, currentIds(run)), pick(run.rng, currentIds(run))]
    if (!a || !b || a === b) return null
    const now = run.driver.clock.time
    return {
      name: `${kind} ${a} -> ${b}`,
      outcome: kind === 'fold' ? run.driver.fold(a, b) : run.driver.replace(a, b),
      apply: () =>
        kind === 'fold' ? model.fold(run.state, a, b) : model.replace(run.state, a, b, now),
    }
  }
const merge: Step = (run) => {
  const people = model.names(run.state).filter((n) => ENTITY_KINDS[n] === 'person')
  const [a, b] = [pick(run.rng, people), pick(run.rng, people)]
  if (!a || !b || a === b) return null
  return {
    name: `merge ${a} into ${b}`,
    outcome: run.driver.merge(a, b),
    apply: () => model.merge(run.state, a, b),
  }
}
const correct: Step = (run) => {
  const old = pick(run.rng, model.current(run.state))
  if (!old) return null
  const extra = run.rng() < 0.5 ? linkBetween(run, old.mentions) : null
  // Brain Agent always words the links it states.
  const links =
    extra && !old.relations.some((r) => model.triple(r) === model.triple(extra))
      ? [{ ...extra, label: extra.label || 'works closely with' }]
      : []
  const end = run.rng() < 0.4 ? pick(run.rng, old.relations) : undefined
  const ends = end ? [model.triple(end)] : []
  const now = run.driver.clock.time
  return {
    name: `correct ${old.id} links ${JSON.stringify(links)} ends ${JSON.stringify(ends)}`,
    outcome: run.driver.correct({ memoryId: old.id, links, ends }),
    apply: (created) =>
      model.correct(run.state, { old: old.id, id: created[0]!, links, ends, now }),
  }
}
const relate: Step = (run) => {
  const host = pick(
    run.rng,
    model.current(run.state).filter((m) => m.mentions.length > 1),
  )
  const next = host && linkBetween(run, host.mentions)
  if (!host || !next || host.relations.some((r) => model.triple(r) === model.triple(next)))
    return null
  const stated = { ...next, label: next.label || 'works closely with' }
  return {
    name: `relate ${host.id} ${JSON.stringify(stated)}`,
    outcome: run.driver.relate({ host: host.id, link: stated }),
    apply: () => model.relate(run.state, host.id, stated),
  }
}
const edit: Step = (run) => {
  const host = pick(
    run.rng,
    model.current(run.state).filter((m) => m.relations.length),
  )
  const relation = host && pick(run.rng, host.relations)
  if (!host || !relation) return null
  const now = run.driver.clock.time
  const patch: Partial<Pick<LinkSpec, 'label' | 'vt'>> = {}
  if (run.rng() < 0.5) patch.label = pick(run.rng, LABELS.slice(1))!
  if (run.rng() < 0.6 || !patch.label)
    patch.vt = Math.max(relation.vf ?? 0, now - Math.floor(run.rng() * 5) * DAY)
  const key = model.triple(relation)
  return {
    name: `edit ${host.id} ${key} ${JSON.stringify(patch)}`,
    outcome: run.driver.editRelation({ host: host.id, key, patch }),
    apply: () => model.editRelation(run.state, host.id, key, patch),
  }
}
const forget: Step = (run) => {
  const id = pick(run.rng, currentIds(run))
  if (!id) return null
  return {
    name: `forget ${id}`,
    outcome: run.driver.forget(id),
    apply: () => {
      model.remove(run.state, id)
      run.undo = []
    },
  }
}
const STEPS_BY_WEIGHT: [number, Step][] = [
  [24, save(false)],
  [7, save(true)],
  [8, pairStep('fold')],
  [8, pairStep('replace')],
  [6, merge],
  [10, correct],
  [10, relate],
  [8, edit],
  [4, forget],
]
function choose(rng: Random): Step | 'undo' {
  let roll = rng() * 100
  for (const [weight, step] of STEPS_BY_WEIGHT) if ((roll -= weight) < 0) return step
  return 'undo'
}
function undoStep(run: Run): void {
  const top = run.undo.pop()
  if (!top) return
  const outcome = run.driver.undo(top.operationId)
  run.log.push(`undo ${top.operationId}: ${'refused' in outcome ? outcome.refused : 'done'}`)
  if ('refused' in outcome) run.undo = []
  else run.state = top.snapshot
}
function step(run: Run): void {
  run.driver.clock.time += DAY
  const chosen = choose(run.rng)
  if (chosen === 'undo') return undoStep(run)
  const before = structuredClone(run.state)
  const next = chosen(run)
  if (!next) return
  const { outcome } = next
  run.log.push(`${next.name}: ${'refused' in outcome ? outcome.refused : 'done'}`)
  if ('refused' in outcome) return
  next.apply(outcome.created, outcome.job)
  if (outcome.operationId) run.undo.push({ operationId: outcome.operationId, snapshot: before })
}

function start(seed: number): Run {
  const driver = makeDriver()
  const state: Model = { memories: [], evidence: 0, order: SETUP.flatMap((g) => g.create) }
  const ids = driver.setup(SETUP)
  SETUP.forEach((group, i) =>
    model.saveRead(
      state,
      {
        lane: group.lane,
        job: `setup-${i}`,
        claims: group.claims,
        ids: ids[i]!,
        now: driver.clock.time,
      },
      false,
    ),
  )
  for (const memory of state.memories) memory.job = null
  return {
    rng: mulberry32(seed),
    driver,
    state,
    lanes: new Set(SETUP.map((g) => g.lane)),
    undo: [],
    log: [],
    count: 0,
  }
}
function check(run: Run, seed: number): void {
  const context = `seed ${seed}\n${run.log.join('\n')}`
  expect(run.driver.currentIds(), context).toEqual([...currentIds(run)].sort())
  expect(run.driver.facts(DETAIL), context).toEqual(model.facts(run.state, DETAIL))
}

it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))(
  'keeps every relationship on purpose only (seed %i)',
  (seed) => {
    const run = start(seed)
    check(run, seed)
    for (let i = 0; i < STEPS; i++) {
      step(run)
      check(run, seed)
    }
  },
)
