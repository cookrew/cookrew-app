import { tintOf } from './zoom-layout'
import type { DeckSource, ItemView, MachineView, MarkView, ZoomInput } from './zoom-model'

/**
 * ANOTHER MACHINE AS THE DEVICES STOP DRAWS IT (zoom-model.ts re-exports
 * machineViewOf and itemInitial): its tiles, faces, counts and decks, from
 * that machine's own feed. Apart from zoom-model.ts so the console's Devices
 * level draws every machine (console-devices.ts, DevicesCanvas.tsx) without
 * the model of a crew and its cards, which its first load must not carry
 * (tests/console-first-load.test.ts).
 */

/** A browser's letter, on its coin, its card and its full view's head: the title's first letter or digit. */
export const itemInitial = (title: string): string => (title.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()

/** A workspace of another machine as a tile (owner 2026-11-11): from its own feed, never a made-up zero. */
const machineMarkOf = (w: NonNullable<ZoomInput['machines']>[number]['workspaces'][number]): MarkView => {
  const waitingCount = w.counts?.waiting ?? w.agents.filter((a) => a.phase === 'waiting').length
  return {
    id: w.id,
    name: w.name,
    presets: w.agents.map((a) => a.harness),
    waiting: waitingCount > 0,
    waitingCount,
    browsers: w.counts?.browsers ?? null,
    notes: w.counts?.notes ?? null,
    deck: (w.deck ?? []).map(deckView)
  }
}

/** One sheet of a workspace's deck, from what its machine said of it. */
export const deckView = (d: DeckSource): ItemView => ({ id: d.id, kind: d.kind, title: d.title, host: d.host ?? '', tint: tintOf(d.id), initial: itemInitial(d.title), line: '', owners: d.owners ?? [] })

/** A machine of the account as the devices stop draws it: its tiles, its counts, never a made-up zero. */
export function machineViewOf(m: NonNullable<ZoomInput['machines']>[number]): MachineView {
  return {
    id: m.id,
    name: m.name,
    local: m.local,
    online: m.online,
    detail: m.detail,
    appVersion: m.appVersion ?? null,
    ...(m.signedIn === undefined ? {} : { signedIn: m.signedIn }),
    os: m.os ?? null,
    workspaces: m.workspaces.map((w) => ({ id: w.id, name: w.name, presets: w.agents.map((a) => a.harness), waiting: w.agents.some((a) => a.phase === 'waiting') })),
    marks: m.workspaces.map((w) => machineMarkOf(w)),
    display: m.display ?? null,
    agents: m.workspaces.length && m.workspaces.every((w) => w.counts) ? m.workspaces.reduce((a, w) => a + (w.counts?.agents ?? 0), 0) : null,
    waiting: m.workspaces.length && m.workspaces.every((w) => w.counts) ? m.workspaces.reduce((a, w) => a + (w.counts?.waiting ?? 0), 0) : null
  }
}
