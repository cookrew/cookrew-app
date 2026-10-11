import { useCallback, useRef, useState } from 'react'
import { cookrew } from '../api'
import type { TerminalNodeData, WorkspaceState } from '../../../shared/model'

/**
 * THE SETUP CARD — a real Shell terminal named "Setup" in the current
 * workspace, made through the ordinary create path the first time a button
 * needs it and reused by name after that. Every "do it" button in the
 * Routing panel lands as one line typed into this card: the user sees the
 * command, the phone can carry on with it, and an error is the vendor's own.
 *
 * A key line is typed WITHOUT Enter and the pane is focused: the user pastes
 * the key and presses Enter themselves, so the key never passes through a
 * Cookrew field, a Cookrew api or this file.
 */

export const SETUP_CARD_NAME = 'Setup'
const SETUP_PRESET = 'Shell'
/** Where the card lands the first time: right of everything, on the dock's 110 px modulus. */
const GUTTER = 110

export interface RunOptions {
  /** Type Enter after the line. Default true; false for a key line. */
  enter?: boolean
}

export interface SetupTerminalControls {
  /** The card, once it exists. */
  terminalId: string | null
  /** Type one line into the card, creating it first if it is not there. */
  run: (line: string, options?: RunOptions) => Promise<void>
  /** Bumped when the pane should take focus (a key line was typed). */
  focusTick: number
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

export function useSetupTerminal(workspace: WorkspaceState | null): SetupTerminalControls {
  const existing = findSetupCard(workspace)
  const [created, setCreated] = useState<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const terminalId = existing?.id ?? created
  const creating = useRef<Promise<string> | null>(null)
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const ensure = useCallback(async (): Promise<string> => {
    const found = findSetupCard(workspaceRef.current)
    if (found) return found.id
    if (created) return created
    if (creating.current) return creating.current
    creating.current = cookrew()
      .createTerminal({ name: SETUP_CARD_NAME, preset: SETUP_PRESET, position: setupCardPosition(workspaceRef.current), orch: false })
      .then((node) => {
        setCreated(node.id)
        return node.id
      })
      .finally(() => {
        creating.current = null
      })
    return creating.current
  }, [created])

  const run = useCallback(
    async (line: string, options: RunOptions = {}): Promise<void> => {
      const id = await ensure()
      const enter = options.enter ?? true
      // A fresh PTY needs a beat before its first bytes; the shell prompt is
      // what tells the user the line landed, so the line waits for it.
      if (!findSetupCard(workspaceRef.current)) await new Promise((r) => setTimeout(r, 600))
      cookrew().ptyInput(id, enter ? `${line}\r` : line)
      if (!enter) setFocusTick((n) => n + 1)
    },
    [ensure]
  )

  return { terminalId, run, focusTick }
}
