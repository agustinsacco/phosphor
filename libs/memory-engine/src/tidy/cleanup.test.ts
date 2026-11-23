import { expect, it } from 'vitest'
import { fixture } from '../test-support'

it('does not scan and close the entire suggestion backlog inside one sweep chunk', () => {
  const { store, db } = fixture()
  const insert = db.prepare(
    "INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,reason,problem,session_id,title,created_at,updated_at) VALUES (?,?,'flagged','flag','open','memory',?,'Verified correction.','wrong','harbor','Harbor',1,1)",
  )
  db.exec('BEGIN')
  for (let n = 0; n < 5000; n++) insert.run(`suggestion-${n}`, `flag-${n}`, `missing-${n}`)
  db.exec('COMMIT')
  store.sweep('all')
  expect(
    Number(db.prepare("SELECT COUNT(*) AS n FROM tidy_suggestions WHERE state='cleared'").get()!.n),
  ).toBeLessThanOrEqual(128)
  const page = store.suggestions('flagged', null, 20)
  expect(page.items).toEqual([])
  expect(
    Number(db.prepare("SELECT COUNT(*) AS n FROM tidy_suggestions WHERE state='cleared'").get()!.n),
  ).toBeLessThanOrEqual(149)
})
