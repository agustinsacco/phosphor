export const connectorConfig = {
  kind: 'unsupported',
  reason: 'Connector configuration and credentials belong to the Host or Desktop.',
} as const

const laneMove = {
  kind: 'unsupported',
  reason: 'Moving lanes needs Desktop, which carries the lane between machines.',
} as const

const fileDownload = {
  kind: 'unsupported',
  reason: 'Downloading a Host file needs Desktop, which saves it.',
} as const

/** Transfers Desktop carries: lanes between machines, and Host files into Downloads. */
export const DESKTOP_TRANSFERS_WEB = {
  'hosts:laneMovePlan': laneMove,
  'hosts:laneMove': laneMove,
  'hosts:fileDownload': fileDownload,
  'hosts:fileDownloadCancel': fileDownload,
}
