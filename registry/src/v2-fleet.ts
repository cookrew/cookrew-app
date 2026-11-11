// THE FLEET ON THE REGISTRY: what a desktop may say about its hardware, and the
// level-0 rows the shell draws (src/shared/fleet.ts · FleetMachine).
//
// The profile is the desktop's own claim and arrives on the record PUT only
// that desktop may make; it is read here member by member, every string capped
// and every array bounded, so a desktop cannot park arbitrary JSON in the
// account file. Anything identifier-shaped (a hardware UUID, a MAC address) is
// refused outright: the desktop never sends one, so one arriving is a bug or a
// forgery, and either way it is not filed.

import { MACHINE_RELAY_PREFIX } from '../../src/shared/machine-relay'
import type { FleetMachine, FleetPresence, MachineKind, MachineProfile } from '../../src/shared/fleet'
import type { V2Desktop } from './v2-accounts'

export const PROFILE_STRING_MAX = 64
export const PROFILE_EVIDENCE_MAX = 12
export const PROFILE_EVIDENCE_STRING_MAX = 96
/** The whole profile as JSON. A real one is ~350 bytes. */
export const PROFILE_BYTES_MAX = 2048
export const APP_VERSION_MAX = 32

const KINDS: ReadonlySet<MachineKind> = new Set(['laptop', 'desktop', 'server', 'cloud', 'vm', 'cluster', 'sandbox', 'unknown'])
const OSES: ReadonlySet<MachineProfile['os']> = new Set(['darwin', 'linux', 'win32', 'other'])
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const MAC_ADDRESS = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/i
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/

/** Not a profile: refuse the PUT. */
export const BAD = Symbol('bad')

const text = (value: unknown, max: number): string | null | typeof BAD => {
  if (value === null) return null
  if (typeof value !== 'string') return BAD
  // eslint-disable-next-line no-control-regex
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value) || UUID.test(value) || MAC_ADDRESS.test(value)) return BAD
  return value
}

const count = (value: unknown, max: number): number | null | typeof BAD => {
  if (value === null) return null
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : BAD
}

/**
 * A profile as the desktop sent it, rebuilt from the members the contract
 * names (unknown members are dropped, not stored). `undefined` = the PUT did
 * not say (keep what is filed); null = clear it; BAD = refuse the PUT.
 */
export function readProfile(raw: unknown): MachineProfile | null | undefined | typeof BAD {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return BAD
  if (JSON.stringify(raw).length > PROFILE_BYTES_MAX) return BAD
  const r = raw as Record<string, unknown>
  if (!KINDS.has(r.kind as MachineKind) || !OSES.has(r.os as MachineProfile['os'])) return BAD
  const model = text(r.model, PROFILE_STRING_MAX)
  const label = text(r.label, PROFILE_STRING_MAX)
  const vendor = text(r.vendor, PROFILE_STRING_MAX)
  const osVersion = text(r.osVersion, PROFILE_STRING_MAX)
  const arch = text(r.arch, 16)
  const cpus = count(r.cpus, 4096)
  const memoryGb = count(r.memoryGb, 1 << 20)
  if ([model, label, vendor, osVersion, arch, cpus, memoryGb].includes(BAD) || arch === null) return BAD
  if (!Array.isArray(r.evidence) || r.evidence.length > PROFILE_EVIDENCE_MAX) return BAD
  const evidence: string[] = []
  for (const fact of r.evidence) {
    const read = text(fact, PROFILE_EVIDENCE_STRING_MAX)
    if (read === BAD || read === null) return BAD
    evidence.push(read)
  }
  return {
    kind: r.kind as MachineKind,
    model: model as string | null,
    label: label as string | null,
    vendor: vendor as string | null,
    os: r.os as MachineProfile['os'],
    osVersion: osVersion as string | null,
    arch: arch as string,
    cpus: cpus as number | null,
    memoryGb: memoryGb as number | null,
    evidence
  }
}

/** `undefined` = not said; null = clear; BAD = refuse. */
export function readAppVersion(raw: unknown): string | null | undefined | typeof BAD {
  if (raw === undefined) return undefined
  if (raw === null) return null
  return typeof raw === 'string' && raw.length <= APP_VERSION_MAX && APP_VERSION.test(raw) ? raw : BAD
}

/** The relay's own fact about a line: held now, and when this process last saw it. */
export interface DesktopPresence {
  online: boolean
  /** Epoch ms; null when this registry process has never seen its line. */
  lastSeenAt: number | null
}

/** Where a desktop's API is reached down the relay: the one path every client uses (shared/machine-relay.ts). */
export const desktopBase = (deviceId: string): string => `${MACHINE_RELAY_PREFIX}/${encodeURIComponent(deviceId)}`

/**
 * WHERE A DESKTOP STANDS, one answer for the list row and the presence row, so
 * the shell can lay one over the other as it stands. Now while it holds its
 * line; otherwise the later of the relay's last sight and the desktop's last
 * record PUT (a desktop filing its record is a desktop that was up); null when
 * neither ever happened.
 */
export function standing(desktop: V2Desktop, line: DesktopPresence | undefined, now: number): Pick<FleetMachine, 'id' | 'online' | 'lastSeenAt'> {
  const online = line?.online === true
  const seen = Math.max(line?.lastSeenAt ?? 0, desktop.updatedAt ?? 0)
  return { id: desktop.deviceId, online, lastSeenAt: online ? now : seen > 0 ? seen : null }
}

/** A level-0 row. */
export function fleetRow(desktop: V2Desktop, line: DesktopPresence | undefined, now: number): FleetMachine {
  const { id, online, lastSeenAt } = standing(desktop, line, now)
  return {
    id,
    name: desktop.name,
    online,
    lastSeenAt,
    appVersion: desktop.appVersion ?? null,
    profile: desktop.profile ?? null,
    base: desktopBase(desktop.deviceId)
  }
}

/** GET /v2/me/presence: every desktop's standing at one instant, and the cap. */
export function fleetPresence(
  desktops: readonly V2Desktop[],
  lines: ReadonlyMap<string, DesktopPresence>,
  cap: number,
  now: number
): FleetPresence {
  const rows = desktops.map((desktop) => standing(desktop, lines.get(desktop.deviceId), now))
  return { at: now, cap, online: rows.filter((row) => row.online).length, desktops: rows }
}
