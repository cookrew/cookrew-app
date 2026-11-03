/**
 * THE BRIEF REACHES THE CARD SOUS JUST RECRUITED (route program R3).
 *
 * Observed live (storyboard beat 4): Sous recruited and wired the new card,
 * it booted routed — and the sentence never arrived. The commit returned the
 * text to the renderer and nothing submitted it, so the card sat at an empty
 * prompt with no turn and no usage row while the echo said the card was made.
 *
 * The sentence goes in through the DISPATCH ENGINE, the same verified path
 * `cookrew ask --no-wait` and the phone use: the ledger records the delivery,
 * the origin mints the cable pulse. Two things about a card created a moment
 * ago are ours to absorb at admission: its pane may not be in the engine's
 * cached inventory yet (503 unreachable) and the turn tracker may not watch
 * it yet (503 no durable observer). Both clear within the boot; everything
 * else is a real refusal and is thrown as such.
 *
 * THE BRIEF THAT VANISHED INTO A BOOTING PANE (2026-11-03, six of six). The
 * engine's herdr submission does NOT wait for the harness: `herdr agent
 * prompt` in ack mode (no --wait) types the moment the pane's agent resolves,
 * and a fresh pane resolves while `claude` is still starting, so the bytes
 * went to a TUI that was not reading yet. herdr exited 0, the engine stamped
 * the record `running` on that acknowledgement alone (confirmed: false), and
 * the recruit said "Prompt delivered" over an empty composer. The armed stamp
 * then held the card busy for every later ask until the ten-minute sweep.
 *
 * So, with a WITNESS (the conductor's view of the card):
 *   1. the brief is held until the harness shows its own input prompt — the
 *      readiness a woken or forked agent already waits for (fork.ts ·
 *      harnessReadyForInput), never a fixed sleep;
 *   2. "delivered" needs evidence: a turn that started after the brief went
 *      in, or the brief's text on the card's screen (composer or echo);
 *   3. without that inside the window the dispatch is CLOSED (interrupted),
 *      so neither the reservation nor the tracker's stamp keeps the card
 *      busy, and the caller is told plainly that the brief is not confirmed.
 * It is never re-sent from here: an unconfirmed brief may still be sitting
 * in the box, and a second copy is the double submit.
 */

import { promptLanded } from './dispatch'

export interface RecruitDispatchEngine {
  dispatch(agentId: string, input: { text: string; origin?: string }): Promise<{ status: number; body: Record<string, unknown> }>
  /** Resolves when the delivery leg for this dispatch has settled. */
  settled(dispatchId: string): Promise<void>
  get(dispatchId: string): { state: string; error?: string } | undefined
  /** Close an open dispatch as interrupted: releases its slot and the tracker's stamp. */
  interrupt?(dispatchId: string, why: string): void
}

/** What the conductor can see of the new card. Every read is cheap and synchronous. */
export interface RecruitWitness {
  /** Is the harness ready to take typed input — its own prompt drawn, the pane quiet? */
  readyForInput(nodeId: string): boolean
  /** Does the live tracker see a turn running right now? */
  turnRunning(nodeId: string): boolean
  /** Completed turns so far; null when the card is not tracked. */
  turnCount(nodeId: string): number | null
  /** The pane's visible text (composer included); null when it cannot be read. */
  screen(nodeId: string): string | null
}

/** How the brief was seen to land. */
export type RecruitEvidence = 'turn' | 'composer'

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
  /**
   * The card's view. Absent (an embedder with no panes), delivery is judged
   * by the engine's record alone, as before; every conductor caller wires it.
   */
  witness?: RecruitWitness
  /** How long the harness may take to show its input prompt before nothing is sent. */
  readyMs?: number
  /** How long after the delivery leg settles a turn or the text may take to show. */
  confirmMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** A fresh Claude pane is usually admitted within a second; a cold boot can take longer. */
export const RECRUIT_ADMISSION_MS = 20_000
export const RECRUIT_RETRY_MS = 250
/** A cold Claude boot (MCP servers, a first-run config) can take tens of seconds. */
export const RECRUIT_READY_MS = 60_000
/** A submitted brief opens a turn within a second or two; a slow model gets margin. */
export const RECRUIT_CONFIRM_MS = 15_000

/** The two refusals a card that is still booting answers with, and only those. */
const RETRYABLE_AT_BOOT: ReadonlySet<string> = new Set(['unreachable', 'agent has no durable observer'])

export function retryableAtBoot(status: number, body: Record<string, unknown>): boolean {
  return status === 503 && typeof body.error === 'string' && RETRYABLE_AT_BOOT.has(body.error)
}

type Sleep = (ms: number) => Promise<void>

/**
 * Hold the brief until the harness takes input (with a witness), admit it
 * (retrying the boot-time refusals inside the window), wait for the delivery
 * leg to settle, and resolve only once the ledger — and, with a witness, the
 * card itself — says the prompt reached it. Throws otherwise.
 */
export async function deliverToRecruit(
  engine: RecruitDispatchEngine,
  input: RecruitDeliveryInput,
  options: RecruitDeliveryOptions = {}
): Promise<{ dispatchId: string; evidence?: RecruitEvidence }> {
  const now = options.now ?? Date.now
  const sleep: Sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryMs = options.retryMs ?? RECRUIT_RETRY_MS
  const witness = options.witness

  if (witness !== undefined) {
    await awaitReady(witness, input.nodeId, options.readyMs ?? RECRUIT_READY_MS, retryMs, now, sleep)
  }
  // The baseline is read at the last moment before the brief goes in: a turn
  // that was already running (a boot spinner) or already counted is not ours.
  const before =
    witness === undefined ? null : { running: witness.turnRunning(input.nodeId), count: witness.turnCount(input.nodeId) }

  const dispatchId = await admit(engine, input, options.admissionMs ?? RECRUIT_ADMISSION_MS, retryMs, now, sleep)

  await engine.settled(dispatchId)
  throwIfEnded(engine, dispatchId)
  if (witness === undefined || before === null) return { dispatchId }

  const confirmMs = options.confirmMs ?? RECRUIT_CONFIRM_MS
  const evidence = await awaitEvidence(engine, witness, input, dispatchId, before, confirmMs, retryMs, now, sleep)
  if (evidence !== null) return { dispatchId, evidence }

  // Not confirmed: close the dispatch so the card is not left busy — the
  // reservation and the tracker's stamp both go with it — and say so.
  engine.interrupt?.(dispatchId, 'interrupted: recruit brief not confirmed')
  throw new Error(
    `no turn started and the text is not on the card's screen ` +
      `${Math.round(confirmMs / 1000)} s after delivery (dispatch ${dispatchId} closed, so the card is not held busy)`
  )
}

/** A delivery leg that ended failed or interrupted is the answer, said as such. */
function throwIfEnded(engine: RecruitDispatchEngine, dispatchId: string): void {
  const record = engine.get(dispatchId)
  if (record !== undefined && (record.state === 'failed' || record.state === 'interrupted')) {
    throw new Error(`the brief did not reach the card: ${record.error ?? record.state}`)
  }
}

/** Poll the harness's readiness; throw (nothing sent) when the window closes first. */
async function awaitReady(
  witness: RecruitWitness,
  nodeId: string,
  readyMs: number,
  retryMs: number,
  now: () => number,
  sleep: Sleep
): Promise<void> {
  const startedAt = now()
  // A card already working on an earlier turn is not booting (Sous's ask
  // path shares this door): its pane will not go quiet until the turn ends,
  // and the engine's own `busy` is the honest answer — given now, not after
  // the boot window.
  const working = (): boolean => witness.turnRunning(nodeId) && (witness.turnCount(nodeId) ?? 0) > 0
  while (!witness.readyForInput(nodeId) && !working()) {
    if (now() - startedAt >= readyMs) {
      throw new Error(`the card never showed its input prompt within ${Math.round(readyMs / 1000)} s — nothing was sent`)
    }
    await sleep(retryMs)
  }
}

/** Admit once, retrying only the two boot-time refusals inside the window. */
async function admit(
  engine: RecruitDispatchEngine,
  input: RecruitDeliveryInput,
  admissionMs: number,
  retryMs: number,
  now: () => number,
  sleep: Sleep
): Promise<string> {
  const startedAt = now()
  const request = { text: input.sentence, ...(input.originId ? { origin: input.originId } : {}) }
  for (;;) {
    const response = await engine.dispatch(input.nodeId, request)
    const body = response.body
    if (response.status === 202 && typeof body.dispatchId === 'string') return body.dispatchId
    const error = typeof body.error === 'string' ? body.error : `dispatch refused (${response.status})`
    if (!retryableAtBoot(response.status, body) || now() - startedAt >= admissionMs) {
      throw new Error(`the card did not take the brief: ${error}`)
    }
    await sleep(retryMs)
  }
}

/**
 * Watch for evidence the brief landed: the engine closing the turn, a turn
 * the tracker saw start (or count) after the brief went in, or the brief's
 * text on the card's screen. Null when the window closes without any.
 */
async function awaitEvidence(
  engine: RecruitDispatchEngine,
  witness: RecruitWitness,
  input: RecruitDeliveryInput,
  dispatchId: string,
  before: { running: boolean; count: number | null },
  confirmMs: number,
  retryMs: number,
  now: () => number,
  sleep: Sleep
): Promise<RecruitEvidence | null> {
  const startedAt = now()
  for (;;) {
    throwIfEnded(engine, dispatchId)
    if (engine.get(dispatchId)?.state === 'done') return 'turn'
    const count = witness.turnCount(input.nodeId)
    const counted = count !== null && before.count !== null && count > before.count
    if (counted || (!before.running && witness.turnRunning(input.nodeId))) return 'turn'
    if (promptLanded(witness.screen(input.nodeId), input.sentence)) return 'composer'
    if (now() - startedAt >= confirmMs) return null
    await sleep(retryMs)
  }
}
