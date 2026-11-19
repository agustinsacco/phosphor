import type { Registry, StageClaim, StageEntity } from './stage-types'

/** A part that marks more than one person as the user marks none: its flags are dropped. */
export function trustedUserFlags(entities: StageEntity[]): StageEntity[] {
  return entities.filter((e) => e.user).length > 1 ? entities.map(withoutUser) : entities
}
export function withoutUser(entity: StageEntity): StageEntity {
  const { user: _user, ...rest } = entity
  return rest
}
/** The user a part names: its one marked person, else the one an earlier part marked. */
export function userEntity(entities: StageEntity[], registry: Registry): StageEntity | undefined {
  const own = entities.filter((e) => e.user && e.kind === 'person')
  if (own.length) return own.length === 1 ? own[0] : undefined
  const earlier = registry.filter((e) => e.user && e.kind === 'person')
  return earlier.length === 1 ? earlier[0] : undefined
}
/** "The user …" or "The user's …" at the start of a claim names the user and mentions them once. */
export function nameUser(claim: StageClaim, user: StageEntity | undefined): StageClaim {
  const leading = user && /^The user(['’]s)? /.exec(claim.text)
  if (!user || !leading) return claim
  return {
    ...claim,
    text: `${user.label}${leading[1] ?? ''} ${claim.text.slice(leading[0].length)}`,
    mentions: claim.mentions.includes(user.ref) ? claim.mentions : [...claim.mentions, user.ref],
  }
}
