/**
 * SERVED TEMPLATES — the inbound trigger the instantiator was missing.
 *
 * Until now an inbound call's slug resolved to a PRE-EXISTING workspace
 * (`store.bySlug`) or to nothing. R30 adds a third thing a slug can name: a
 * template the owner has started serving, which has no workspace yet and mints
 * one on first call. This module is that registry and the one decision that
 * tells the three cases apart, kept pure so the routing choice is testable
 * without a listener.
 *
 * WHAT ADDRESSES WHAT. A caller always calls the SERVICE slug — the public name
 * the owner chose when they started serving. The instantiator then routes them
 * to their own session's Conductor; the minted session's own `svc-…` slug is
 * internal and never an inbound address. So this registry is keyed by the
 * service slug, and a minted session slug can never appear here.
 *
 * ONE NAMESPACE. A service slug shares the workspace-slug namespace (the arch
 * note's rule: "a service cannot shadow the owner's own workspace"). This module
 * does not police that at write time — the caller picks a unique slug via
 * `uniqueSlug` when serving — but `resolveCallScope` gives a live workspace
 * PRECEDENCE regardless, so even a slug that somehow collided resolves to the
 * owner's own workspace, never a stranger's mint. Authoritative-wins is the safe
 * direction for confidentiality.
 *
 * It is NOT free of an availability cost, and the cost runs the OTHER way in
 * time: `uniqueSlug` is checked once at serve, but `liveWorkspaceId` is consulted
 * live on every call, so a workspace the owner names AFTER serving can take the
 * served slug and silently divert callers off the sandboxed mint — the service
 * goes unreachable with no signal. The caller (index.ts) should refuse or surface
 * a serve whose slug a live workspace already holds; this module keeps the safe
 * confidentiality default and leaves that availability check to its owner.
 */

/** A template the owner is serving under a public slug. */
/**
 * Who may start a session (the share-on-save choice). `just-me` is deliberately
 * NOT a value here: a private team simply is not served, so the registry cannot
 * hold an entry that means "nobody" — absence is the private state.
 */
export type ServeAccess = 'account' | 'paid'

export interface ServedTemplate {
  /** Stable id the gate and the instantiator key on — the export's identity. */
  serviceId: string
  /** The saved-team id `TeamStore.load` reads to mint from. */
  templateId: string
  /** The public slug callers address. Unique in the workspace-slug namespace. */
  slug: string
  /** The door: sign in (free) or sign in + pay per session. */
  access: ServeAccess
  /**
   * USDC per SESSION, as a decimal string ('2.50'). Present iff `access` is
   * 'paid' — an unpriced paid door or a priced free one is a caller deception,
   * so `serve` refuses both shapes rather than normalising them.
   */
  priceUsd?: string
}

/** A well-formed price: digits with an optional 1–2 decimal places, > 0. */
export function validPrice(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0
}

/**
 * The template's ORCH, by name, or null when it has none (`orchAgentOf`).
 *
 * A seam rather than a `TeamStore` import: this module is the pure routing
 * decision and must stay testable without a snapshot on disk. It is required,
 * not optional — a default that answered "sure, it has a door" is exactly how
 * the orch-less serve got in, and an unwired construction site should fail to
 * compile rather than fail open.
 */
export interface TemplateDoor {
  orchOf(templateId: string): string | null
}

/**
 * Why a serve was refused. Each value names something the OWNER can fix, and is
 * what the share sheet turns into a sentence — a reason a UI cannot phrase is a
 * reason that becomes "unknown" on a bar.
 */
export type ServeRefusal = 'no-orch' | 'bad-price' | 'priced-free-door' | 'grant-unusable'

/** Thrown by `serve`. Carries the machine-readable reason, not just prose. */
export class ServeRefused extends Error {
  readonly reason: ServeRefusal
  constructor(reason: ServeRefusal) {
    super(REFUSAL_TEXT[reason])
    this.reason = reason
    this.name = 'ServeRefused'
  }
}

const REFUSAL_TEXT: Record<ServeRefusal, string> = {
  'no-orch': 'a served crew needs an orch — callers talk to one agent',
  'bad-price': 'a paid door needs a price',
  'priced-free-door': 'a free door cannot carry a price',
  'grant-unusable': 'the orch cannot complete a request with this grant'
}

/**
 * The refusal for this serve, or null when it may go ahead. Pure, and separate
 * from `serve` so the owner surface can ask BEFORE the act — the save sheet
 * needs the answer while the button is still unpressed.
 *
 * The orch is checked first because it is the structural refusal: a priced door
 * is a crew configured wrong, an orch-less one is a crew that cannot work at
 * all, and that is the sentence worth showing.
 */
export function serveRefusal(template: ServedTemplate, door: TemplateDoor): ServeRefusal | null {
  if (door.orchOf(template.templateId) === null) return 'no-orch'
  // The two deceptive shapes, refused rather than normalised: a paid door with
  // no price quotes nothing at 402, and a price on a free door charges for what
  // the owner said was free.
  if (template.access === 'paid' && !validPrice(template.priceUsd ?? '')) return 'bad-price'
  if (template.access !== 'paid' && template.priceUsd !== undefined) return 'priced-free-door'
  return null
}

/**
 * The set of templates currently taking calls. Owner-only writes (serve/stop
 * are IPC, never on the listener — the same rule the grant surface follows);
 * the reads below are what the call path consults.
 */
export class ServedTemplates {
  private readonly templatesByService = new Map<string, ServedTemplate>()
  private readonly serviceIdBySlug = new Map<string, string>()
  private readonly door: TemplateDoor

  constructor(door: TemplateDoor) {
    this.door = door
  }

  /**
   * Start serving, or replace an existing entry for the same service (a
   * re-serve under a new slug, say). Replacing drops the old slug so a stale one
   * cannot linger and resolve after the owner moved the service.
   *
   * Throws `ServeRefused` on any shape the gate would have to apologise for
   * later. That is also the rehydrate filter: `wireServing` drops what this
   * refuses, so a crew that lost its orch since the app last ran comes back
   * NOT SERVED rather than serving a door that 503s.
   */
  serve(template: ServedTemplate): void {
    const refusal = serveRefusal(template, this.door)
    if (refusal !== null) throw new ServeRefused(refusal)
    const prior = this.templatesByService.get(template.serviceId)
    if (prior && prior.slug !== template.slug) this.serviceIdBySlug.delete(prior.slug)
    // Frozen, and this is the only copy the readers hand back — so a caller that
    // mutated a returned record could not desync the two maps (the slug on the
    // record and the slug the index is keyed by would diverge). Clone-in without
    // freeze would still leak a mutable reference on the way OUT.
    this.templatesByService.set(template.serviceId, Object.freeze({ ...template }))
    this.serviceIdBySlug.set(template.slug, template.serviceId)
  }

  /** Stop serving. Idempotent — stopping something not served is a no-op. */
  stop(serviceId: string): void {
    const prior = this.templatesByService.get(serviceId)
    if (!prior) return
    this.templatesByService.delete(serviceId)
    this.serviceIdBySlug.delete(prior.slug)
  }

  bySlug(slug: string): ServedTemplate | null {
    const serviceId = this.serviceIdBySlug.get(slug)
    return serviceId ? (this.templatesByService.get(serviceId) ?? null) : null
  }

  byService(serviceId: string): ServedTemplate | null {
    return this.templatesByService.get(serviceId) ?? null
  }

  list(): readonly ServedTemplate[] {
    return [...this.templatesByService.values()]
  }
}

/**
 * What an inbound slug names. A live workspace is answered the way it always
 * was; a served template mints (or reuses) a session; nothing is a 404.
 */
export type CallScope =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'serve'; service: ServedTemplate }
  | { kind: 'none' }

export interface ScopeLookup {
  /** The owner's live workspace for this slug, or null. `store.bySlug(slug)?.id`. */
  liveWorkspaceId(slug: string): string | null
  /** The served template for this slug, or null. */
  servedBySlug(slug: string): ServedTemplate | null
}

/**
 * Resolve an inbound slug. A live workspace is checked FIRST and wins: the
 * owner's own canvas is authoritative, so a service slug can never route a
 * caller onto — or shadow — a workspace the owner named. Only when no live
 * workspace claims the slug does a served template get to mint.
 */
export function resolveCallScope(slug: string, lookup: ScopeLookup): CallScope {
  const workspaceId = lookup.liveWorkspaceId(slug)
  if (workspaceId !== null) return { kind: 'workspace', workspaceId }

  const service = lookup.servedBySlug(slug)
  if (service !== null) return { kind: 'serve', service }

  return { kind: 'none' }
}
