import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pairTranscript } from '../shared/account-pair'

/**
 * THE ACCOUNT'S MACHINES TRUST EACH OTHER (owner, 2026-11-09: full control).
 *
 * This machine holds a key for every other machine of the account, collected
 * with no code and no password: cookrew.dev hands a desktop a MACHINE pass for
 * its own key (registry v2-device-grant.ts · issueMachineGrant), and each other
 * machine's door (account-pair.ts) admits it as a device of that machine after
 * a signature over that machine's own challenge. The key opens that machine as
 * a paired phone's does; revoking this machine at cookrew.dev ends it there.
 *
 * WHAT THIS SIGNS: only a challenge in the name of the machine it meant to
 * enter. A machine answering in another's name (passing on a third machine's
 * challenge) gets no signature, and a key answered for another machine is not
 * kept (security review 2026-11-09, the watch's same finding).
 */

export interface MachineRow {
  readonly id: string
  readonly name: string
  readonly online: boolean
}

export interface MachineKeyStore {
  readonly file: string
  token(desktopId: string): string | null
  keep(desktopId: string, name: string, token: string): void
  /** Machines revoked at the account: their keys go. */
  forget(desktopIds: readonly string[]): void
  ids(): string[]
}

export interface MachineKeysDeps {
  /** This machine's account device: who asks. Null with no account. */
  readonly self: () => { readonly deviceId: string; readonly name: string; readonly jwk: Record<string, unknown> } | null
  /** The account's desktops; null when cookrew.dev could not be asked. */
  readonly desktops: () => Promise<readonly MachineRow[] | null>
  /** This machine's pass into the others, or null. */
  readonly grant: () => Promise<string | null>
  /** One POST to another machine down the relay, under this machine's session; null when nothing came back. */
  readonly relay: (desktopId: string, route: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown } | null>
  /** This machine's device key over a message (account-v2.ts · signWithDevice). */
  readonly sign: (message: string) => string
  readonly store: MachineKeyStore
  readonly log?: (line: string) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

type Held = Record<string, { name: string; token: string; at: number }>

export function createMachineKeyStore(file: string, now: () => number = Date.now): MachineKeyStore {
  const read = (): Held => {
    try {
      if (!existsSync(file)) return {}
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isRecord(parsed) ? (parsed as Held) : {}
    } catch {
      return {}
    }
  }
  const write = (held: Held): void => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(held, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return {
    file,
    token: (desktopId) => {
      const held = read()[desktopId.toLowerCase()]
      return typeof held?.token === 'string' && held.token.length > 0 ? held.token : null
    },
    keep: (desktopId, name, token) => write({ ...read(), [desktopId.toLowerCase()]: { name, token, at: now() } }),
    forget: (desktopIds) => {
      const held = read()
      const gone = desktopIds.map((id) => id.toLowerCase()).filter((id) => id in held)
      if (gone.length === 0) return
      write(Object.fromEntries(Object.entries(held).filter(([id]) => !gone.includes(id))))
    },
    ids: () => Object.keys(read())
  }
}

/** One machine, entered with the pass: its key, or null. */
async function enterOne(deps: MachineKeysDeps, machine: MachineRow, grant: string, self: NonNullable<ReturnType<MachineKeysDeps['self']>>): Promise<string | null> {
  const meant = machine.id.toLowerCase()
  const asking = { deviceId: self.deviceId, jwk: self.jwk, name: self.name }
  const begun = await deps.relay(machine.id, 'api/pair/begin', { device: asking, grant })
  if (begun === null || begun.status !== 200 || !isRecord(begun.body)) return null
  const { challengeId, nonce, desktopId } = begun.body
  if (typeof challengeId !== 'string' || typeof nonce !== 'string' || typeof desktopId !== 'string') return null
  if (desktopId.toLowerCase() !== meant) {
    deps.log?.(`machine keys: ${machine.name} answered in another machine's name; nothing signed`)
    return null
  }
  const sig = deps.sign(pairTranscript({ desktopId, challengeId, nonce, deviceId: self.deviceId }))
  const done = await deps.relay(machine.id, 'api/pair', { device: asking, grant, challengeId, sig })
  if (done === null || done.status !== 200 || !isRecord(done.body)) return null
  const answer = done.body
  if (answer.ok !== true || typeof answer.token !== 'string' || answer.token.length === 0) return null
  if (typeof answer.desktopId !== 'string' || answer.desktopId.toLowerCase() !== meant) return null
  return answer.token
}

/** Every other online machine of the account this one holds no key for yet: entered. The ids entered. */
export async function enterMachines(deps: MachineKeysDeps): Promise<string[]> {
  const self = deps.self()
  if (self === null) return []
  const desktops = await deps.desktops()
  if (desktops === null) return []
  const missing = desktops.filter((m) => m.online && m.id.toLowerCase() !== self.deviceId.toLowerCase() && deps.store.token(m.id) === null)
  if (missing.length === 0) return []
  const grant = await deps.grant()
  if (grant === null) return []
  const entered: string[] = []
  for (const machine of missing) {
    try {
      const token = await enterOne(deps, machine, grant, self)
      if (token === null) continue
      deps.store.keep(machine.id, machine.name, token)
      deps.log?.(`machine keys: holding a key for ${machine.name}`)
      entered.push(machine.id)
    } catch (error) {
      deps.log?.(`machine keys: ${machine.name} could not be entered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return entered
}

/**
 * MACHINES FORGOTTEN HERE STAY OUT. The account's machines collect keys for
 * each other on their own, so a Forget on this machine would last only until the
 * forgotten one came back with its pass. Remembered here, and the door turns
 * its pass away (account-pair.ts · refusedMachine). Revoking it at the account
 * ends it everywhere.
 */
export interface RefusedMachines {
  has(deviceId: string): boolean
  add(deviceId: string): void
}

export function createRefusedMachines(file: string): RefusedMachines {
  const read = (): string[] => {
    try {
      if (!existsSync(file)) return []
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }
  return {
    has: (deviceId) => read().includes(deviceId.toLowerCase()),
    add: (deviceId) => {
      const held = read()
      const id = deviceId.toLowerCase()
      if (held.includes(id)) return
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify([...held, id])}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(file, 0o600)
    }
  }
}
