import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import type { TerminalNodeData, WorkspaceState } from '../../../shared/model'
import { SETUP_LINE_COPY } from '../../../shared/first-run-copy'
import { setupLineAllowed } from '../../../shared/route-lines'
import { lineEndWords, SETUP_CARD_NAME, SETUP_CARD_PRESET, type SetupAsking, type SetupLineNow, type SetupStart } from '../../../shared/setup-line'
import { LINE_RUNNING, NOTHING_READ, observeOutput, runningView, startedLine, type SetupRunning } from './setup-line-state'

/**
 * THE SETUP CARD — a real Shell terminal named "Setup" in the CURRENT
 * workspace, made through the ordinary create path the first time a button
 * needs it and reused by name after that. Every "do it" button in the
 * Routing panel lands as one line run in this card: the user sees the
 * command, the phone can carry on with it, and an error is the vendor's own.
 *
 * Main does the typing, and only at the pane's prompt (main/setup-line.ts): a
 * pane with a password prompt open gets nothing, the press gets a sentence, and
 * Stop is the way to clear it. Main also says when the line ended, from its exit
 * status. Only lines of a known shape go at all (shared/route-lines.ts), held to
 * that here and again in main: a RouteState arrives over the companion API and
 * the relay too, and a string handed to a renderer must not become shell on the
 * owner's Mac. A key line is typed WITHOUT Enter and the pane is focused: the user
 * pastes the key and presses Enter themselves, so the key never passes
 * through a Cookrew field, a Cookrew api or this file.
 *
 * The card is found PER WORKSPACE, and the workspace is read at the moment
 * of typing: the key is computed synchronously from the current state when
 * `run` starts and checked again after the card is ensured, so a switch in
 * between types nothing into the workspace the owner just left. The id of
 * a card this hook created is remembered WITH the workspace it was made in,
 * never alone.
 */

export { SETUP_CARD_NAME }
/** Where the card lands the first time: right of everything, on the dock's 110 px modulus. */
const GUTTER = 110
/** How long a just-created card may take to show up in the workspace state. */
const APPEAR_MS = 5_000
const APPEAR_STEP_MS = 100
/** What an older desktop answers a door it does not have with. */
const NO_SUCH_DOOR = /\b40[45]\b/
/** How often main is asked how the line is doing. */
const NOW_EVERY_MS = 800
/** Asks that may go unanswered in a row before the line is given up on: a phone on a bad network. */
const NOW_MISSES = 15

export interface RunOptions {
  /** Type Enter after the line. Default true; false for a key line. */
  enter?: boolean
}

export type RunOutcome = { ok: true } | { ok: false; reason: string }

/** The card to type into, and whether this press made it. */
export interface EnsuredCard {
  id: string
  fresh: boolean
}

/** A line that ran to its end, for a screen with more to say about it. */
export interface SetupEnded {
  line: string
  ok: boolean
}

export interface SetupError {
  text: string
  /** Epoch ms, so the panel can show the newest of several sources. */
  at: number
}

export interface SetupTerminalControls {
  /** The card, once it exists in this workspace. */
  terminalId: string | null
  /** Type one line into the card, creating it first if it is not there. Never throws. */
  run: (line: string, options?: RunOptions) => Promise<RunOutcome>
  /** Bumped when the pane should take focus (a key line was typed). */
  focusTick: number
  /** Why the last run did nothing, or null. Cleared by the next run. */
  error: SetupError | null
  /** The line typed last, until it has ended. */
  running: SetupRunning | null
  /** The last line to end, whichever way. */
  ended: SetupEnded | null
  /** A press found the pane taken: Stop is the way to clear it. */
  stuck: boolean
  /** ^C to the pane: what a person would press, for a pane that may be off screen. */
  stop: () => void
}

export function findSetupCard(workspace: WorkspaceState | null): TerminalNodeData | null {
  if (!workspace) return null
  for (const node of workspace.nodes) {
    if (node.kind === 'terminal' && node.preset === SETUP_CARD_PRESET && node.name === SETUP_CARD_NAME) return node
  }
  return null
}

/** A spot beside the board, never on top of a card. */
export function setupCardPosition(workspace: WorkspaceState | null): { x: number; y: number } {
  if (!workspace || workspace.nodes.length === 0) return { x: 0, y: 0 }
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  for (const node of workspace.nodes) {
    right = Math.max(right, node.position.x + node.size.width)
    top = Math.min(top, node.position.y)
  }
  return { x: Math.ceil((right + GUTTER) / GUTTER) * GUTTER, y: Math.max(0, Math.ceil(top / GUTTER) * GUTTER) }
}

/** A workspace's identity for "did it change" — the state carries no id; name and directory, printably joined. */
export function workspaceKey(workspace: WorkspaceState | null): string {
  return workspace ? `${workspace.name} | ${workspace.dir}` : ''
}

export const WORKSPACE_CHANGED = 'the workspace changed while the Setup card was being readied — nothing typed'
export const LINE_UNEXPECTED = 'setup line unexpected — not typed'

/**
 * One run, as a decision: the allowlist, the card, the workspace read before and
 * after, and only then the ask to main. Pure over its deps so the refusals can be
 * tested without React: the hook supplies the live workspace and the bridge.
 */
export async function runLine(input: {
  line: string
  /** The workspace key now; read twice, around `ensure`. */
  currentKey: () => string
  ensure: (forKey: string) => Promise<EnsuredCard>
  send: (card: EnsuredCard) => Promise<SetupStart>
}): Promise<(SetupStart & { ok: true; id: string }) | Extract<SetupStart, { ok: false }>> {
  if (!setupLineAllowed(input.line)) return { ok: false, reason: LINE_UNEXPECTED, busy: false }
  const startKey = input.currentKey()
  let card: EnsuredCard
  try {
    card = await input.ensure(startKey)
  } catch (e: unknown) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), busy: false }
  }
  // The owner may have switched while the card was being made: the id
  // belongs to the workspace it was made in, and that is not this one.
  if (input.currentKey() !== startKey) return { ok: false, reason: WORKSPACE_CHANGED, busy: false }
  const answer = await input.send(card).catch((e: unknown): SetupStart => ({ ok: false, reason: NO_SUCH_DOOR.test(String(e)) ? SETUP_LINE_COPY.OLD_DESKTOP : SETUP_LINE_COPY.NOT_SENT, busy: false }))
  return answer.ok ? { ...answer, id: card.id } : answer
}

export function useSetupTerminal(workspace: WorkspaceState | null): SetupTerminalControls {
  // A card this hook made, remembered with the workspace it was made in.
  const [created, setCreated] = useState<{ key: string; id: string } | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const [error, setError] = useState<SetupError | null>(null)
  const [running, setRunning] = useState<SetupRunning | null>(null)
  const [ended, setEnded] = useState<SetupEnded | null>(null)
  const [stuck, setStuck] = useState(false)
  const runningRef = useRef<SetupRunning | null>(null)
  const watching = useRef<(() => void) | null>(null)
  const runningCard = useRef<string | null>(null)
  const creating = useRef<{ key: string; promise: Promise<string> } | null>(null)
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const key = workspaceKey(workspace)
  const existing = findSetupCard(workspace)
  // Synchronous on every render: a switch exposes no old id for even one frame.
  const terminalId = existing?.id ?? (created !== null && created.key === key ? created.id : null)

  const terminalRef = useRef(terminalId)
  terminalRef.current = terminalId

  const ensure = useCallback(async (forKey: string): Promise<EnsuredCard> => {
    const found = findSetupCard(workspaceRef.current)
    if (found) return { id: found.id, fresh: false }
    if (created !== null && created.key === forKey) return { id: created.id, fresh: false }
    if (creating.current !== null && creating.current.key === forKey) return { id: await creating.current.promise, fresh: true }
    const promise = cookrew()
      .createTerminal({ name: SETUP_CARD_NAME, preset: SETUP_CARD_PRESET, position: setupCardPosition(workspaceRef.current), orch: false })
      .then(async (node) => {
        // The PTY exists once the card is in the workspace state; typing
        // before that is typing into nothing. Bounded: a card that never
        // shows up is an error, not a wait.
        const deadline = Date.now() + APPEAR_MS
        while (Date.now() < deadline) {
          if (workspaceRef.current?.nodes.some((n) => n.id === node.id)) break
          await new Promise((r) => setTimeout(r, APPEAR_STEP_MS))
        }
        if (!workspaceRef.current?.nodes.some((n) => n.id === node.id)) throw new Error('the Setup card did not appear on the canvas')
        setCreated({ key: forKey, id: node.id })
        return node.id
      })
      .finally(() => {
        if (creating.current?.promise === promise) creating.current = null
      })
    creating.current = { key: forKey, promise }
    return { id: await promise, fresh: true }
  }, [created])

  // The line runs until main says it ended. The stream is a further attachment to
  // the same PTY, for the sign-in page a line prints; it ends nothing.
  const show = useCallback((next: SetupRunning | null): void => {
    runningRef.current = next
    setRunning(next)
  }, [])
  const watch = useCallback((id: string, line: string, runId: string): void => {
    watching.current?.()
    runningCard.current = id
    let stream = startedLine(line)
    let pane: { lastLine: string; asking: SetupAsking } = NOTHING_READ
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let misses = 0
    show(runningView(stream))
    const detachStream = cookrew().ptyAttach(id, (chunk) => {
      stream = observeOutput(stream, chunk)
      if (live) show(runningView(stream, pane))
    })
    const stopWatching = (): void => {
      live = false
      if (timer !== null) clearTimeout(timer)
      detachStream()
      if (watching.current === stopWatching) watching.current = null
    }
    const finish = (code: number | null, said?: string): void => {
      stopWatching()
      runningCard.current = null
      const words = said ?? lineEndWords(code)
      setError(words === null ? null : { text: words, at: Date.now() })
      setEnded({ line, ok: code === 0 })
      setStuck(false)
      show(null)
    }
    const read = (now: SetupLineNow | null): void => {
      if (!live) return
      misses = now === null ? misses + 1 : 0
      // Main still has the run, so this says what is known: not that it ended.
      if (misses >= NOW_MISSES) return finish(null, SETUP_LINE_COPY.OUT_OF_TOUCH)
      if (now?.state === 'ended') return finish(now.code)
      if (now?.state === 'none') return finish(null)
      if (now?.state === 'running') {
        // The answer goes in the pane: keys must not need a click first.
        if (now.asking !== null && pane.asking === null) setFocusTick((n) => n + 1)
        pane = now
        show(runningView(stream, pane))
      }
      timer = setTimeout(ask, NOW_EVERY_MS)
    }
    const ask = (): void => void (cookrew().setupLineNow?.(id, runId) ?? Promise.resolve(null)).catch(() => null).then(read)
    watching.current = stopWatching
    timer = setTimeout(ask, NOW_EVERY_MS)
  }, [show])
  useEffect(() => () => watching.current?.(), [])

  // A run main still has, on a screen that came back to it: a reload, a reopened phone.
  const adopt = useCallback((id: string): void => {
    void cookrew()
      .setupLineCurrent?.(id)
      .then((open) => {
        if (open && watching.current === null) watch(id, open.line, open.runId)
      })
      .catch(() => undefined)
  }, [watch])
  useEffect(() => {
    if (terminalId !== null) adopt(terminalId)
  }, [terminalId, adopt])

  const run = useCallback(
    async (line: string, options: RunOptions = {}): Promise<RunOutcome> => {
      setError(null)
      setStuck(false)
      setEnded(null)
      const enter = options.enter ?? true
      // One line at a time, from the press on: a card can take seconds to be ready,
      // and a line in another workspace is still the one Stop has to reach.
      if (runningRef.current !== null) {
        setError({ text: LINE_RUNNING, at: Date.now() })
        return { ok: false, reason: LINE_RUNNING }
      }
      if (enter) show(runningView(startedLine(line)))
      const answer = await runLine({
        line,
        currentKey: () => workspaceKey(workspaceRef.current),
        ensure,
        send: async ({ id, fresh }) => (await cookrew().setupLineStart?.({ terminalId: id, line, enter, fresh })) ?? { ok: false, reason: SETUP_LINE_COPY.OLD_DESKTOP, busy: false }
      })
      if (!answer.ok) {
        show(null)
        setError({ text: answer.reason, at: Date.now() })
        setStuck(answer.busy)
        if (answer.busy && terminalRef.current !== null) adopt(terminalRef.current)
        return answer
      }
      if (!enter) setFocusTick((n) => n + 1)
      else if (answer.runId !== null) watch(answer.id, line, answer.runId)
      else {
        show(null)
        if (answer.unwatched) setError({ text: SETUP_LINE_COPY.UNWATCHED, at: Date.now() })
      }
      return { ok: true }
    },
    [ensure, watch, show, adopt]
  )

  const stop = useCallback((): void => {
    // The card the line runs on, which need not be the one this workspace shows.
    const id = runningCard.current ?? terminalRef.current
    if (id === null) return
    cookrew().ptyInput(id, '\x03')
    setError(null)
    setStuck(false)
  }, [])

  return { terminalId, run, focusTick, error, running, ended, stuck, stop }
}
