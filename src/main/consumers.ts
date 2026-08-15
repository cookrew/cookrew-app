// Who is allowed to ask, and for what (v4 §4's ~/.cookrew/consumers.json).
//
// The spec's own framing is that the pairing and wall tokens "become rows 1 and
// 2 (strict generalization)" — so the table is not a new authority, it is the
// existing two credentials written down in the shape everything after them will
// use. That is why the generated rows live HERE in code rather than in the file:
// an absent, unreadable or malformed consumers.json must land on exactly
// today's two-token behaviour, never on an empty table (which would lock the
// owner's own phone out) and never on a permissive one.
//
// Rows other than `phone` and `wall` are parsed and kept, but nothing can
// present their credential: minting consumer tokens is wave 5 (the factory
// binds instance tokens at instantiation). A row for a consumer that cannot
// authenticate is inert, which is the honest state for a table that is ahead of
// its token minting.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { GateConsumer } from '../shared/gate'

/**
 * The phone's row: the paired device is the owner's own hand on the canvas, so
 * it holds every group. `admin` is included for the same reason it exists —
 * gate management is an owner action — even though no admin route exists yet.
 */
export const PHONE_CONSUMER: GateConsumer = {
  groups: ['observe', 'dispatch', 'orchestrate', 'terminal-io', 'admin'],
  workspaces: '*'
}

/**
 * The wall's row: observe and nothing else. This URL lives in a Home Assistant
 * script on an always-on screen, so it must never carry write authority — and
 * `terminal-io` is not observe, because raw pane bytes can carry secrets the
 * curated projections do not.
 */
export const WALL_CONSUMER: GateConsumer = { groups: ['observe'], workspaces: '*' }

/** Names the two generated rows answer to. */
export const PHONE_CONSUMER_NAME = 'phone'
export const WALL_CONSUMER_NAME = 'wall'

export function defaultConsumersFile(): string {
  return path.join(homedir(), '.cookrew', 'consumers.json')
}

const scopeSchema = z.union([z.literal('*'), z.array(z.string())])

/**
 * Deliberately NOT `.strict()`: §4's own example rows carry `dispatch`,
 * `rate` and `meter` fields that belong to later waves. Rejecting a file
 * because it is ahead of the code would make writing it impossible; ignoring
 * the fields we do not enforce yet is honest, and the gate only ever reads the
 * three that are enforced today.
 */
const rowSchema = z.object({
  groups: z.array(
    z.enum(['observe', 'dispatch', 'orchestrate', 'terminal-io', 'admin', 'public'])
  ),
  workspaces: scopeSchema.optional(),
  agents: scopeSchema.optional()
})

const tableSchema = z.record(z.string(), rowSchema)

/**
 * Read the table, or return an empty one.
 *
 * Every failure path is the same: log and return {}, which leaves the caller on
 * the generated rows. A file that cannot be trusted must not be able to WIDEN
 * anyone's scope.
 *
 * The 0600 check is part of that: a consumers table other users can rewrite is
 * not a credential store, it is an invitation, and reading it would let any
 * local account grant itself the owner's groups.
 *
 * (Refusing to boot over a bad file would trade a misconfiguration for a dead
 * app; falling back to the generated rows keeps the owner's phone working.)
 */
export function loadConsumerRows(file: string): Record<string, GateConsumer> {
  try {
    if (!existsSync(file)) return {}
    const mode = statSync(file).mode & 0o777
    if ((mode & 0o077) !== 0) {
      console.error(
        `consumers.json ignored: mode ${mode.toString(8)} is group/world accessible (want 600)`
      )
      return {}
    }
    const parsed = tableSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!parsed.success) {
      console.error('consumers.json ignored: it does not match the v4 §4 row shape')
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed.data).map(([name, row]) => [
        name,
        {
          groups: row.groups,
          workspaces: row.workspaces ?? '*',
          ...(row.agents !== undefined ? { agents: row.agents } : {})
        } satisfies GateConsumer
      ])
    )
  } catch (error) {
    console.error('consumers.json ignored:', error instanceof Error ? error.message : error)
    return {}
  }
}

/**
 * The row a credential resolves to. A file row of the same name WINS — that is
 * what makes the table useful (tightening the phone, scoping the wall to one
 * workspace) — and its absence falls back to the generated row, which is
 * today's behaviour written down.
 */
export function consumerRow(
  name: typeof PHONE_CONSUMER_NAME | typeof WALL_CONSUMER_NAME,
  rows: Readonly<Record<string, GateConsumer>> | undefined
): GateConsumer {
  return rows?.[name] ?? (name === WALL_CONSUMER_NAME ? WALL_CONSUMER : PHONE_CONSUMER)
}
