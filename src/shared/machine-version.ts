/**
 * THE OLDEST MACHINE THE CONSOLE READS.
 *
 * 0.6.0 is the first build that takes the account's pass at its own door and
 * answers on the one relay path. A machine below it is told to update and is
 * ASKED NOTHING: not for its fleet, not to pair. The rule is stated once, here,
 * because the console draws the account's machines in two places (its Devices
 * level, and the devices stop inside a machine) and the second one once read
 * the old machine anyway.
 *
 * The desktop app does not apply it: it reaches the account's other machines
 * with a machine key, not the pass, and says what stands in the way in its own
 * words (zoom/machine-why.ts).
 */
export const MIN_MACHINE_VERSION = '0.6.0'

const triple = (version: string | null | undefined): readonly [number, number, number] | null => {
  // A pre-release or build suffix does not change which protocol a build speaks.
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version ?? '')
  return parts === null ? null : [Number(parts[1]), Number(parts[2]), Number(parts[3])]
}

const MIN_TRIPLE = triple(MIN_MACHINE_VERSION) ?? [0, 0, 0]

/** Older than the first build the console speaks to. A version that cannot be read is not taken for a new one. */
export function machineOutdated(version: string | null | undefined): boolean {
  const have = triple(version)
  if (have === null) return true
  for (let at = 0; at < 3; at += 1) if (have[at] !== MIN_TRIPLE[at]) return have[at] < MIN_TRIPLE[at]
  return false
}
