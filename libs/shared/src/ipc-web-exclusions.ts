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

const filePreview = {
  kind: 'unsupported',
  reason: 'Streaming a Host file into a viewer needs Desktop’s file scheme.',
} as const

/** Transfers Desktop carries: lanes between machines, Host files into Downloads or a viewer. */
export const DESKTOP_TRANSFERS_WEB = {
  'hosts:laneMovePlan': laneMove,
  'hosts:laneMove': laneMove,
  'hosts:fileDownload': fileDownload,
  'hosts:fileDownloadCancel': fileDownload,
  'hosts:filePreviewUrl': filePreview,
}
