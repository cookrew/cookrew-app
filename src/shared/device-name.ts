/**
 * WHAT A MAC CALLS ITSELF ON THE ACCOUNT (v3, D12).
 *
 * "MacBook Pro" three times over is a Devices tab nobody can act on: the row
 * to revoke is the one that is NOT this Mac, and with three identical names
 * that is a guess. The design's answer is "<model> · <host>" —
 * "MacBook Pro · drej-mbp" — and a third machine that still collides gets a
 * counter, decided here and never at the registry: the registry files what it
 * is sent, and two devices sent the same name would be filed as the same name.
 *
 * PURE, AND SHARED. main gathers the two facts (sysctl hw.model, the
 * hostname); nothing about deciding the label needs a machine, so the
 * decision is testable without one and the web side can spell a name the same
 * way if it ever files a device.
 */

/**
 * The model identifiers Apple actually emits, by prefix, to the name a person
 * would use. `hw.model` says "MacBookPro18,3"; nobody calls their machine that.
 * Longest prefix wins, so "MacBookPro" is tried before "MacBook".
 */
const MODEL_LABELS: readonly (readonly [prefix: string, label: string])[] = [
  ['MacBookPro', 'MacBook Pro'],
  ['MacBookAir', 'MacBook Air'],
  ['MacBook', 'MacBook'],
  ['Macmini', 'Mac mini'],
  ['MacStudio', 'Mac Studio'],
  ['MacPro', 'Mac Pro'],
  ['iMacPro', 'iMac Pro'],
  ['iMac', 'iMac'],
  // Apple silicon models from 2022 on report "Mac14,7"-style identifiers
  // that no longer carry the family. "Mac" is honest; a table of every
  // Mac1x,y pair is a table that is wrong the week after the next keynote.
  ['Mac', 'Mac']
]

/** "MacBookPro18,3" → "MacBook Pro". An identifier we do not know is kept as typed. */
export function modelLabel(hwModel: string): string {
  const model = hwModel.trim()
  if (model.length === 0) return 'Mac'
  const hit = MODEL_LABELS.find(([prefix]) => model.startsWith(prefix))
  return hit ? hit[1] : model
}

/**
 * The hostname as a person set it: "drej-mbp.local" → "drej-mbp". The
 * `.local` is mDNS plumbing, and an empty hostname is still a Mac.
 */
export function hostLabel(hostname: string): string {
  const host = hostname.trim().replace(/\.local$/i, '')
  return host.length === 0 ? 'this-mac' : host
}

export interface DeviceNameInput {
  /** `sysctl -n hw.model`, or '' when it could not be read. */
  model: string
  /** `os.hostname()`, `.local` and all. */
  host: string
  /** The names already on the account, as GET /v2/me lists them. */
  taken: readonly string[]
}

/**
 * "<model> · <host>", and " (2)", " (3)"… while that name is already on the
 * account. The counter starts at 2 because the first holder of a name is not
 * "(1)" to anybody — and it climbs rather than stopping at 2, because a
 * fourth identical machine is unlikely and a name that collides is worse than
 * a name that is long.
 */
export function deviceDisplayName(input: DeviceNameInput): string {
  const base = `${modelLabel(input.model)} · ${hostLabel(input.host)}`
  const taken = new Set(input.taken.map((name) => name.trim()))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} (${n})`)) n += 1
  return `${base} (${n})`
}
