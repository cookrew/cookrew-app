// The registry's two fleet reads as the strata preview's mock answers them
// (src/shared/strata.ts, "registry"): the desktop list and the batch presence.
// Pure, so the preview and its tests build the same rows.

/** The relay keeps this many desktops of one account online at once. */
export const LINKS_PER_ACCOUNT = 8

/** As the registry says it: while a desktop is online it is seen now. */
const seenAt = ({ online, lastSeenAt }, at) => (online ? at : lastSeenAt)

/** GET /v2/me/desktops: every machine without its levels, reached at /m/<id>/ in the preview. */
export const desktopRows = (machines, at) =>
  machines.map(({ levels, ...row }) => ({ ...row, lastSeenAt: seenAt(row, at), base: `/m/${row.id}/` }))

/** GET /v2/me/presence: a row means exactly what its list row means at the same instant. */
export const presenceOf = (machines, at, cap = LINKS_PER_ACCOUNT) => {
  const desktops = machines.map((m) => ({ id: m.id, online: m.online, lastSeenAt: seenAt(m, at) }))
  return { at, cap, online: desktops.filter((d) => d.online).length, desktops }
}
