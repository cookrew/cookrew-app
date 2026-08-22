import type http from 'node:http'
import { readJson, respondJson } from './mobile-http'
import { parseCallAddress, parseCeremonyRoute } from './call-route'
import type { CallCeremony, AssertInput } from './call-ceremony'
import type { CallDecision } from './call-gate'
import type { CallSession } from './call-session'
import { isConversationId } from './call-conversation'

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
}

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
    const body = await readJson<Partial<AssertInput>>(request)
    const result = deps.ceremony.assert(workspaceId, body as AssertInput)
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
    const realm = deps.slugOf(workspaceId) ?? workspaceId
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

  const body = await readJson<{ conversation?: unknown }>(request)
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
    respondJson(response, 409, {
      reason: 'no_version',
      detail: error instanceof Error ? error.message : String(error)
    })
    return true
  }

  // THE GATE SAID YES, THE VERSION EXISTS, AND THERE IS NO TURN TO RUN YET.
  //
  // 501, not 200. A 200 here would be a call that answered without running —
  // the wrong-answer-that-looks-right this lane refuses everywhere else, and
  // the caller would have no way to tell an empty reply from a finished one.
  // S4 runs the turn against `fork` and turns this into a 200 carrying a reply;
  // everything else in this body is already the real thing.
  respondJson(response, 501, {
    reason: 'turn_not_implemented',
    agent: address.agent,
    conversation: session.conversation,
    version: session.version,
    fork: session.forkId
  })
  return true
}
