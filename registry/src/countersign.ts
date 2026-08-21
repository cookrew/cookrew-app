import { createHash } from 'node:crypto'

/**
 * WHAT A COUNTERSIGNATURE COMMITS TO.
 *
 * A publish and a key rotation are both "this identity vouches for this author
 * key on this preset", and until the routes existed that looked like one fact
 * worth one payload. It is not. The two operations MEAN different things — one
 * says "these bytes are mine", the other says "my signing key has changed" —
 * and a countersignature is published in the transparency log, where anybody
 * can read it.
 *
 * ONE payload for both therefore had a replay: lift a countersig out of the log
 * and present it at the OTHER route, and it verified, because it was a bare
 * signature over bytes that never said which operation was meant. Anyone with a
 * session token could have turned a publish into a key rotation.
 *
 * So the operation is INSIDE the digest, behind a scheme tag, with every field
 * separated by a NUL that cannot occur in any of them. The separator matters as
 * much as the fields: concatenating `a` + `bc` and `ab` + `c` gives one string
 * from two different pairs, and an attacker chooses the key id.
 *
 * The NUL is written as an escape rather than typed. A literal NUL in a source
 * file makes git call the whole file BINARY: it stops diffing, reviews stop
 * showing changes to it, and this module is one nobody should be able to change
 * invisibly. `'\0'` is the identical byte.
 */

/** The two things an identity can countersign. Never interchangeable. */
export type CountersignOperation = 'publish' | 'key-rotation'

/** Domain tag, so these bytes cannot collide with any other digest we make. */
const SCHEME = 'cookrew.countersign/1'

export function countersignPayload(
  operation: CountersignOperation,
  authorKeyId: string,
  presetId: string
): Buffer {
  return createHash('sha256')
    .update(`${SCHEME}\0${operation}\0${authorKeyId}\0${presetId}`)
    .digest()
}

/**
 * The same payload as a hex string — the form the challenge binding and the log
 * record use, so an auditor reading a record can recompute the exact bytes that
 * record claims were countersigned.
 */
export function countersignBinding(
  operation: CountersignOperation,
  authorKeyId: string,
  presetId: string
): string {
  return countersignPayload(operation, authorKeyId, presetId).toString('hex')
}
