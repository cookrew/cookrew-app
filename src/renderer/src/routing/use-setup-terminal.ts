import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import type { TerminalNodeData, WorkspaceState } from '../../../shared/model'
import { setupLineAllowed } from '../../../shared/route-lines'
import { LINE_RUNNING, observeOutput, runningView, startedLine, type SetupRunning } from './setup-line-state'

/**
 * THE SETUP CARD — a real Shell terminal named "Setup" in the CURRENT
 * workspace, made through the ordinary create path the first time a button
 * needs it and reused by name after that. Every "do it" button in the
 * Routing panel lands as one line typed into this card: the user sees the
 * command, the phone can carry on with it, and an error is the vendor's own.
 *
 * Only lines of a known shape are typed (shared/route-lines.ts): a
 * RouteState arrives over the companion API and the relay too, and a
 * renderer must not turn a string it was handed into shell on the owner's
 * Mac. A key line is typed WITHOUT Enter and the pane is focused: the user
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

export const SETUP_CARD_NAME = 'Setup'
const SETUP_PRESET = 'Shell'
/** Where the card lands the first time: right of everything, on the dock's 110 px modulus. */
const GUTTER = 110
/** How long a just-created card may take to show up in the workspace state. */
const APPEAR_MS = 5_000
const APPEAR_STEP_MS = 100

export interface RunOptions {
  /** Type Enter after the line. Default true; false for a key line. */
  enter?: boolean
}

export type RunOutcome = { ok: true } | { ok: false; reason: string }

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
  /** The line typed last, while the pane has not shown its prompt again. */
  running: SetupRunning | null
}

export function findSetupCard(workspace: WorkspaceState | null): TerminalNodeData | null {
  if (!workspace) return null
  for (const node of workspace.nodes) {
    if (node.kind === 'terminal' && node.preset === SETUP_PRESET && node.name === SETUP_CARD_NAME) return node
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

/** The one line a key is pasted after, or a line with Enter: what the PTY receives. */
export function typedBytes(line: string, enter: boolean): string {
  return enter ? `${line}\r` : line
}

/** A workspace's identity for "did it change" — the state carries no id; name and directory, printably joined. */
export function workspaceKey(workspace: WorkspaceState | null): string {
  return workspace ? `${workspace.name} | ${workspace.dir}` : ''
}

export const WORKSPACE_CHANGED = 'the workspace changed while the Setup card was being readied — nothing typed'
export const LINE_UNEXPECTED = 'setup line unexpected — not typed'

/**
 * One run, as a decision: the allowlist, the card, the workspace read before
 * and after, and only then the bytes. Pure over its deps so the refusals can
 * be tested without React — the hook supplies the live workspace and the PTY.
 */
export async function runLine(input: {
  line: string
  enter: boolean
  /** The workspace key now; read twice, around `ensure`. */
  currentKey: () => string
  ensure: (forKey: string) => Promise<string>
  type: (terminalId: string, bytes: string) => void
}): Promise<RunOutcome> {
  if (!setupLineAllowed(input.line)) return { ok: false, reason: LINE_UNEXPECTED }
  const startKey = input.currentKey()
  let id: string
  try {
    id = await input.ensure(startKey)
  } catch (e: unknown) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  // The owner may have switched while the card was being made: the id
  // belongs to the workspace it was made in, and that is not this one.
  if (input.currentKey() !== startKey) return { ok: false, reason: WORKSPACE_CHANGED }
  input.type(id, typedBytes(input.line, input.enter))
  return { ok: true }
}

export function useSetupTerminal(workspace: WorkspaceState | null): SetupTerminalControls {
  // A card this hook made, remembered with the workspace it was made in.
  const [created, setCreated] = useState<{ key: string; id: string } | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const [error, setError] = useState<SetupError | null>(null)
  const [running, setRunning] = useState<SetupRunning | null>(null)
  const runningRef = useRef<SetupRunning | null>(null)
  const watching = useRef<(() => void) | null>(null)
  const creating = useRef<{ key: string; promise: Promise<string> } | null>(null)
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const key = workspaceKey(workspace)
  const existing = findSetupCard(workspace)
  // Synchronous on every render: a switch exposes no old id for even one frame.
  const terminalId = existing?.id ?? (created !== null && created.key === key ? created.id : null)

  const ensure = useCallback(async (forKey: string): Promise<string> => {
    const found = findSetupCard(workspaceRef.current)
    if (found) return found.id
    if (created !== null && created.key === forKey) return created.id
    if (creating.current !== null && creating.current.key === forKey) return creating.current.promise
    const promise = cookrew()
      .createTerminal({ name: SETUP_CARD_NAME, preset: SETUP_PRESET, position: setupCardPosition(workspaceRef.current), orch: false })
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
    return promise
  }, [created])

  // The line runs until the pane shows its prompt again (setup-line-state):
  // a third attachment to the same PTY, dropped the moment the prompt is back.
  const watch = useCallback((id: string, line: string): void => {
    watching.current?.()
    let state = startedLine(line)
    const show = (next: SetupRunning | null): void => {
      runningRef.current = next
      setRunning(next)
    }
    show(runningView(state))
    const detach = cookrew().ptyAttach(id, (chunk) => {
      state = observeOutput(state, chunk)
      if (state.done) {
        detach()
        if (watching.current === detach) watching.current = null
        show(null)
      } else show(runningView(state))
    })
    watching.current = detach
  }, [])
  useEffect(() => () => watching.current?.(), [])

  const run = useCallback(
    async (line: string, options: RunOptions = {}): Promise<RunOutcome> => {
      setError(null)
      const enter = options.enter ?? true
      if (runningRef.current !== null && runningRef.current.line === line) {
        setError({ text: LINE_RUNNING, at: Date.now() })
        return { ok: false, reason: LINE_RUNNING }
      }
      let typedInto: string | null = null
      const outcome = await runLine({
        line,
        enter,
        currentKey: () => workspaceKey(workspaceRef.current),
        ensure,
        type: (id, bytes) => {
          typedInto = id
          cookrew().ptyInput(id, bytes)
        }
      })
      if (!outcome.ok) setError({ text: outcome.reason, at: Date.now() })
      else if (!enter) setFocusTick((n) => n + 1)
      else if (typedInto !== null) watch(typedInto, line)
      return outcome
    },
    [ensure, watch]
  )

  return { terminalId, run, focusTick, error, running }
}
