/** Release builds stamp an independent Host semver; dev builds stamp the source commit. */
declare const __PHOSPHOR_HOST_SOURCE_SHA__: string | undefined

export const HOST_SOURCE_SHA: string | null =
  typeof __PHOSPHOR_HOST_SOURCE_SHA__ === 'string' &&
  /^[0-9a-f]{40}$/.test(__PHOSPHOR_HOST_SOURCE_SHA__)
    ? __PHOSPHOR_HOST_SOURCE_SHA__
    : null

declare const __PHOSPHOR_HOST_RELEASE_VERSION__: string | undefined

export const HOST_VERSION =
  typeof __PHOSPHOR_HOST_RELEASE_VERSION__ === 'string' &&
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(
    __PHOSPHOR_HOST_RELEASE_VERSION__,
  )
    ? __PHOSPHOR_HOST_RELEASE_VERSION__
    : `0.0.0-dev.${HOST_SOURCE_SHA?.slice(0, 7) ?? 'source'}`
