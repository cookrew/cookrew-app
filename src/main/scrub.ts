/**
 * SCRUB — placeholder for Tinker's `scrub()` (HP contract: replaces every
 * sealed secret value, the pairing token, gateway keys, KEY/TOKEN/SECRET/
 * PASSWORD env values and high-entropy runs with `[redacted]`; never
 * word-list based). His lane lands the real one at THIS path under THIS
 * name; until it merges, this identity shim keeps the Sous ledger's every
 * row going through the same call, so the swap is a merge and not an edit.
 * Atlas: on conflict, take Tinker's file.
 */
export function scrub(text: string): string {
  return text
}
