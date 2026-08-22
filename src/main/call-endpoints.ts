import type http from 'node:http'
import { readJson, respondJson } from './mobile-http'
import { parseCallAddress, parseCeremonyRoute } from './call-route'
import type { CallCeremony, AssertInput } from './call-ceremony'
import type { CallDecision } from './call-gate'
import type { CallSession } from './call-session'
import { isConversationId } from './call-conversation'
import { validateCallPrompt } from './call-prompt'
import type { CallRunResult } from './call-run'

/**
 * THE INTERNET GATE'S HTTP SURFACE (§9 · ④ · S2).
 *
 * Routes only. Every answer is chosen by the gate; nothing here branches on
 * auth, which is what makes M2's 402 an insertion in one shared function rather
 * than an edit spread across handlers.
 *
 * STATUS CODES HERE ARE THE PROTOCOL (spec §2, R14). They are not user-facing
 * chrome: no token and no code in this file reaches a rendered sheet, and
 * nothing in a response body is a sentence. That is why these bodies look
 * unlike their neighbours in mobile-server, which answer `{ error: "..." }` to
 * a phone that will show the string — this surface answers a machine, and a
 * reason word is something a client can branch on.
 */

export interface CallEndpointDeps {
  /** Resolve + gate one call. Transport-free; this file only renders it. */
  decide: (workspaceId: string, agent: string, credential: string | null) => CallDecision
  ceremony: CallCeremony
  /** The slug the workspace is addressed at, for the challenge realm. */
  slugOf: (workspaceId: string) => string | undefined
  /**
   * The fork this conversation runs against, cutting a version pin when it is
   * the first call (§10). Only ever reached after the gate served the call.
   */
  session: (input: {
    workspaceId: string
    nodeId: string
    sub: string
    conversation?: string
  }) => CallSession
  /**
   * Run the turn against the fork. The ONLY path from this surface into a pty,
   * and it never receives a terminal id that call-session did not produce.
   */
  run: (input: { workspaceId: string; forkId: string; prompt: string }) => Promise<CallRunResult>
}

/**
 * What a realm may look like: exactly what workspace-slug.ts mints. Checked
 * here rather than assumed, because this file is where a bad value becomes a
 * response header.
 */
const SLUG_REALM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The credential presented, or null. Never an empty string, never a default. */
function bearer(request: http.IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

export async function handleCallRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: CallEndpointDeps,
  workspaceId: string
): Promise<boolean> {
  const method = request.method ?? 'GET'

  const ceremony = parseCeremonyRoute(method, url.pathname)
  if (ceremony === 'challenge') {
    // Unauthenticated by necessity — this is what a caller has instead of a
    // credential. It discloses nothing: a nonce is worthless without an
    // enrolled key, and the answer is identical whether or not the asker is
    // enrolled here, so this cannot be used to probe who is.
    respondJson(response, 200, { challenge: deps.ceremony.challenge(workspaceId) })
    return true
  }

  if (ceremony === 'assert') {
    // EVERY failure of this route is one 401, including the ones that are not
    // the ceremony's (Tinker LOW-1). Malformed JSON threw out of readJson and
    // surfaced as a 500 carrying the parser's message; mint() was unwrapped
    // too, so a signing key with the wrong mode could have shown an anonymous
    // caller an absolute path from this machine. A refusal that is uniform for
    // four reasons and then leaks on a fifth is not uniform.
    let result: ReturnType<CallCeremony['assert']>
    try {
      const body = await readJson<Partial<AssertInput>>(request)
      result = deps.ceremony.assert(workspaceId, body as AssertInput)
    } catch {
      respondJson(response, 401, {})
      return true
    }
    if (!result.ok) {
      // ONE answer for every way a ceremony fails. The reason is real and it is
      // kept server-side: telling a caller that its subject was unknown but its
      // signature would have been fine is an enrolment oracle, and telling it
      // which half of a forgery was wrong is the same mistake the registry
      // refuses to make at 401.
      respondJson(response, 401, {})
      return true
    }
    respondJson(response, 200, { token: result.token })
    return true
  }

  const address = parseCallAddress(method, url.pathname)
  if (address === null) return false

  const decision = deps.decide(workspaceId, address.agent, bearer(request))
  const verdict = decision.verdict

  if (verdict.code === 401) {
    // The challenge rides in the header the spec names, so a client reads one
    // place for "what next", and the realm names the workspace it must
    // ceremony against — the nonce is bound to that workspace and will not be
    // spent anywhere else.
    //
    // Set before the body rather than through respondJson, which takes no
    // headers: Node merges setHeader values into writeHead's, so the shared
    // helper stays as it is for the ~44 routes that do not need one.
    //
    // The realm is CHECKED here, not trusted (Tinker LOW-3). It was
    // interpolated straight into a quoted header field on the strength of an
    // invariant enforced in workspace-slug.ts — true today, and a header
    // injection the moment someone relaxes it in a file that has no idea this
    // depends on it. A value that is not the shape slugs are minted in is
    // replaced rather than escaped: the realm is a label, and a wrong label
    // costs a client nothing, while a quote inside one costs everything.
    const named = deps.slugOf(workspaceId)
    const realm = named !== undefined && SLUG_REALM.test(named) ? named : 'cookrew'
    response.setHeader(
      'www-authenticate',
      `Cookrew realm="${realm}", challenge=${verdict.challenge}`
    )
    respondJson(response, 401, {})
    return true
  }
  if (verdict.code === 403) {
    respondJson(response, 403, { reason: verdict.reason })
    return true
  }
  if (verdict.code === 404) {
    respondJson(response, 404, {})
    return true
  }

  // Served. From here the call has a subject, a fork and a version.
  //
  // `claims` is null only for a public resource, and this store refuses to
  // record a public export precisely because a call with no subject has nothing
  // to key a conversation on (agent-export.ts). Refusing here as well means the
  // invariant holds even if that ever changes without this being revisited.
  if (verdict.claims === null || decision.target === null) {
    respondJson(response, 403, { reason: 'identity' })
    return true
  }

  let body: { conversation?: unknown; text?: unknown }
  try {
    body = await readJson<{ conversation?: unknown; text?: unknown }>(request)
  } catch {
    // Same rule as the ceremony: a parser message is not this route's answer.
    respondJson(response, 403, { reason: 'conversation' })
    return true
  }

  // THE INBOUND BOUNDARY. Checked before a fork is even resolved, because a
  // prompt that will be refused should not cost the owner a harness boot — and
  // because the bytes below travel into a real agent's input box. See
  // call-prompt.ts for the bracketed-paste escape this closes.
  const prompt = validateCallPrompt(body?.text)
  if (!prompt.ok) {
    respondJson(response, 400, { reason: prompt.reason })
    return true
  }

  const requested = body?.conversation
  if (requested !== undefined && (typeof requested !== 'string' || !isConversationId(requested))) {
    // A conversation id is a KEY. Refused rather than coerced, because two
    // spellings that resolve to one conversation are two names for one fork.
    respondJson(response, 403, { reason: 'conversation' })
    return true
  }

  let session: CallSession
  try {
    session = deps.session({
      workspaceId,
      nodeId: decision.target.nodeId,
      sub: verdict.claims.sub,
      ...(typeof requested === 'string' ? { conversation: requested } : {})
    })
  } catch (error) {
    // A source with no completed turns cannot be forked, and a fork that fails
    // is a call that did not happen. Said plainly rather than answered 501,
    // which would claim the gate is fine and only the turn is missing.
    // A reason word, never the thrown message. `error` here can come from the
    // fork engine or the filesystem, and either can carry an absolute path from
    // the owner's machine — which is not something an anonymous caller has any
    // business reading out of a refusal.
    void error
    respondJson(response, 409, { reason: 'no_version' })
    return true
  }

  const outcome = await deps.run({
    workspaceId,
    forkId: session.forkId,
    prompt: prompt.text
  })

  if (!outcome.ok) {
    // 409 for all three: not now, and the caller may retry. A busy producer, a
    // fork whose pty is not attached and a context that never settled are
    // different facts to the owner's log and the same instruction to a client.
    respondJson(response, 409, { reason: outcome.reason })
    return true
  }

  // Served, for real. The conversation and version travel with every reply so a
  // caller can continue this conversation (and so it can SEE that continuing
  // costs no new version) without holding state we would then have to trust.
  respondJson(response, 200, {
    reply: outcome.text,
    truncated: outcome.truncated,
    agent: address.agent,
    conversation: session.conversation,
    version: session.version
  })
  return true
}
