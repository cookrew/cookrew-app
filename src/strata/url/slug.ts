// URL SLUGS for Strata levels. Readable names in the URL, ids everywhere else:
// a slug is decided among siblings only, the oldest namesake keeps the bare
// slug, later ones get a short id hash, and a URL with that hash still finds
// its item after a rename. Pure: same siblings → same slugs.

export interface Named {
  id: string
  name: string
}

const MAX = 40
const SUFFIX_LENGTHS = [4, 6, 8] as const

/** Lower-case, accents folded, any other run → '-', ≤ 40 chars, 'x' when nothing is left. */
export const slugify = (name: string): string => {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  const capped = [...slug].slice(0, MAX).join('').replace(/-+$/, '')
  return capped || 'x'
}

/** murmur3's finalizer: every input bit moves every output bit. */
const fmix32 = (value: number): number => {
  let h = value >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

const BASE36_4 = 36 ** 4

/** FNV-1a over the id, mixed, as lower-case base36 of the given length (4–8). */
export const shortId = (id: string, length = 4): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0
  const first = fmix32(h)
  const second = fmix32(first ^ 0x9e3779b9)
  const digits = (n: number) => (n % BASE36_4).toString(36).padStart(4, '0')
  return (digits(first) + digits(second)).slice(0, length)
}

const suffixed = (base: string, id: string, length: number) => `${base}-${shortId(id, length)}`

/**
 * Slugs for one level's items, in their given (creation) order. The oldest of
 * each name keeps the bare slug unless it is reserved; the rest get the
 * shortest id suffix that is free.
 */
export const siblingSlugs = (siblings: readonly Named[], reserved: ReadonlySet<string> = new Set()): Map<string, string> => {
  const bases = siblings.map((s) => slugify(s.name))
  const firstOf = new Map<string, string>()
  bases.forEach((base, i) => {
    if (!firstOf.has(base) && !reserved.has(base)) firstOf.set(base, siblings[i].id)
  })
  const taken = new Set([...firstOf.keys(), ...reserved])
  const out = new Map<string, string>()
  siblings.forEach((sibling, i) => {
    const base = bases[i]
    if (firstOf.get(base) === sibling.id) {
      out.set(sibling.id, base)
      return
    }
    const free = SUFFIX_LENGTHS.map((n) => suffixed(base, sibling.id, n)).find((slug) => !taken.has(slug)) ?? `${base}-${sibling.id}`
    taken.add(free)
    out.set(sibling.id, free)
  })
  return out
}

const SUFFIX = /-([0-9a-z]{4,8})$/

/**
 * The sibling a URL slug names: the formatted slug, else the oldest whose name
 * slugs the same, else the one whose id hash matches the suffix (a renamed item).
 */
export const matchSibling = <T extends Named>(siblings: readonly T[], slug: string, reserved?: ReadonlySet<string>): T | null => {
  const exact = siblingSlugs(siblings, reserved)
  const byExact = siblings.find((s) => exact.get(s.id) === slug)
  if (byExact) return byExact
  const wanted = slugify(slug)
  const byName = siblings.find((s) => slugify(s.name) === wanted)
  if (byName) return byName
  const hash = SUFFIX.exec(wanted)?.[1]
  if (!hash) return null
  return siblings.find((s) => shortId(s.id, hash.length) === hash) ?? null
}
