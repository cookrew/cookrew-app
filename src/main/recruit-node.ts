/**
 * WHAT A RECRUITED CARD CARRIES, AND WHAT A SPAWN MAY TYPE (route program R3).
 *
 * Observed live: after the RTE pick respawned a recruited card in place, the
 * sentence Sous had delivered reappeared in the composer UNSENT — the ledger
 * held one dispatch (done), so the second copy was not a delivery. The recruit
 * had written the sentence into `role`, a field every other reader treats as
 * a SAVED ROLE NAME: the pane chrome wore it as the display agent, the Agents
 * list drew it as a role chip, team fork looked it up, and a boot path that
 * keys on a role is one respawn away from typing it again.
 *
 * So the sentence has its own field, `brief`, which nothing types. The one
 * text a (re)spawn may put into a card is a staged copy preamble
 * (`pendingInject`, written by copyTeam for a card made while its workspace
 * was inactive, cleared on delivery). A brief is never that, and neither is a
 * role name.
 */
import type { TerminalNodeData } from '../shared/model'

/** The patch a recruit writes on the new node: the brief, and no role. */
export function recruitPatch(sentence: string): Pick<TerminalNodeData, 'brief' | 'role'> {
  return { brief: sentence, role: null }
}

/**
 * The ONLY text a spawn or respawn is allowed to type into a card: a staged
 * copy preamble. Null for everything else — a brief, a role name, a card that
 * has nothing staged — so a respawn types nothing of its own.
 */
export function spawnInjectionFor(node: Pick<TerminalNodeData, 'pendingInject' | 'brief' | 'role'>): string | null {
  const staged = node.pendingInject
  return typeof staged === 'string' && staged.length > 0 ? staged : null
}
