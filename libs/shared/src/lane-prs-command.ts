/**
 * Track and Hide's slash command, `/phosphor-prs pin|hide|clear <url>`, as clients
 * send it. `LANE_PRS_COMMAND` in `libs/pi-extensions/pi-ext/lane-prs.ts` registers
 * it; pi loads that file outside Phosphor's module graph and the Web image does not
 * ship it, so the clients spell the name here (`lanePrOverrides.test.ts` pins the two).
 */
export const LANE_PRS_COMMAND = 'phosphor-prs'

/**
 * A Track or Hide prompt. It only appends an entry to the lane's file, so it is
 * never a reason to start a stopped lane.
 */
export function isLanePrsPrompt(message: unknown): boolean {
  return typeof message === 'string' && message.startsWith(`/${LANE_PRS_COMMAND} `)
}
