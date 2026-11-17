import { tintOf } from './zoom-layout'
import { inkStatusOfRow, statusWord } from './ink-status'
import type { AgentPhase } from '../agent-rows'
import type { AgentView, DeckSource, ItemView, MachineView, MarkView, SeatedAgent, ZoomInput } from './zoom-model'

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

/**
 * The feed's phase (shared/fleet.ts · AgentPhase: idle, thinking, waiting, replied, offline) in the
 * board's words every view reads (agent-rows.ts · AgentPhase); a board word passes as it is. A reply
 * the feed calls `replied` is one not read yet.
 */
const SEAT_PHASE: Record<string, { phase: AgentPhase; unread: boolean }> = {
  idle: { phase: 'quiet', unread: false },
  thinking: { phase: 'working', unread: false },
  replied: { phase: 'done', unread: true },
  waiting: { phase: 'waiting', unread: false },
  offline: { phase: 'offline', unread: false },
  working: { phase: 'working', unread: false },
  done: { phase: 'done', unread: false },
  failed: { phase: 'failed', unread: false },
  quiet: { phase: 'quiet', unread: false }
}
export const seatPhase = (phase: string): { phase: AgentPhase; unread: boolean } => SEAT_PHASE[phase] ?? { phase: 'quiet', unread: false }

/** An agent as its desktop's feed seats it, drawn as every view draws one; null when the feed names no id. */
export function seatedView(agent: SeatedAgent): AgentView | null {
  if (!agent.id) return null
  const { phase, unread } = seatPhase(agent.phase)
  const status = inkStatusOfRow(phase, unread)
  return { id: agent.id, name: agent.name ?? agent.id, preset: agent.harness, orch: !!agent.orch, phase, unread, status, word: statusWord(status), line: agent.reply || agent.task || 'Nothing said yet.', browsers: agent.attachments?.filter((item) => item.kind === 'browser').length ?? 0, notes: agent.attachments?.filter((item) => item.kind === 'note').length ?? 0, turn: null }
}

/** A workspace of another machine as a tile (owner 2026-11-11): from its own feed, never a made-up zero. */
const machineMarkOf = (w: NonNullable<ZoomInput['machines']>[number]['workspaces'][number]): MarkView => {
  const waitingCount = w.counts?.waiting ?? w.agents.filter((a) => a.phase === 'waiting').length
  return {
    id: w.id,
    name: w.name,
    presets: w.agents.map((a) => a.harness),
    // Who is there, by name and state: the devices stop draws them, and the keys stand on them (agent-keys.ts).
    agents: w.agents.flatMap((a) => seatedView(a) ?? []),
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
