import type { RemoteMachineAnswer } from '../../../shared/remote-machine-calls'
import { briefId, type WaitAbout } from '../../../shared/wait-about'
import { hasWordsRow, type MenuAct, type WaitChoice, type WaitOption, type WaitRole } from '../../../shared/wait-choice'
import { statusWord, type InkStatus } from './ink-status'
import type { AgentView, MarkView } from './zoom-model'

/**
 * ANOTHER MACHINE INSIDE THIS ONE'S ZOOM VIEW (owner 2026-11-10, design B).
 *
 * The other machine answers with the compact cards its watch reads
 * (main/watch-routes.ts · cards): a tile per workspace, then a workspace's
 * whole crew, each card with its latest words, its menu and its items. This
 * turns that answer into the zoom's own views (zoom-model.ts), so the faces,
 * the words and the menu are drawn by the same parts as this machine's own,
 * and says, in every crumb past "Devices", whose they are.
 *
 * Nothing here trusts the other machine's shape: a card or a tile it cannot
 * use is left out, and an answer that is not one is null.
 */

export type RemoteStatus = 'idle' | 'working' | 'waiting' | 'done' | 'offline'

export interface RemoteItem {
  readonly id: string
  readonly kind: 'browser' | 'note'
  readonly title: string
  readonly host: string
  readonly tint: string
  readonly initial: string
  /** A device card's kind (shared/use-url.ts): a computer's screen is driven once control is taken. */
  readonly use?: 'computer' | 'phone' | 'hardware'
}

export interface RemoteCard {
  readonly id: string
  readonly name: string
  readonly preset: string
  readonly orch: boolean
  readonly workspace: { readonly id: string; readonly name: string }
  readonly status: RemoteStatus
  readonly word: string
  readonly words: { readonly text: string; readonly tone: 'working' | 'waiting' | 'done'; readonly full?: string } | null
  readonly about: string | null
  readonly choice: (WaitChoice & { readonly id: string }) | null
  readonly items: readonly RemoteItem[]
  readonly browsers: number
  readonly notes: number
}

export interface RemoteTile {
  readonly id: string
  readonly name: string
  readonly active: boolean
  readonly agents: number
  readonly waiting: number
  readonly working: number
  readonly done: number
}

export interface RemoteCards {
  readonly cards: readonly RemoteCard[]
  readonly workspaces: readonly RemoteTile[]
  readonly platform: string | null
}

type Loose = Record<string, unknown>

const STATUSES: readonly RemoteStatus[] = ['idle', 'working', 'waiting', 'done', 'offline']
const TONES = ['working', 'waiting', 'done'] as const
const ROLES: readonly WaitRole[] = ['toggle', 'type', 'submit', 'chat']
const USES = ['computer', 'phone', 'hardware'] as const

const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 20_000): string | null => (typeof value === 'string' && value.length <= max ? value : null)
const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0)
const index = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)
/** A tint as a colour and nothing else: it is written into a style, so never a url(). */
const colourOf = (value: unknown): string => (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : '')
const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((one) => typeof one === 'string') ? (value as string[]) : null)

function itemOf(raw: unknown): RemoteItem | null {
  if (!isObject(raw)) return null
  const id = text(raw.id, 200)
  const title = text(raw.title, 500)
  if (!id || title === null || (raw.kind !== 'browser' && raw.kind !== 'note')) return null
  const use = USES.find((one) => one === raw.use)
  return { id, kind: raw.kind, title, host: text(raw.host, 300) ?? '', tint: colourOf(raw.tint), initial: text(raw.initial, 4) ?? '', ...(use ? { use } : {}) }
}

function optionOf(raw: unknown): WaitOption | null {
  if (!isObject(raw)) return null
  const key = text(raw.key, 8)
  const label = text(raw.label, 2000)
  if (key === null || label === null) return null
  const role = ROLES.find((one) => one === raw.role)
  return {
    key,
    label,
    detail: text(raw.detail, 2000),
    ...(role ? { role } : {}),
    ...(typeof raw.checked === 'boolean' ? { checked: raw.checked } : {})
  }
}

function aboutOf(raw: unknown): WaitAbout | undefined {
  if (!isObject(raw)) return undefined
  const notes = strings(raw.notes)
  const body = strings(raw.body)
  if (!notes || !body) return undefined
  const sum = text(raw.sum, 128)
  return { title: text(raw.title, 2000), notes, body, partial: raw.partial === true, ...(sum !== null ? { sum } : {}) }
}

function choiceOf(raw: unknown): RemoteCard['choice'] {
  if (!isObject(raw)) return null
  const id = text(raw.id, 16_000)
  const question = text(raw.question, 4000)
  if (!id || question === null || (raw.kind !== 'menu' && raw.kind !== 'yn') || !Array.isArray(raw.options)) return null
  const options = raw.options.map(optionOf)
  if (options.length === 0 || options.some((one) => one === null)) return null
  const steps = isObject(raw.steps) ? { done: count(raw.steps.done), total: count(raw.steps.total) } : undefined
  const review = Array.isArray(raw.review)
    ? raw.review.flatMap((one) => (isObject(one) && typeof one.question === 'string' && typeof one.answer === 'string' ? [{ question: one.question, answer: one.answer }] : []))
    : undefined
  const about = aboutOf(raw.about)
  return {
    id,
    kind: raw.kind,
    question,
    sub: text(raw.sub, 2000),
    options: options as WaitOption[],
    cursor: index(raw.cursor),
    escIndex: index(raw.escIndex),
    ...(steps ? { steps } : {}),
    ...(review?.length ? { review } : {}),
    ...(about ? { about } : {})
  }
}

function wordsOf(raw: unknown): RemoteCard['words'] {
  if (!isObject(raw)) return null
  const said = text(raw.text)
  const tone = TONES.find((one) => one === raw.tone)
  if (said === null || !tone) return null
  const full = text(raw.full)
  return { text: said, tone, ...(full !== null ? { full } : {}) }
}

function cardOf(raw: unknown): RemoteCard | null {
  if (!isObject(raw)) return null
  const id = text(raw.id, 200)
  const name = text(raw.name, 500)
  const status = STATUSES.find((one) => one === raw.status)
  if (!id || name === null || !status) return null
  const workspace = isObject(raw.workspace) ? raw.workspace : {}
  const items = Array.isArray(raw.items) ? raw.items.map(itemOf).filter((one): one is RemoteItem => one !== null) : []
  return {
    id,
    name,
    preset: text(raw.preset, 100) ?? '',
    orch: raw.orch === true,
    workspace: { id: text(workspace.id, 200) ?? '', name: text(workspace.name, 500) ?? '' },
    status,
    word: text(raw.word, 100) ?? statusWord(status),
    words: wordsOf(raw.words),
    about: text(raw.about, 4000),
    choice: status === 'waiting' ? choiceOf(raw.choice) : null,
    items,
    browsers: count(raw.browsers),
    notes: count(raw.notes)
  }
}

function tileOf(raw: unknown): RemoteTile | null {
  if (!isObject(raw)) return null
  const id = text(raw.id, 200)
  const name = text(raw.name, 500)
  if (!id || name === null) return null
  return { id, name, active: raw.active === true, agents: count(raw.agents), waiting: count(raw.waiting), working: count(raw.working), done: count(raw.done) }
}

/** The other machine's cards, or null for an answer that is not one. */
export function parseRemoteCards(body: unknown): RemoteCards | null {
  if (!isObject(body) || !Array.isArray(body.cards) || !Array.isArray(body.workspaces)) return null
  return {
    cards: body.cards.map(cardOf).filter((one): one is RemoteCard => one !== null),
    workspaces: body.workspaces.map(tileOf).filter((one): one is RemoteTile => one !== null),
    platform: text(body.platform, 40)
  }
}

/** A card as the zoom's own parts draw an agent (zoom-model.ts · AgentView). */
export function remoteAgentView(card: RemoteCard): AgentView {
  const status: InkStatus = card.status
  return {
    id: card.id,
    name: card.name,
    preset: card.preset,
    orch: card.orch,
    phase: card.status === 'done' ? 'done' : card.status === 'idle' ? 'quiet' : card.status,
    unread: card.status === 'done',
    status,
    word: card.word,
    line: card.about ?? '',
    browsers: card.browsers,
    notes: card.notes,
    turn: { title: card.about, ask: null, tools: [], latest: card.words, pendingInput: null, tail: null }
  }
}

/** The faces a tile fans: one per agent, at most the tile's six. */
const TILE_FACES = 6

/** A workspace tile in the zoom's own form (WorkspaceTile.tsx); its items are not counted from here. */
export function tileView(tile: RemoteTile): MarkView {
  return {
    id: tile.id,
    name: tile.name,
    presets: Array.from({ length: Math.min(tile.agents, TILE_FACES) }, () => 'claude'),
    waiting: tile.waiting > 0,
    waitingCount: tile.waiting,
    browsers: null,
    notes: null,
    deck: []
  }
}

export interface Crumb {
  readonly label: string
  /** How deep it steps back to: 0 is the devices, 1 the machine, 2 a workspace, 3 an agent. */
  readonly depth: number
  /** Inside the other machine: drawn in its colour, so nothing is sent to the wrong one. */
  readonly remote: boolean
}

/** The breadcrumb: Devices, then the machine, then each stop inside it. */
export function crumbsOf(
  machine: { readonly name: string },
  workspace: { readonly id: string; readonly name: string } | null,
  agent: { readonly id: string; readonly name: string } | null,
  item: { readonly id: string; readonly title: string } | null
): Crumb[] {
  const inside = [machine.name, workspace?.name, agent?.name, item?.title]
  const crumbs: Crumb[] = [{ label: 'Devices', depth: 0, remote: false }]
  for (const [i, label] of inside.entries()) {
    if (label === undefined) break
    crumbs.push({ label, depth: i + 1, remote: true })
  }
  return crumbs
}

/** Did it answer at all: anything but "nothing came back" and the relay's own failures. */
export const answered = (answer: RemoteMachineAnswer): boolean => answer.status !== 0 && answer.status < 500

/** Why words, a menu's answer or a stop did not land, in words; null when it did. */
export function sendRefusal(answer: RemoteMachineAnswer, machine: string): string | null {
  const body = 'body' in answer && isObject(answer.body) ? answer.body : null
  if (answer.status === 0) return `${machine} isn’t answering. Your words are still here.`
  if (answer.status >= 200 && answer.status < 300) {
    if (body?.ok === false) return body.reason === 'moved' ? 'The menu moved on. Nothing was sent.' : 'That did not go through. Try again.'
    return null
  }
  const error = text(body?.error, 300)
  if (error && answer.status < 500) return error
  return `${machine} did not take that. Try again.`
}

/** A call a card makes on the other machine: its route and body. */
export interface CardCall {
  readonly route: string
  readonly body?: Record<string, unknown>
}

const terminal = (card: Pick<RemoteCard, 'id'>, what: string): string => `api/terminal/${encodeURIComponent(card.id)}/${what}`

/** An answer to the menu the card shows, named as that machine checks it (main/menu-answer.ts). */
export const menuCall = (card: Pick<RemoteCard, 'id'>, choice: NonNullable<RemoteCard['choice']>, act: MenuAct): CardCall => ({
  route: terminal(card, 'menu'),
  body: { menu: choice.id, brief: briefId(choice.about), act }
})

/**
 * What the reply box sends: words to the agent, or, with a menu up, into its
 * row to type in. A menu with no such row takes no words (null): they would
 * land on the row under its cursor, which may be "Yes".
 */
export function replyCall(card: Pick<RemoteCard, 'id' | 'choice'>, words: string): CardCall | null {
  const text = words.trim()
  if (!text) return null
  if (!card.choice) return { route: terminal(card, 'input'), body: { text } }
  return hasWordsRow(card.choice) ? menuCall(card, card.choice, { kind: 'words', text }) : null
}

/** Stop the turn: Esc, as the machine's own card sends it. */
export const stopCall = (card: Pick<RemoteCard, 'id'>): CardCall => ({ route: `api/watch/card/${encodeURIComponent(card.id)}/stop` })
