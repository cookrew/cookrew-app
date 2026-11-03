/** The panel has one line for what did not happen; of several sources it shows the one that spoke last. */
export function newestError(...errors: ({ text: string; at: number } | null | undefined)[]): string | null {
  let newest: { text: string; at: number } | null = null
  for (const e of errors) {
    if (e && (newest === null || e.at >= newest.at)) newest = e
  }
  return newest?.text ?? null
}
