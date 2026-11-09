// A PANE THAT IS GONE TAKES ITS INPUT BOX WITH IT.
//
// The producer lease keeps facts about what may sit in a card's input box: a
// cancelled paste, or a dispatch delivery no transcript has witnessed yet
// (producer-lease.ts). Every producer refuses while one stands, and only proof
// clears one: the witness, or a kill that was awaited. A card whose agent EXITED
// on its own had neither (Solis, 2026-11-09: the bypass notice made claude exit
// 1 under a delivered brief), so every later `cookrew ask` was refused with
// "restart the terminal", which the CLI cannot do.
//
// Before a card is started again, a box fact is dropped when the multiplexer
// POSITIVELY says the pane is not there: the box the fact described no longer
// exists anywhere, the same proof a finished kill gives. Unsure is not gone.

import type { ProducerLease } from './producer-lease'

/** Drop the box facts of a pane that is gone. True when there were some to drop. */
export function forgetDeadBox(lease: ProducerLease, terminalId: string, presence: () => boolean | null): boolean {
  // isContaminated folds in the unconfirmed delivery: the two facts that refuse.
  if (!lease.isContaminated(terminalId)) return false
  if (presence() !== false) return false
  lease.clearProvenanceOnDeath(terminalId)
  return true
}
