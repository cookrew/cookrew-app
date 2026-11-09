import type { MachineProfile } from './fleet'

/**
 * A MACHINE DRAWN AS WHAT IT IS (owner, 2026-11-10: "lists all my machines as
 * shape of a computer, with type you could detect"). The kind, OS and model a
 * machine reports about itself (main/machine-profile.ts) pick a drawing: a
 * MacBook, a Mac mini, a Windows tower, a server, a server in a cloud with its
 * provider on it. Every drawing has a SCREEN, an empty group (`data-screen`)
 * at known coordinates that the page fills in once the reader has proved it is
 * them (cookrew.dev/me · machines.js); before that it stays blank.
 *
 * Ink line art on a 200×150 box, coloured by the page's own CSS classes, so it
 * follows the light and dark themes with no colours of its own.
 */

export type MachineShape =
  | 'macbook'
  | 'mini'
  | 'imac'
  | 'studio'
  | 'pclaptop'
  | 'tower'
  | 'server'
  | 'cloud'
  | 'vm'
  | 'sandbox'
  | 'cluster'
  | 'unknown'

export function machineShape(profile: MachineProfile | null): MachineShape {
  if (profile === null) return 'unknown'
  switch (profile.kind) {
    case 'cloud':
    case 'vm':
    case 'sandbox':
    case 'cluster':
    case 'server':
      return profile.kind
    case 'laptop':
      return profile.os === 'darwin' ? 'macbook' : 'pclaptop'
    case 'desktop': {
      if (profile.os !== 'darwin') return 'tower'
      const said = `${profile.label ?? ''} ${profile.model ?? ''}`
      if (/iMac/.test(said)) return 'imac'
      if (/Studio/.test(said)) return 'studio'
      return 'mini'
    }
    default:
      return 'unknown'
  }
}

const SYSTEM: Record<MachineProfile['os'], string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', other: 'Computer' }

/** The line under a machine's name: its model when it knows it, else its system. */
export function machineCaption(profile: MachineProfile | null): string {
  if (profile === null) return 'Computer'
  if (profile.label) return profile.model && profile.kind === 'cloud' ? `${profile.label} · ${profile.model}` : profile.label
  const system = SYSTEM[profile.os]
  return profile.osVersion ? `${system} · ${profile.osVersion}` : system
}

const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A screen, and the empty group the page fills in: its own coordinates, inset from the bezel. */
const screen = (x: number, y: number, w: number, h: number, dashed = false): string =>
  `<rect class="ms-scr" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"${dashed ? ' stroke-dasharray="6 5"' : ''}/><g data-screen="${x + 6} ${y + 6} ${w - 12} ${h - 12}"></g>`

const led = (x: number, y: number): string => `<circle class="ms-led" cx="${x}" cy="${y}" r="2.5"/>`

const DRAW: Record<MachineShape, (vendor: string | null) => string> = {
  macbook: () => `${screen(40, 22, 120, 78)}<path class="ms-body" d="M22 106 h156 l-10 14 h-136 z"/><path class="ms-ink" d="M88 106 h24"/>`,
  imac: () => `<rect class="ms-body" x="34" y="12" width="132" height="98" rx="8"/>${screen(42, 20, 116, 70)}<path class="ms-body" d="M86 110 l-6 22 h40 l-6 -22 z"/><path class="ms-ink" d="M70 134 h60"/>`,
  mini: () => `${screen(46, 14, 108, 74)}<path class="ms-ink" d="M100 88 v10"/><rect class="ms-body" x="56" y="104" width="88" height="26" rx="8"/>${led(132, 117)}`,
  studio: () => `${screen(30, 10, 104, 72)}<path class="ms-ink" d="M82 82 v12"/><rect class="ms-body" x="132" y="70" width="48" height="60" rx="9"/>${led(168, 120)}`,
  pclaptop: () => `${screen(42, 22, 116, 76)}<path class="ms-body" d="M30 104 h140 v12 h-140 z"/><path class="ms-ink" d="M42 110 h116" stroke-dasharray="3 4"/>`,
  tower: () => `${screen(20, 18, 112, 76)}<path class="ms-ink" d="M76 94 v14 M56 110 h40"/><rect class="ms-body" x="146" y="22" width="38" height="98" rx="5"/><path class="ms-ink" d="M154 38 h22 M154 46 h22"/>${led(165, 106)}`,
  server: () => `${screen(52, 8, 96, 56)}<rect class="ms-body" x="30" y="74" width="140" height="22" rx="4"/><rect class="ms-body" x="30" y="100" width="140" height="22" rx="4"/>${led(156, 85)}${led(156, 111)}<path class="ms-ink" d="M42 85 h50 M42 111 h50"/>`,
  cloud: (vendor) =>
    `<path class="ms-ink" d="M48 120 c-24 0 -26 -34 -2 -36 c2 -24 34 -30 46 -10 c10 -16 40 -12 42 10 c26 -2 30 34 4 36 z" stroke-dasharray="4 5"/>${screen(56, 10, 88, 54)}<rect class="ms-body" x="70" y="80" width="60" height="16" rx="3"/><rect class="ms-body" x="70" y="99" width="60" height="16" rx="3"/>${led(122, 88)}${led(122, 107)}${
      vendor ? `<text class="ms-vendor vendor" x="100" y="146" text-anchor="middle">${esc(vendor.slice(0, 24))}</text>` : ''
    }`,
  vm: () => `${screen(36, 18, 128, 84, true)}<path class="ms-ink" d="M84 104 v12 M66 118 h68" stroke-dasharray="4 4"/>`,
  sandbox: () =>
    `${screen(54, 10, 92, 58)}<path class="ms-body" d="M40 84 l60 -12 l60 12 l-60 12 z"/><path class="ms-body" d="M40 84 v34 l60 14 v-36 z"/><path class="ms-body" d="M160 84 v34 l-60 14 v-36 z"/>`,
  cluster: () =>
    `${screen(56, 6, 88, 52)}${[0, 1, 2].map((i) => `<rect class="ms-body" x="${30 + i * 8}" y="${66 + i * 22}" width="${140 - i * 16}" height="18" rx="3"/>${led(156 - i * 8, 75 + i * 22)}`).join('')}`,
  unknown: () => `${screen(40, 18, 120, 82)}<path class="ms-ink" d="M100 100 v14 M76 118 h48"/>`
}

/** The drawing, as an SVG element. `vendor` is written on a cloud. */
export function machineSvg(shape: MachineShape, vendor: string | null): string {
  return `<svg class="ms" viewBox="0 0 200 150" aria-hidden="true" focusable="false">${DRAW[shape](vendor)}</svg>`
}
