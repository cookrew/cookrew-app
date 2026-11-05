import { cookrew } from '../api'

/**
 * Asked before words go to an offline agent. The keys are fire and forget and a
 * box clears as it sends, so a card that cannot start would swallow them; asked
 * first, they stay in the box and it says why. A fix made since (the folder put
 * back, the tool installed) answers null here and the send wakes the agent.
 */
export async function launchRefusal(agentId: string): Promise<string | null> {
  try {
    const failure = (await cookrew().launchCheck?.(agentId)) ?? null
    return failure ? `Not sent: ${failure.why} ${failure.fix}` : null
  } catch {
    // No answer is no refusal: main refuses for itself, and the words come back from there.
    return null
  }
}
