import { expect, it } from 'vitest'
import { layoutMap, type MapBox, type MapLinkInput, type MapNodeInput } from './mapLayout'

const hub: MapNodeInput = { id: 'harbor', label: 'Harbor migration', kind: 'project', memories: 13 }
function neighbours(count: number): { nodes: MapNodeInput[]; links: MapLinkInput[] } {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    label: `Kestrel component number ${index + 1}`,
    kind: 'component' as const,
    memories: (index % 7) + 1,
  }))
  const links = nodes.map((node, index) => ({
    id: `l${index}`,
    subjectId: 'harbor',
    objectId: node.id,
    predicate: 'uses' as const,
  }))
  return { nodes: [hub, ...nodes], links }
}
const overlap = (a: MapBox, b: MapBox): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

it('draws 24 neighbours with no touching nodes or labels, all inside the box', () => {
  for (const [width, height] of [
    [336, 420],
    [520, 360],
    [240, 240],
  ] as const) {
    const layout = layoutMap({ centerId: 'harbor', ...neighbours(24), hops: 1, width, height })
    expect(layout.nodes).toHaveLength(25)
    expect(layout.hidden).toBe(0)
    for (const [i, a] of layout.nodes.entries())
      for (const b of layout.nodes.slice(i + 1))
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id}/${b.id}`).toBeGreaterThan(a.r + b.r)
    const boxes = layout.nodes.flatMap((node) => (node.caption ? [node.caption.box] : []))
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false)
    for (const node of layout.nodes) {
      expect(node.x - node.r).toBeGreaterThanOrEqual(0)
      expect(node.x + node.r).toBeLessThanOrEqual(width)
      expect(node.y - node.r).toBeGreaterThanOrEqual(0)
      expect(node.y + node.r).toBeLessThanOrEqual(height)
      if (node.caption) {
        expect(node.caption.box.x).toBeGreaterThanOrEqual(0)
        expect(node.caption.box.x + node.caption.box.width).toBeLessThanOrEqual(width)
        for (const other of layout.nodes)
          if (other !== node)
            expect(
              overlap(node.caption.box, {
                x: other.x - other.r,
                y: other.y - other.r,
                width: other.r * 2,
                height: other.r * 2,
              }),
            ).toBe(false)
      }
    }
    expect(layout.nodes[0]!.caption?.text).toBe('Harbor migration')
  }
})

it('keeps the same positions whatever order the graph arrives in', () => {
  const { nodes, links } = neighbours(12)
  const a = layoutMap({ centerId: 'harbor', nodes, links, hops: 1, width: 336, height: 420 })
  const b = layoutMap({
    centerId: 'harbor',
    nodes: nodes.toReversed(),
    links: links.toReversed(),
    hops: 1,
    width: 336,
    height: 420,
  })
  expect(b.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
    a.nodes.map(({ id, x, y }) => ({ id, x, y })),
  )
})

it('caps a hub at its strongest neighbours and counts the rest', () => {
  const { nodes, links } = neighbours(30)
  // Two links to n29 make it the strongest neighbour even though it is listed last.
  links.push({ id: 'extra', subjectId: 'n29', objectId: 'harbor', predicate: 'depends_on' })
  const layout = layoutMap({ centerId: 'harbor', nodes, links, hops: 1, width: 336, height: 420 })
  expect(layout.nodes).toHaveLength(25)
  expect(layout.hidden).toBe(6)
  expect(layout.nodes[1]!.id).toBe('n29')
  expect(layout.edges.find((edge) => edge.links.length === 2)?.key).toBe('harbor|n29')
})

it('puts second steps on an outer ring and draws one edge per pair', () => {
  const nodes: MapNodeInput[] = [
    hub,
    { id: 'rina', label: 'Rina Okafor', kind: 'person', memories: 4 },
    { id: 'ledger', label: 'Ledger team', kind: 'team', memories: 3 },
  ]
  const links: MapLinkInput[] = [
    { id: 'a', subjectId: 'rina', objectId: 'harbor', predicate: 'owns' },
    { id: 'b', subjectId: 'rina', objectId: 'ledger', predicate: 'member_of' },
    { id: 'c', subjectId: 'rina', objectId: 'harbor', predicate: 'owns' },
  ]
  const one = layoutMap({ centerId: 'harbor', nodes, links, hops: 1, width: 300, height: 300 })
  expect(one.nodes.map((node) => node.id)).toEqual(['harbor', 'rina'])
  expect(one.edges).toHaveLength(1)
  expect(one.edges[0]!.links).toHaveLength(1)
  const two = layoutMap({ centerId: 'harbor', nodes, links, hops: 2, width: 300, height: 300 })
  expect(two.nodes.map((node) => [node.id, node.ring])).toEqual([
    ['harbor', 0],
    ['rina', 1],
    ['ledger', 2],
  ])
  const distance = (id: string): number => {
    const node = two.nodes.find((n) => n.id === id)!
    return Math.hypot(node.x - 150, node.y - 150)
  }
  expect(distance('ledger')).toBeGreaterThan(distance('rina'))
})

it('draws nothing for an unknown centre or an empty box', () => {
  expect(
    layoutMap({ centerId: 'x', ...neighbours(2), hops: 1, width: 300, height: 300 }).nodes,
  ).toEqual([])
  expect(
    layoutMap({ centerId: 'harbor', ...neighbours(2), hops: 1, width: 0, height: 300 }).nodes,
  ).toEqual([])
})

it('never puts two neighbours on one line through the centre, so a link between them misses it', () => {
  const { nodes, links } = neighbours(2)
  const layout = layoutMap({
    centerId: 'harbor',
    nodes,
    links: [...links, { id: 'between', subjectId: 'n0', objectId: 'n1', predicate: 'uses' }],
    hops: 1,
    width: 520,
    height: 360,
  })
  const [centre, a, b] = ['harbor', 'n0', 'n1'].map((id) => layout.nodes.find((n) => n.id === id)!)
  // Distance from the centre to the line through the two neighbours.
  const cross = (b!.x - a!.x) * (centre!.y - a!.y) - (b!.y - a!.y) * (centre!.x - a!.x)
  const distance = Math.abs(cross) / Math.hypot(b!.x - a!.x, b!.y - a!.y)
  expect(distance).toBeGreaterThan(centre!.r * 2)
})
