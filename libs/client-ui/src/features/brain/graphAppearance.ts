import { Color } from 'three'
import SpriteText from 'three-spritetext'
import {
  graphEndpoint,
  graphNeighbors,
  type GraphModel,
  type GraphLink,
  type GraphNode,
} from './graphModel'
import type { GraphTheme } from './graphColors'
import type { BrainForceGraph } from './graphActivity'

function colorOpacity(color: string, bright: boolean): string {
  return new Color(color)
    .getStyle()
    .replace('rgb(', 'rgba(')
    .replace(')', `,${bright ? 1 : 0.16})`)
}

export function graphAppearance(graph: BrainForceGraph): {
  data: (model: GraphModel) => void
  paint: (hover: string | null, matches: Set<string> | null, theme: GraphTheme) => void
} {
  let model: GraphModel = { nodes: [], links: [] }
  let largest = new Set<string>()
  const labels = new Map<string, SpriteText>()
  const predicates = new Map<GraphLink, SpriteText>()
  graph
    .nodeThreeObjectExtend(true)
    .linkThreeObjectExtend(true)
    .nodeThreeObject((node) => labels.get(node.id)!)
    .linkThreeObject((link) => predicates.get(link)!)
    .linkPositionUpdate((object, { start, end }) => {
      object.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2)
    })
  return {
    data: (next) => {
      model = next
      largest = new Set(
        [...model.nodes]
          .sort((a, b) => b.val - a.val || a.id.localeCompare(b.id))
          .slice(0, 20)
          .map((node) => node.id),
      )
      labels.clear()
      predicates.clear()
      for (const node of model.nodes) {
        const sprite = new SpriteText(node.label, 4)
        sprite.position.y = 4 * Math.cbrt(node.val) + 4
        labels.set(node.id, sprite)
      }
      for (const link of model.links)
        predicates.set(link, new SpriteText(link.predicates.join(', '), 3))
    },
    paint: (hover, matches, theme) => {
      const neighbors = graphNeighbors(model, hover)
      const bright = (node: GraphNode): boolean =>
        (!matches || matches.has(node.id)) && (!hover || neighbors.has(node.id))
      const connected = (link: GraphLink): boolean =>
        graphEndpoint(link.source) === hover || graphEndpoint(link.target) === hover
      graph
        .nodeColor((node) => colorOpacity(theme.kinds[node.kind], bright(node)))
        .linkColor((link) =>
          colorOpacity(
            connected(link) ? theme.accent : theme.edge,
            (!hover || connected(link)) &&
              (!matches ||
                (matches.has(graphEndpoint(link.source)) &&
                  matches.has(graphEndpoint(link.target)))),
          ),
        )
      for (const node of model.nodes) {
        const label = labels.get(node.id)!
        label.visible = largest.has(node.id) || hover === node.id
        label.color = theme.text
        label.material.opacity = bright(node) ? 1 : 0.16
      }
      for (const link of model.links) {
        const label = predicates.get(link)!
        label.visible = connected(link)
        label.color = theme.accent
      }
    },
  }
}
