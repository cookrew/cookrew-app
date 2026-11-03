/**
 * THE SURFACES THE SCRUB COVERS TODAY — each a small, typed map over one
 * shape that leaves main, so index.ts wires one line per surface and a test
 * can prove the map without the app.
 */

import type { InboxRow } from '../shared/inbox-rank'
import type { SousCommandResult } from './sous-control'
import type { Scrub } from './scrub'

/** An inbox row for the desktop box, the phone and its stream. */
export const scrubInboxRow = <T extends InboxRow & { text?: string }>(row: T, scrub: Scrub): T => ({
  ...row,
  reasons: row.reasons.map(scrub),
  ...(typeof row.text === 'string' ? { text: scrub(row.text) } : {})
})

/** Sous's answer: the sentence it says, the choices it offers, the decision's own sentence. */
export const scrubSousResult = (result: SousCommandResult, scrub: Scrub): SousCommandResult => ({
  ...result,
  spoken: scrub(result.spoken),
  ...(typeof result.text === 'string' ? { text: scrub(result.text) } : {}),
  ...(result.choices ? { choices: result.choices.map(scrub) } : {}),
  ...(result.decision ? { decision: { ...result.decision, sentence: scrub(result.decision.sentence) } } : {})
})
