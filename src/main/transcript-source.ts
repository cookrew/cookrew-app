import type { TerminalNodeData } from '../shared/model'
import { harnessFor } from './harness'

/**
 * WHERE A CARD'S RECORD COMES FROM — one answer per node, decided in one place.
 *
 *   'door'   the card is a line into a session at someone else's app; the
 *            record is read from that door (door-transcript.ts).
 *   'file'   the harness writes a session file here; the record is derived
 *            from it (harness registry, `turns: 'file'`).
 *   'scrape' nothing durable exists but the PTY; the tracker's scrape is the
 *            only history there will be.
 *
 * The three never overlap: a served card runs `node …/orch-line.mjs`, which no
 * harness matches, so a 'door' node can never also be 'file' — and this is
 * pinned by tests/remote-card-gates.test.ts (P14) so the harness contract's
 * "capability ⇔ wiring" rule keeps biting for the new source.
 */
export type TranscriptSource = 'door' | 'file' | 'scrape'

export function transcriptSourceFor(node: TerminalNodeData): TranscriptSource {
  if (node.servedSession) return 'door'
  return harnessFor(node.command)?.turns === 'file' ? 'file' : 'scrape'
}

const DOOR_NAME = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/
const DOOR_ARG = /(?:^|\s)'--door'\s+'(@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)'/

/**
 * The relayed door a card reaches, if it reaches one through the relay.
 *
 * Read from the receipt first; cards placed before the receipt carried the
 * name still say it in their command (the `--door` the line script resolves
 * at run time), so those keep working without being imported again.
 */
export function doorNameOf(node: TerminalNodeData): string | null {
  // Re-checked: the receipt is read back from persisted workspace JSON, and
  // the name becomes a URL path segment at the relay's loopback end.
  const kept = node.servedSession?.door
  if (kept && DOOR_NAME.test(kept)) return kept
  return DOOR_ARG.exec(node.command)?.[1] ?? null
}
