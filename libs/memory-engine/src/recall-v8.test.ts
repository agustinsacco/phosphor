import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { searchFixture } from './test-support'
import { edges } from './graph'

function setup() {
  const { store, search, path } = searchFixture()
  const db = new DatabaseSync(path)
  db.exec(`
    INSERT INTO entities(n,id,label,kind,created_at,memories) VALUES
      (1,'h','Harbor','project',1,4),(2,'l','Ledger','project',1,2001),
      (3,'t','Tom Lee','person',1,2),(4,'r','Rina Okafor','person',1,1);
    INSERT INTO entity_names(entity,name,folded) VALUES (1,'Harbor','harbor'),(2,'Ledger','ledger'),(3,'Tom','tom'),(4,'Tom','tom');
    INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state,valid_to) VALUES
      (1,'expired','Billing','fact','reported','/',1,1,'active',2),
      (2,'current','Billing','fact','reported','/',1,1,'active',NULL),
      (3,'bridge','Connected','fact','reported','/',1,1,'active',NULL),
      (4,'leaf','Elsewhere','fact','reported','/',1,1,'active',NULL);
    INSERT INTO mentions VALUES (1,1),(2,1),(2,3),(3,1),(3,2),(4,2);
    INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (3,1,'uses',2,1,1);
    UPDATE meta SET value='4' WHERE key='memories';
  `)
  const ask = () => search.recall({ query:'Harbor', limit:20, vector:null, scope:null, branch:null, now:3 })
  return { ask, store, search, db, ctx: {db, now:()=>3, id:()=>''} }
}
it('explains a mention-only hit from the named seed', () => {
  const { ask, db } = setup()
  db.close()
  expect(ask().hits.find(h=>h.memory.id==='current')).toMatchObject({trail:{seedId:'h',entityId:'h',links:[]},reasons:expect.arrayContaining(['linked'])})
})
it('does not flood recall with memories of a non-focus mention hub', () => {
  const { ask, db } = setup()
  db.close()
  expect(ask().hits.map(h=>h.memory.id)).not.toContain('leaf')
})
it('separates ended edges from current neighbours', () => {
  const {store, db, ctx} = setup()
  db.exec('UPDATE relations SET valid_to=2')
  try {expect(edges(ctx,'h')).toEqual([])} finally {db.close()}
  expect(store.entity('h').ended[0]?.link).toMatchObject({memoryId:'bridge',validTo:2})
  expect(store.neighbourhood('h',1,10).ended[0]?.memoryId).toBe('bridge')
})
it('discounts expired twins and keeps them out of the walk', () => {
  const { ask, db } = setup()
  db.close()
  const hits=ask().hits
  const old=hits.find(h=>h.memory.id==='expired')!
  expect(old.score).toBeLessThan(hits.find(h=>h.memory.id==='current')!.score)
  expect(old.reasons).not.toContain('linked')
})
it('routes through a memory naming both people and things', () => {
  const {search,db}=setup(); db.close()
  expect(search.routes?.('t','h',3)?.routes[0]).toEqual([{kind:'together',fromId:'t',toId:'h',memoryId:'current',shared:1}])
})
it('resolves ambiguous names without discarding the alternatives', () => {
  const {search,db}=setup(); db.close()
  expect(search.resolve?.(['tom','l','missing'])?.map(rows=>rows.map(e=>e.id))).toEqual([['t','r'],['l'],[]])
})
it('picks the Tom Lee sharing current memories with Ledger over the more-mentioned namesake', () => {
  const {search,db}=setup()
  db.exec(`UPDATE entities SET label='Tom Lee' WHERE n=4;
    INSERT INTO entity_names(entity,name,folded) VALUES (3,'Tom Lee','tom lee'),(4,'Tom Lee','tom lee');
    INSERT INTO mentions VALUES (4,4);`)
  db.close()
  expect(search.resolve?.(['Tom Lee','Ledger'])?.[0]?.map(e=>e.id)).toEqual(['r','t'])
})
