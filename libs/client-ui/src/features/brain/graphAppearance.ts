import { Color, Vector2 } from 'three'
import type SpriteText from 'three-spritetext'
import { graphLabel } from './graphLabels'
import { declutterLabels, rankLabels, type LabelCandidate } from './graphLabelLayout'
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

export interface GraphAppearance {
  data: (model: GraphModel) => void
  paint: (
    hover: string | null,
    matches: Set<string> | null,
    theme: GraphTheme,
    path?: Set<string> | null,
    focus?: string | null,
  ) => void
}

/** The twenty largest nodes are labelled without a hover or a selection. */
function largestNodes(model: GraphModel): Set<string> {
  return new Set(
    [...model.nodes]
      .sort((a, b) => b.val - a.val || a.id.localeCompare(b.id))
      .slice(0, 20)
      .map((node) => node.id),
  )
}

export function graphAppearance(graph: BrainForceGraph): GraphAppearance {
  let model: GraphModel = { nodes: [], links: [] }
  let largest = new Set<string>()
  const labels = new Map<string, SpriteText>()
  const predicates = new Map<GraphLink, SpriteText>()
  let candidates: LabelCandidate[] = []
  const pane = new Vector2()
  // Nodes and the camera move between paints, so labels are thinned on every drawn frame.
  graph.scene().onBeforeRender = (renderer, _scene, camera) => {
    renderer.getSize(pane)
    declutterLabels(candidates, camera, pane.x, pane.y)
  }
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
      largest = largestNodes(model)
      labels.clear()
      predicates.clear()
      for (const node of model.nodes) {
        const sprite = graphLabel(node.label, 12)
        sprite.position.y = 4 * Math.cbrt(node.val) + 4
        labels.set(node.id, sprite)
      }
      for (const link of model.links)
        predicates.set(
          link,
          graphLabel(link.predicates.map((p) => p.replaceAll('_', ' ')).join(', '), 11),
        )
    },
    paint: (hover, matches, theme, path, focus) => {
      const { selected, bright, connected, roaming } = selectionStyle(model, hover, matches, focus)
      graph
        .nodeColor((node) => colorOpacity(theme.kinds[node.kind], bright(node)))
        .linkColor((link) =>
          colorOpacity(
            connected(link) || path?.has(link.id) ? theme.accent : theme.edge,
            (!path || path.has(link.id)) &&
              (!(roaming || focus) || connected(link) || !!path?.has(link.id)) &&
              (!matches ||
                (matches.has(graphEndpoint(link.source)) &&
                  matches.has(graphEndpoint(link.target)))),
          ),
        )
      for (const node of model.nodes) {
        const label = labels.get(node.id)!
        label.visible =
          largest.has(node.id) ||
          hover === node.id ||
          !!selected?.has(node.id) ||
          !!matches?.has(node.id)
        // Assigning a colour redraws the label's canvas, so skip an unchanged one.
        if (label.color !== theme.text) label.color = theme.text
        label.material.opacity = bright(node) ? 1 : 0.16
      }
      for (const link of model.links) {
        const label = predicates.get(link)!
        label.visible = connected(link) || !!path?.has(link.id)
        if (label.color !== theme.accent) label.color = theme.accent
      }
      candidates = rankLabels(
        model,
        labels,
        predicates,
        new Set([hover, focus].filter((id) => typeof id === 'string')),
      )
    },
  }
}

function selectionStyle(
  model: GraphModel,
  hover: string | null,
  matches: Set<string> | null,
  focus?: string | null,
) {
  const selected = focus && !matches ? graphNeighbors(model, focus) : null
  // A hover highlights its neighbourhood only on an unselected graph; it never dims a selection.
  const roaming = matches || selected ? null : hover
  const neighbors = graphNeighbors(model, roaming)
  const bright = (node: GraphNode): boolean =>
    node.id === hover ||
    ((!matches || matches.has(node.id)) &&
      (!selected || selected.has(node.id)) &&
      (!roaming || neighbors.has(node.id)))
  const connected = (link: GraphLink): boolean =>
    (!!roaming &&
      (graphEndpoint(link.source) === roaming || graphEndpoint(link.target) === roaming)) ||
    (!!focus && (graphEndpoint(link.source) === focus || graphEndpoint(link.target) === focus))
  return { selected, bright, connected, roaming }
}
