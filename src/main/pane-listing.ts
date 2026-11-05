// One pane listing for everyone waiting on one.
//
// A close polls until its pane is gone, and a workspace delete runs one close per
// card: left alone that is a fork per card per tick. Callers in the same moment
// share a read, and a failed read is never kept.

export type Listing = () => Promise<ReadonlySet<string>>

export function sharedListing(read: Listing, freshMs: number, now: () => number = Date.now): Listing {
  let pending: Promise<ReadonlySet<string>> | null = null
  let last: { at: number; names: ReadonlySet<string> } | null = null
  return () => {
    if (pending) return pending
    if (last && now() - last.at < freshMs) return Promise.resolve(last.names)
    const run = read()
      .then((names) => {
        last = { at: now(), names }
        return names
      })
      .finally(() => {
        pending = null
      })
    pending = run
    return run
  }
}
