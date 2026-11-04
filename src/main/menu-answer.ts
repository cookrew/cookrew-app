import { answerKeys, choiceId, menuHeldOnScreen, MENU_KEYS, waitChoiceOfScreen, type MenuAct } from '../shared/wait-choice'

/**
 * AN ANSWER TO A WAITING AGENT'S MENU, CHECKED AGAINST THE SCREEN (owner task,
 * 2026-11-04). The box and the card draw a menu from an activity that may be a
 * push behind, and the same digit is valid on the next question: a tap on what
 * was on show must not land on what is on show now. So a client names the menu
 * and what it wants; this reads the screen as it stands, refuses if it is no
 * longer that menu, and works the keys out from the cursor it finds there.
 *
 * Writes go one at a time with a beat between: Enter in a burst with arrows
 * lands on the row they started from (measured). One answer at a time per
 * terminal, and the next one reads the screen the last one left.
 */

export interface MenuAnswerRequest {
  /** choiceId of the menu the client was showing. */
  readonly menu: string
  readonly act: MenuAct
}

export type MenuAnswerResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'moved' | 'refused' }

export interface MenuAnswerDeps {
  /** The screen as it stands: every byte received parsed. Null when it cannot be read. */
  screen: (terminalId: string) => Promise<string | null>
  /** Write keys; false when they were refused. inMenu: a menu stands in the input box's place. */
  send: (terminalId: string, keys: string, inMenu: boolean) => boolean
  sleep?: (ms: number) => Promise<void>
}

const GAP_MS = 150
/** What a client's act may carry: a real answer is short, and this crosses the wire. */
const MAX_WORDS = 4000
const MAX_MENU = 16_000

/** A request off the wire, or null. */
export function parseMenuRequest(body: unknown): MenuAnswerRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { menu, act } = body as { menu?: unknown; act?: unknown }
  if (typeof menu !== 'string' || menu.length === 0 || menu.length > MAX_MENU) return null
  if (typeof act !== 'object' || act === null) return null
  const a = act as { kind?: unknown; index?: unknown; dir?: unknown; text?: unknown; seq?: unknown }
  if (a.kind === 'esc') return { menu, act: { kind: 'esc' } }
  if (a.kind === 'key' && typeof a.seq === 'string' && MENU_KEYS.includes(a.seq)) return { menu, act: { kind: 'key', seq: a.seq } }
  if (a.kind === 'row' && Number.isInteger(a.index) && (a.index as number) >= 0 && (a.index as number) < 100) return { menu, act: { kind: 'row', index: a.index as number } }
  if (a.kind === 'step' && (a.dir === 1 || a.dir === -1)) return { menu, act: { kind: 'step', dir: a.dir } }
  // Words are words: no control bytes ride in on them.
  if (a.kind === 'words' && typeof a.text === 'string' && a.text.length > 0 && a.text.length <= MAX_WORDS) {
    const text = a.text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
    return text ? { menu, act: { kind: 'words', text } } : null
  }
  return null
}

export function createMenuAnswerer(deps: MenuAnswerDeps): (terminalId: string, request: MenuAnswerRequest) => Promise<MenuAnswerResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  /** The answer in hand per terminal: the next waits for it. */
  const queue = new Map<string, Promise<unknown>>()

  const answer = async (terminalId: string, request: MenuAnswerRequest): Promise<MenuAnswerResult> => {
    const screen = await deps.screen(terminalId)
    const choice = screen === null ? null : waitChoiceOfScreen(screen)
    if (screen === null || !choice || choiceId(choice) !== request.menu) return { ok: false, reason: 'moved' }
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
