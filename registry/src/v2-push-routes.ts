import { readJsonBody } from './http'
import { noContent, refuse, signedIn, v2Json, type Signed, type V2Context } from './v2-http'
import { v2Error } from './v2-copy'
import { pushEndpointOk, readSend, readSubscription, SUBSCRIPTION_ID, type PushSend } from './v2-push-check'
import type { PushSubscriptionRecord } from './v2-push-store'
import { liveRows } from './v2-push-live'
import { vapidAuthorization, type PushFeature } from './v2-push-vapid'

/**
 * PHONE PUSH — THE FIVE ROUTES (HITL phase 4, "三端通知 / 手机").
 *
 *   GET    /v2/me/push/key                the VAPID public key       console, desktop
 *   POST   /v2/me/push/subscriptions      file this browser          console, any device
 *   DELETE /v2/me/push/subscriptions/:id  take one off               console, any device
 *   GET    /v2/me/push/subscriptions/mine label, date, id: the owner  console, any device
 *   GET    /v2/me/push/subscriptions      ids and keys, no endpoint  a DESKTOP of the account
 *   POST   /v2/me/push/send               post an encrypted record   a DESKTOP of the account
 *
 * The split is the point. A console page holds a token a script in it could
 * read, so it may add and remove its own browser and nothing more. Reading the
 * keys and sending are a desktop's: the machine that knows an agent is
 * waiting encrypts the message itself (RFC 8291), and this registry only signs
 * the VAPID header and carries the bytes. It never decrypts them and never
 * logs them, and the endpoint never leaves it.
 *
 * A row lives as long as the sign-in that filed it (v2-push-live.ts), and
 * every read here sees only the live ones.
 */

const SMALL_BODY = 16 * 1024
/** A push service that has not answered in ten seconds is one that did not take it. */
const PUSH_TIMEOUT_MS = 10_000

type PushRoute =
  | { kind: 'key' }
  | { kind: 'subscribe' }
  | { kind: 'unsubscribe'; id: string }
  | { kind: 'list' }
  | { kind: 'mine' }
  | { kind: 'send' }

function routeOf(method: string, tail: readonly string[]): PushRoute | null {
  const [first, second] = tail
  if (tail.length === 1 && first === 'key' && method === 'GET') return { kind: 'key' }
  if (tail.length === 1 && first === 'send' && method === 'POST') return { kind: 'send' }
  if (tail.length === 1 && first === 'subscriptions' && method === 'GET') return { kind: 'list' }
  if (tail.length === 1 && first === 'subscriptions' && method === 'POST') return { kind: 'subscribe' }
  if (tail.length === 2 && first === 'subscriptions' && second === 'mine' && method === 'GET') return { kind: 'mine' }
  if (tail.length === 2 && first === 'subscriptions' && method === 'DELETE') return { kind: 'unsubscribe', id: second }
  return null
}

/** Answers true when it claimed the request: everything under /v2/me/push is this file's. */
export function handlePushRoute(ctx: V2Context, rest: readonly string[]): boolean {
  if (rest[0] !== 'me' || rest[1] !== 'push') return false
  const route = routeOf(ctx.method, rest.slice(2))
  if (route === null) {
    refuse(ctx.response, 404, 'not_found')
    return true
  }
  void answer(ctx, route).catch(() => {
    if (!ctx.response.headersSent) refuse(ctx.response, 500, 'server_error')
  })
  return true
}

async function answer(ctx: V2Context, route: PushRoute): Promise<void> {
  if (route.kind === 'list' || route.kind === 'send') return asDesktop(ctx, route)
  const signed = signedIn(ctx.request, ctx.v2, 'any', { console: true })
  if (signed === null) return refuse(ctx.response, 401, 'unauthenticated')
  const push = ctx.v2.push
  if (push === null) return refuse(ctx.response, 404, 'push_off')
  if (route.kind === 'key') return v2Json(ctx.response, 200, { publicKey: push.vapid.publicKey })
  if (route.kind === 'subscribe') return subscribe(ctx, push, signed)
  if (route.kind === 'mine') return listForOwner(ctx, signed)
  return unsubscribe(ctx, signed, route.id)
}

/** This account's rows whose sign-in is still on. */
const liveOf = (ctx: V2Context, signed: Signed): PushSubscriptionRecord[] =>
  liveRows(ctx.v2.pushSubscriptions.list(signed.account.username), signed.account, ctx.v2.now())

/**
 * THE DESKTOP'S TWO ROUTES. A session of this account whose device IS a
 * desktop and files a desktop record, and not a console page's: a phone or a
 * browser signed in on the account is not the machine that knows what its
 * agents are waiting on. The kind is checked as well as the record, so a
 * record filed by any other way still opens nothing (review M1). A desktop
 * need not be a trusted machine (`machine`): one joined by a code is the
 * account's desktop all the same, and a password change would otherwise
 * silence every Mac until it proved itself again.
 */
async function asDesktop(ctx: V2Context, route: { kind: 'list' } | { kind: 'send' }): Promise<void> {
  const signed = signedIn(ctx.request, ctx.v2)
  if (signed === null) return refuse(ctx.response, 401, 'unauthenticated')
  const isDesktop =
    signed.claims.via !== 'console' && signed.device.kind === 'desktop' && signed.account.desktops.some((d) => d.deviceId === signed.claims.dev)
  if (!isDesktop) return refuse(ctx.response, 403, 'desktop_only')
  const push = ctx.v2.push
  if (push === null) return refuse(ctx.response, 404, 'push_off')
  if (route.kind === 'list') return list(ctx, signed)
  return send(ctx, push, signed)
}

async function subscribe(ctx: V2Context, push: PushFeature, signed: Signed): Promise<void> {
  const { username } = signed.account
  if (!push.writes.take(`push-subscribe|${username}`)) return refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok && body.reason === 'too_large') return refuse(ctx.response, 413, 'malformed')
  const input = body.ok ? readSubscription(body.value) : null
  if (input === null) return refuse(ctx.response, 400, 'bad_push')
  const session = ctx.v2.accounts.session(username, signed.claims.jti)
  const sid = session?.sitting ?? session?.jti
  if (sid === undefined) return refuse(ctx.response, 401, 'unauthenticated')
  const filed = ctx.v2.pushSubscriptions.put(username, { ...input, dev: signed.claims.dev, sid })
  v2Json(ctx.response, 201, { id: filed.id })
}

function unsubscribe(ctx: V2Context, signed: Signed, id: string): void {
  const removed = SUBSCRIPTION_ID.test(id) && ctx.v2.pushSubscriptions.remove(signed.account.username, id)
  if (!removed) return refuse(ctx.response, 404, 'not_found')
  noContent(ctx.response)
}

function list(ctx: V2Context, signed: Signed): void {
  // Never the endpoint: a desktop encrypts to the keys, and the registry is the one that posts.
  const rows = liveOf(ctx, signed).map(({ id, p256dh, auth, label }) => ({ id, p256dh, auth, label }))
  v2Json(ctx.response, 200, rows)
}

/** What the owner is shown: which browsers are told, since when, and which one this is. Never a key or an endpoint. */
function listForOwner(ctx: V2Context, signed: Signed): void {
  const rows = liveOf(ctx, signed).map(({ id, label, createdAt, dev }) => ({ id, label, createdAt, here: dev === signed.claims.dev }))
  v2Json(ctx.response, 200, rows)
}

async function send(ctx: V2Context, push: PushFeature, signed: Signed): Promise<void> {
  const { username } = signed.account
  if (!push.sends.take(`push-send|${username}`)) return refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok && body.reason === 'too_large') return refuse(ctx.response, 413, 'malformed')
  const message = body.ok ? readSend(body.value) : null
  if (message === null) return refuse(ctx.response, 400, 'bad_push')
  const target = liveOf(ctx, signed).find((row) => row.id === message.subscription)
  if (target === undefined) return refuse(ctx.response, 404, 'not_found')
  // EVERY ACCOUNT TOGETHER (review L2): a bucket, then a ceiling on posts under way.
  if (!push.everyone.take() || !push.inFlight.enter()) return refuse(ctx.response, 503, 'push_busy', undefined, { 'retry-after': '5' })
  let outcome: 'sent' | 'gone' | 'failed'
  try {
    outcome = await deliver(push, target, message, ctx.v2.now())
  } finally {
    push.inFlight.leave()
  }
  if (outcome === 'sent') return v2Json(ctx.response, 202, { sent: true })
  if (outcome === 'failed') return refuse(ctx.response, 502, 'push_failed')
  // The browser let go of it (unsubscribed, uninstalled, signed out of the push service): so does the account.
  ctx.v2.pushSubscriptions.remove(username, target.id)
  v2Json(ctx.response, 410, { ...v2Error('push_gone'), gone: true })
}

/** RFC 8030 section 5 with RFC 8188's encoding and RFC 8292's header. Redirects are not followed: they lead off the allow-list. */
async function deliver(push: PushFeature, target: PushSubscriptionRecord, message: PushSend, now: number): Promise<'sent' | 'gone' | 'failed'> {
  // Checked again on the way out: an allow-list narrowed since the subscription was filed still holds.
  if (!pushEndpointOk(target.endpoint)) return 'failed'
  const headers: Record<string, string> = {
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(message.ttl),
    urgency: message.urgency,
    ...(message.topic === null ? {} : { topic: message.topic }),
    authorization: vapidAuthorization(push.vapid, target.endpoint, now)
  }
  try {
    const answered = await push.fetch(target.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(message.record),
      redirect: 'manual',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
    })
    // What the push service says back is not read: only its status matters here.
    await answered.body?.cancel().catch(() => undefined)
    if (answered.status >= 200 && answered.status < 300) return 'sent'
    return answered.status === 404 || answered.status === 410 ? 'gone' : 'failed'
  } catch {
    return 'failed'
  }
}
