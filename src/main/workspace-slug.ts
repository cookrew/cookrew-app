/**
 * A workspace's URL identity — the `<slug>` in https://<host>/<slug>.
 *
 * Commander's ruling (marketplace-architecture §11, 2026-08-20): DERIVE AND
 * FREEZE. The slug is minted once, from the name, at creation; a rename never
 * moves it. That asymmetry is deliberate — a name is a label the owner edits
 * freely, but a slug is an address a paired phone has bookmarked, an exported
 * agent is called at (/<slug>/agents/<name>/ask), and a version pin cites.
 * Recomputing it on rename would silently 404 every one of those.
 *
 * Names are user text, so nothing here may throw: every input yields SOME
 * usable path segment, including one made entirely of emoji.
 */

/** Longest slug we mint. Long enough to stay readable, short enough to type. */
const MAX_SLUG = 48

/**
 * First path segments the SERVER owns. A workspace slugged with one of these
 * would mount its routes underneath the server's own and become unreachable,
 * so they are deflected at mint time rather than diagnosed later.
 *
 * `src` and `node_modules` are here because of the renderer DEV proxy
 * (renderer-dev-proxy.ts: rendererDevPathAllowed). Found by walking the live
 * app under the flag: /src/main.tsx was being read as a workspace slug `src`
 * and answered 404, so a phone in dev mode loaded an index and then no
 * modules — a blank page. `/@vite/client` and `/node_modules/...` survived
 * only because '@' and '_' happen to fail the slug shape, which is luck, not
 * design. Exported so the route splitter uses the SAME list; two copies of a
 * reserved-word list is how they drift.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'assets',
  'index.html',
  'src',
  'node_modules'
])

/**
 * Name → path segment. ASCII-only by design: a percent-encoded slug is not a
 * thing anyone can read off a phone screen or type into a terminal, so
 * non-ASCII is dropped rather than transliterated.
 */
export function deriveSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')

  if (base.length === 0) return 'workspace'
  // Suffixed rather than rejected: the owner's chosen name still shows through.
  if (RESERVED_SLUGS.has(base)) return `${base}-ws`
  return base
}

/**
 * Resolve a collision at MINT time. Matches uniqueName()'s shape in
 * shared/model.ts — same counting, URL-safe punctuation.
 */
export function uniqueSlug(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/**
 * The slug of a workspace: its frozen one if it has one, a freshly minted
 * unique one if it does not.
 *
 * `taken` is consulted ONLY when minting. A frozen slug is returned even if it
 * now collides — re-uniquing a live address is the failure this whole module
 * exists to prevent, and a collision among frozen slugs cannot arise from
 * minting (each was uniqued against its predecessors when it was created).
 */
export function slugFor(
  meta: { readonly name: string; readonly slug?: string },
  taken: readonly string[]
): string {
  if (meta.slug) return meta.slug
  return uniqueSlug(deriveSlug(meta.name), taken)
}
