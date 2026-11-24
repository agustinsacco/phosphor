/**
 * Set in every terminal and lane the service spawns: the service's own pid, so an
 * updater started there knows it runs inside the service. A leaf on purpose: the
 * session runtime and terminals import it without pulling in the updater.
 */
export const HOST_PID_ENV = 'PHOSPHOR_HOST_PID'
