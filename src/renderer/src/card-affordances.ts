import type { CanvasNode, TerminalNodeData } from '../../shared/model'

/**
 * WHAT A CARD'S MENU MAY OFFER — decided once, testable without a DOM.
 *
 * Everything tappable on a card either works or is absent; nothing renders
 * and then dies silently (remote-card parity contract, P11). The known liar
 * this replaces: FORK was offered on an imported card because "the api has
 * listTurns", and forked nothing — a fork truncates a LOCAL session file copy,
 * and an imported card's session file lives at the author's app. Same for
 * SAVE ROLE and WORKDIR (the cwd is at the author's app too).
 */
export interface CardAffordances {
  rename: boolean
  role: boolean
  fork: boolean
  workdir: boolean
}

export interface CardCapabilities {
  /** The bridge can list turns (every bridge today; kept explicit). */
  listTurns: boolean
  /** A role can be saved from a checkpoint on this host. */
  roleFromCheckpoint: boolean
}

export function cardAffordances(node: CanvasNode | null, caps: CardCapabilities): CardAffordances {
  const terminal = node?.kind === 'terminal' ? (node as TerminalNodeData) : null
  // An imported card is a line into someone else's session. Its record is
  // read from the door; nothing here can rewrite it, so nothing here offers to.
  const remote = terminal?.servedSession != null
  const fork = terminal !== null && !remote && caps.listTurns
  const role = fork && caps.roleFromCheckpoint && terminal.command.trim() !== ''
  const workdir = terminal !== null && !remote
  return { rename: node !== null, role, fork, workdir }
}
