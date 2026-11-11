/**
 * THE ZOOM NAVIGATOR'S DEVICES — the account's desktops, as a renderer may see them.
 *
 * The registry's GET /v2/me/desktops row is a desktop's whole directory record:
 * its signed reach card (addresses), the doors it holds, the relay base, and
 * the FleetMachine facts (shared/fleet.ts). The navigator draws a device from
 * the facts and nothing else, so the record is cut down HERE, on the side that
 * asked (main for the desktop window, the phone's own fetch through the
 * relay), and an address never reaches a view.
 *
 * Another desktop's workspaces come as names only: its agents live on that
 * Mac, behind that Mac's own pairing token, which this one does not hold.
 */
import { FLEET_LINE_MAX, type MachineKind, type MachineProfile } from './fleet'

/** One desktop of the signed-in account. */
export interface AccountMachine {
  /** Registry desktop id: stable across renames. */
  id: string
  name: string
  /** Holding its relay line right now (the registry's word). */
  online: boolean
  lastSeenAt: number | null
  appVersion: string | null
  /** Null for a desktop older than the probe: drawn as unknown. */
  profile: MachineProfile | null
  /** False when the registry says nobody is signed in on it; absent when it does not say (shared/fleet.ts). */
  signedIn?: boolean
  /** The workspaces it registered, by name. */
  workspaces: Array<{ id: string; name: string }>
  /** The desktop answering: this window's own Mac, or the one the phone is served for. */
  current: boolean
}

/**
 * signed-out   no account here, or its session ended: a state, not an error
 * unavailable  this surface cannot ask (a page the Mac serves itself has no account cookie)
 * offline      cookrew.dev did not answer
 * refused      it answered no
 * malformed    it answered something this app cannot read
 * failed       the question could not be asked at all
 */
export type AccountMachinesRefusal = 'signed-out' | 'unavailable' | 'offline' | 'refused' | 'malformed' | 'failed'

export type AccountMachines = { ok: true; machines: AccountMachine[] } | { ok: false; reason: AccountMachinesRefusal }

const KINDS: readonly MachineKind[] = ['laptop', 'desktop', 'server', 'cloud', 'vm', 'cluster', 'sandbox', 'unknown']
const OSES: readonly MachineProfile['os'][] = ['darwin', 'linux', 'win32', 'other']
/** Probe facts kept per profile; a desktop sends a handful. */
const EVIDENCE_MAX = 16

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.slice(0, FLEET_LINE_MAX) : null)
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

/** A profile as the desktop probed it, every field checked; null when there is none. */
export function parseProfile(raw: unknown): MachineProfile | null {
  if (!isRow(raw)) return null
  return {
    kind: oneOf(raw.kind, KINDS, 'unknown'),
    model: text(raw.model),
    label: text(raw.label),
    vendor: text(raw.vendor),
    os: oneOf(raw.os, OSES, 'other'),
    osVersion: text(raw.osVersion),
    arch: text(raw.arch) ?? '',
    cpus: count(raw.cpus),
    memoryGb: count(raw.memoryGb),
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.filter((fact): fact is string => typeof fact === 'string').slice(0, EVIDENCE_MAX)
      : []
  }
}

const parseWorkspaces = (raw: unknown): AccountMachine['workspaces'] =>
  Array.isArray(raw)
    ? raw.flatMap((w) => {
        if (!isRow(w)) return []
        const id = text(w.id)
        const name = text(w.name)
        return id && name ? [{ id, name }] : []
      })
    : []

function parseRow(raw: unknown, currentId: string | null): AccountMachine | null {
  if (!isRow(raw)) return null
  // fleetRow's `id`, else desktopBody's `deviceId` (a registry older than these rows).
  const id = text(raw.id) ?? text(raw.deviceId)
  const name = text(raw.name)
  if (!id || !name) return null
  return {
    id,
    name,
    online: raw.online === true,
    lastSeenAt: count(raw.lastSeenAt),
    appVersion: text(raw.appVersion),
    profile: parseProfile(raw.profile),
    ...(typeof raw.signedIn === 'boolean' ? { signedIn: raw.signedIn } : {}),
    workspaces: parseWorkspaces(raw.workspaces),
    current: currentId !== null && id.toLowerCase() === currentId.toLowerCase()
  }
}

/**
 * The registry's /v2/me/desktops answer, cut to AccountMachine rows. A row it
 * cannot read is dropped; an answer that is not a list is null (malformed).
 */
export function parseAccountMachines(raw: unknown, currentId: string | null): AccountMachine[] | null {
  if (!Array.isArray(raw)) return null
  return raw.flatMap((row) => {
    const machine = parseRow(row, currentId)
    return machine ? [machine] : []
  })
}
