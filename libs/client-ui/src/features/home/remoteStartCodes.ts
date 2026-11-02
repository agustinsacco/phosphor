/**
 * The Host took the creation but did not say whether its first prompt went in.
 * The lane is open; sending the prompt again could run it twice.
 */
export const PROMPT_UNCONFIRMED = 'prompt-unconfirmed'

/**
 * From `hosts:createLane`: the Host created the lane and ran its first prompt, but
 * it could not be opened here. The prompt is spent; the lane is on the Host.
 */
export const LANE_STARTED_UNOPENED = 'lane-started-unopened'
