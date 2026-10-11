/**
 * `cookrew secret read <name>` and `cookrew secret list` — the agent's side
 * of the sealed slot (shared/secret-slot.ts, main/secrets-store.ts).
 *
 * THE RULE: secrets are the owner's. A read is answered only to a pane that
 * belongs to THIS app's owner — a served session (someone else's seat on
 * this machine) is refused before the store is even opened, whatever the
 * secret's `served` flag says; that flag has no reader this round. Served
 * panes are also given no socket at all (pane-env.ts), so this refusal is
 * the second lock on a door that is already shut.
 *
 * EVERY READ LEAVES A LINE: `secret.read {terminalId, name}` in the event
 * log, name only. A read of a name nobody sealed leaves `secret.requested`
 * instead and exits 2 with the sentence the owner needs — the inbox turns
 * that event into a row that opens the note slot pre-named (Fresco's lane).
 *
 * The value goes to stdout and nowhere else: no event, no log, no error.
 */

import type { CliRequest, TerminalNodeData } from '../shared/model'
import { isSecretName, secretSlotOf } from '../shared/secret-slot'
import type { SecretsStore } from './secrets-store'

/** Exit codes a shell caller branches on. */
export const SECRET_EXIT = {
  ok: 0,
  usage: 1,
  missing: 2,
  refused: 3
} as const

export class SecretCliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'SecretCliError'
    this.exitCode = exitCode
  }
}

export type SecretAuditType = 'secret.read' | 'secret.requested'

export interface SecretAudit {
  readonly type: SecretAuditType
  readonly terminalId: string
  readonly name: string
}

export interface SecretCliDeps {
  readonly secrets: SecretsStore
  /** Who is asking: the calling pane as the socket server resolved it. */
  readonly self: (request: CliRequest) => TerminalNodeData
  readonly audit: (event: SecretAudit) => void
}

/** A served session's pane: the seat of someone who is not the owner. */
export const isServedPane = (me: TerminalNodeData): boolean =>
  me.servedSession !== undefined && me.servedSession !== null

export const SECRET_USAGE = 'usage: cookrew secret read <name> | cookrew secret list'

export const cmdSecret = (request: CliRequest, deps: SecretCliDeps): string => {
  const [sub, name] = request.args
  if (sub !== 'read' && sub !== 'list') throw new SecretCliError(SECRET_USAGE, SECRET_EXIT.usage)
  const me = deps.self(request)
  if (isServedPane(me)) {
    throw new SecretCliError("refused: secrets are the owner's — never readable from a served session", SECRET_EXIT.refused)
  }
  if (sub === 'list') {
    const rows = deps.secrets.list()
    if (rows.length === 0) return '(no secrets sealed)'
    return rows
      .map((row) => `${row.name}\t${row.served ? 'served' : 'local'}\t${new Date(row.updatedAt).toISOString()}`)
      .join('\n')
  }
  if (typeof name !== 'string' || !isSecretName(name)) {
    throw new SecretCliError(SECRET_USAGE, SECRET_EXIT.usage)
  }
  const record = deps.secrets.read(name)
  if (!record) {
    deps.audit({ type: 'secret.requested', terminalId: me.id, name })
    throw new SecretCliError(
      `no secret ${name} — the owner can fill it in the note slot 🔒 ${name}`,
      SECRET_EXIT.missing
    )
  }
  deps.audit({ type: 'secret.read', terminalId: me.id, name })
  return record.value
}

/**
 * THE DETAILS FIELD OF AN AUDIT ROW, as the inbox parses it (Fresco's
 * src/main/inbox.ts · parseSecretDetails): the name first, then — when a
 * note on the asking pane's canvas already carries the slot line — a
 * `note:<id>` the row can open straight to the field. Never the value.
 */
export const secretAuditDetails = (
  name: string,
  notes: readonly { readonly id: string; readonly content: string }[]
): string => {
  const holder = notes.find((note) => note.content.split('\n').some((line) => secretSlotOf(line) === name))
  return holder ? `${name} note:${holder.id}` : name
}
