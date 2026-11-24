/**
 * The two CONTROL_LIMITS values the frozen 684cb3478 machines parser reads, as that
 * release shipped them. The live constants have since changed (maxHostsPerAccount is
 * 100), so importing them would make the frozen parser accept what the shipped one refuses.
 */
export const CONTROL_LIMITS = {
  heartbeatMinSec: 10,
  maxHostsPerAccount: 20,
} as const
