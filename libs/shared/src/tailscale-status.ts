export type TailscaleCode =
  | 'ready'
  | 'not-installed'
  | 'not-running'
  | 'signed-out'
  | 'magicdns-unavailable'
  | 'https-unavailable'
  | 'check-failed'
export interface TailscaleStatus {
  code: TailscaleCode
}
