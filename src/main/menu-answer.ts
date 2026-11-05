import { answerKeys, choiceId, menuHeldOnScreen, MENU_KEYS, waitChoiceOfScreen, type MenuAct, type WaitChoice } from '../shared/wait-choice'
import { briefId } from '../shared/wait-about'

/**
 * AN ANSWER TO A WAITING AGENT'S MENU, CHECKED AGAINST THE SCREEN (owner task,
 * 2026-11-04). The box and the card draw a menu from an activity that may be a
 * push behind, and the same digit is valid on the next question: a tap on what
 * was on show must not land on what is on show now. So a client names the menu
 * and what it wants; this reads the screen as it stands, refuses if it is no
 * longer that menu, and works the keys out from the cursor it finds there.
 * A row taken also names what it approves (`brief`): two commands under one
 * question are one menu, and a Yes must land on the command the card showed.
 *
 * Writes go one at a time with a beat between: Enter in a burst with arrows
 * lands on the row they started from (measured). One answer at a time per
 * terminal, and the next one reads the screen the last one left.
 */

export interface MenuAnswerRequest {
  /** choiceId of the menu the client was showing. */
  readonly menu: string
  readonly act: MenuAct
  /** briefId of what the client was showing. Absent: a page from before it. */
  readonly brief?: string
}

export type MenuAnswerResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'moved' | 'refused' }

export interface MenuAnswerDeps {
  /** The screen as it stands: every byte received parsed. Null when it cannot be read. */
  screen: (terminalId: string) => Promise<string | null>
  /** Write keys; false when they were refused. inMenu: a menu stands in the input box's place. */
  send: (terminalId: string, keys: string, inMenu: boolean) => boolean
  /** The menu with its box whole, read now: a box taller than the screen keeps its top in the pane's history. */
  whole?: (terminalId: string, choice: WaitChoice) => Promise<WaitChoice | null>
  /** The client's brief is not the box that stands: what it shows should be read again. */
  moved?: (terminalId: string) => void
  sleep?: (ms: number) => Promise<void>
}

const GAP_MS = 150
/** What a client's act may carry: a real answer is short, and this crosses the wire. */
const MAX_WORDS = 4000
const MAX_MENU = 16_000
const MAX_BRIEF = 64

/** A request off the wire, or null. */
export function parseMenuRequest(body: unknown): MenuAnswerRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { menu, act, brief } = body as { menu?: unknown; act?: unknown; brief?: unknown }
  if (typeof menu !== 'string' || menu.length === 0 || menu.length > MAX_MENU) return null
  const parsed = actOf(act)
  if (!parsed) return null
  return typeof brief === 'string' && brief.length <= MAX_BRIEF ? { menu, act: parsed, brief } : { menu, act: parsed }
}

function actOf(act: unknown): MenuAct | null {
  if (typeof act !== 'object' || act === null) return null
  const a = act as { kind?: unknown; index?: unknown; dir?: unknown; text?: unknown; seq?: unknown }
  if (a.kind === 'esc') return { kind: 'esc' }
  if (a.kind === 'key' && typeof a.seq === 'string' && MENU_KEYS.includes(a.seq)) return { kind: 'key', seq: a.seq }
  if (a.kind === 'row' && Number.isInteger(a.index) && (a.index as number) >= 0 && (a.index as number) < 100) return { kind: 'row', index: a.index as number }
  if (a.kind === 'step' && (a.dir === 1 || a.dir === -1)) return { kind: 'step', dir: a.dir }
  // Words are words: no control bytes ride in on them.
  if (a.kind === 'words' && typeof a.text === 'string' && a.text.length > 0 && a.text.length <= MAX_WORDS) {
    const text = a.text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
    return text ? { kind: 'words', text } : null
  }
  return null
}

export function createMenuAnswerer(deps: MenuAnswerDeps): (terminalId: string, request: MenuAnswerRequest) => Promise<MenuAnswerResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  /** The answer in hand per terminal: the next waits for it. */
  const queue = new Map<string, Promise<unknown>>()

  /**
   * Does what stands now match what the client showed? Only a row that goes
   * ahead approves anything: Esc, the arrows and the Esc row must always get
   * through. A card still showing the end of a tall box said so, and matches
   * the screen; a whole one is checked against the whole box, read now.
   */
  const approves = async (terminalId: string, choice: WaitChoice, request: MenuAnswerRequest): Promise<boolean> => {
    const { act, brief } = request
    if (act.kind !== 'row' || brief === undefined || act.index === choice.escIndex) return true
    if (brief === briefId(choice.about)) return true
    if (!choice.about?.partial || !deps.whole) return false
    return briefId((await deps.whole(terminalId, choice))?.about) === brief
  }

  /** The screen once a pane's history has been read, which takes seconds: the keys come from this one. */
  const after = async (terminalId: string, screen: string, choice: WaitChoice, menu: string): Promise<{ screen: string; choice: WaitChoice } | null> => {
    if (!choice.about?.partial) return { screen, choice }
    const now = await deps.screen(terminalId)
    const read = now === null ? null : waitChoiceOfScreen(now)
    return now !== null && read && choiceId(read) === menu && briefId(read.about) === briefId(choice.about) ? { screen: now, choice: read } : null
  }

  const answer = async (terminalId: string, request: MenuAnswerRequest): Promise<MenuAnswerResult> => {
    const first = await deps.screen(terminalId)
    const seen = first === null ? null : waitChoiceOfScreen(first)
    if (first === null || !seen || choiceId(seen) !== request.menu) return { ok: false, reason: 'moved' }
    if (!(await approves(terminalId, seen, request))) {
      deps.moved?.(terminalId)
      return { ok: false, reason: 'moved' }
    }
    const held = await after(terminalId, first, seen, request.menu)
    if (!held) return { ok: false, reason: 'moved' }
    const { screen, choice } = held
    // Keys into a held menu skip the input box's guards, so it must still stand
    // before each write: gone, an Enter would land in the box. Rows nothing
    // proves a menu just keep those guards.
    const inMenu = menuHeldOnScreen(screen)
    const writes = answerKeys(choice, request.act)
    if (writes === null) return { ok: false, reason: 'refused' }
    for (const [i, keys] of writes.entries()) {
      if (i > 0) {
        await sleep(GAP_MS)
        if (inMenu && !menuHeldOnScreen((await deps.screen(terminalId)) ?? '')) return { ok: false, reason: 'moved' }
      }
      if (keys && !deps.send(terminalId, keys, inMenu)) return { ok: false, reason: 'refused' }
    }
    // The TUI's turn to redraw, before the next answer reads it.
    await sleep(GAP_MS)
    return { ok: true }
  }

  return (terminalId, request) => {
    const before = queue.get(terminalId) ?? Promise.resolve()
    const mine = before.then(
      () => answer(terminalId, request),
      () => answer(terminalId, request)
    )
    queue.set(terminalId, mine)
    return mine
  }
}

/** The running answerer, for the phone's route: index.ts has the terminals, mobile-api the request. */
let running: ReturnType<typeof createMenuAnswerer> | null = null
export const setMenuAnswerer = (answerer: ReturnType<typeof createMenuAnswerer>): void => {
  running = answerer
}
export const answerMenuRequest = (terminalId: string, request: MenuAnswerRequest): Promise<MenuAnswerResult> =>
  running ? running(terminalId, request) : Promise.resolve({ ok: false, reason: 'refused' })
