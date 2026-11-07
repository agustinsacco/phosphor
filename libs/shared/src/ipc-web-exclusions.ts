export const readOnlyFiles = {
  kind: 'unsupported',
  reason: 'Browser file access is read-only and explicitly Host-scoped.',
} as const

export const connectorConfig = {
  kind: 'unsupported',
  reason: 'Connector configuration and credentials belong to the Host or Desktop.',
} as const

const desktopOnly = {
  kind: 'unsupported',
  reason: 'Moving lanes needs Desktop, which carries the lane between machines.',
} as const

export const LANE_TRANSFER_WEB = {
  'hosts:laneMovePlan': desktopOnly,
  'hosts:laneMove': desktopOnly,
}
