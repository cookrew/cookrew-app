import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * A TAILNET, AS THIS COMPUTER'S TAILSCALE SEES IT (owner ruling 2026-11-17: plain http to
 * another Magpie only on a tailnet). An address is a tailnet one only when `tailscale status
 * --json` names it: this computer's own Tailscale addresses, or a peer's addresses and name.
 * Looking like 100.64/10 or ending in .ts.net proves nothing (a hotel network can hand out
 * 100.64/10, any DNS can answer a .ts.net-looking name). No Tailscale, Tailscale not running,
 * an answer that cannot be read: nothing is a tailnet, and the warnings and https stand.
 */

export interface Tailnet {
  /** This computer's Tailscale addresses and name. */
  readonly self: readonly string[]
  /** Its peers' addresses and names. */
  readonly peers: readonly string[]
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
const name = (value: unknown): string[] => (typeof value === 'string' && value !== '' ? [value.toLowerCase().replace(/\.$/, '')] : [])

export function parseTailscaleStatus(text: string): Tailnet | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const status = parsed as { BackendState?: unknown; Self?: { TailscaleIPs?: unknown; DNSName?: unknown }; Peer?: unknown }
  if (status?.BackendState !== 'Running' || typeof status.Self !== 'object' || status.Self === null) return null
  const self = [...strings(status.Self.TailscaleIPs), ...name(status.Self.DNSName)]
  if (self.length === 0) return null
  const peers = Object.values((status.Peer as Record<string, { TailscaleIPs?: unknown; DNSName?: unknown }> | null | undefined) ?? {}).flatMap((p) => [...strings(p?.TailscaleIPs), ...name(p?.DNSName)])
  return { self, peers }
}

export const isTailnetPeer = (tailnet: Tailnet | null, host: string): boolean => tailnet !== null && tailnet.peers.includes(host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, ''))
export const isTailnetSelf = (tailnet: Tailnet | null, address: string): boolean => tailnet !== null && tailnet.self.includes(address)

const CLI = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']

const statusFrom = (bin: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)))
  })

/** `tailscale status --json` from the first Tailscale CLI that answers, or null. */
export async function tailscaleStatus(): Promise<string | null> {
  for (const bin of CLI) {
    if (bin.startsWith('/') && !existsSync(bin)) continue
    const out = await statusFrom(bin)
    if (out !== null) return out
  }
  return null
}

/** What Tailscale said last; read again on `refresh`. Starts knowing nothing. */
export function createTailnetView(read: () => Promise<string | null> = tailscaleStatus): { known(): Tailnet | null; refresh(): Promise<void> } {
  let known: Tailnet | null = null
  return {
    known: () => known,
    refresh: async () => {
      const text = await read().catch(() => null)
      known = text === null ? null : parseTailscaleStatus(text)
    }
  }
}
