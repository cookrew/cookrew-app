/**
 * THE BRIEF REACHES THE CARD SOUS JUST RECRUITED (route program R3).
 *
 * Observed live (storyboard beat 4): Sous recruited and wired the new card,
 * it booted routed — and the sentence never arrived. The commit returned the
 * text to the renderer and nothing submitted it, so the card sat at an empty
 * prompt with no turn and no usage row while the echo said the card was made.
 *
 * The sentence goes in through the DISPATCH ENGINE, the same verified path
 * `cookrew ask --no-wait` and the phone use: herdr's submit waits for the
 * harness to reach its prompt, the ledger records the delivery, the origin
 * mints the cable pulse. Two things about a card created a moment ago are
 * ours to absorb at admission: its pane may not be in the engine's cached
 * inventory yet (503 unreachable) and the turn tracker may not watch it yet
 * (503 no durable observer). Both clear within the boot; everything else is
 * a real refusal and is thrown as such.
 */

export interface RecruitDispatchEngine {
  dispatch(agentId: string, input: { text: string; origin?: string }): Promise<{ status: number; body: Record<string, unknown> }>
  /** Resolves when the delivery leg for this dispatch has settled. */
  settled(dispatchId: string): Promise<void>
  get(dispatchId: string): { state: string; error?: string } | undefined
}

export interface RecruitDeliveryInput {
  nodeId: string
  sentence: string
  /** The card the recruit was placed beside — the asker, for the ledger and the cable pulse. */
  originId: string | null
}

export interface RecruitDeliveryOptions {
  /** How long a booting card may keep answering a retryable 503 before the delivery is given up. */
  admissionMs?: number
  retryMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** A fresh Claude pane is usually admitted within a second; a cold boot can take longer. */
export const RECRUIT_ADMISSION_MS = 20_000
export const RECRUIT_RETRY_MS = 250

/** The two refusals a card that is still booting answers with, and only those. */
const RETRYABLE_AT_BOOT: ReadonlySet<string> = new Set(['unreachable', 'agent has no durable observer'])

export function retryableAtBoot(status: number, body: Record<string, unknown>): boolean {
  return status === 503 && typeof body.error === 'string' && RETRYABLE_AT_BOOT.has(body.error)
}

/**
 * Admit the brief (retrying the boot-time refusals inside the window), then
 * wait for the delivery leg to settle, and throw unless the ledger says the
 * prompt reached the card. Resolves with the dispatch id once it has.
 */
export async function deliverToRecruit(engine: RecruitDispatchEngine, input: RecruitDeliveryInput, options: RecruitDeliveryOptions = {}): Promise<{ dispatchId: string }> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const admissionMs = options.admissionMs ?? RECRUIT_ADMISSION_MS
  const retryMs = options.retryMs ?? RECRUIT_RETRY_MS
  const startedAt = now()
  const request = { text: input.sentence, ...(input.originId ? { origin: input.originId } : {}) }

  const dispatchId = await (async (): Promise<string> => {
    for (;;) {
      const response = await engine.dispatch(input.nodeId, request)
      const body = response.body
      if (response.status === 202 && typeof body.dispatchId === 'string') return body.dispatchId
      const error = typeof body.error === 'string' ? body.error : `dispatch refused (${response.status})`
      if (!retryableAtBoot(response.status, body) || now() - startedAt >= admissionMs) {
        throw new Error(`the new card did not take the brief: ${error}`)
      }
      await sleep(retryMs)
    }
  })()

  await engine.settled(dispatchId)
  const record = engine.get(dispatchId)
  if (record !== undefined && (record.state === 'failed' || record.state === 'interrupted')) {
    throw new Error(`the brief did not reach the new card: ${record.error ?? record.state}`)
  }
  return { dispatchId }
}
