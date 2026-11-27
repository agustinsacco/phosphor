/**
 * A lane its owner keeps out of every ordinary route: the Host's Brain Agent lane. Its identity
 * is this object, held only by the owner that created it, never its folder, transcript or name:
 * a lane started in the same folder by any other route is an ordinary lane and gets nothing
 * this one gets.
 */
export interface ReservedLane {
  readonly kind: 'brain-agent'
  /** Real path of the lane's folder. */
  readonly folder: string
}

export function createReservedLane(kind: ReservedLane['kind'], folder: string): ReservedLane {
  return Object.freeze({ kind, folder })
}
