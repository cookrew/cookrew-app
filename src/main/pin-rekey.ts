// THE RE-KEY refuseRenumber HAS BEEN DEMANDING (lineage-ledger.ts): a ledger
// renumber is refused while any pin is keyed only by checkpoint INDEX,
// because renumbering moves every index out from under those pins — "Re-key
// pins by checkpoint uuid first, then re-run." This is that re-key. For each
// pin that has no `atUuid` yet, the ledger record at its `atIndex` supplies
// the uuid: pins and ledger live in the SAME index space at cut time (both
// continue across a /compact), so the record at that index IS the checkpoint
// the pin was cut at — the one moment the index join is still trustworthy.
// After the backfill the pin anchors by uuid (pinRowFraction) and the index
// becomes a display/legacy label that a compact can renumber harmlessly.

import type { TurnRecord } from '../shared/turn'
import type { VersionPinRecord } from '../shared/version-pin'

/**
 * Backfill `atUuid` on legacy pins from the durable turn ledger. Pure: inputs
 * are never mutated — a re-keyed pin is a NEW record with the uuid added, and
 * everything else (version, scrollLine, cutAt, manifestId, pinId) untouched;
 * a re-key is not an edit. Pins already keyed pass through unchanged, and so
 * do pins whose index no ledger record resolves (a truncated ledger, a
 * uuid-less scrape record) — honesty over guessing: an unresolvable pin keeps
 * its index anchoring rather than gaining a fabricated identity.
 */
export function rekeyPinsByUuid(
  pins: readonly VersionPinRecord[],
  records: readonly TurnRecord[]
): { pins: VersionPinRecord[]; changed: number } {
  const uuidByIndex = new Map<number, string>()
  for (const record of records) {
    if (record.uuid !== undefined) uuidByIndex.set(record.index, record.uuid)
  }
  let changed = 0
  const rekeyed = pins.map((pin) => {
    if (pin.atUuid !== undefined) return pin
    const uuid = uuidByIndex.get(pin.atIndex)
    if (uuid === undefined) return pin
    changed += 1
    return { ...pin, atUuid: uuid }
  })
  return { pins: rekeyed, changed }
}
